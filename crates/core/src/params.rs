//! What differs between networks (ADR 0011). Only test networks exist (P7), and there is no id
//! for any other. The genesis, the Targets and the Checkpoint signer's key join these values in
//! later items of step 2C.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChainParams {
    /// First in the signed bytes of every transaction and Checkpoint, and never stored in them,
    /// so a signature made for one network does not verify on another.
    pub network_id: u32,
}

/// The public test network.
pub const TESTNET: ChainParams = ChainParams { network_id: 1 };

/// A network for development and tests on one machine.
pub const DEV: ChainParams = ChainParams { network_id: 2 };
