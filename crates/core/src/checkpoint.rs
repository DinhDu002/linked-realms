//! Checkpoints (ADR 0006 point 9, ADR 0015, docs/protocols/blocks.md): every 10 Blocks the
//! Checkpoint signer signs a Block's id, and no Node takes a history that changes the Block a
//! Checkpoint names. Choosing between branches is the Node's.

use crate::block::ChainView;
use crate::params::ChainParams;
use crate::{Error, SCHEME_ML_DSA_44, SIGNATURE_LEN, SigningKey, verify};

/// The context of every Checkpoint signature, so none passes for another kind of signature.
pub const CHECKPOINT_CONTEXT: &[u8] = b"linked-realms/checkpoint/v1";
/// Checkpoints name Blocks at heights that are multiples of this.
pub const CHECKPOINT_INTERVAL: u64 = 10;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Checkpoint {
    pub height: u64,
    pub block_id: [u8; 32],
    pub signature: [u8; SIGNATURE_LEN],
}

impl Checkpoint {
    /// Signs the Block `block_id` at `height` for the Checkpoint signer. `rnd` must be 32 fresh
    /// random bytes.
    pub fn sign(
        params: &ChainParams,
        key: &SigningKey,
        height: u64,
        block_id: [u8; 32],
        rnd: &[u8; 32],
    ) -> Result<Checkpoint, Error> {
        check_height(height)?;
        let signature = key.sign(
            CHECKPOINT_CONTEXT,
            &signed_bytes(params, height, &block_id),
            rnd,
        )?;
        Ok(Checkpoint {
            height,
            block_id,
            signature,
        })
    }
}

/// `network_id ‖ height ‖ block_id`: binary, since a Checkpoint is never shown to a Player.
pub fn signed_bytes(params: &ChainParams, height: u64, block_id: &[u8; 32]) -> [u8; 44] {
    let mut bytes = [0; 44];
    bytes[..4].copy_from_slice(&params.network_id.to_be_bytes());
    bytes[4..12].copy_from_slice(&height.to_be_bytes());
    bytes[12..].copy_from_slice(block_id);
    bytes
}

/// Whether `checkpoint` is the Checkpoint signer's on the network of `params`.
pub fn verify_checkpoint(params: &ChainParams, checkpoint: &Checkpoint) -> Result<(), Error> {
    check_height(checkpoint.height)?;
    let message = signed_bytes(params, checkpoint.height, &checkpoint.block_id);
    match verify(
        SCHEME_ML_DSA_44,
        &params.checkpoint_signer_key,
        CHECKPOINT_CONTEXT,
        &message,
        &checkpoint.signature,
    ) {
        true => Ok(()),
        false => Err(Error::BadSignature),
    }
}

/// Whether `chain` holds the Block `checkpoint` names. A chain that does not reach its height
/// does not.
pub fn branch_matches_checkpoint(
    chain: &(impl ChainView + ?Sized),
    checkpoint: &Checkpoint,
) -> bool {
    chain.tip_height() >= checkpoint.height
        && chain.header(checkpoint.height).id() == checkpoint.block_id
}

fn check_height(height: u64) -> Result<(), Error> {
    match height % CHECKPOINT_INTERVAL {
        0 => Ok(()),
        _ => Err(Error::CheckpointHeight),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::block::Header;
    use crate::params::{DEV, DEV_CHECKPOINT_SEED, TESTNET};

    fn signer() -> SigningKey {
        SigningKey::from_seed(&DEV_CHECKPOINT_SEED)
    }

    /// The dev genesis and `n` Blocks after it, only their ids mattering.
    fn chain(n: u64) -> Vec<Header> {
        let mut headers = vec![DEV.genesis()];
        for height in 1..=n {
            let parent = headers.last().unwrap().id();
            headers.push(Header {
                height,
                prev_id: parent,
                ..DEV.genesis()
            });
        }
        headers
    }

    #[test]
    fn the_signer_signs_and_every_node_verifies() {
        let checkpoint = Checkpoint::sign(&DEV, &signer(), 20, [7; 32], &[0; 32]).unwrap();
        assert_eq!(verify_checkpoint(&DEV, &checkpoint), Ok(()));
        // Another network, another Block, another height, another key: refused.
        assert_eq!(
            verify_checkpoint(&TESTNET, &checkpoint),
            Err(Error::BadSignature)
        );
        let changed = |f: &dyn Fn(&mut Checkpoint)| {
            let mut changed = checkpoint.clone();
            f(&mut changed);
            verify_checkpoint(&DEV, &changed)
        };
        assert_eq!(changed(&|c| c.block_id[0] ^= 1), Err(Error::BadSignature));
        assert_eq!(changed(&|c| c.height = 30), Err(Error::BadSignature));
        assert_eq!(changed(&|c| c.height = 25), Err(Error::CheckpointHeight));
        let other = SigningKey::from_seed(&[3; 32]);
        let forged = Checkpoint::sign(&DEV, &other, 20, [7; 32], &[0; 32]).unwrap();
        assert_eq!(verify_checkpoint(&DEV, &forged), Err(Error::BadSignature));
    }

    #[test]
    fn only_heights_that_are_multiples_of_10_are_signed() {
        for height in [1, 9, 11, 15] {
            let signed = Checkpoint::sign(&DEV, &signer(), height, [7; 32], &[0; 32]);
            assert_eq!(signed, Err(Error::CheckpointHeight));
        }
    }

    #[test]
    fn a_branch_matches_only_if_it_holds_the_named_block() {
        let headers = chain(25);
        let at = |height: u64, id: [u8; 32]| {
            Checkpoint::sign(&DEV, &signer(), height, id, &[0; 32]).unwrap()
        };
        assert!(branch_matches_checkpoint(
            &headers[..],
            &at(20, headers[20].id())
        ));
        assert!(branch_matches_checkpoint(
            &headers[..],
            &at(0, headers[0].id())
        ));
        assert!(!branch_matches_checkpoint(
            &headers[..],
            &at(20, headers[19].id())
        ));
        // Too short to hold it.
        assert!(!branch_matches_checkpoint(
            &headers[..=19],
            &at(20, headers[20].id())
        ));
    }
}
