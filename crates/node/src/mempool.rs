//! The transactions a Node holds until a Block takes them, and the Block template it builds from
//! them (docs/protocols/transactions.md, "Mempool"). All of it is Node policy, not a chain rule:
//! a Block may hold any transaction the rules take.

use std::cmp::{Ordering, Reverse};
use std::collections::{BTreeMap, BinaryHeap, HashMap, HashSet};

use linked_realms_core::block::{Block, HEADER_LEN, MAX_BLOCK_SIZE, MAX_NEW_ACCOUNTS};
use linked_realms_core::params::ChainParams;
use linked_realms_core::state::{Account, State, StateView};
use linked_realms_core::tx::{Kind, Tx, apply_tx};
use linked_realms_core::{ADDRESS_LEN, Address, Error as RuleError};

use crate::{Chain, Error};

/// The smallest transaction an Account sends first: a transfer with its public key and no memo.
const FIRST_TRANSFER_LEN: u64 = 3_829;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Policy {
    /// Base units per byte a transaction pays at least.
    pub min_fee_rate: u64,
    /// A transfer that creates an Account moves at least this many base units (ADR 0015).
    pub dust: u64,
    /// By how many percent a transaction's fee rate must pass the one it replaces.
    pub replace_margin: u64,
    /// Transactions held per sender, at most.
    pub per_sender: usize,
    /// Bytes of transactions held, at most.
    pub max_bytes: usize,
}

impl Default for Policy {
    fn default() -> Self {
        Policy {
            min_fee_rate: 10,
            // What the new Account pays, at the minimum fee rate, to move it on: less is never
            // worth spending.
            dust: 10 * FIRST_TRANSFER_LEN,
            replace_margin: 10,
            per_sender: 25,
            max_bytes: 20 * MAX_BLOCK_SIZE,
        }
    }
}

/// Why the mempool does not take a transaction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refused {
    /// A chain rule refuses it on the tip, after the sender's transactions held before it.
    Rule(RuleError),
    /// One with the same id is held.
    Known,
    FeeTooLow,
    /// A transfer that creates an Account with less than the dust amount.
    Dust,
    /// Its nonce is past the next one after the sender's transactions.
    NonceGap,
    /// The sender has as many transactions held as the policy allows.
    TooMany,
    /// It has a held transaction's sender and nonce, without a fee rate higher by the margin.
    ReplacementTooCheap,
    /// The mempool is full, and it pays no more per byte than the lowest held, or it went with
    /// its sender's earlier one that paid the least.
    Full,
}

/// A fee per byte, compared exactly.
#[derive(Debug, Clone, Copy)]
struct Rate {
    fee: u64,
    size: usize,
}

impl Ord for Rate {
    fn cmp(&self, other: &Self) -> Ordering {
        let mine = u128::from(self.fee) * other.size as u128;
        mine.cmp(&(u128::from(other.fee) * self.size as u128))
    }
}

impl PartialOrd for Rate {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl PartialEq for Rate {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}

impl Eq for Rate {}

struct Held {
    tx: Tx,
    id: [u8; 32],
    size: usize,
    /// The sender's account after it.
    after: Account,
}

impl Held {
    fn rate(&self) -> Rate {
        Rate {
            fee: self.tx.fee,
            size: self.size,
        }
    }
}

pub struct Mempool {
    params: ChainParams,
    policy: Policy,
    /// The tip the transactions were checked on.
    tip: Option<[u8; 32]>,
    /// Each sender's transactions by nonce, from its nonce on the tip and without a gap.
    senders: HashMap<Address, BTreeMap<u64, Held>>,
    bytes: usize,
}

impl Mempool {
    pub fn new(params: ChainParams, policy: Policy) -> Self {
        Mempool {
            params,
            policy,
            tip: None,
            senders: HashMap::new(),
            bytes: 0,
        }
    }

    /// Takes `tx` if the policy and the chain rules do, on `state`, the accounts at the tip
    /// `follow` last saw. A transaction with a held one's sender and nonce replaces it, and the
    /// sender's later ones are checked again.
    pub fn add(&mut self, state: &impl StateView, tx: Tx) -> Result<(), Refused> {
        let size = tx.to_bytes().len();
        let id = tx.id(&self.params);
        if u128::from(tx.fee) < u128::from(self.policy.min_fee_rate) * size as u128 {
            return Err(Refused::FeeTooLow);
        }
        if let Kind::Transfer { to, amount, .. } = &tx.kind
            && *amount < self.policy.dust
            && state.account(to).is_none()
        {
            return Err(Refused::Dust);
        }
        let first = state.account(&tx.sender).map_or(0, |account| account.nonce);
        let held = self.senders.get(&tx.sender);
        let count = held.map_or(0, BTreeMap::len);
        let replaced = held.and_then(|held| held.get(&tx.nonce));
        match replaced {
            Some(old) if old.id == id => return Err(Refused::Known),
            Some(old) => {
                let margin = u128::from(100 + self.policy.replace_margin);
                let new = u128::from(tx.fee) * old.size as u128 * 100;
                if new < u128::from(old.tx.fee) * size as u128 * margin {
                    return Err(Refused::ReplacementTooCheap);
                }
            }
            None if tx.nonce > first + count as u64 => return Err(Refused::NonceGap),
            None if tx.nonce == first + count as u64 && count >= self.policy.per_sender => {
                return Err(Refused::TooMany);
            }
            None => {}
        }
        // Full: refused before its signature is checked if it would go first. A refused
        // transaction leaves the mempool as it was.
        let (me, nonce) = (tx.sender, tx.nonce);
        if self.bytes - replaced.map_or(0, |old| old.size) + size > self.policy.max_bytes {
            // ponytail: another scan of every held transaction, only when the mempool is full.
            let lowest = self
                .senders
                .iter()
                .flat_map(|(sender, held)| held.iter().map(move |(n, h)| (*sender, *n, h)))
                .filter(|(sender, n, _)| (*sender, *n) != (me, nonce))
                .map(|(_, _, held)| held.rate())
                .min();
            if lowest.is_none_or(|lowest| Rate { fee: tx.fee, size } <= lowest) {
                return Err(Refused::Full);
            }
        }
        let before = match held.and_then(|held| held.get(&tx.nonce.checked_sub(1)?)) {
            Some(previous) => Some(previous.after.clone()),
            None => state.account(&tx.sender),
        };
        let mut sender = Sender {
            base: state,
            address: tx.sender,
            account: before,
        };
        apply_tx(&self.params, &mut sender, &tx).map_err(Refused::Rule)?;
        let after = sender.account.expect("set by apply_tx");

        let address = me;
        let later = self.take_from(&address, nonce);
        let held = Held {
            tx,
            id,
            size,
            after,
        };
        self.senders.entry(address).or_default().insert(nonce, held);
        self.bytes += size;
        // Replaced: the later ones go back in on the new one, up to the first one that fails.
        for held in later.into_values().skip(1) {
            if self.add(state, held.tx).is_err() {
                break;
            }
        }
        self.evict();
        match self.senders.get(&address).and_then(|held| held.get(&nonce)) {
            Some(held) if held.id == id => Ok(()),
            _ => Err(Refused::Full),
        }
    }

    /// Checks every held transaction again on the chain's tip if it moved, with those of the
    /// Blocks the move took off the chain.
    pub fn follow<H: Fn(&[u8], &[u8; 32]) -> [u8; 32]>(
        &mut self,
        chain: &Chain<H>,
    ) -> Result<(), Error> {
        let (tip, state) = chain.state()?;
        if self.tip == Some(tip) {
            return Ok(());
        }
        let mut txs = match self.tip {
            Some(old) => chain.txs_left_since(&old)?,
            None => Vec::new(),
        };
        let held = std::mem::take(&mut self.senders);
        txs.extend(
            held.into_values()
                .flat_map(|held| held.into_values().map(|h| h.tx)),
        );
        self.tip = Some(tip);
        self.bytes = 0;
        // ponytail: checks every held signature again on each new tip; keep the account each
        // sender's transactions were checked on, to skip unchanged senders, if that shows.
        txs.sort_by_key(|tx| (tx.sender.to_bytes(), tx.nonce));
        for tx in txs {
            let _ = self.add(&state, tx);
        }
        Ok(())
    }

    /// A Block template on the chain's tip paying `reward_address` (`Chain::template`), with the
    /// held transactions by fee rate, each sender's in nonce order, up to the Block size limit.
    pub fn template<H: Fn(&[u8], &[u8; 32]) -> [u8; 32]>(
        &mut self,
        chain: &Chain<H>,
        reward_address: Address,
        now: u64,
    ) -> Result<Block, Error> {
        loop {
            self.follow(chain)?;
            let (tip, state) = chain.state()?;
            if self.tip != Some(tip) {
                continue;
            }
            let txs = self.select(&state, reward_address, MAX_BLOCK_SIZE - HEADER_LEN - 2);
            let template = chain.template(reward_address, txs, now);
            // A rule refuses what was held for a tip that moved since: choose again.
            if matches!(template, Err(Error::Rule(_))) && chain.state()?.0 != tip {
                continue;
            }
            return template;
        }
    }

    /// Greedy by fee rate: the sender whose next transaction pays the most per byte goes first.
    /// A transaction that does not fit, in bytes or in new Accounts, leaves out its sender's
    /// later ones.
    fn select(&self, state: &impl StateView, reward_address: Address, budget: usize) -> Vec<Tx> {
        // A Block creates at most `MAX_NEW_ACCOUNTS`, its reward address included.
        let mut created = HashSet::new();
        if state.account(&reward_address).is_none() {
            created.insert(reward_address);
        }
        type Next = (Rate, Reverse<[u8; ADDRESS_LEN]>, u64);
        let next = |sender: &Address, nonce: u64| -> Option<Next> {
            let held = self.senders[sender].get(&nonce)?;
            Some((held.rate(), Reverse(sender.to_bytes()), nonce))
        };
        let mut heads: BinaryHeap<Next> = self
            .senders
            .iter()
            .filter_map(|(sender, held)| next(sender, *held.keys().next()?))
            .collect();
        let (mut size, mut txs) = (0, Vec::new());
        while let Some((_, Reverse(sender), nonce)) = heads.pop() {
            let sender = Address::from_bytes(&sender).expect("a held sender");
            let held = &self.senders[&sender][&nonce];
            let creates = match &held.tx.kind {
                Kind::Transfer { to, .. }
                    if !created.contains(to) && state.account(to).is_none() =>
                {
                    Some(*to)
                }
                _ => None,
            };
            if size + held.size > budget || (creates.is_some() && created.len() >= MAX_NEW_ACCOUNTS)
            {
                continue;
            }
            size += held.size;
            created.extend(creates);
            txs.push(held.tx.clone());
            heads.extend(next(&sender, nonce + 1));
        }
        txs
    }

    /// Removes the lowest fee rate, with the sender's later transactions, until the bytes held
    /// fit. Among equal rates, the latest nonce goes first.
    fn evict(&mut self) {
        while self.bytes > self.policy.max_bytes {
            // ponytail: scans every held transaction per eviction; keep them ordered by fee
            // rate if pools grow past a few thousand.
            let (sender, nonce) = self
                .senders
                .iter()
                .flat_map(|(sender, held)| held.iter().map(move |(n, h)| (h.rate(), *sender, *n)))
                .min_by_key(|(rate, _, nonce)| (*rate, Reverse(*nonce)))
                .map(|(_, sender, nonce)| (sender, nonce))
                .expect("bytes held");
            self.take_from(&sender, nonce);
        }
    }

    /// Takes the sender's transactions from `nonce` on out of the mempool.
    fn take_from(&mut self, sender: &Address, nonce: u64) -> BTreeMap<u64, Held> {
        let Some(held) = self.senders.get_mut(sender) else {
            return BTreeMap::new();
        };
        let taken = held.split_off(&nonce);
        if held.is_empty() {
            self.senders.remove(sender);
        }
        self.bytes -= taken.values().map(|held| held.size).sum::<usize>();
        taken
    }
}

/// The tip's accounts, with the sender's as its held transactions leave it. Only the sender's
/// changes are kept: the others' accounts do not decide whether its transactions pass.
struct Sender<'a, S> {
    base: &'a S,
    address: Address,
    account: Option<Account>,
}

impl<S: StateView> StateView for Sender<'_, S> {
    fn account(&self, address: &Address) -> Option<Account> {
        match *address == self.address {
            true => self.account.clone(),
            false => self.base.account(address),
        }
    }
}

impl<S: StateView> State for Sender<'_, S> {
    fn set_account(&mut self, address: Address, account: Account) {
        if address == self.address {
            self.account = Some(account);
        }
    }
}

#[cfg(test)]
mod tests;
