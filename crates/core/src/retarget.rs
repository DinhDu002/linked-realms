//! The Retarget: a linearly weighted moving average (LWMA) after every Block (ADR 0006,
//! docs/protocols/blocks.md). Fixed by the vectors in `chain.json`, not by a citation.

use crate::params::ChainParams;
use crate::u256::U256;

/// The Target of the Block at `height`. `header_at(j)` gives the timestamp and the Target of the
/// header at height `j` on the chain being checked; it is asked only for heights
/// `height - N - 1` to `height - 1`, so at `N + 1` the window starts at the genesis.
pub fn next_target(
    params: &ChainParams,
    height: u64,
    header_at: impl Fn(u64) -> (u64, U256),
) -> U256 {
    let (t, n) = (params.block_time, params.retarget_window);
    if !params.retarget_enabled || height <= n {
        return params.initial_target;
    }
    let start = height - n - 1;
    let (mut previous, _) = header_at(start);
    let (mut weighted, mut sum) = (0u64, U256::ZERO);
    let mut parent = U256::ZERO;
    for i in 1..=n {
        let (timestamp, target) = header_at(start + i);
        // Timestamps may go backwards; i128 holds any difference of two u64.
        let solvetime = (i128::from(timestamp) - i128::from(previous)).clamp(1, i128::from(6 * t));
        weighted += solvetime as u64 * i;
        sum = sum.saturating_add(target);
        (previous, parent) = (timestamp, target);
    }
    // Solvetimes of exactly `t` give `weighted == k`, so equal Targets stay the same.
    let k = n * (n + 1) / 2 * t;
    let next = sum.mul_div(1, n).mul_div(weighted, k);
    // max then min rather than clamp: total even for a parent outside 1..=max_target, which a
    // valid chain never has.
    next.max(parent.mul_div(1, 2).max(U256::ONE))
        .min(parent.mul_div(2, 1).min(params.max_target))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::params::{DEV, TESTNET};

    const X: U256 = U256::ones(200);

    /// Headers from the genesis at time 0, `solvetime` apart, all with Target `target`.
    fn steady(solvetime: u64, target: U256) -> impl Fn(u64) -> (u64, U256) {
        move |j| (j * solvetime, target)
    }

    fn params(initial_target: U256) -> ChainParams {
        ChainParams {
            initial_target,
            ..TESTNET
        }
    }

    #[test]
    fn the_first_n_blocks_and_the_dev_network_keep_the_initial_target() {
        let p = params(X);
        for height in [0, 1, 60] {
            assert_eq!(next_target(&p, height, |_| unreachable!()), X);
        }
        let dev = ChainParams {
            initial_target: X,
            ..DEV
        };
        assert_eq!(next_target(&dev, 1_000, |_| unreachable!()), X);
    }

    #[test]
    fn height_n_plus_1_reads_from_the_genesis() {
        let read = std::cell::RefCell::new(Vec::new());
        next_target(&params(X), 61, |j| {
            read.borrow_mut().push(j);
            (j * 60, X)
        });
        assert_eq!(read.into_inner(), (0..=60).collect::<Vec<_>>());
    }

    #[test]
    fn steady_blocks_keep_the_target() {
        for target in [U256::ONE, X, TESTNET.max_target] {
            for height in [61, 62, 1_000] {
                assert_eq!(next_target(&params(X), height, steady(60, target)), target);
            }
        }
    }

    #[test]
    fn fast_blocks_lower_the_target_and_slow_ones_raise_it() {
        let p = params(X);
        assert_eq!(next_target(&p, 100, steady(40, X)), X.mul_div(40, 60));
        assert_eq!(next_target(&p, 100, steady(90, X)), X.mul_div(90, 60));
        // Clamped to half and double the parent's.
        assert_eq!(next_target(&p, 100, steady(0, X)), X.mul_div(1, 2));
        assert_eq!(next_target(&p, 100, steady(1_000, X)), X.mul_div(2, 1));
        // Never 0, never above the maximum.
        assert_eq!(next_target(&p, 100, steady(0, U256::ONE)), U256::ONE);
        let max = TESTNET.max_target;
        assert_eq!(next_target(&p, 100, steady(1_000, max)), max);
    }

    #[test]
    fn a_recent_solvetime_weighs_more() {
        let p = params(X);
        // One solvetime of 360 among 59 of 60: oldest, or newest.
        let late = |slow_at: u64| {
            move |j: u64| {
                let shift = if j >= slow_at { 300 } else { 0 };
                (j * 60 + shift, X)
            }
        };
        let oldest = next_target(&p, 100, late(40));
        let newest = next_target(&p, 100, late(99));
        assert!(X < oldest && oldest < newest);
        // weighted = k + 300 * i for the slow Block at window position i.
        assert_eq!(oldest, X.mul_div(109_800 + 300, 109_800));
        assert_eq!(newest, X.mul_div(109_800 + 300 * 60, 109_800));
    }
}
