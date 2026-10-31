//! The Checkpoint signer (step 2C flow 6, ADR 0012): a Node that checks every Block itself and
//! signs Checkpoints on its own best chain, which its other Nodes then pass on.

use std::fs::File;
use std::io::Read;

use linked_realms_core::SigningKey;
use linked_realms_core::checkpoint::Checkpoint;
use linked_realms_core::params::ChainParams;

use crate::Error;
use crate::p2p::{Network, Node};

/// Blocks a Checkpoint stays below the tip, so a Block that may yet be orphaned is not signed.
pub const CHECKPOINT_LAG: u64 = 6;

/// The height of the Checkpoint due on a best chain whose tip is at `tip`, if one is due above
/// the `latest` one: the highest multiple of 10 at least `CHECKPOINT_LAG` below the tip.
pub fn due(tip: u64, latest: Option<u64>) -> Option<u64> {
    let height = tip.checked_sub(CHECKPOINT_LAG)? / 10 * 10;
    (height > 0 && latest.is_none_or(|latest| height > latest)).then_some(height)
}

/// Signs the Checkpoint due on `node`'s best chain, if one is, and gives it to the Node as one
/// sent to it, so the Node passes it on. Only while the Node has another Node and is synced, so
/// a Node that has not caught up yet does not sign a Block the network has left behind.
// ponytail: it trusts the Nodes it dials (the company's seed and Public node) to show it the
// network's best chain; a longer branch they hide from it, it cannot see.
pub fn sign_due<H: Fn(&[u8], &[u8; 32]) -> [u8; 32]>(
    node: &mut Node<H>,
    net: &mut impl Network,
    params: &ChainParams,
    key: &SigningKey,
) -> Result<Option<Checkpoint>, Error> {
    if node.connections() == 0 || !node.synced() {
        return Ok(None);
    }
    let latest = node
        .chain
        .latest_checkpoint()?
        .map(|checkpoint| checkpoint.height);
    let Some(height) = due(node.chain.tip()?.height, latest) else {
        return Ok(None);
    };
    let block_id = node.chain.headers_from(height, 1)?[0].id();
    let mut rnd = [0; 32];
    File::open("/dev/urandom")
        .and_then(|mut random| random.read_exact(&mut rnd))
        .expect("reading /dev/urandom");
    let checkpoint = Checkpoint::sign(params, key, height, block_id, &rnd).map_err(Error::Rule)?;
    node.submit_checkpoint(net, checkpoint.clone())?
        .map_err(Error::Rule)?;
    Ok(Some(checkpoint))
}

#[cfg(test)]
mod tests;
