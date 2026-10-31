//! The network simulation (step 2C plan, "Simulation", item 26): the Retarget's case of
//! `crates/core/tests/retarget_simulation.rs` through Nodes on the in-memory `Network`, and a
//! branch with more work that forks below the last Checkpoint. Proof of Work is faked: the
//! nonce alone passes, and a Block's solvetime is drawn as the Retarget simulation draws it.

use linked_realms_core::params::DEV;
use linked_realms_core::retarget::next_target;
use linked_realms_core::u256::U256;

use super::tests::Mesh;
use super::*;
use crate::chain::tests::{Builder, checkpoint, nobody, submit_all};

/// splitmix64, so every run draws the same Blocks.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    /// A draw from the uniform distribution over (0, 1].
    fn uniform(&mut self) -> f64 {
        ((self.next() >> 11) as f64 + 1.0) / (1u64 << 53) as f64
    }

    /// A draw from the exponential distribution with mean 1.
    fn exponential(&mut self) -> f64 {
        -self.uniform().ln()
    }
}

fn as_f64(target: U256) -> f64 {
    (target.to_be_bytes().iter()).fold(0.0, |n, &byte| n * 256.0 + f64::from(byte))
}

/// The dev network with the Retarget on and an initial Target far below the maximum, so the
/// maximum never caps it.
const SIM: ChainParams = ChainParams {
    retarget_enabled: true,
    initial_target: U256::ones(230),
    max_target: U256::ones(255),
    ..DEV
};

const RISE: u64 = 200;
const FALL: u64 = 700;
const END: u64 = 1_200;

/// The Retarget simulation's case: steady, four times the hash rate at `RISE`, then half of
/// that at `FALL`. Relative to the rate at which the initial Target gives Blocks 60 seconds apart.
fn hash_rate(height: u64) -> f64 {
    match height {
        h if h < RISE => 1.0,
        h if h < FALL => 4.0,
        _ => 2.0,
    }
}

/// Each Node's share of the hash rate: its Mine finds that share of the Blocks.
const SHARES: [f64; 3] = [0.5, 0.3, 0.2];

#[test]
fn three_nodes_bring_block_time_back_to_60_seconds_after_a_rise_and_a_fall() {
    let mut mesh = Mesh::on(SIM, "sim-retarget", 3, &[(1, 0), (2, 1)]);
    mesh.tick();
    assert!(mesh.connected(0, 1) && mesh.connected(1, 2));
    let mut rng = Rng(1);
    let genesis = SIM.genesis().timestamp;
    let initial = as_f64(SIM.initial_target);
    let window = SIM.retarget_window;
    let mut time = 0.0;
    for height in 1..=END {
        let draw = rng.uniform();
        let mut winner = 0;
        let mut below = SHARES[0];
        while draw > below && winner + 1 < SHARES.len() {
            winner += 1;
            below += SHARES[winner];
        }
        // The Target the winner's Node asks for, which `crates/core` gives from its chain.
        let chain = &mesh.nodes[winner].chain;
        let from = height.saturating_sub(window + 1);
        let last = chain.headers_from(from, window + 1).unwrap();
        let target = next_target(&SIM, height, |j| {
            let header = &last[(j - from) as usize];
            (header.timestamp, header.target)
        });
        let ease = as_f64(target) / initial;
        time += SIM.block_time as f64 / (ease * hash_rate(height)) * rng.exponential();
        mesh.now = genesis + time.round() as u64;
        let mut block = chain
            .template(nobody(winner as u8 + 1), Vec::new(), mesh.now)
            .unwrap();
        assert_eq!(block.header.target, target, "Block {height}");
        block.header.nonce = 1;
        mesh.with(winner, |node, net| node.mined(net, &block))
            .unwrap();
        assert!(
            (0..3).all(|i| mesh.tip(i) == block.header.id()),
            "every Node takes Block {height}"
        );
    }

    let headers = mesh.nodes[2].chain.headers_from(0, END + 1).unwrap();
    // The mean solvetime from the timestamps, and the mean ease, over Blocks `from` to `to`.
    let mean = |from: u64, to: u64| {
        let (a, b) = (&headers[from as usize], &headers[to as usize]);
        (b.timestamp - a.timestamp) as f64 / (to - from) as f64
    };
    let ease = |from: u64, to: u64| {
        (from..to)
            .map(|h| as_f64(headers[h as usize].target) / initial)
            .sum::<f64>()
            / (to - from) as f64
    };
    // Settled: more than twice the window after each change.
    let (steady, after_rise, after_fall) =
        (mean(1, RISE), mean(RISE + 200, FALL), mean(FALL + 200, END));
    let (rise_ease, fall_ease) = (ease(RISE + 200, FALL), ease(FALL + 200, END));
    println!(
        "{steady:.1} s, then {after_rise:.1} s at ease {rise_ease:.3}, then {after_fall:.1} s at ease {fall_ease:.3}"
    );
    for (name, seconds) in [
        ("steady", steady),
        ("after the rise", after_rise),
        ("after the fall", after_fall),
    ] {
        assert!((seconds - 60.0).abs() < 6.0, "{name}: {seconds} s");
    }
    // The Target follows the hash rate: four times as hard, then half that.
    assert!(
        (rise_ease * 4.0 - 1.0).abs() < 0.2,
        "after the rise: ease {rise_ease}"
    );
    assert!(
        (fall_ease * 2.0 - 1.0).abs() < 0.2,
        "after the fall: ease {fall_ease}"
    );
}

#[test]
fn a_branch_with_more_work_that_forks_below_the_checkpoint_never_wins() {
    // Node 0 mined 30 Blocks. Node 1 mined a longer branch from Block 10, so with more work.
    // Node 2 follows Node 1.
    let mut build = Builder::new();
    let genesis = build.genesis();
    let honest = build.branch(&genesis, nobody(1), 30);
    let mut heavier = build.branch(&honest[9], nobody(2), 40);
    let pushed = build.child(&heavier[39], nobody(2), Vec::new());
    heavier.push(pushed);
    let mut mesh = Mesh::new("sim-checkpoint", 3, &[(1, 0), (2, 1)]);
    submit_all(&mesh.nodes[0].chain, &honest);
    submit_all(&mesh.nodes[1].chain, &honest[..10]);
    submit_all(&mesh.nodes[1].chain, &heavier[..40]);
    // Late enough for every Block above.
    mesh.now = heavier[40].header.timestamp;
    mesh.tick();
    // Without a Checkpoint, the most work wins everywhere.
    for i in 0..3 {
        assert_eq!(mesh.tip(i), heavier[39].header.id(), "Node {i}");
    }

    // The Checkpoint names Block 20 of Node 0's chain: every Node goes back to it.
    let held = checkpoint(20, honest[19].header.id());
    mesh.with(0, |node, net| node.submit_checkpoint(net, held.clone()))
        .unwrap()
        .unwrap();
    mesh.tick();
    for i in 0..3 {
        assert_eq!(mesh.tip(i), honest[29].header.id(), "Node {i}");
        assert_eq!(
            mesh.nodes[i].chain.latest_checkpoint().unwrap(),
            Some(held.clone())
        );
    }

    // Nothing of the branch above Block 10 stays but its headers.
    for i in 0..3 {
        assert_eq!(
            mesh.nodes[i].chain.block(&heavier[0].header.id()).unwrap(),
            None
        );
    }

    // Node 1 pushes one more Block on its branch, past its own Node. Nodes 0 and 2 take it in,
    // keep their tip, and drop its body. Node 1 is not banned: a Node that has not heard of the
    // Checkpoint yet passes on such a Block in good faith.
    let id = heavier[40].header.id();
    mesh.with(1, |node, net| {
        node.broadcast(net, &Message::Block(heavier[40].clone()), None)
    });
    for i in [0, 2] {
        assert_eq!(mesh.tip(i), honest[29].header.id(), "Node {i}");
        assert!(mesh.nodes[i].chain.has_header(&id).unwrap(), "Node {i}");
        assert_eq!(mesh.nodes[i].chain.block(&id).unwrap(), None, "Node {i}");
        assert!(mesh.connected(i, 1), "Node {i}");
    }
}
