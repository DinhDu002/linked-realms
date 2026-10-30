//! How Gold is created: only as Block rewards, on a fixed schedule (P4, ADR 0006, ADR 0011).

/// Base units in 1 GOLD (8 decimals).
pub const BASE_UNITS_PER_GOLD: u64 = 100_000_000;
/// Blocks between halvings: about 4 years of 60-second Blocks.
pub const HALVING_INTERVAL: u64 = 2_100_000;
/// The reward before the first halving: 5 GOLD.
const FIRST_REWARD: u64 = 5 * BASE_UNITS_PER_GOLD;
/// After this many halvings the reward stays at 0.3125 GOLD forever (`FIRST_REWARD / 16` is
/// exact).
const HALVINGS: u64 = 4;

/// The Block reward at `height`, in base units. The genesis Block (height 0) pays nothing and the
/// first mined Block is height 1, so halvings count from height 1: heights 1 to 2,100,000 pay 5
/// GOLD, and the first halving is at height 2,100,001.
pub fn reward(height: u64) -> u64 {
    match height {
        0 => 0,
        _ => FIRST_REWARD >> ((height - 1) / HALVING_INTERVAL).min(HALVINGS),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewards_at_the_era_edges() {
        for (height, gold_e8) in [
            (0, 0),
            (1, 500_000_000),
            (2_100_000, 500_000_000),
            (2_100_001, 250_000_000),
            (4_200_000, 250_000_000),
            (4_200_001, 125_000_000),
            (6_300_001, 62_500_000),
            (8_400_000, 62_500_000),
            (8_400_001, 31_250_000),
            (u64::MAX, 31_250_000),
        ] {
            assert_eq!(reward(height), gold_e8, "height {height}");
        }
    }

    #[test]
    fn issuance_before_the_tail_is_exact() {
        // ADR 0006: 19,687,500 GOLD after four halvings.
        let total: u64 = (1..=4 * HALVING_INTERVAL).map(reward).sum();
        assert_eq!(total, 19_687_500 * BASE_UNITS_PER_GOLD);
    }
}
