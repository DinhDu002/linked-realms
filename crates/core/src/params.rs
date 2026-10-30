//! What differs between networks (ADR 0011, ADR 0012). Only the test and dev networks exist so
//! far; the main network joins at the end of step 2C (P7, ADR 0015).

use crate::block::Header;
use crate::merkle::tx_root;
use crate::u256::U256;
use crate::{ADDRESS_LEN, Address, PUBLIC_KEY_LEN, SCHEME_ML_DSA_44, SEED_LEN, smt};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChainParams {
    /// First in the signed bytes of every transaction and Checkpoint, and never stored in them,
    /// so a signature made for one network does not verify on another. A reset of a network
    /// takes a new id, so nothing signed before it verifies after it (ADR 0012).
    pub network_id: u32,
    /// The genesis's timestamp. The header holds no network id, so a reset also takes a new
    /// timestamp, and with it a new genesis.
    pub genesis_timestamp: u64,
    /// The easiest Target a header may carry.
    pub max_target: U256,
    /// The Target of the genesis and the first `retarget_window` Blocks, and of every Block when
    /// `retarget_enabled` is false.
    pub initial_target: U256,
    /// The goal for the average time between Blocks, in seconds (`T`).
    pub block_time: u64,
    /// How many recent Blocks the Retarget reads (`N`).
    pub retarget_window: u64,
    pub retarget_enabled: bool,
    /// The Checkpoint signer's ML-DSA-44 public key, replaceable only by a network upgrade.
    pub checkpoint_signer_key: [u8; PUBLIC_KEY_LEN],
}

impl ChainParams {
    /// Height 0: no parent, no transaction, no account, and no Proof of Work. A Node starts from
    /// it, and no rule checks it (`block::check_genesis`). Nobody holds its reward address.
    pub fn genesis(&self) -> Header {
        let mut nobody = [0; ADDRESS_LEN];
        nobody[1] = SCHEME_ML_DSA_44;
        Header {
            height: 0,
            prev_id: [0; 32],
            timestamp: self.genesis_timestamp,
            target: self.initial_target,
            tx_root: tx_root(&[]),
            state_root: smt::empty(256),
            reward_address: Address::from_bytes(&nobody).expect("a well-formed address"),
            nonce: 0,
        }
    }
}

/// `2^240 - 1`: about 65,536 hashes a Block at the easiest.
const MAX_TARGET: U256 = U256::ones(240);

/// 2026-10-30 00:00:00 UTC.
const GENESIS_TIMESTAMP: u64 = 1_793_318_400;

/// The public test network. `retarget_window` was set by the simulation of plan item 6
/// (`tests/retarget_simulation.rs`). `initial_target` is the maximum, easier than the project
/// owner's M5 mining on every thread in fast mode (ADR 0012). The project owner holds the
/// Checkpoint signer's key (ADR 0015).
pub const TESTNET: ChainParams = ChainParams {
    network_id: 1,
    genesis_timestamp: GENESIS_TIMESTAMP,
    max_target: MAX_TARGET,
    initial_target: MAX_TARGET,
    block_time: 60,
    retarget_window: 60,
    retarget_enabled: true,
    checkpoint_signer_key: public_key(include_str!("../keys/testnet-checkpoint.hex")),
};

/// A network for development and tests on one machine. Its Target stays fixed and easy, about
/// 1,024 hashes a Block, so Blocks keep coming in seconds without running ahead of the clock
/// (ADR 0012). Anyone can sign its Checkpoints, from `DEV_CHECKPOINT_SEED`.
pub const DEV: ChainParams = ChainParams {
    network_id: 2,
    genesis_timestamp: GENESIS_TIMESTAMP,
    max_target: U256::ones(246),
    initial_target: U256::ones(246),
    block_time: 60,
    retarget_window: 60,
    retarget_enabled: false,
    checkpoint_signer_key: public_key(include_str!("../keys/dev-checkpoint.hex")),
};

/// The published seed `xi` of the dev network's Checkpoint signer key: the network's id, repeated.
pub const DEV_CHECKPOINT_SEED: [u8; SEED_LEN] = [2; SEED_LEN];

/// A public key from its file in `keys/`: lowercase hex and a newline, as
/// `examples/checkpoint_key.rs` writes it. Decoded when compiling, so a malformed file does not
/// build.
const fn public_key(hex: &str) -> [u8; PUBLIC_KEY_LEN] {
    let hex = hex.as_bytes();
    assert!(hex.len() == 2 * PUBLIC_KEY_LEN + 1 && hex[2 * PUBLIC_KEY_LEN] == b'\n');
    let mut key = [0; PUBLIC_KEY_LEN];
    let mut i = 0;
    while i < PUBLIC_KEY_LEN {
        key[i] = nibble(hex[2 * i]) << 4 | nibble(hex[2 * i + 1]);
        i += 1;
    }
    key
}

const fn nibble(digit: u8) -> u8 {
    match digit {
        b'0'..=b'9' => digit - b'0',
        b'a'..=b'f' => digit - b'a' + 10,
        _ => panic!("not lowercase hex"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::SigningKey;

    #[test]
    fn the_dev_checkpoint_key_comes_from_its_published_seed() {
        let key = SigningKey::from_seed(&DEV_CHECKPOINT_SEED);
        assert_eq!(key.public_key(), &DEV.checkpoint_signer_key);
    }

    #[test]
    fn each_network_has_its_own_checkpoint_key_and_genesis() {
        assert_ne!(TESTNET.checkpoint_signer_key, DEV.checkpoint_signer_key);
        assert_ne!(TESTNET.genesis().id(), DEV.genesis().id());
    }

    #[test]
    fn the_genesis_holds_no_account_and_no_transaction() {
        let genesis = TESTNET.genesis();
        assert_eq!(genesis.state_root, smt::empty(256));
        assert_eq!(genesis.tx_root, tx_root(&[]));
        assert_eq!(genesis.target, TESTNET.initial_target);
        assert_eq!(genesis.reward_address.hash(), &[0; 32]);
    }
}
