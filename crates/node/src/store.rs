//! The tables of the chain database and the forms of what they hold. Each change to the chain is
//! one `redb` write transaction, so a Block is applied, or a branch is left, whole or not at all.

use linked_realms_core::block::{Block, ChainView, HEADER_LEN, Header};
use linked_realms_core::checkpoint::Checkpoint;
use linked_realms_core::codec::Reader;
use linked_realms_core::smt::{Node, SmtStore};
use linked_realms_core::state::{Account, PublicKey, State, StateView};
use linked_realms_core::u256::U256;
use linked_realms_core::{ADDRESS_LEN, Address};
use redb::{ReadableTable, StorageError, Table, TableDefinition, WriteTransaction};

use crate::Error;

/// Every stored header by its id, with the work of its branch up to it and whether a rule
/// refused it. The headers of every branch are kept.
pub const HEADERS: TableDefinition<[u8; 32], &[u8]> = TableDefinition::new("headers");
/// The best chain: the id of its Block at each height.
const HEIGHTS: TableDefinition<u64, [u8; 32]> = TableDefinition::new("height_index");
/// Block bytes by id. A Block whose body a rule may have refused only because someone changed a
/// signature has none until a good copy comes (`Chain::submit_block`).
const BLOCKS: TableDefinition<[u8; 32], &[u8]> = TableDefinition::new("blocks");
/// For each Block of the best chain, the accounts it changed as they were before it.
const UNDO: TableDefinition<[u8; 32], &[u8]> = TableDefinition::new("undo");
pub const ACCOUNTS: TableDefinition<[u8; ADDRESS_LEN], &[u8]> = TableDefinition::new("accounts");
/// The state tree's entries (`smt`) by depth and path.
const SMT: TableDefinition<[u8; 34], &[u8]> = TableDefinition::new("smt");
/// Checkpoints by height: the Block id, then the signature.
const CHECKPOINTS: TableDefinition<u64, &[u8]> = TableDefinition::new("checkpoints");
/// Where branches end: each stored Block with no stored child, as it was stored.
const TIPS: TableDefinition<[u8; 32], ()> = TableDefinition::new("tips");
/// `network`: the network id; `tip`: the id of the best chain's last Block.
pub const META: TableDefinition<&str, &[u8]> = TableDefinition::new("meta");

/// A read or a write inside a transaction failed: the disk or the file is broken, and nothing
/// the Node would do next can be trusted.
pub fn db<T>(result: Result<T, StorageError>) -> T {
    result.expect("the chain database failed")
}

/// Bytes this Node wrote, read back.
fn ours<T>(result: Result<T, linked_realms_core::Error>) -> T {
    result.expect("bytes the Node stored")
}

#[derive(Debug, Clone, Copy)]
pub struct Stored {
    pub header: Header,
    /// The work of the branch from the genesis to this Block.
    pub work: U256,
    /// A rule refused this Block. Its descendants are refused when a walk meets it.
    pub refused: bool,
}

impl Stored {
    fn to_bytes(self) -> Vec<u8> {
        let mut bytes = self.header.to_bytes().to_vec();
        bytes.extend_from_slice(&self.work.to_be_bytes());
        bytes.push(u8::from(self.refused));
        bytes
    }

    fn from_bytes(bytes: &[u8]) -> Stored {
        let (header, rest) = bytes.split_at(HEADER_LEN);
        let (work, refused) = rest.split_at(32);
        Stored {
            header: ours(Header::from_bytes(header)),
            work: U256::from_be_bytes(work.try_into().expect("32 bytes")),
            refused: refused == [1],
        }
    }
}

pub fn stored_header(
    headers: &impl ReadableTable<[u8; 32], &'static [u8]>,
    id: &[u8; 32],
) -> Option<Stored> {
    db(headers.get(id)).map(|bytes| Stored::from_bytes(bytes.value()))
}

pub fn tip_id(meta: &impl ReadableTable<&'static str, &'static [u8]>) -> [u8; 32] {
    let tip = db(meta.get("tip")).expect("a tip");
    tip.value().try_into().expect("32 bytes")
}

/// `balance ‖ nonce`, then the key's scheme and bytes if it has one.
fn account_bytes(account: &Account) -> Vec<u8> {
    let mut bytes = account.balance.to_be_bytes().to_vec();
    bytes.extend_from_slice(&account.nonce.to_be_bytes());
    if let Some(key) = &account.key {
        bytes.push(key.scheme);
        bytes.extend_from_slice(&key.bytes);
    }
    bytes
}

fn read_account(bytes: &[u8]) -> Account {
    let (numbers, key) = bytes.split_at(16);
    let (balance, nonce) = numbers.split_at(8);
    Account {
        balance: u64::from_be_bytes(balance.try_into().expect("8 bytes")),
        nonce: u64::from_be_bytes(nonce.try_into().expect("8 bytes")),
        key: key.split_first().map(|(&scheme, bytes)| PublicKey {
            scheme,
            bytes: bytes.to_vec(),
        }),
    }
}

/// The accounts table, read from any transaction and written in a write transaction.
pub struct Accounts<T>(pub T);

impl<T: ReadableTable<[u8; ADDRESS_LEN], &'static [u8]>> StateView for Accounts<T> {
    fn account(&self, address: &Address) -> Option<Account> {
        db(self.0.get(address.to_bytes())).map(|bytes| read_account(bytes.value()))
    }
}

impl State for Accounts<Table<'_, [u8; ADDRESS_LEN], &'static [u8]>> {
    fn set_account(&mut self, address: Address, account: Account) {
        db(self
            .0
            .insert(address.to_bytes(), account_bytes(&account).as_slice()));
    }
}

impl Accounts<Table<'_, [u8; ADDRESS_LEN], &'static [u8]>> {
    /// Only undoing a Block removes an account.
    pub fn remove(&mut self, address: &Address) {
        db(self.0.remove(address.to_bytes()));
    }
}

/// The state tree's entries.
pub struct Tree<'t>(pub Table<'t, [u8; 34], &'static [u8]>);

fn tree_position(depth: u16, path: &[u8; 32]) -> [u8; 34] {
    let mut position = [0; 34];
    position[..2].copy_from_slice(&depth.to_be_bytes());
    position[2..].copy_from_slice(path);
    position
}

impl SmtStore for Tree<'_> {
    fn node(&self, depth: u16, path: &[u8; 32]) -> Option<Node> {
        let bytes = db(self.0.get(tree_position(depth, path)))?;
        let mut reader = Reader::new(bytes.value());
        let node = match ours(reader.u8()) {
            0 => Node::Leaf {
                key: ours(reader.array()),
                leaf: ours(reader.array()),
                hash: ours(reader.array()),
            },
            _ => Node::Inner {
                hash: ours(reader.array()),
                split: ours(reader.u16()),
                branch: ours(reader.array()),
            },
        };
        Some(node)
    }

    fn set_node(&mut self, depth: u16, path: [u8; 32], node: Option<Node>) {
        let position = tree_position(depth, &path);
        let bytes = match node {
            None => return drop(db(self.0.remove(position))),
            Some(Node::Leaf { key, leaf, hash }) => [&[0][..], &key, &leaf, &hash].concat(),
            Some(Node::Inner {
                hash,
                split,
                branch,
            }) => [&[1][..], &hash, &split.to_be_bytes(), &branch].concat(),
        };
        db(self.0.insert(position, bytes.as_slice()));
    }
}

/// An undo record: how many addresses the Block changed, then each with its account before the
/// Block, if it had one.
fn undo_bytes(before: &[(Address, Option<Account>)]) -> Vec<u8> {
    let count = u32::try_from(before.len()).expect("a Block's changes fit");
    let mut bytes = count.to_be_bytes().to_vec();
    for (address, account) in before {
        bytes.extend_from_slice(&address.to_bytes());
        if let Some(account) = account {
            let account = account_bytes(account);
            let len = u16::try_from(account.len()).expect("an account fits");
            bytes.extend_from_slice(&len.to_be_bytes());
            bytes.extend_from_slice(&account);
        } else {
            bytes.extend_from_slice(&[0, 0]);
        }
    }
    bytes
}

fn read_undo(bytes: &[u8]) -> Vec<(Address, Option<Account>)> {
    let mut reader = Reader::new(bytes);
    let count = ours(reader.u32());
    let mut before = Vec::new();
    for _ in 0..count {
        let address = ours(reader.address());
        // An account is at least 16 bytes, so a length of 0 is no account.
        let account = match ours(reader.u16()) {
            0 => None,
            len => Some(read_account(ours(reader.bytes(len.into())))),
        };
        before.push((address, account));
    }
    before
}

/// Every table, open in one write transaction.
pub struct Tables<'t> {
    pub headers: Table<'t, [u8; 32], &'static [u8]>,
    heights: Table<'t, u64, [u8; 32]>,
    blocks: Table<'t, [u8; 32], &'static [u8]>,
    undo: Table<'t, [u8; 32], &'static [u8]>,
    pub accounts: Accounts<Table<'t, [u8; ADDRESS_LEN], &'static [u8]>>,
    pub tree: Tree<'t>,
    checkpoints: Table<'t, u64, &'static [u8]>,
    tips: Table<'t, [u8; 32], ()>,
    pub meta: Table<'t, &'static str, &'static [u8]>,
}

impl<'t> Tables<'t> {
    pub fn open(txn: &'t WriteTransaction) -> Result<Self, Error> {
        Ok(Tables {
            headers: txn.open_table(HEADERS)?,
            heights: txn.open_table(HEIGHTS)?,
            blocks: txn.open_table(BLOCKS)?,
            undo: txn.open_table(UNDO)?,
            accounts: Accounts(txn.open_table(ACCOUNTS)?),
            tree: Tree(txn.open_table(SMT)?),
            checkpoints: txn.open_table(CHECKPOINTS)?,
            tips: txn.open_table(TIPS)?,
            meta: txn.open_table(META)?,
        })
    }

    /// Starts an empty database from `genesis` on the network `network_id`, or checks that it
    /// holds that chain.
    pub fn start(&mut self, network_id: u32, genesis: &Block) -> Result<(), Error> {
        let id = genesis.header.id();
        match self.best(0) {
            None => {
                let stored = Stored {
                    header: genesis.header,
                    work: U256::ZERO,
                    refused: false,
                };
                self.put_header(&id, stored);
                self.put_block(&id, genesis);
                self.set_best(0, &id);
                self.set_tip(&id);
                db(self
                    .meta
                    .insert("network", network_id.to_be_bytes().as_slice()));
                Ok(())
            }
            Some(genesis_id) => {
                let network = db(self.meta.get("network")).map(|bytes| bytes.value().to_vec());
                match genesis_id == id && network == Some(network_id.to_be_bytes().to_vec()) {
                    true => Ok(()),
                    false => Err(Error::OtherNetwork),
                }
            }
        }
    }

    pub fn header(&self, id: &[u8; 32]) -> Option<Stored> {
        stored_header(&self.headers, id)
    }

    pub fn put_header(&mut self, id: &[u8; 32], stored: Stored) {
        db(self.headers.insert(id, stored.to_bytes().as_slice()));
    }

    /// Stores a Block of any branch whose header is stored, as a branch's new end.
    pub fn put_block(&mut self, id: &[u8; 32], block: &Block) {
        db(self.blocks.insert(id, block.to_bytes().as_slice()));
        db(self.tips.remove(block.header.prev_id));
        db(self.tips.insert(id, ()));
    }

    pub fn block(&self, id: &[u8; 32]) -> Option<Block> {
        db(self.blocks.get(id)).map(|bytes| ours(Block::from_bytes(bytes.value())))
    }

    pub fn has_block(&self, id: &[u8; 32]) -> bool {
        db(self.blocks.get(id)).is_some()
    }

    pub fn remove_block(&mut self, id: &[u8; 32]) {
        db(self.blocks.remove(id));
    }

    pub fn tips(&self) -> Vec<[u8; 32]> {
        db(self.tips.iter())
            .map(|entry| db(entry).0.value())
            .collect()
    }

    /// The id of the best chain's Block at `height`.
    pub fn best(&self, height: u64) -> Option<[u8; 32]> {
        db(self.heights.get(height)).map(|id| id.value())
    }

    pub fn on_best_chain(&self, id: &[u8; 32], height: u64) -> bool {
        self.best(height) == Some(*id)
    }

    pub fn set_best(&mut self, height: u64, id: &[u8; 32]) {
        db(self.heights.insert(height, id));
    }

    /// Takes the best chain's last Block off it, with its undo record.
    pub fn pop_best(&mut self, height: u64) -> ([u8; 32], Vec<(Address, Option<Account>)>) {
        let id = db(self.heights.remove(height)).expect("a Block").value();
        let undo = db(self.undo.remove(id)).expect("an undo record");
        (id, read_undo(undo.value()))
    }

    pub fn put_undo(&mut self, id: &[u8; 32], before: &[(Address, Option<Account>)]) {
        db(self.undo.insert(id, undo_bytes(before).as_slice()));
    }

    pub fn tip(&self) -> [u8; 32] {
        tip_id(&self.meta)
    }

    pub fn set_tip(&mut self, id: &[u8; 32]) {
        db(self.meta.insert("tip", id.as_slice()));
    }

    pub fn put_checkpoint(&mut self, height: u64, record: &[u8]) {
        db(self.checkpoints.insert(height, record));
    }

    /// The highest Checkpoint taken.
    pub fn latest_checkpoint(&self) -> Option<Checkpoint> {
        db(self.checkpoints.last()).map(|(height, record)| {
            let (id, signature) = record.value().split_at(32);
            Checkpoint {
                height: height.value(),
                block_id: id.try_into().expect("32 bytes"),
                signature: signature.try_into().expect("a signature"),
            }
        })
    }

    /// The height and Block id of the highest Checkpoint at or below `height`.
    pub fn checkpoint_at_or_below(&self, height: u64) -> Option<(u64, [u8; 32])> {
        let last = db(self.checkpoints.range(..=height)).next_back();
        db(last.transpose()).map(|(height, record)| {
            let id = record.value()[..32].try_into().expect("32 bytes");
            (height.value(), id)
        })
    }
}

/// The chain a Block extends, for `block::check_block`: the headers of its branch above the best
/// chain, then the best chain below them.
pub struct Branch<'a, 't> {
    tables: &'a Tables<'t>,
    /// The branch's own headers, lowest first, from just above `fork`.
    side: Vec<Header>,
    fork: u64,
    tip: u64,
}

impl<'a, 't> Branch<'a, 't> {
    /// The branch that ends with the stored Block `tip_id`. Refused if a rule refused one of its
    /// Blocks.
    pub fn new(tables: &'a Tables<'t>, tip_id: &[u8; 32]) -> Result<Self, Error> {
        let mut side = Vec::new();
        let mut id = *tip_id;
        let fork = loop {
            let stored = tables.header(&id).expect("a stored ancestor");
            if stored.refused {
                return Err(Error::RefusedBranch);
            }
            if tables.on_best_chain(&id, stored.header.height) {
                break stored.header.height;
            }
            side.push(stored.header);
            id = stored.header.prev_id;
        };
        side.reverse();
        Ok(Branch {
            tables,
            tip: fork + side.len() as u64,
            side,
            fork,
        })
    }
}

impl ChainView for Branch<'_, '_> {
    fn tip_height(&self) -> u64 {
        self.tip
    }

    fn header(&self, height: u64) -> Header {
        match height.checked_sub(self.fork + 1) {
            Some(i) => self.side[i as usize],
            None => {
                let id = self.tables.best(height).expect("a Block at every height");
                self.tables.header(&id).expect("a stored header").header
            }
        }
    }
}
