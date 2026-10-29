//! `tx_root` (ADR 0011): a binary Merkle tree over a Block's transaction ids, in Block order.

use crate::keccak256;

/// Leaves are `keccak256(0x00 ‖ id)` and inner nodes `keccak256(0x01 ‖ left ‖ right)`, so a leaf
/// never passes for a node. An odd node at the end of a level moves up unchanged: Bitcoin pairs it
/// with itself, which gives two different lists of transactions the same root. With no
/// transactions the root is `keccak256("")`.
pub fn tx_root(ids: &[[u8; 32]]) -> [u8; 32] {
    let mut level: Vec<[u8; 32]> = ids.iter().map(|id| keccak256(&[&[0x00], id])).collect();
    if level.is_empty() {
        return keccak256(&[]);
    }
    while level.len() > 1 {
        level = level
            .chunks(2)
            .map(|pair| match pair {
                [left, right] => keccak256(&[&[0x01], left, right]),
                _ => pair[0],
            })
            .collect();
    }
    level[0]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn leaf(id: &[u8; 32]) -> [u8; 32] {
        keccak256(&[&[0x00], id])
    }

    fn node(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
        keccak256(&[&[0x01], left, right])
    }

    #[test]
    fn empty_is_the_hash_of_nothing() {
        let expected = "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470";
        assert_eq!(hex::encode(tx_root(&[])), expected);
    }

    #[test]
    fn small_trees() {
        let [a, b, c, d, e] = [1u8, 2, 3, 4, 5].map(|i| [i; 32]);
        assert_eq!(tx_root(&[a]), leaf(&a));
        assert_eq!(tx_root(&[a, b]), node(&leaf(&a), &leaf(&b)));
        let ab = node(&leaf(&a), &leaf(&b));
        let cd = node(&leaf(&c), &leaf(&d));
        assert_eq!(tx_root(&[a, b, c]), node(&ab, &leaf(&c)));
        assert_eq!(tx_root(&[a, b, c, d]), node(&ab, &cd));
        assert_eq!(tx_root(&[a, b, c, d, e]), node(&node(&ab, &cd), &leaf(&e)));
    }

    #[test]
    fn the_odd_node_is_not_duplicated() {
        let [a, b, c] = [1u8, 2, 3].map(|i| [i; 32]);
        assert_ne!(tx_root(&[a, b, c]), tx_root(&[a, b, c, c]));
        assert_ne!(tx_root(&[a, b]), tx_root(&[b, a]));
    }
}
