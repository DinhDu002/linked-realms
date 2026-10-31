//! The chain a Node follows (docs/protocols/blocks.md). A Block of any branch is stored once
//! `block::check_block` passes on its branch; its accounts are checked only when its branch
//! becomes the best. The best branch has the most work among the branches that hold the highest
//! Checkpoint any branch holds, and no branch counts past a Checkpoint it contradicts. Moving to
//! another branch undoes Blocks back to where the branches part, then applies the other
//! branch's, in one write transaction: a Block a rule refuses on the way leaves the chain as it
//! was.
//!
//! A pruning Node drops the bodies and undo records of the Blocks far enough below the
//! Checkpoint its best chain holds, and every Node drops the bodies of branches that can never
//! be the best. A Node far behind starts from a state snapshot at a Checkpoint instead of the
//! Blocks below it (docs/plans/phase-2c-the-chain.md, "A Node joining the network").

use std::collections::HashMap;
use std::ops::Bound;
use std::path::Path;

use linked_realms_core::Address;
use linked_realms_core::Error as RuleError;
use linked_realms_core::block::{
    Block, ChainView, Header, check_block, check_header, check_on_accounts, median_time_past,
    state_root_after,
};
use linked_realms_core::checkpoint::{Checkpoint, verify_checkpoint};
use linked_realms_core::merkle::tx_root;
use linked_realms_core::params::ChainParams;
use linked_realms_core::retarget::{next_target, work};
use linked_realms_core::smt;
use linked_realms_core::state::{Account, State, StateView, tree_key};
use linked_realms_core::tx::Tx;
use linked_realms_core::u256::U256;
use redb::{Database, ReadableDatabase, ReadableTable};

use crate::Error;
use crate::store::{
    ACCOUNTS, Accounts, Branch, HEADERS, META, Recent, Stored, Tables, db, entry_bytes, read_entry,
    stored_header, tip_id,
};

/// Blocks a pruning Node keeps below the Checkpoint its best chain holds, about a day of them; and
/// how far below it any Node serves a state snapshot, so each stays a bounded amount of work.
pub const KEEP_BELOW_CHECKPOINT: u64 = 1_440;

/// A part of a state snapshot: accounts in the tree's key order, and whether more follow.
pub type SnapshotPart = (Vec<(Address, Account)>, bool);

pub struct Chain<H> {
    db: Database,
    params: ChainParams,
    hash: H,
    /// Blocks kept below the Checkpoint the best chain holds, if this Node prunes.
    keep: Option<u64>,
    /// Fails every move to another branch just before its commit.
    #[cfg(test)]
    fail_moves: std::cell::Cell<bool>,
}

/// Why a move to another branch stopped.
enum Stop {
    /// A rule refused this Block's accounts.
    Refused([u8; 32], RuleError),
    Failed(Error),
}

impl From<Error> for Stop {
    fn from(error: Error) -> Self {
        Stop::Failed(error)
    }
}

impl<H: Fn(&[u8], &[u8; 32]) -> [u8; 32]> Chain<H> {
    /// Opens the chain database at `path`, or creates it with the genesis of `params`, then
    /// finishes a move a stop interrupted. `hash(header bytes, key)` is the Proof-of-Work hash,
    /// as for `block::validate_block`.
    pub fn open(path: impl AsRef<Path>, params: ChainParams, hash: H) -> Result<Self, Error> {
        let chain = Chain {
            db: Database::create(path)?,
            params,
            hash,
            keep: None,
            #[cfg(test)]
            fail_moves: Default::default(),
        };
        let genesis = Block {
            header: chain.params.genesis(),
            txs: Vec::new(),
        };
        chain.write(|t| t.start(chain.params.network_id, &genesis))?;
        chain.follow_best()?;
        // A state snapshot being taken does not outlive the Node that took it.
        chain.begin_snapshot()?;
        Ok(chain)
    }

    /// Makes this Node prune, keeping `keep` Blocks below the Checkpoint its best chain holds,
    /// from its next move on. A Node that does not is an archive.
    pub fn pruning(mut self, keep: u64) -> Self {
        self.keep = Some(keep);
        self
    }

    pub fn keep(&self) -> Option<u64> {
        self.keep
    }

    /// The best chain's last header.
    pub fn tip(&self) -> Result<Header, Error> {
        let txn = self.db.begin_read()?;
        let id = tip_id(&txn.open_table(META)?);
        Ok(stored_header(&txn.open_table(HEADERS)?, &id)
            .expect("a stored tip")
            .header)
    }

    /// Ids of the best chain, from the tip down: the last 10, then steps that double, then the
    /// genesis. Another Node finds where its chain and this one part with them.
    pub fn locator(&self) -> Result<Vec<[u8; 32]>, Error> {
        self.read(|t| {
            let tip = t.header(&t.tip()).expect("a stored tip").header.height;
            let (mut ids, mut height, mut step) = (Vec::new(), tip, 1);
            loop {
                ids.push(t.best(height).expect("a Block at every height"));
                if height == 0 {
                    return Ok(ids);
                }
                if ids.len() >= 10 {
                    step *= 2;
                }
                height = height.saturating_sub(step);
            }
        })
    }

    /// Up to `max` headers of the best chain after the first id of `locator` it holds, or after
    /// the genesis if it holds none.
    pub fn headers_after(&self, locator: &[[u8; 32]], max: u64) -> Result<Vec<Header>, Error> {
        self.read(|t| {
            let from = locator
                .iter()
                .filter_map(|id| Some((id, t.header(id)?.header.height)))
                .find(|(id, height)| t.on_best_chain(id, *height))
                .map_or(0, |(_, height)| height);
            let tip = t.header(&t.tip()).expect("a stored tip").header.height;
            Ok((from + 1..=tip.min(from.saturating_add(max)))
                .map(|height| {
                    let id = t.best(height).expect("a Block at every height");
                    t.header(&id).expect("a stored header").header
                })
                .collect())
        })
    }

    /// The stored Block `id`, if this Node has its body.
    pub fn block(&self, id: &[u8; 32]) -> Result<Option<Block>, Error> {
        self.read(|t| Ok(t.block(id)))
    }

    pub fn has_header(&self, id: &[u8; 32]) -> Result<bool, Error> {
        self.read(|t| Ok(t.header(id).is_some()))
    }

    /// The ids of `ids` whose Block this Node does not have the body of.
    pub fn missing(&self, ids: &[[u8; 32]]) -> Result<Vec<[u8; 32]>, Error> {
        self.read(|t| Ok(ids.iter().filter(|id| t.needs_body(id)).copied().collect()))
    }

    /// The highest Checkpoint taken.
    pub fn latest_checkpoint(&self) -> Result<Option<Checkpoint>, Error> {
        self.read(|t| Ok(t.latest_checkpoint()))
    }

    /// `address`'s account at the best chain's tip.
    pub fn account(&self, address: &Address) -> Result<Option<Account>, Error> {
        let txn = self.db.begin_read()?;
        Ok(Accounts(txn.open_table(ACCOUNTS)?).account(address))
    }

    /// The best chain's tip id and its accounts, read at the same moment.
    pub fn state(&self) -> Result<([u8; 32], impl StateView + use<H>), Error> {
        let txn = self.db.begin_read()?;
        let id = tip_id(&txn.open_table(META)?);
        Ok((id, Accounts(txn.open_table(ACCOUNTS)?)))
    }

    /// The transactions of the Blocks that the branch ending with `old_tip` holds above the best
    /// chain: what a move to another branch took off it, lowest first. None for an unknown id.
    pub fn txs_left_since(&self, old_tip: &[u8; 32]) -> Result<Vec<Tx>, Error> {
        self.read(|t| {
            let mut blocks = Vec::new();
            let mut id = *old_tip;
            while let Some(stored) = t.header(&id) {
                if t.on_best_chain(&id, stored.header.height) {
                    break;
                }
                // Gone if a state snapshot or pruning dropped the branch: its transactions too.
                blocks.extend(t.block(&id));
                id = stored.header.prev_id;
            }
            Ok(blocks
                .into_iter()
                .rev()
                .flat_map(|block| block.txs)
                .collect())
        })
    }

    /// A Block on the best chain's tip paying `reward_address`, with `txs` in this order and its
    /// Proof of Work not done (`nonce` 0). Its timestamp is `now`, or the earliest the rules
    /// allow if that is later. Refused if a rule but the Proof of Work refuses it on the tip.
    pub fn template(
        &self,
        reward_address: Address,
        txs: Vec<Tx>,
        now: u64,
    ) -> Result<Block, Error> {
        self.read(|t| {
            let tip = t.tip();
            let chain = Branch::new(t, &tip)?;
            let height = chain.tip_height() + 1;
            let ids: Vec<_> = txs.iter().map(|tx| tx.id(&self.params)).collect();
            let mut block = Block {
                header: Header {
                    height,
                    prev_id: tip,
                    timestamp: now.max(median_time_past(&chain, height) + 1),
                    target: next_target(&self.params, height, |j| {
                        let header = chain.header(j);
                        (header.timestamp, header.target)
                    }),
                    tx_root: tx_root(&ids),
                    state_root: [0; 32],
                    reward_address,
                    nonce: 0,
                },
                txs,
            };
            check_block(&self.params, &block, &chain, |_, _| [0; 32]).map_err(Error::Rule)?;
            block.header.state_root = state_root_after(&self.params, &block, &t.accounts, &t.tree)
                .map_err(Error::Rule)?;
            Ok(block)
        })
    }

    /// Stores `block` if `block::check_block` passes on the branch it extends, then follows the
    /// best branch. `Ok` means stored, not on the best chain. Refused if its parent is not stored
    /// (`UnknownParent`) or is on a refused branch (`RefusedBranch`), or if a rule refuses it now
    /// or when its branch is tried (`Rule`).
    pub fn submit_block(&self, block: &Block) -> Result<(), Error> {
        let id = block.header.id();
        let stored = self.write(|t| {
            if t.header(&id).is_some() {
                // Refused if a rule refused it or a Block below it.
                Branch::new(t, &id)?;
                if !t.needs_body(&id) {
                    return Ok(false);
                }
            }
            if block.header.height == 0 {
                return Err(Error::Rule(RuleError::WrongGenesis));
            }
            let parent = t
                .header(&block.header.prev_id)
                .ok_or(Error::UnknownParent)?;
            let branch = Branch::new(t, &block.header.prev_id)?;
            check_block(&self.params, block, &branch, &self.hash).map_err(Error::Rule)?;
            let stored = Stored {
                header: block.header,
                work: parent.work.saturating_add(work(block.header.target)),
                refused: false,
            };
            t.put_header(&id, stored);
            t.put_block(&id, block);
            Ok(true)
        })?;
        if !stored {
            return Ok(());
        }
        match self.follow_best()?.into_iter().find(|(r, _)| *r == id) {
            Some((_, error)) => Err(Error::Rule(error)),
            None => Ok(()),
        }
    }

    /// Stores `headers`, each the child of the one before it and the first the child of a stored
    /// header, if `block::check_header` passes on each, without their Blocks: how a Node that
    /// starts from a state snapshot takes the headers below its Checkpoint. Refused as
    /// `submit_block` is; one refused stores none.
    pub fn submit_headers(&self, headers: &[Header]) -> Result<(), Error> {
        let Some(first) = headers.first() else {
            return Ok(());
        };
        self.write(|t| {
            if t.header(&first.prev_id).is_none() {
                return Err(Error::UnknownParent);
            }
            let mut chain = Recent::new(t, &first.prev_id)?;
            let mut prev = first.prev_id;
            for header in headers {
                // A stored header is not checked again, so its place in the batch is.
                if header.prev_id != prev {
                    return Err(Error::Rule(RuleError::WrongParent));
                }
                let id = header.id();
                match t.header(&id) {
                    Some(stored) if stored.refused => return Err(Error::RefusedBranch),
                    Some(_) => {}
                    None => {
                        check_header(&self.params, header, &chain, &self.hash)
                            .map_err(Error::Rule)?;
                        let parent = t.header(&header.prev_id).expect("its parent, checked");
                        let stored = Stored {
                            header: *header,
                            work: parent.work.saturating_add(work(header.target)),
                            refused: false,
                        };
                        t.put_header(&id, stored);
                    }
                }
                chain.push(*header);
                prev = id;
            }
            Ok(())
        })
    }

    /// Up to `max` accounts of the state at the Checkpoint at `height`, in the tree's key order,
    /// after the key `after` if given, and whether more follow. `None` unless the best chain holds
    /// that Checkpoint, at or above what this Node pruned and at most `KEEP_BELOW_CHECKPOINT`
    /// below the highest one it holds.
    // ponytail: the accounts as they were are read back from the undo records of every Block
    // above `height`, for each part, and a peer may ask for parts as fast as it likes: at most
    // about 1,450 undo records a part, a few with empty Blocks. Keep them between parts, or
    // limit each peer's asks, if serving snapshots shows.
    pub fn snapshot(
        &self,
        height: u64,
        after: Option<[u8; 32]>,
        max: usize,
    ) -> Result<Option<SnapshotPart>, Error> {
        self.read(|t| {
            let checkpointed = matches!(t.checkpoint_at_or_below(height),
                Some((at, id)) if at == height && t.on_best_chain(&id, at));
            let far_below = height + KEEP_BELOW_CHECKPOINT < t.held_checkpoint();
            if !checkpointed || height < t.pruned() || far_below {
                return Ok(None);
            }
            // The accounts the Blocks above `height` changed, as they were at it: `None` for one
            // created since. The lowest Block's record is the one that stays.
            let tip = t.header(&t.tip()).expect("a stored tip").header.height;
            let mut then = HashMap::new();
            for above in (height + 1..=tip).rev() {
                let id = t.best(above).expect("a Block at every height");
                then.extend(t.undo_record(&id));
            }
            let from = after.map_or(Bound::Unbounded, Bound::Excluded);
            let mut accounts = Vec::new();
            for entry in db(t.accounts.0.range((from, Bound::Unbounded))) {
                let (address, account) = read_entry(db(entry).1.value());
                let Some(account) = then.get(&address).cloned().unwrap_or(Some(account)) else {
                    continue;
                };
                if accounts.len() == max {
                    return Ok(Some((accounts, true)));
                }
                accounts.push((address, account));
            }
            Ok(Some((accounts, false)))
        })
    }

    /// Starts taking a state snapshot, dropping any part of one taken before.
    pub fn begin_snapshot(&self) -> Result<(), Error> {
        self.write(|t| {
            db(t.snapshot.retain(|_, _| false));
            Ok(())
        })
    }

    /// Takes the next part of a state snapshot. Refused (`SnapshotOrder`) if its accounts do not
    /// follow those taken in the tree's key order, each key once, and then the snapshot is
    /// dropped.
    pub fn add_snapshot(&self, accounts: &[(Address, Account)]) -> Result<(), Error> {
        let taken = self.write(|t| {
            let mut last = db(t.snapshot.last()).map(|(key, _)| key.value());
            for (address, account) in accounts {
                let key = tree_key(address);
                if last.is_some_and(|last| key <= last) {
                    return Err(Error::Rule(RuleError::SnapshotOrder));
                }
                db(t.snapshot
                    .insert(key, entry_bytes(address, account).as_slice()));
                last = Some(key);
            }
            Ok(())
        });
        if taken.is_err() {
            self.begin_snapshot()?;
        }
        taken
    }

    /// Checks the state snapshot taken against the state root of the Block the Checkpoint at
    /// `height` names, whose header must be stored. If it holds, its accounts replace this Node's
    /// and that Block becomes the tip, with the Blocks below it and none of their bodies, then
    /// the Node follows the best branch. Refused (`WrongStateRoot`) otherwise, and nothing but
    /// the snapshot changes. Either way the snapshot is dropped.
    pub fn finish_snapshot(&self, height: u64) -> Result<(), Error> {
        let taken = self.write(|t| {
            let (_, id) = t
                .checkpoint_at_or_below(height)
                .filter(|(at, _)| *at == height)
                .expect("a Checkpoint at the snapshot's height");
            let root = t
                .header(&id)
                .expect("the Checkpoint's header")
                .header
                .state_root;
            db(t.accounts.0.retain(|_, _| false));
            db(t.tree.0.retain(|_, _| false));
            for entry in db(t.snapshot.iter()) {
                let (key, value) = db(entry);
                db(t.accounts.0.insert(key.value(), value.value()));
            }
            let leaves = db(t.accounts.0.iter()).map(|entry| {
                let (key, value) = db(entry);
                let (address, account) = read_entry(value.value());
                (key.value(), account.hashed_bytes(&address).to_vec())
            });
            smt::check_snapshot(&mut t.tree, leaves, &root).map_err(Error::Rule)?;
            // The Blocks of the best chain go, then the Checkpoint's Block and those below it
            // are the best chain: none of them is ever undone.
            let tip = t.header(&t.tip()).expect("a stored tip").header.height;
            for below in (1..=tip).rev() {
                let old = t.drop_best(below);
                t.remove_block(&old);
            }
            let mut on = id;
            while let Some(stored) = t.header(&on).filter(|s| s.header.height > 0) {
                t.set_best(stored.header.height, &on);
                on = stored.header.prev_id;
            }
            t.set_tip(&id);
            t.set_pruned(height);
            db(t.snapshot.retain(|_, _| false));
            Ok::<_, Error>(())
        });
        match taken {
            Ok(()) => self.follow_best().map(drop),
            Err(error) => {
                self.begin_snapshot()?;
                Err(error)
            }
        }
    }

    /// Takes `checkpoint` if the Checkpoint signer signed it, then follows the best branch.
    pub fn add_checkpoint(&self, checkpoint: &Checkpoint) -> Result<(), Error> {
        verify_checkpoint(&self.params, checkpoint).map_err(Error::Rule)?;
        // Every branch starts at the genesis: a Checkpoint that names another leaves none.
        if checkpoint.height == 0 && checkpoint.block_id != self.params.genesis().id() {
            return Err(Error::Rule(RuleError::WrongGenesis));
        }
        let record = [&checkpoint.block_id[..], &checkpoint.signature].concat();
        self.write(|t| {
            t.put_checkpoint(checkpoint.height, &record);
            Ok::<_, Error>(())
        })?;
        self.follow_best()?;
        Ok(())
    }

    /// Runs `change` in one write transaction, committed only if it succeeds.
    fn write<T, E: From<Error>>(
        &self,
        change: impl FnOnce(&mut Tables) -> Result<T, E>,
    ) -> Result<T, E> {
        let txn = self.db.begin_write().map_err(Error::from)?;
        let done = change(&mut Tables::open(&txn)?)?;
        txn.commit().map_err(Error::from)?;
        Ok(done)
    }

    /// Runs `look` on the tables, then drops what it would change.
    // ponytail: a write transaction for one view of every table, so it holds the writer for as
    // long as `look` runs (a template's signature checks); add read-only tables if that shows.
    fn read<T>(&self, look: impl FnOnce(&Tables) -> Result<T, Error>) -> Result<T, Error> {
        let txn = self.db.begin_write()?;
        let seen = look(&Tables::open(&txn)?);
        txn.abort()?;
        seen
    }

    /// Moves to the best branch. A Block a rule refuses on the way is marked and the choice made
    /// again without it; they come back with the rule's error.
    fn follow_best(&self) -> Result<Vec<([u8; 32], RuleError)>, Error> {
        let mut refused = Vec::new();
        loop {
            match self.write(|t| {
                self.move_to_best(t)?;
                self.prune(t);
                Ok(())
            }) {
                Ok(()) => return Ok(refused),
                Err(Stop::Failed(error)) => return Err(error),
                Err(Stop::Refused(id, error)) => {
                    self.write(|t| {
                        // A transaction's id leaves out its signature, so the header does not
                        // fix the signatures: a changed one refuses this copy, not the Block.
                        if error == RuleError::BadSignature {
                            t.remove_block(&id);
                        } else {
                            let stored = t.header(&id).expect("a stored header");
                            t.put_header(
                                &id,
                                Stored {
                                    refused: true,
                                    ..stored
                                },
                            );
                        }
                        Ok::<_, Error>(())
                    })?;
                    refused.push((id, error));
                }
            }
        }
    }

    fn move_to_best(&self, t: &mut Tables) -> Result<(), Stop> {
        let (target, tip) = (best_candidate(t), t.tip());
        if target == tip {
            return Ok(());
        }
        // The target's Blocks above the best chain, lowest first, and where they leave it.
        let mut side = Vec::new();
        let mut id = target;
        let fork = loop {
            let stored = t.header(&id).expect("a stored header");
            if t.on_best_chain(&id, stored.header.height) {
                break stored;
            }
            side.push(id);
            id = stored.header.prev_id;
        };
        if fork.header.height < t.pruned() {
            return Err(Stop::Failed(Error::Pruned));
        }
        let tip_height = t.header(&tip).expect("a stored tip").header.height;
        for height in (fork.header.height + 1..=tip_height).rev() {
            undo(t, height);
        }
        debug_assert_eq!(smt::root(&t.tree), fork.header.state_root);
        for id in side.into_iter().rev() {
            let block = t.block(&id).expect("a candidate has every body");
            apply(&self.params, t, &id, &block).map_err(|error| Stop::Refused(id, error))?;
        }
        t.set_tip(&target);
        #[cfg(test)]
        if self.fail_moves.get() {
            let injected = std::io::Error::other("injected before the commit");
            return Err(Stop::Failed(Error::Storage(injected.into())));
        }
        Ok(())
    }

    /// Drops the bodies and undo records of the best chain's Blocks more than `keep` below the
    /// Checkpoint it holds, if this Node prunes, and the bodies of branches that can never be
    /// the best: one that parts from the best chain below that Checkpoint, and every Block from
    /// a branch's end down to the lowest one a rule refused.
    fn prune(&self, t: &mut Tables) {
        let held = t.held_checkpoint();
        if let Some(keep) = self.keep {
            let (pruned, below) = (t.pruned(), held.saturating_sub(keep));
            for height in pruned + 1..=below {
                let id = t.best(height).expect("a Block at every height");
                t.remove_block(&id);
                t.remove_undo(&id);
            }
            if below > pruned {
                t.set_pruned(below);
            }
        }
        for end in t.tips() {
            // The branch's Blocks above the best chain, from its end down.
            let (mut walked, mut refused, mut id) = (Vec::new(), None, end);
            let fork = loop {
                let stored = t.header(&id).expect("a stored header");
                if t.on_best_chain(&id, stored.header.height) {
                    break stored.header.height;
                }
                if stored.refused {
                    refused = Some(walked.len());
                }
                walked.push(id);
                id = stored.header.prev_id;
            };
            let dead = match (fork < held, refused) {
                (true, _) => walked.len(),
                (false, Some(lowest)) => lowest + 1,
                (false, None) => continue,
            };
            walked[..dead].iter().for_each(|id| t.remove_block(id));
            t.remove_tip(&end);
            // What lies below a refused Block may still become the best.
            if let Some(below) = walked.get(dead) {
                t.add_tip(below);
            }
        }
    }
}

/// Applies the stored Block `id` on the best chain's tip, recording what it changes.
fn apply(
    params: &ChainParams,
    t: &mut Tables,
    id: &[u8; 32],
    block: &Block,
) -> Result<(), RuleError> {
    let changes = check_on_accounts(params, block, &t.accounts, &t.tree)?;
    let before: Vec<_> = changes
        .accounts
        .keys()
        .map(|address| (*address, t.accounts.account(address)))
        .collect();
    changes.apply(&mut t.accounts, &mut t.tree);
    t.put_undo(id, &before);
    t.set_best(block.header.height, id);
    Ok(())
}

/// Takes the Block at `height`, the best chain's last, off it. The tree's entries depend only on
/// its keys, so setting each account back rebuilds them as they were.
fn undo(t: &mut Tables, height: u64) {
    let (_, before) = t.pop_best(height);
    for (address, account) in before {
        let key = tree_key(&address);
        match account {
            Some(account) => {
                smt::insert(&mut t.tree, &key, &account.hashed_bytes(&address));
                t.accounts.set_account(address, account);
            }
            None => {
                smt::remove(&mut t.tree, &key);
                t.accounts.remove(&address);
            }
        }
    }
}

/// The Block the best branch ends with. Each branch ends below its lowest Block that a rule
/// refused or that has no body, and below each Checkpoint's height at which it holds another
/// Block. Branches that hold a higher Checkpoint's Block come first, then the most work; a tie
/// keeps the tip.
fn best_candidate(t: &Tables) -> [u8; 32] {
    let candidate = |end: [u8; 32]| -> (u64, U256, [u8; 32]) {
        let mut usable = end;
        let mut id = end;
        loop {
            let stored = t.header(&id).expect("a stored header");
            if t.on_best_chain(&id, stored.header.height) {
                break;
            }
            if stored.refused || !t.has_block(&id) {
                usable = stored.header.prev_id;
            }
            id = stored.header.prev_id;
        }
        // A Checkpoint's Block fixes every Block below it, so the highest one the branch holds
        // is its rank. The genesis is held by every branch.
        let mut below = t.header(&usable).expect("a stored header").header.height;
        let held = loop {
            match t.checkpoint_at_or_below(below) {
                None => break 0,
                Some((height, block_id)) if ancestor(t, usable, height) == block_id => {
                    break height;
                }
                Some((height, _)) => {
                    // Not the genesis: a Checkpoint at height 0 names it.
                    usable = ancestor(t, usable, height - 1);
                    below = height - 1;
                }
            }
        };
        (
            held,
            t.header(&usable).expect("a stored header").work,
            usable,
        )
    };
    let mut best = candidate(t.tip());
    for end in t.tips() {
        let next = candidate(end);
        if (next.0, next.1) > (best.0, best.1) {
            best = next;
        }
    }
    best.2
}

/// The id of the Block at `height` on the branch that ends with `id`, at or above it.
fn ancestor(t: &Tables, mut id: [u8; 32], height: u64) -> [u8; 32] {
    loop {
        let stored = t.header(&id).expect("a stored header");
        if stored.header.height == height {
            return id;
        }
        if t.on_best_chain(&id, stored.header.height) {
            return t.best(height).expect("a Block at every height");
        }
        id = stored.header.prev_id;
    }
}

#[cfg(test)]
pub(crate) mod tests;
