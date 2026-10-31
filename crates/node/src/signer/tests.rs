use std::net::SocketAddr;

use linked_realms_core::checkpoint::verify_checkpoint;
use linked_realms_core::params::DEV_CHECKPOINT_SEED;

use super::*;
use crate::chain::tests::{Builder, File, PARAMS, submit_all};
use crate::mempool::tests::key;
use crate::p2p::Message;
use crate::p2p::tests::{Recorder, greet, node};

#[test]
fn a_checkpoint_is_due_at_each_tenth_block_six_below_the_tip() {
    assert_eq!(due(5, None), None);
    assert_eq!(due(15, None), None, "height 0 is the genesis");
    assert_eq!(due(16, None), Some(10));
    assert_eq!(due(25, Some(10)), None);
    assert_eq!(due(26, Some(10)), Some(20));
    assert_eq!(due(56, Some(20)), Some(50), "only the highest one due");
    assert_eq!(due(1_005, Some(990)), None);
    assert_eq!(due(1_006, Some(990)), Some(1_000));
}

#[test]
fn the_signer_signs_its_best_chain_once_synced_and_passes_it_on() {
    let file = File::new("signer");
    let mut node = node(&file, 0, &[]);
    let mut net = Recorder::default();
    let signer = SigningKey::from_seed(&DEV_CHECKPOINT_SEED);
    let mut build = Builder::new();
    let mut blocks = vec![build.genesis()];
    for _ in 1..=16 {
        let block = build.child(blocks.last().unwrap(), key(1).address(), Vec::new());
        blocks.push(block);
    }
    submit_all(&node.chain, &blocks[1..]);
    let now = blocks[16].header.timestamp;

    // Alone, it signs nothing.
    assert_eq!(
        sign_due(&mut node, &mut net, &PARAMS, &signer).unwrap(),
        None
    );
    greet(
        &mut node,
        &mut net,
        1,
        SocketAddr::from(([10, 0, 0, 9], 5000)),
        now,
    );
    let signed = sign_due(&mut node, &mut net, &PARAMS, &signer).unwrap();
    let checkpoint = signed.unwrap();
    assert_eq!(
        (checkpoint.height, checkpoint.block_id),
        (10, blocks[10].header.id())
    );
    verify_checkpoint(&PARAMS, &checkpoint).unwrap();
    assert_eq!(
        node.chain.latest_checkpoint().unwrap(),
        Some(checkpoint.clone())
    );
    assert_eq!(
        net.sent.last(),
        Some(&(1, Message::Checkpoint(Box::new(checkpoint))))
    );
    assert_eq!(
        sign_due(&mut node, &mut net, &PARAMS, &signer).unwrap(),
        None
    );

    // Not while it waits for a Block a peer announced.
    let more: Vec<_> = (17..=26)
        .map(|_| {
            let block = build.child(blocks.last().unwrap(), key(1).address(), Vec::new());
            blocks.push(block.clone());
            block
        })
        .collect();
    submit_all(&node.chain, &more);
    let inv = Message::Inv(vec![[1; 32]]).to_frame(PARAMS.magic());
    let event = crate::p2p::Event::Received {
        peer: 1,
        bytes: inv,
    };
    node.handle(&mut net, event, now).unwrap();
    assert_eq!(
        sign_due(&mut node, &mut net, &PARAMS, &signer).unwrap(),
        None
    );
}
