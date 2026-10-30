//! Blocks (ADR 0011, docs/protocols/blocks.md): the header and its id, the byte layout, and the
//! rules that check a Block against the chain it extends and the accounts.

use std::collections::HashMap;

use crate::codec::Reader;
use crate::issuance::reward;
use crate::merkle::tx_root;
use crate::params::ChainParams;
use crate::retarget::next_target;
use crate::smt::{self, Node, SmtStore};
use crate::state::{Account, State, StateView, tree_key};
use crate::tx::{Tx, apply_tx};
use crate::u256::U256;
use crate::{Address, Error, keccak256};

pub const BLOCK_VERSION: u8 = 1;
pub const HEADER_LEN: usize = 187;
/// Where the nonce starts: the header's last 8 bytes, the only ones a Mine changes.
pub const NONCE_OFFSET: usize = 179;
/// The most bytes a whole Block may have: header, transaction count and transactions.
pub const MAX_BLOCK_SIZE: usize = 1_000_000;
/// The most Accounts one Block may create, its reward address included (ADR 0015).
pub const MAX_NEW_ACCOUNTS: usize = 50;
/// The latest timestamp a header may carry, so that the difference of two fits in an `i64`.
pub const MAX_TIMESTAMP: u64 = 1 << 62;
/// How many timestamps before a Block the median it must pass reads.
const MEDIAN_SPAN: u64 = 11;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Header {
    pub height: u64,
    /// The parent's id; 32 zero bytes in the genesis.
    pub prev_id: [u8; 32],
    /// Unix seconds.
    pub timestamp: u64,
    pub target: U256,
    pub tx_root: [u8; 32],
    /// The state root after this Block.
    pub state_root: [u8; 32],
    /// Gets the reward and the fees. No key is involved (P2).
    pub reward_address: Address,
    pub nonce: u64,
}

impl Header {
    pub fn to_bytes(&self) -> [u8; HEADER_LEN] {
        let mut bytes = Vec::with_capacity(HEADER_LEN);
        bytes.push(BLOCK_VERSION);
        bytes.extend_from_slice(&self.height.to_be_bytes());
        bytes.extend_from_slice(&self.prev_id);
        bytes.extend_from_slice(&self.timestamp.to_be_bytes());
        bytes.extend_from_slice(&self.target.to_be_bytes());
        bytes.extend_from_slice(&self.tx_root);
        bytes.extend_from_slice(&self.state_root);
        bytes.extend_from_slice(&self.reward_address.to_bytes());
        bytes.extend_from_slice(&self.nonce.to_be_bytes());
        bytes.try_into().expect("a header is 187 bytes")
    }

    /// `keccak256` of the header bytes. The Proof-of-Work hash is another hash of the same bytes,
    /// so the id cannot be mined lower by chance.
    pub fn id(&self) -> [u8; 32] {
        keccak256(&[&self.to_bytes()])
    }

    /// A header alone, as a Node stores it.
    pub fn from_bytes(bytes: &[u8]) -> Result<Header, Error> {
        let mut reader = Reader::new(bytes);
        let header = Header::read(&mut reader)?;
        reader.finish()?;
        Ok(header)
    }

    fn read(reader: &mut Reader<'_>) -> Result<Header, Error> {
        if reader.u8()? != BLOCK_VERSION {
            return Err(Error::UnknownVersion);
        }
        // Fields are read in the order they are written here.
        Ok(Header {
            height: reader.u64()?,
            prev_id: reader.array()?,
            timestamp: reader.u64()?,
            target: U256::from_be_bytes(reader.array()?),
            tx_root: reader.array()?,
            state_root: reader.array()?,
            reward_address: reader.address()?,
            nonce: reader.u64()?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Block {
    pub header: Header,
    pub txs: Vec<Tx>,
}

impl Block {
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut bytes = self.header.to_bytes().to_vec();
        let count = u16::try_from(self.txs.len()).expect("at most 65,535 transactions");
        bytes.extend_from_slice(&count.to_be_bytes());
        for tx in &self.txs {
            bytes.extend_from_slice(&tx.to_bytes());
        }
        bytes
    }

    /// The length of `to_bytes`.
    pub fn size(&self) -> usize {
        let txs: usize = self.txs.iter().map(|tx| tx.to_bytes().len()).sum();
        HEADER_LEN + 2 + txs
    }

    /// Refuses more than `MAX_BLOCK_SIZE` bytes, then reads the fields in order; the first one
    /// that is wrong gives the error. A transaction count above the number of transactions gives
    /// `Truncated`, and one below it `TrailingBytes`.
    pub fn from_bytes(bytes: &[u8]) -> Result<Block, Error> {
        if bytes.len() > MAX_BLOCK_SIZE {
            return Err(Error::BlockTooLarge);
        }
        let mut reader = Reader::new(bytes);
        let header = Header::read(&mut reader)?;
        let count = reader.u16()?;
        let txs = (0..count)
            .map(|_| Tx::read(&mut reader))
            .collect::<Result<_, _>>()?;
        reader.finish()?;
        Ok(Block { header, txs })
    }
}

/// The height of the Block whose id is the RandomX key at `height`: a new key every 2048 Blocks,
/// used from 64 Blocks after it (ADR 0012). Monero's `rx_seedheight` switches one Block later.
pub fn key_height(height: u64) -> u64 {
    if height < 2112 {
        0
    } else {
        (height - 64) / 2048 * 2048
    }
}

/// Whether `block` is the genesis of `params`, the only Block a Node takes at height 0.
pub fn check_genesis(params: &ChainParams, block: &Block) -> Result<(), Error> {
    match block.header == params.genesis() && block.txs.is_empty() {
        true => Ok(()),
        false => Err(Error::WrongGenesis),
    }
}

/// The chain a Block extends: the headers from the genesis to its parent. It always holds the
/// genesis, which no rule checks: a Node starts from the genesis of its `ChainParams`. The Node
/// implements it on its database, tests on a slice.
pub trait ChainView {
    /// The parent's height.
    fn tip_height(&self) -> u64;
    /// The header at `height`, from 0 to `tip_height()`.
    fn header(&self, height: u64) -> Header;
}

impl ChainView for [Header] {
    fn tip_height(&self) -> u64 {
        self.len() as u64 - 1
    }

    fn header(&self, height: u64) -> Header {
        self[height as usize]
    }
}

/// What a valid Block changes: accounts as they are after it, and state-tree entries (`None`
/// removes one).
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Changes {
    pub accounts: HashMap<Address, Account>,
    pub tree: HashMap<(u16, [u8; 32]), Option<Node>>,
}

impl Changes {
    /// Writes the changes. A Node writes them, with the Block, in one database transaction.
    pub fn apply(self, state: &mut impl State, tree: &mut impl SmtStore) {
        for (address, account) in self.accounts {
            state.set_account(address, account);
        }
        for ((depth, path), node) in self.tree {
            tree.set_node(depth, path, node);
        }
    }
}

/// Checks `block` on top of `chain`, against the accounts in `state` and their tree in `tree`, in
/// the order of docs/protocols/blocks.md; the first check that fails gives the error.
/// `hash(header bytes, key)` is the Proof-of-Work hash: RandomX v2 in the Node, a fake in tests,
/// so this crate needs no RandomX. Nothing is written: the changes come back.
pub fn validate_block(
    params: &ChainParams,
    block: &Block,
    chain: &(impl ChainView + ?Sized),
    state: &impl StateView,
    tree: &impl SmtStore,
    hash: impl Fn(&[u8], &[u8; 32]) -> [u8; 32],
) -> Result<Changes, Error> {
    check_block(params, block, chain, hash)?;
    check_on_accounts(params, block, state, tree)
}

/// The checks of `validate_block` that need no account, in its order: the size, the header
/// against the chain it extends, and the transactions against the header's `tx_root`. A Node
/// runs them before it stores a Block of any branch. A transaction's id leaves out its
/// signature, so a Block that passes may still carry a signature someone changed.
pub fn check_block(
    params: &ChainParams,
    block: &Block,
    chain: &(impl ChainView + ?Sized),
    hash: impl Fn(&[u8], &[u8; 32]) -> [u8; 32],
) -> Result<(), Error> {
    // 1. What `from_bytes` checks, for a Block built in memory.
    if block.size() > MAX_BLOCK_SIZE {
        return Err(Error::BlockTooLarge);
    }
    // 2. The parent.
    let header = &block.header;
    let height = chain.tip_height() + 1;
    if header.height != height {
        return Err(Error::WrongHeight);
    }
    if header.prev_id != chain.header(height - 1).id() {
        return Err(Error::WrongParent);
    }
    // 3. Timestamp and Target. The Target the Retarget gives is always between 1 and the
    // maximum, so equality covers both bounds.
    if header.timestamp > MAX_TIMESTAMP {
        return Err(Error::TimestampTooLate);
    }
    if header.timestamp <= median_time_past(chain, height) {
        return Err(Error::TimestampTooEarly);
    }
    let target = next_target(params, height, |j| {
        let header = chain.header(j);
        (header.timestamp, header.target)
    });
    if header.target != target {
        return Err(Error::WrongTarget);
    }
    // 4. Proof of Work: expensive, so before the transactions.
    let key = chain.header(key_height(height)).id();
    if U256::from_be_bytes(hash(&header.to_bytes(), &key)) >= header.target {
        return Err(Error::InsufficientWork);
    }
    // 5. The transactions, then the reward, then the state root.
    let ids: Vec<[u8; 32]> = block.txs.iter().map(|tx| tx.id(params)).collect();
    match tx_root(&ids) == header.tx_root {
        true => Ok(()),
        false => Err(Error::WrongTxRoot),
    }
}

/// The rest of `validate_block`, on the accounts as the Block's parent leaves them, for a Block
/// that `check_block` has passed: the transactions, the reward and the state root.
pub fn check_on_accounts(
    params: &ChainParams,
    block: &Block,
    state: &impl StateView,
    tree: &impl SmtStore,
) -> Result<Changes, Error> {
    let (root, changes) = after_block(params, block, state, tree)?;
    match root == block.header.state_root {
        true => Ok(changes),
        false => Err(Error::WrongStateRoot),
    }
}

/// The state root `block` leaves, whatever its header holds: what a Block template's header
/// gets. Refused as `check_on_accounts` refuses, but for the state root.
pub fn state_root_after(
    params: &ChainParams,
    block: &Block,
    state: &impl StateView,
    tree: &impl SmtStore,
) -> Result<[u8; 32], Error> {
    after_block(params, block, state, tree).map(|(root, _)| root)
}

/// The state root after `block`, and its changes.
fn after_block(
    params: &ChainParams,
    block: &Block,
    state: &impl StateView,
    tree: &impl SmtStore,
) -> Result<([u8; 32], Changes), Error> {
    let (header, height) = (&block.header, block.header.height);
    let mut after = Overlay {
        state,
        tree,
        changes: Changes::default(),
        created: 0,
    };
    let mut fees = 0u64;
    for tx in &block.txs {
        apply_tx(params, &mut after, tx)?;
        fees = fees.checked_add(tx.fee).ok_or(Error::Overflow)?;
        after.check_created()?;
    }
    let mut account = after.account(&header.reward_address).unwrap_or_default();
    account.balance = reward(height)
        .checked_add(fees)
        .and_then(|gold| account.balance.checked_add(gold))
        .ok_or(Error::Overflow)?;
    after.set_account(header.reward_address, account);
    after.check_created()?;
    let leaves: Vec<_> = after
        .changes
        .accounts
        .iter()
        .map(|(address, account)| (tree_key(address), account.hashed_bytes(address)))
        .collect();
    for (key, value) in &leaves {
        smt::insert(&mut after, key, value);
    }
    Ok((smt::root(&after), after.changes))
}

/// The median of the timestamps of the up to 11 Blocks before `height`: with an even number of
/// them, the later of the two in the middle. A Block's timestamp must be above it.
pub fn median_time_past(chain: &(impl ChainView + ?Sized), height: u64) -> u64 {
    let mut times: Vec<u64> = (height.saturating_sub(MEDIAN_SPAN)..height)
        .map(|j| chain.header(j).timestamp)
        .collect();
    times.sort_unstable();
    times[times.len() / 2]
}

/// The accounts and their tree as a Block leaves them, over a base it does not write.
struct Overlay<'a, S, T> {
    state: &'a S,
    tree: &'a T,
    changes: Changes,
    /// Accounts set here that the base does not have: the Accounts the Block creates, since none
    /// is ever removed.
    created: usize,
}

impl<S, T> Overlay<'_, S, T> {
    fn check_created(&self) -> Result<(), Error> {
        match self.created > MAX_NEW_ACCOUNTS {
            true => Err(Error::TooManyNewAccounts),
            false => Ok(()),
        }
    }
}

impl<S: StateView, T> StateView for Overlay<'_, S, T> {
    fn account(&self, address: &Address) -> Option<Account> {
        match self.changes.accounts.get(address) {
            Some(account) => Some(account.clone()),
            None => self.state.account(address),
        }
    }
}

impl<S: StateView, T> State for Overlay<'_, S, T> {
    fn set_account(&mut self, address: Address, account: Account) {
        if !self.changes.accounts.contains_key(&address) && self.state.account(&address).is_none() {
            self.created += 1;
        }
        self.changes.accounts.insert(address, account);
    }
}

impl<S, T: SmtStore> SmtStore for Overlay<'_, S, T> {
    fn node(&self, depth: u16, path: &[u8; 32]) -> Option<Node> {
        match self.changes.tree.get(&(depth, *path)) {
            Some(node) => *node,
            None => self.tree.node(depth, path),
        }
    }

    fn set_node(&mut self, depth: u16, path: [u8; 32], node: Option<Node>) {
        self.changes.tree.insert((depth, path), node);
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;
    use crate::issuance::BASE_UNITS_PER_GOLD as GOLD;
    use crate::params::DEV;
    use crate::tx::Kind;
    use crate::{ADDRESS_LEN, SCHEME_ML_DSA_44, SigningKey};

    type Accounts = HashMap<Address, Account>;
    type Tree = HashMap<(u16, [u8; 32]), Node>;

    /// Half of all hashes pass; the Retarget is off.
    const PARAMS: ChainParams = ChainParams {
        max_target: U256::ones(255),
        initial_target: U256::ones(255),
        ..DEV
    };

    /// Proof of Work by the nonce alone: 0 fails, anything else passes.
    fn work(header: &[u8], _key: &[u8; 32]) -> [u8; 32] {
        match header[NONCE_OFFSET..] == [0; 8] {
            true => [0xff; 32],
            false => [0; 32],
        }
    }

    fn key(seed: u8) -> SigningKey {
        SigningKey::from_seed(&[seed; 32])
    }

    /// An address nobody has the key of.
    fn nobody(n: u8) -> Address {
        let mut bytes = [n; ADDRESS_LEN];
        bytes[..2].copy_from_slice(&[0, SCHEME_ML_DSA_44]);
        Address::from_bytes(&bytes).unwrap()
    }

    fn transfer(from: &SigningKey, nonce: u64, to: Address, amount: u64) -> Tx {
        let mut tx = Tx {
            scheme: SCHEME_ML_DSA_44,
            sender: from.address(),
            nonce,
            fee: 10,
            kind: Kind::Transfer {
                to,
                amount,
                memo: Vec::new(),
            },
            public_key: (nonce == 0).then(|| from.public_key().to_vec()),
            signature: Vec::new(),
        };
        tx.sign(&PARAMS, from, &[0; 32]).unwrap();
        tx
    }

    fn tree_of(state: &Accounts) -> Tree {
        let mut tree = Tree::new();
        for (address, account) in state {
            smt::insert(
                &mut tree,
                &tree_key(address),
                &account.hashed_bytes(address),
            );
        }
        tree
    }

    /// Headers from the genesis, one per timestamp. Only what `validate_block` reads is real.
    fn chain(timestamps: &[u64]) -> Vec<Header> {
        let mut headers: Vec<Header> = Vec::new();
        for (height, &timestamp) in timestamps.iter().enumerate() {
            headers.push(Header {
                height: height as u64,
                prev_id: headers.last().map_or([0; 32], Header::id),
                timestamp,
                target: PARAMS.initial_target,
                tx_root: tx_root(&[]),
                state_root: smt::empty(256),
                reward_address: nobody(0),
                nonce: 0,
            });
        }
        headers
    }

    /// A valid Block on top of `chain`. Its state root comes from applying the transactions and
    /// the reward to a copy of `state`, then building the tree from scratch.
    fn block(chain: &[Header], state: &Accounts, reward_address: Address, txs: Vec<Tx>) -> Block {
        let parent = chain.last().unwrap();
        let mut after = state.clone();
        for tx in &txs {
            apply_tx(&PARAMS, &mut after, tx).unwrap();
        }
        let fees: u64 = txs.iter().map(|tx| tx.fee).sum();
        after.entry(reward_address).or_default().balance += reward(parent.height + 1) + fees;
        let ids: Vec<_> = txs.iter().map(|tx| tx.id(&PARAMS)).collect();
        Block {
            header: Header {
                height: parent.height + 1,
                prev_id: parent.id(),
                timestamp: parent.timestamp + 60,
                target: PARAMS.initial_target,
                tx_root: tx_root(&ids),
                state_root: smt::root(&tree_of(&after)),
                reward_address,
                nonce: 1,
            },
            txs,
        }
    }

    /// A chain of two headers, an account with 1 GOLD, and a valid Block that sends 5 base
    /// units from it to a new address.
    fn setup() -> (Vec<Header>, Accounts, Tree, Block) {
        let chain = chain(&[1_000, 1_060]);
        let a = key(1);
        let state = Accounts::from([(
            a.address(),
            Account {
                balance: GOLD,
                ..Account::default()
            },
        )]);
        let block = block(
            &chain,
            &state,
            nobody(3),
            vec![transfer(&a, 0, nobody(2), 5)],
        );
        let tree = tree_of(&state);
        (chain, state, tree, block)
    }

    #[test]
    fn header_bytes_and_id() {
        let header = setup().3.header;
        let bytes = header.to_bytes();
        assert_eq!(bytes[0], BLOCK_VERSION);
        assert_eq!(bytes[1..9], header.height.to_be_bytes());
        assert_eq!(bytes[9..41], header.prev_id);
        assert_eq!(bytes[41..49], header.timestamp.to_be_bytes());
        assert_eq!(bytes[49..81], header.target.to_be_bytes());
        assert_eq!(bytes[81..113], header.tx_root);
        assert_eq!(bytes[113..145], header.state_root);
        assert_eq!(bytes[145..NONCE_OFFSET], header.reward_address.to_bytes());
        assert_eq!(bytes[NONCE_OFFSET..], header.nonce.to_be_bytes());
        assert_eq!(header.id(), keccak256(&[&bytes]));
        assert_eq!(Header::from_bytes(&bytes), Ok(header));
        assert_eq!(Header::from_bytes(&bytes[1..]), Err(Error::UnknownVersion));
        assert_eq!(
            Header::from_bytes(&[&bytes[..], &[0]].concat()),
            Err(Error::TrailingBytes)
        );
    }

    #[test]
    fn reading_refuses_malformed_bytes() {
        let block = setup().3;
        let bytes = block.to_bytes();
        assert_eq!(bytes.len(), block.size());
        assert_eq!(Block::from_bytes(&bytes), Ok(block.clone()));
        let with = |at: usize, byte: u8| {
            let mut changed = bytes.clone();
            changed[at] = byte;
            Block::from_bytes(&changed)
        };
        assert_eq!(with(0, 2), Err(Error::UnknownVersion));
        assert_eq!(with(145, 1), Err(Error::BadAddress));
        assert_eq!(with(146, 2), Err(Error::UnknownScheme));
        // The count, 1, is the byte after the header.
        assert_eq!(with(HEADER_LEN + 1, 2), Err(Error::Truncated));
        assert_eq!(with(HEADER_LEN + 1, 0), Err(Error::TrailingBytes));
        let longer = [bytes.as_slice(), &[0]].concat();
        assert_eq!(Block::from_bytes(&longer), Err(Error::TrailingBytes));
        assert_eq!(
            Block::from_bytes(&bytes[..bytes.len() - 1]),
            Err(Error::Truncated)
        );
        let mut large = bytes.clone();
        large.resize(MAX_BLOCK_SIZE + 1, 0);
        assert_eq!(Block::from_bytes(&large), Err(Error::BlockTooLarge));
        large.pop();
        assert_eq!(Block::from_bytes(&large), Err(Error::TrailingBytes));
        let empty = Block {
            header: block.header,
            txs: Vec::new(),
        };
        assert_eq!(Block::from_bytes(&empty.to_bytes()), Ok(empty));
    }

    #[test]
    fn a_valid_block_changes_the_accounts_and_the_tree() {
        let (chain, mut state, mut tree, block) = setup();
        let changes = validate_block(&PARAMS, &block, &chain[..], &state, &tree, work).unwrap();
        assert_eq!(changes.accounts.len(), 3);
        changes.apply(&mut state, &mut tree);
        assert_eq!(smt::root(&tree), block.header.state_root);
        assert_eq!(
            tree,
            tree_of(&state),
            "the same entries as a tree built from scratch"
        );
        assert_eq!(state[&key(1).address()].balance, GOLD - 15);
        assert_eq!(state[&nobody(2)].balance, 5);
        assert_eq!(state[&nobody(3)].balance, reward(2) + 10);
    }

    #[test]
    fn a_template_gets_the_state_root_its_block_leaves() {
        let (_, state, tree, mut block) = setup();
        let root = block.header.state_root;
        block.header.state_root = [0; 32];
        assert_eq!(state_root_after(&PARAMS, &block, &state, &tree), Ok(root));
        block.txs[0].nonce = 1;
        assert_eq!(
            state_root_after(&PARAMS, &block, &state, &tree),
            Err(Error::WrongNonce)
        );
    }

    /// A change that makes one check fail, and its error.
    type Break = (fn(&mut Block), Error);

    #[test]
    fn checks_run_in_order_cheap_first() {
        let (chain, state, tree, mut block) = setup();
        // Each break fails one check. Applied from the last, each new one fails first.
        let breaks: [Break; 10] = [
            (
                |b| b.txs[0].signature.resize(MAX_BLOCK_SIZE, 0),
                Error::BlockTooLarge,
            ),
            (|b| b.header.height += 1, Error::WrongHeight),
            (|b| b.header.prev_id[0] ^= 1, Error::WrongParent),
            (
                |b| b.header.timestamp = MAX_TIMESTAMP + 1,
                Error::TimestampTooLate,
            ),
            // The parent's timestamp, the later of the two before.
            (|b| b.header.timestamp = 1_060, Error::TimestampTooEarly),
            (|b| b.header.target = U256::ONE, Error::WrongTarget),
            (|b| b.header.nonce = 0, Error::InsufficientWork),
            (|b| b.header.tx_root[0] ^= 1, Error::WrongTxRoot),
            (|b| b.txs[0].signature[0] ^= 1, Error::BadSignature),
            (|b| b.header.state_root[0] ^= 1, Error::WrongStateRoot),
        ];
        for (break_one, error) in breaks.iter().rev() {
            break_one(&mut block);
            let result = validate_block(&PARAMS, &block, &chain[..], &state, &tree, work);
            assert_eq!(result, Err(*error));
        }
    }

    #[test]
    fn a_timestamp_must_pass_the_median_of_the_last_11() {
        let empty = Accounts::new();
        let check = |chain: &[Header], timestamp: u64| {
            let mut block = block(chain, &empty, nobody(3), Vec::new());
            block.header.timestamp = timestamp;
            validate_block(&PARAMS, &block, chain, &empty, &Tree::new(), work).map(|_| ())
        };
        // The 11 before height 13 are heights 2 to 12; sorted, the middle one is 500. Heights 0
        // and 1 would move it.
        let headers = chain(&[
            0, 9_999, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1_000, 50,
        ]);
        assert_eq!(check(&headers, 500), Err(Error::TimestampTooEarly));
        assert_eq!(check(&headers, 501), Ok(()));
        assert_eq!(check(&headers, 20), Err(Error::TimestampTooEarly));
        // Two before: the later one.
        let two = chain(&[1_000, 900]);
        assert_eq!(check(&two, 1_000), Err(Error::TimestampTooEarly));
        assert_eq!(check(&two, 1_001), Ok(()));
        assert_eq!(check(&two, MAX_TIMESTAMP), Ok(()));
        assert_eq!(check(&two, MAX_TIMESTAMP + 1), Err(Error::TimestampTooLate));
    }

    #[test]
    fn the_target_and_the_key_come_from_the_chain() {
        let empty = Accounts::new();
        let seen = RefCell::new(Vec::new());
        let record = |header: &[u8], key: &[u8; 32]| {
            seen.borrow_mut().push((header.to_vec(), *key));
            [0; 32]
        };
        // With the Retarget on and a window of 2, fast Blocks halve the Target at height 3.
        let params = ChainParams {
            retarget_enabled: true,
            retarget_window: 2,
            ..PARAMS
        };
        let headers = chain(&[0, 30, 60]);
        let mut fast = block(&headers, &empty, nobody(3), Vec::new());
        assert_eq!(
            validate_block(&params, &fast, &headers[..], &empty, &Tree::new(), record),
            Err(Error::WrongTarget)
        );
        fast.header.target = PARAMS.initial_target.mul_div(1, 2);
        assert!(validate_block(&params, &fast, &headers[..], &empty, &Tree::new(), record).is_ok());
        assert_eq!(
            seen.take(),
            [(fast.header.to_bytes().to_vec(), headers[0].id())]
        );

        // From height 2112 the key is a later Block's id.
        let headers = chain(&(0..2112).map(|t| t * 60).collect::<Vec<_>>());
        let late = block(&headers, &empty, nobody(3), Vec::new());
        assert!(validate_block(&PARAMS, &late, &headers[..], &empty, &Tree::new(), record).is_ok());
        assert_eq!(seen.take()[0].1, headers[2048].id());
    }

    #[test]
    fn key_heights() {
        for (height, key) in [
            (0, 0),
            (1, 0),
            (2111, 0),
            (2112, 2048),
            (4159, 2048),
            (4160, 4096),
        ] {
            assert_eq!(key_height(height), key, "at {height}");
        }
    }

    #[test]
    fn the_reward_is_credited_after_the_transactions() {
        let (chain, state, tree, _) = setup();
        let a = key(1);
        // All of A's Gold and a fee: the reward to A would pay the fee, but comes after.
        let mut block = block(
            &chain,
            &state,
            a.address(),
            vec![transfer(&a, 0, nobody(2), 5)],
        );
        block.txs = vec![transfer(&a, 0, nobody(2), GOLD)];
        block.header.tx_root = tx_root(&[block.txs[0].id(&PARAMS)]);
        assert_eq!(
            validate_block(&PARAMS, &block, &chain[..], &state, &tree, work).map(|_| ()),
            Err(Error::InsufficientBalance)
        );
    }

    #[test]
    fn the_reward_credit_cannot_overflow() {
        let (chain, mut state, _, block) = setup();
        state.insert(
            nobody(3),
            Account {
                balance: u64::MAX - reward(2),
                ..Account::default()
            },
        );
        // Only the fee is too much.
        let tree = tree_of(&state);
        assert_eq!(
            validate_block(&PARAMS, &block, &chain[..], &state, &tree, work).map(|_| ()),
            Err(Error::Overflow)
        );
    }

    #[test]
    fn a_block_creates_at_most_50_accounts_its_reward_address_included() {
        let chain = chain(&[0]);
        let a = key(1);
        let state = Accounts::from([(
            a.address(),
            Account {
                balance: GOLD,
                ..Account::default()
            },
        )]);
        let tree = tree_of(&state);
        let txs: Vec<Tx> = (0..52)
            .map(|n| transfer(&a, n, nobody(n as u8), 1))
            .collect();
        let check = |block: &Block| {
            validate_block(&PARAMS, block, &chain[..], &state, &tree, work).map(|changes| {
                changes.accounts.len() - 1 // the sender's Account is not new
            })
        };
        let new = nobody(200);
        // 50 new recipients, the reward to the sender's Account.
        assert_eq!(
            check(&block(&chain, &state, a.address(), txs[..50].to_vec())),
            Ok(50)
        );
        // 49 and a new reward address.
        assert_eq!(
            check(&block(&chain, &state, new, txs[..49].to_vec())),
            Ok(50)
        );
        // 50 and a new reward address.
        assert_eq!(
            check(&block(&chain, &state, new, txs[..50].to_vec())),
            Err(Error::TooManyNewAccounts)
        );
        // An address counts once: the reward to a new recipient, and a new recipient paid twice.
        assert_eq!(
            check(&block(&chain, &state, nobody(0), txs[..50].to_vec())),
            Ok(50)
        );
        let again = [&txs[..50], &[transfer(&a, 50, nobody(0), 1)]].concat();
        assert_eq!(check(&block(&chain, &state, a.address(), again)), Ok(50));
        // Counted after each transaction: the 51st new recipient stops the Block before the
        // next transaction's bad signature.
        let mut block = block(&chain, &state, a.address(), txs);
        block.txs[51].signature[0] ^= 1;
        assert_eq!(check(&block), Err(Error::TooManyNewAccounts));
    }
}
