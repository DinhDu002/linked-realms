//! What differs between networks (ADR 0011). Only the test and dev networks exist so far; the
//! main network joins at the end of step 2C (P7, ADR 0015). The genesis and the Checkpoint signer's
//! key join these values in later items of step 2C.

use crate::u256::U256;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChainParams {
    /// First in the signed bytes of every transaction and Checkpoint, and never stored in them,
    /// so a signature made for one network does not verify on another.
    pub network_id: u32,
    /// The easiest Target a header may carry.
    pub max_target: U256,
    /// The Target of the first `retarget_window` Blocks, and of every Block when
    /// `retarget_enabled` is false.
    pub initial_target: U256,
    /// The goal for the average time between Blocks, in seconds (`T`).
    pub block_time: u64,
    /// How many recent Blocks the Retarget reads (`N`).
    pub retarget_window: u64,
    pub retarget_enabled: bool,
}

/// `2^240 - 1` on both networks.
const MAX_TARGET: U256 = U256::ones(240);

/// The public test network. `retarget_window` is provisional until the simulation of plan item 6,
/// and `initial_target` until plan item 9 measures the hash rate (ADR 0012).
pub const TESTNET: ChainParams = ChainParams {
    network_id: 1,
    max_target: MAX_TARGET,
    initial_target: MAX_TARGET,
    block_time: 60,
    retarget_window: 60,
    retarget_enabled: true,
};

/// A network for development and tests on one machine. Its Target stays fixed, so Blocks keep
/// coming quickly; `initial_target` is provisional until plan item 9.
pub const DEV: ChainParams = ChainParams {
    network_id: 2,
    max_target: MAX_TARGET,
    initial_target: MAX_TARGET,
    block_time: 60,
    retarget_window: 60,
    retarget_enabled: false,
};
