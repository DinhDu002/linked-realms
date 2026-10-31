//! The LR Node (docs/plans/phase-2c-the-chain.md, `crates/node`): it stores the chain in `redb`
//! and follows its best branch. Every chain rule is a call into `crates/core`.

mod chain;
pub mod control;
mod mempool;
pub mod mine;
pub mod p2p;
pub mod pow;
pub mod rpc;
pub mod run;
mod store;

use std::fmt;

pub use chain::{Chain, KEEP_BELOW_CHECKPOINT, Placed};
pub use mempool::{Mempool, Policy, Refused};

#[derive(Debug)]
pub enum Error {
    /// A chain rule refuses the Block or the Checkpoint.
    Rule(linked_realms_core::Error),
    /// The Block's parent is not stored here: it must come first.
    UnknownParent,
    /// The Block is, or extends, a Block a rule refused.
    RefusedBranch,
    /// The database holds another network's chain.
    OtherNetwork,
    /// The best branch parts from the best chain below Blocks this Node pruned, so it cannot
    /// undo back to it: only a Checkpoint signer that signed two branches leads here.
    Pruned,
    Storage(redb::Error),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Rule(error) => write!(f, "{error}"),
            Error::UnknownParent => f.write_str("the parent Block is unknown"),
            Error::RefusedBranch => f.write_str("the Block is on a branch a rule refused"),
            Error::OtherNetwork => f.write_str("the database holds another network's chain"),
            Error::Pruned => f.write_str("the best branch parts below the pruned Blocks"),
            Error::Storage(error) => write!(f, "chain database: {error}"),
        }
    }
}

impl std::error::Error for Error {}

macro_rules! storage_errors {
    ($($error:ty),*) => {$(
        impl From<$error> for Error {
            fn from(error: $error) -> Self {
                Error::Storage(error.into())
            }
        }
    )*};
}

storage_errors!(
    redb::DatabaseError,
    redb::TransactionError,
    redb::TableError,
    redb::CommitError,
    redb::StorageError
);
