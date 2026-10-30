//! The chain a Node follows (docs/protocols/blocks.md). A Block of any branch is stored once
//! `block::check_block` passes on its branch; its accounts are checked only when its branch
//! becomes the best. The best branch has the most work among the branches that hold the highest
//! Checkpoint any branch holds, and no branch counts past a Checkpoint it contradicts. Moving to
//! another branch undoes Blocks back to where the branches part, then applies the other
//! branch's, in one write transaction: a Block a rule refuses on the way leaves the chain as it
//! was.

use std::path::Path;

use linked_realms_core::Address;
use linked_realms_core::Error as RuleError;
use linked_realms_core::block::{Block, Header, check_block, check_on_accounts};
use linked_realms_core::checkpoint::{Checkpoint, verify_checkpoint};
use linked_realms_core::params::ChainParams;
use linked_realms_core::retarget::work;
use linked_realms_core::smt;
use linked_realms_core::state::{Account, State, StateView, tree_key};
use linked_realms_core::u256::U256;
use redb::{Database, ReadableDatabase};

use crate::Error;
use crate::store::{
    ACCOUNTS, Accounts, Branch, HEADERS, META, Stored, Tables, stored_header, tip_id,
};

pub struct Chain<H> {
    db: Database,
    params: ChainParams,
    hash: H,
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
            #[cfg(test)]
            fail_moves: Default::default(),
        };
        let genesis = Block {
            header: chain.params.genesis(),
            txs: Vec::new(),
        };
        chain.write(|t| t.start(chain.params.network_id, &genesis))?;
        chain.follow_best()?;
        Ok(chain)
    }

    /// The best chain's last header.
    pub fn tip(&self) -> Result<Header, Error> {
        let txn = self.db.begin_read()?;
        let id = tip_id(&txn.open_table(META)?);
        Ok(stored_header(&txn.open_table(HEADERS)?, &id)
            .expect("a stored tip")
            .header)
    }

    /// `address`'s account at the best chain's tip.
    pub fn account(&self, address: &Address) -> Result<Option<Account>, Error> {
        let txn = self.db.begin_read()?;
        Ok(Accounts(txn.open_table(ACCOUNTS)?).account(address))
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
                if t.has_block(&id) {
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

    /// Moves to the best branch. A Block a rule refuses on the way is marked and the choice made
    /// again without it; they come back with the rule's error.
    fn follow_best(&self) -> Result<Vec<([u8; 32], RuleError)>, Error> {
        let mut refused = Vec::new();
        loop {
            match self.write(|t| self.move_to_best(t)) {
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
mod tests;
