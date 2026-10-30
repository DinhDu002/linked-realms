//! A 256-bit unsigned number for Targets, with only what the Retarget needs (ADR 0011).

/// Most significant limb first, so the derived order is the numeric order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct U256([u64; 4]);

impl U256 {
    pub const ZERO: U256 = U256([0; 4]);
    pub const ONE: U256 = U256([0, 0, 0, 1]);
    pub const MAX: U256 = U256([u64::MAX; 4]);

    /// `2^bits - 1`, for `bits` up to 256.
    pub const fn ones(bits: u32) -> U256 {
        let mut limbs = [0u64; 4];
        let mut i = 0;
        while i < 4 {
            let low = 64 * (3 - i as u32);
            limbs[i] = match bits.saturating_sub(low) {
                0 => 0,
                n if n >= 64 => u64::MAX,
                n => (1 << n) - 1,
            };
            i += 1;
        }
        U256(limbs)
    }

    pub fn from_be_bytes(bytes: [u8; 32]) -> U256 {
        let (limbs, _) = bytes.as_chunks::<8>();
        U256(std::array::from_fn(|i| u64::from_be_bytes(limbs[i])))
    }

    pub fn to_be_bytes(self) -> [u8; 32] {
        let mut bytes = [0u8; 32];
        for (chunk, limb) in bytes.as_chunks_mut::<8>().0.iter_mut().zip(self.0) {
            *chunk = limb.to_be_bytes();
        }
        bytes
    }

    pub fn saturating_add(self, other: U256) -> U256 {
        let mut sum = [0u64; 4];
        let mut carry = false;
        for i in (0..4).rev() {
            let (s, c1) = self.0[i].overflowing_add(other.0[i]);
            let (s, c2) = s.overflowing_add(u64::from(carry));
            sum[i] = s;
            carry = c1 || c2;
        }
        if carry { U256::MAX } else { U256(sum) }
    }

    /// `floor(self * mul / div)`, through a 320-bit product, or `U256::MAX` if the result does
    /// not fit. `div` must not be 0.
    pub fn mul_div(self, mul: u64, div: u64) -> U256 {
        // The product, five limbs, most significant first.
        let mut product = [0u64; 5];
        let mut carry = 0u128;
        for i in (0..4).rev() {
            let p = u128::from(self.0[i]) * u128::from(mul) + carry;
            product[i + 1] = p as u64;
            carry = p >> 64;
        }
        product[0] = carry as u64;
        // Long division by `div`, from the most significant limb.
        let mut quotient = [0u64; 5];
        let mut rest = 0u128;
        for (q, limb) in quotient.iter_mut().zip(product) {
            let n = (rest << 64) | u128::from(limb);
            *q = (n / u128::from(div)) as u64;
            rest = n % u128::from(div);
        }
        match quotient[0] {
            0 => U256([quotient[1], quotient[2], quotient[3], quotient[4]]),
            _ => U256::MAX,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn small(n: u128) -> U256 {
        U256([0, 0, (n >> 64) as u64, n as u64])
    }

    #[test]
    fn bytes_and_order() {
        let bytes: [u8; 32] = std::array::from_fn(|i| i as u8);
        assert_eq!(U256::from_be_bytes(bytes).to_be_bytes(), bytes);
        assert_eq!(U256::from_be_bytes([0xff; 32]), U256::MAX);
        let mut one = [0u8; 32];
        one[31] = 1;
        assert_eq!(U256::from_be_bytes(one), U256::ONE);
        // A higher limb outweighs every lower one.
        assert!(U256([0, 0, 1, 0]) > U256([0, 0, 0, u64::MAX]));
        assert!(U256([1, 0, 0, 0]) > U256([0, u64::MAX, u64::MAX, u64::MAX]));
    }

    #[test]
    fn ones() {
        assert_eq!(U256::ones(0), U256::ZERO);
        assert_eq!(U256::ones(1), U256::ONE);
        assert_eq!(U256::ones(64), U256([0, 0, 0, u64::MAX]));
        assert_eq!(U256::ones(65), U256([0, 0, 1, u64::MAX]));
        assert_eq!(
            U256::ones(240),
            U256([0xffff_ffff_ffff, u64::MAX, u64::MAX, u64::MAX])
        );
        assert_eq!(U256::ones(256), U256::MAX);
    }

    #[test]
    fn add_carries_and_saturates() {
        assert_eq!(
            small(u64::MAX.into()).saturating_add(U256::ONE),
            U256([0, 0, 1, 0])
        );
        assert_eq!(
            U256([0, u64::MAX, u64::MAX, u64::MAX]).saturating_add(U256::ONE),
            U256([1, 0, 0, 0])
        );
        assert_eq!(U256::MAX.saturating_add(U256::ZERO), U256::MAX);
        assert_eq!(U256::MAX.saturating_add(U256::ONE), U256::MAX);
    }

    #[test]
    fn mul_div_matches_u128() {
        let values = [
            0u128,
            1,
            2,
            59,
            60,
            1 << 63,
            u64::MAX.into(),
            1 << 100,
            u128::MAX >> 20,
        ];
        let factors = [1u64, 2, 3, 60, 1_830, 109_800, 658_800];
        for &v in &values {
            for &m in &factors {
                for &d in &factors {
                    if let Some(p) = v.checked_mul(m.into()) {
                        assert_eq!(
                            small(v).mul_div(m, d),
                            small(p / u128::from(d)),
                            "{v} * {m} / {d}"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn mul_div_through_320_bits() {
        // (2^256 - 1) * 2 / 2 needs the fifth limb on the way.
        assert_eq!(U256::MAX.mul_div(2, 2), U256::MAX);
        // (2^240 - 1) * 658,800 passes 2^256; divided by 109,800 it is (2^240 - 1) * 6.
        let max_target = U256::ones(240);
        let six = max_target
            .saturating_add(max_target)
            .saturating_add(max_target)
            .saturating_add(max_target)
            .saturating_add(max_target)
            .saturating_add(max_target);
        assert_eq!(max_target.mul_div(658_800, 109_800), six);
        // Halving and doubling.
        assert_eq!(U256([1, 0, 0, 1]).mul_div(1, 2), U256([0, 1 << 63, 0, 0]));
        assert_eq!(U256([1 << 63, 0, 0, 0]).mul_div(2, 1), U256::MAX);
        assert_eq!(
            U256([1 << 62, 0, 0, 1]).mul_div(2, 1),
            U256([1 << 63, 0, 0, 2])
        );
        assert_eq!(U256::MAX.mul_div(u64::MAX, 1), U256::MAX);
    }
}
