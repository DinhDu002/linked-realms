//! The Retarget simulation (step 2C plan, "Simulation", item 6): the real `next_target` against a
//! modelled hash rate. Proof of Work is faked by its distribution: a Block's solvetime is drawn
//! from the exponential distribution whose mean is the time the hash rate needs, on average, to
//! find a Solution below the Target.

use linked_realms_core::params::{ChainParams, TESTNET};
use linked_realms_core::retarget::next_target;
use linked_realms_core::u256::U256;

/// splitmix64, so every run draws the same solvetimes.
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

/// One Block of a simulated chain.
struct Mined {
    /// When it was found, in seconds from the genesis.
    time: f64,
    timestamp: u64,
    target: U256,
    /// The mean solvetime its Target and the hash rate give: the Retarget's error, without the
    /// luck of the draw.
    expected: f64,
}

/// A chain of `blocks` Blocks after the genesis. `hash_rate(height, target)` is relative to the
/// rate at which the initial Target gives Blocks `T` apart; it may depend on the Target, as a Mine
/// that comes and goes does. `stamp(rng, real, median)` gives a Block's timestamp from the real
/// time, rounded to the second, and the median of the last 11; it is raised to the median plus 1,
/// the earliest a Block may have.
fn simulate(
    params: &ChainParams,
    blocks: u64,
    seed: u64,
    hash_rate: impl Fn(u64, f64) -> f64,
    mut stamp: impl FnMut(&mut Rng, u64, u64) -> u64,
) -> Vec<Mined> {
    let mut rng = Rng(seed);
    let initial = as_f64(params.initial_target);
    let mut chain = vec![Mined {
        time: 0.0,
        timestamp: 0,
        target: params.initial_target,
        expected: params.block_time as f64,
    }];
    let mut time = 0.0;
    for height in 1..=blocks {
        let target = next_target(params, height, |j| {
            let block = &chain[j as usize];
            (block.timestamp, block.target)
        });
        // Relative to the initial Target: 1 is as easy, 2 twice as easy.
        let ease = as_f64(target) / initial;
        let expected = params.block_time as f64 / (ease * hash_rate(height, ease));
        time += expected * rng.exponential();
        let mut last: Vec<u64> = (chain.iter().rev().take(11))
            .map(|block| block.timestamp)
            .collect();
        last.sort_unstable();
        let median = last[last.len() / 2];
        chain.push(Mined {
            time,
            timestamp: stamp(&mut rng, time.round() as u64, median).max(median + 1),
            target,
            expected,
        });
    }
    chain
}

/// Honest Mines stamp the real time.
fn honest(_: &mut Rng, real: u64, _: u64) -> u64 {
    real
}

/// The mean of `f` over `seeds` chains, Block by Block.
fn mean_over_seeds(chains: &[Vec<Mined>], f: impl Fn(&Mined) -> f64) -> Vec<f64> {
    (0..chains[0].len())
        .map(|height| {
            chains.iter().map(|chain| f(&chain[height])).sum::<f64>() / chains.len() as f64
        })
        .collect()
}

/// The first height from `from` whose expected solvetime, averaged over the chains, is within
/// 10% of `T`, counted in Blocks after `from`.
fn recovery(expected: &[f64], from: usize, t: f64) -> usize {
    (from..expected.len())
        .find(|&h| (expected[h] / t - 1.0).abs() <= 0.1)
        .map_or(usize::MAX, |h| h - from)
}

/// The mean real time between Blocks from height `from` to `to`.
fn mean_solvetime(chain: &[Mined], from: usize, to: usize) -> f64 {
    (chain[to].time - chain[from].time) / (to - from) as f64
}

/// The test network's values with a window of `n` and an initial Target 1024 times harder than
/// the maximum, so the maximum never caps the Retarget here. Item 9 sets the real initial Target.
fn params(n: u64) -> ChainParams {
    ChainParams {
        retarget_window: n,
        initial_target: U256::ones(230),
        ..TESTNET
    }
}

const RISE: usize = 1_000;
const FALL: usize = 2_000;
const END: usize = 3_000;

/// The plan's case: steady, four times the hash rate at `RISE`, then half of that at `FALL`.
fn steps(height: u64, _ease: f64) -> f64 {
    match height as usize {
        h if h < RISE => 1.0,
        h if h < FALL => 4.0,
        _ => 2.0,
    }
}

/// Recovery after the rise and after the fall, in Blocks, and the mean solvetime of the Blocks
/// after each has settled.
fn step_response(params: &ChainParams, seeds: u64) -> (usize, usize, f64, f64) {
    let chains: Vec<_> = (0..seeds)
        .map(|seed| simulate(params, END as u64, seed, steps, honest))
        .collect();
    let expected = mean_over_seeds(&chains, |block| block.expected);
    let settled = |from: usize, to: usize| {
        chains
            .iter()
            .map(|chain| mean_solvetime(chain, from, to))
            .sum::<f64>()
            / seeds as f64
    };
    let t = params.block_time as f64;
    (
        recovery(&expected, RISE, t),
        recovery(&expected, FALL, t),
        settled(RISE + 500, FALL),
        settled(FALL + 500, END),
    )
}

#[test]
fn block_time_returns_to_60_seconds_after_a_rise_and_a_fall() {
    let (rise, fall, after_rise, after_fall) = step_response(&params(TESTNET.retarget_window), 40);
    println!("recovery {rise} and {fall} Blocks; then {after_rise:.1} s and {after_fall:.1} s");
    assert!(
        rise <= 2 * TESTNET.retarget_window as usize,
        "rise: {rise} Blocks"
    );
    assert!(
        fall <= 2 * TESTNET.retarget_window as usize,
        "fall: {fall} Blocks"
    );
    assert!(
        (after_rise - 60.0).abs() < 3.0,
        "after the rise: {after_rise} s"
    );
    assert!(
        (after_fall - 60.0).abs() < 3.0,
        "after the fall: {after_fall} s"
    );
}

/// `cargo test --release -p linked-realms-core --test retarget_simulation -- --ignored --nocapture`
///
/// Compares windows. Steady: the mean solvetime at a constant hash rate, and how far each Block's
/// expected solvetime strays from `T` (standard deviation). Steps: as above. On and off: a Mine
/// with five times the rest's hash rate mines only while the Target is at least as easy as the
/// rest alone needs; then the mean solvetime, and the share of Blocks over `5T`, the delays the
/// rest suffers after it leaves.
#[test]
#[ignore = "a measurement, run in release"]
fn windows() {
    const SEEDS: u64 = 200;
    println!(
        "    N  steady mean  spread | rise  fall  after rise  after fall | on-off mean  over 5T"
    );
    for n in [30, 45, 60, 90, 120, 180, 240] {
        let params = params(n);
        let t = params.block_time as f64;
        let steady: Vec<_> = (0..SEEDS)
            .map(|seed| simulate(&params, 5_000, seed, |_, _| 1.0, honest))
            .collect();
        let settled = 1_000;
        let mean = steady
            .iter()
            .map(|chain| mean_solvetime(chain, settled, 5_000))
            .sum::<f64>()
            / SEEDS as f64;
        let errors: Vec<f64> = (steady.iter())
            .flat_map(|chain| {
                chain[settled..]
                    .iter()
                    .map(|block| block.expected / t - 1.0)
            })
            .collect();
        let spread = (errors.iter().map(|e| e * e).sum::<f64>() / errors.len() as f64).sqrt();
        let (rise, fall, after_rise, after_fall) = step_response(&params, SEEDS);
        let on_off: Vec<_> = (0..SEEDS)
            .map(|seed| {
                simulate(
                    &params,
                    5_000,
                    seed,
                    |_, ease| if ease >= 1.0 { 6.0 } else { 1.0 },
                    honest,
                )
            })
            .collect();
        let on_off_mean = on_off
            .iter()
            .map(|chain| mean_solvetime(chain, settled, 5_000))
            .sum::<f64>()
            / SEEDS as f64;
        let late = (on_off.iter())
            .flat_map(|chain| chain[settled..].windows(2))
            .filter(|pair| pair[1].time - pair[0].time > 5.0 * t)
            .count() as f64
            / (SEEDS as f64 * 4_000.0);
        println!(
            "{n:>5}  {mean:>9.2} s  {:>5.1}% | {rise:>4}  {fall:>4}  {after_rise:>8.2} s  {after_fall:>8.2} s | {on_off_mean:>9.2} s  {:>6.2}%",
            spread * 100.0,
            late * 100.0
        );
    }
}

/// How a dishonest Mine stamps its Blocks.
#[derive(Clone, Copy, Debug)]
enum Dishonest {
    /// 300 seconds past the real time, as far ahead as Nodes accept a Block.
    Ahead,
    /// The median of the last 11 plus 1, the earliest a Block may have.
    Earliest,
    /// Ahead and earliest by turns.
    Both,
}

/// The mean real time between Blocks from height 1,000 to 4,000, at a constant hash rate of which
/// a Mine with `share` stamps its Blocks as `dishonest` says.
fn attacked(params: &ChainParams, share: f64, dishonest: Dishonest, seed: u64) -> f64 {
    let mut ahead = false;
    let stamp = |rng: &mut Rng, real: u64, median: u64| {
        if rng.uniform() > share {
            return real;
        }
        ahead = !ahead;
        match dishonest {
            Dishonest::Ahead => real + 300,
            Dishonest::Earliest => median + 1,
            Dishonest::Both if ahead => real + 300,
            Dishonest::Both => median + 1,
        }
    };
    let chain = simulate(params, 4_000, seed, |_, _| 1.0, stamp);
    mean_solvetime(&chain, 1_000, 4_000)
}

/// Timestamps cannot buy Gold: a Mine with a fifth or half of the hash rate that stamps ahead,
/// as early as allowed, or both by turns, never makes Blocks come faster than `T`, and makes them
/// slower by little. Counting each solvetime from the previous timestamp alone, clamped to at
/// least 1, gave Blocks 4 times faster with a fifth stamping ahead.
#[test]
fn dishonest_timestamps_do_not_make_blocks_faster() {
    let params = params(TESTNET.retarget_window);
    for dishonest in [Dishonest::Ahead, Dishonest::Earliest, Dishonest::Both] {
        for share in [0.2, 0.5] {
            let mean = (0..10)
                .map(|seed| attacked(&params, share, dishonest, seed))
                .sum::<f64>()
                / 10.0;
            println!("{dishonest:?} {share}: {mean:.1} s");
            assert!(
                (59.0..70.0).contains(&mean),
                "{dishonest:?} {share}: {mean} s"
            );
        }
    }
}
