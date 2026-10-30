//! The state root (ADR 0011, docs/protocols/transactions.md): a sparse Merkle tree of depth 256
//! over (key, value) pairs. It never reads a value; the state root uses an account's hashed
//! bytes as the value of `state::tree_key(address)`.
//!
//! Storage keeps only what the root needs (a shortcut in storage, not in the hashes): an `Inner`
//! entry for each node whose subtree holds two or more keys, and one `Leaf` entry at the highest
//! node whose subtree holds a single key. A missing entry is an empty subtree. The entries depend
//! only on the set of keys, never on the order of changes.

use std::collections::HashMap;
use std::sync::OnceLock;

use crate::{Error, keccak256};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Node {
    /// A node whose subtree holds two or more keys.
    Inner { hash: [u8; 32] },
    /// The highest node whose subtree holds only `key`: its leaf hash, and that leaf folded up to
    /// this node with empty siblings.
    Leaf {
        key: [u8; 32],
        leaf: [u8; 32],
        hash: [u8; 32],
    },
}

impl Node {
    pub fn hash(&self) -> [u8; 32] {
        match self {
            Node::Inner { hash } | Node::Leaf { hash, .. } => *hash,
        }
    }
}

/// Where the entries live: the Node keeps them in its database, tests in a map.
pub trait SmtStore {
    /// The entry at `depth` on `path`, a key whose bits from `depth` on are zero.
    fn node(&self, depth: u16, path: &[u8; 32]) -> Option<Node>;
    /// Writes an entry, or removes it with `None`.
    fn set_node(&mut self, depth: u16, path: [u8; 32], node: Option<Node>);
}

impl SmtStore for HashMap<(u16, [u8; 32]), Node> {
    fn node(&self, depth: u16, path: &[u8; 32]) -> Option<Node> {
        self.get(&(depth, *path)).copied()
    }

    fn set_node(&mut self, depth: u16, path: [u8; 32], node: Option<Node>) {
        match node {
            Some(node) => self.insert((depth, path), node),
            None => self.remove(&(depth, path)),
        };
    }
}

/// `E[height]`: the hash of a subtree with no key. `E[0]` is 32 zero bytes, an empty leaf slot.
pub fn empty(height: u16) -> [u8; 32] {
    static TABLE: OnceLock<[[u8; 32]; 257]> = OnceLock::new();
    TABLE.get_or_init(|| {
        let mut table = [[0u8; 32]; 257];
        for h in 0..256 {
            table[h + 1] = node_hash(&table[h], &table[h]);
        }
        table
    })[usize::from(height)]
}

pub fn leaf_hash(key: &[u8; 32], value: &[u8]) -> [u8; 32] {
    keccak256(&[&[0x00], key, value])
}

fn node_hash(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    keccak256(&[&[0x01], left, right])
}

/// Bit `i` of `key`, from the top: a node at depth `i` goes left on 0 and right on 1.
fn bit(key: &[u8; 32], i: u16) -> u8 {
    (key[usize::from(i / 8)] >> (7 - i % 8)) & 1
}

/// The path to `key`'s node at `depth`: `key` with the bits from `depth` on set to zero.
fn path(key: &[u8; 32], depth: u16) -> [u8; 32] {
    let mut path = *key;
    let depth = usize::from(depth);
    if depth < 256 {
        path[depth / 8] &= !(0xff >> (depth % 8));
        path[depth / 8 + 1..].fill(0);
    }
    path
}

/// The node at `depth` on `key`'s path, from the hash of its child on that path and the other
/// child's hash.
fn join(key: &[u8; 32], depth: u16, mine: &[u8; 32], other: &[u8; 32]) -> [u8; 32] {
    match bit(key, depth) {
        0 => node_hash(mine, other),
        _ => node_hash(other, mine),
    }
}

/// One step of the fold rule: the node at `depth` above `hash`, with an empty other child.
fn up(key: &[u8; 32], hash: &[u8; 32], depth: u16) -> [u8; 32] {
    join(key, depth, hash, &empty(255 - depth))
}

/// The `Leaf` entry of a subtree at `depth` that holds only `key`.
fn single(key: &[u8; 32], leaf: [u8; 32], depth: u16) -> Node {
    let hash = (depth..256).rev().fold(leaf, |hash, d| up(key, &hash, d));
    Node::Leaf {
        key: *key,
        leaf,
        hash,
    }
}

fn hash_or_empty(node: Option<Node>, depth: u16) -> [u8; 32] {
    node.map_or(empty(256 - depth), |node| node.hash())
}

pub fn root(store: &impl SmtStore) -> [u8; 32] {
    hash_or_empty(store.node(0, &[0; 32]), 0)
}

/// Sets `key` to `value`, adding the key if it is new.
pub fn insert(store: &mut impl SmtStore, key: &[u8; 32], value: &[u8]) {
    set(store, 0, key, Some(leaf_hash(key, value)));
}

/// Removes `key`, if it is there. Only a Node undoing a Block removes keys: accounts are never
/// removed by a rule.
pub fn remove(store: &mut impl SmtStore, key: &[u8; 32]) {
    set(store, 0, key, None);
}

/// Changes the subtree at `depth` on `key`'s path so that `key` has the leaf hash `leaf` (or is
/// gone with `None`), writes its new entry and returns it.
fn set(
    store: &mut impl SmtStore,
    depth: u16,
    key: &[u8; 32],
    leaf: Option<[u8; 32]>,
) -> Option<Node> {
    let new = match (store.node(depth, &path(key, depth)), leaf) {
        (None, None) => return None,
        (None, Some(leaf)) => Some(single(key, leaf, depth)),
        (Some(Node::Leaf { key: other, .. }), leaf) if other == *key => {
            leaf.map(|leaf| single(key, leaf, depth))
        }
        (unchanged @ Some(Node::Leaf { .. }), None) => return unchanged,
        (
            Some(Node::Leaf {
                key: other,
                leaf: other_leaf,
                ..
            }),
            Some(leaf),
        ) => {
            // A second key: both leaves go below the first bit where the keys differ, and every
            // node from there up to `depth` holds both.
            let split = first_difference(key, &other);
            let (mine, theirs) = (
                single(key, leaf, split + 1),
                single(&other, other_leaf, split + 1),
            );
            store.set_node(split + 1, path(key, split + 1), Some(mine));
            store.set_node(split + 1, path(&other, split + 1), Some(theirs));
            let mut hash = join(key, split, &mine.hash(), &theirs.hash());
            for d in (depth..split).rev() {
                store.set_node(d + 1, path(key, d + 1), Some(Node::Inner { hash }));
                hash = up(key, &hash, d);
            }
            Some(Node::Inner { hash })
        }
        (Some(Node::Inner { .. }), leaf) => {
            let child = set(store, depth + 1, key, leaf);
            let mut sibling_path = path(key, depth + 1);
            sibling_path[usize::from(depth / 8)] ^= 0x80 >> (depth % 8);
            let sibling = store.node(depth + 1, &sibling_path);
            match (child, sibling) {
                // A removal left one key below: its leaf moves up to this node.
                (Some(Node::Leaf { key, leaf, hash }), None)
                | (None, Some(Node::Leaf { key, leaf, hash })) => {
                    store.set_node(depth + 1, path(&key, depth + 1), None);
                    Some(Node::Leaf {
                        key,
                        leaf,
                        hash: up(&key, &hash, depth),
                    })
                }
                (None, None) => None,
                (child, sibling) => Some(Node::Inner {
                    hash: join(
                        key,
                        depth,
                        &hash_or_empty(child, depth + 1),
                        &hash_or_empty(sibling, depth + 1),
                    ),
                }),
            }
        }
    };
    store.set_node(depth, path(key, depth), new);
    new
}

fn first_difference(a: &[u8; 32], b: &[u8; 32]) -> u16 {
    let i = (0..32).find(|&i| a[i] != b[i]).expect("two different keys");
    (i * 8) as u16 + (a[i] ^ b[i]).leading_zeros() as u16
}

/// Builds the tree of a state snapshot in `store`, which must be empty, and checks it against
/// `expected_root` (the state root of a Checkpoint's header). Keys must come in ascending order
/// as unsigned bytes, each once.
pub fn check_snapshot(
    store: &mut impl SmtStore,
    entries: impl IntoIterator<Item = ([u8; 32], Vec<u8>)>,
    expected_root: &[u8; 32],
) -> Result<(), Error> {
    debug_assert_eq!(
        root(store),
        empty(256),
        "a snapshot is built in an empty store"
    );
    let mut last: Option<[u8; 32]> = None;
    for (key, value) in entries {
        if last.is_some_and(|last| key <= last) {
            return Err(Error::SnapshotOrder);
        }
        insert(store, &key, &value);
        last = Some(key);
    }
    match root(store) == *expected_root {
        true => Ok(()),
        false => Err(Error::WrongStateRoot),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    type Store = HashMap<(u16, [u8; 32]), Node>;

    /// The definition, with no storage shortcut: the root of a full tree of depth 256.
    fn reference_root(leaves: &[([u8; 32], [u8; 32])], depth: u16) -> [u8; 32] {
        match leaves {
            [] => empty(256 - depth),
            [(_, leaf)] if depth == 256 => *leaf,
            _ => {
                let (left, right): (Vec<_>, Vec<_>) =
                    leaves.iter().partition(|(key, _)| bit(key, depth) == 0);
                node_hash(
                    &reference_root(&left, depth + 1),
                    &reference_root(&right, depth + 1),
                )
            }
        }
    }

    fn key(n: u32) -> [u8; 32] {
        keccak256(&[&n.to_be_bytes()])
    }

    fn with_bit_flipped(key: &[u8; 32], i: u16) -> [u8; 32] {
        let mut flipped = *key;
        flipped[usize::from(i / 8)] ^= 0x80 >> (i % 8);
        flipped
    }

    fn store_of(entries: &HashMap<[u8; 32], Vec<u8>>) -> Store {
        let mut store = Store::new();
        for (key, value) in entries {
            insert(&mut store, key, value);
        }
        store
    }

    #[test]
    fn empty_subtrees() {
        assert_eq!(empty(0), [0; 32]);
        assert_eq!(empty(1), keccak256(&[&[1], &[0; 32], &[0; 32]]));
        assert_eq!(root(&Store::new()), empty(256));
    }

    #[test]
    fn paths_and_bits() {
        let key = [0xff; 32];
        assert_eq!(path(&key, 0), [0; 32]);
        assert_eq!(path(&key, 256), key);
        let three = path(&key, 3);
        assert_eq!(three[0], 0b1110_0000);
        assert_eq!(three[1..], [0; 31]);
        assert_eq!(bit(&[0x80; 32], 0), 1);
        assert_eq!(bit(&[0x80; 32], 1), 0);
        assert_eq!(bit(&[0x01; 32], 255), 1);
        assert_eq!(first_difference(&key, &with_bit_flipped(&key, 100)), 100);
    }

    #[test]
    fn one_key_follows_the_fold_rule() {
        let (k, value) = (key(1), b"value");
        let mut store = Store::new();
        insert(&mut store, &k, value);
        let mut c = leaf_hash(&k, value);
        for j in 0..256u16 {
            c = match bit(&k, 255 - j) {
                0 => node_hash(&c, &empty(j)),
                _ => node_hash(&empty(j), &c),
            };
        }
        assert_eq!(root(&store), c);
        assert_eq!(store.len(), 1, "one Leaf entry at the root");
    }

    #[test]
    fn matches_the_reference_through_inserts_updates_and_removals() {
        let base = key(0);
        // Keys that share 255, 100, 8 and 0 bits with `base`, and random ones.
        let mut keys = vec![
            base,
            with_bit_flipped(&base, 255),
            with_bit_flipped(&base, 100),
            with_bit_flipped(&base, 8),
            with_bit_flipped(&base, 0),
        ];
        keys.extend((1..12).map(key));
        let mut entries: HashMap<[u8; 32], Vec<u8>> = HashMap::new();
        let mut store = Store::new();
        for step in 0..90u32 {
            let k = keys[keccak256(&[&step.to_be_bytes()])[0] as usize % keys.len()];
            if step % 3 == 2 {
                remove(&mut store, &k);
                entries.remove(&k);
            } else {
                let value = step.to_be_bytes().to_vec();
                insert(&mut store, &k, &value);
                entries.insert(k, value);
            }
            let leaves: Vec<_> = entries
                .iter()
                .map(|(key, value)| (*key, leaf_hash(key, value)))
                .collect();
            assert_eq!(root(&store), reference_root(&leaves, 0), "step {step}");
            assert_eq!(
                store,
                store_of(&entries),
                "step {step}: the entries depend only on the set"
            );
        }
    }

    #[test]
    fn insertion_order_does_not_matter() {
        let keys = [key(1), key(2), key(3)];
        let orders = [
            [0, 1, 2],
            [0, 2, 1],
            [1, 0, 2],
            [1, 2, 0],
            [2, 0, 1],
            [2, 1, 0],
        ];
        let stores: Vec<Store> = orders
            .iter()
            .map(|order| {
                let mut store = Store::new();
                for &i in order {
                    insert(&mut store, &keys[i], &[i as u8]);
                }
                store
            })
            .collect();
        assert!(stores.iter().all(|store| *store == stores[0]));
    }

    #[test]
    fn a_split_goes_down_to_the_first_differing_bit() {
        let a = key(7);
        let b = with_bit_flipped(&a, 200);
        let mut store = Store::new();
        insert(&mut store, &a, b"a");
        insert(&mut store, &b, b"b");
        // Inner entries at depths 0 to 200, and the two leaves at depth 201.
        assert_eq!(store.len(), 203);
        assert!(matches!(
            store.node(201, &path(&a, 201)),
            Some(Node::Leaf { .. })
        ));
        remove(&mut store, &b);
        let mut alone = Store::new();
        insert(&mut alone, &a, b"a");
        assert_eq!(store, alone);
        remove(&mut store, &a);
        assert!(store.is_empty());
    }

    #[test]
    fn snapshot_check() {
        let mut entries: Vec<([u8; 32], Vec<u8>)> =
            (0..5).map(|n| (key(n), vec![n as u8])).collect();
        entries.sort();
        let mut built = Store::new();
        for (key, value) in &entries {
            insert(&mut built, key, value);
        }
        let expected = root(&built);
        let check = |entries: Vec<([u8; 32], Vec<u8>)>| {
            check_snapshot(&mut Store::new(), entries, &expected)
        };
        assert_eq!(check(entries.clone()), Ok(()));
        assert_eq!(check(entries[1..].to_vec()), Err(Error::WrongStateRoot));
        let mut changed = entries.clone();
        changed[2].1 = vec![9];
        assert_eq!(check(changed), Err(Error::WrongStateRoot));
        let mut swapped = entries.clone();
        swapped.swap(1, 2);
        assert_eq!(check(swapped), Err(Error::SnapshotOrder));
        let mut repeated = entries.clone();
        repeated.insert(1, entries[1].clone());
        assert_eq!(check(repeated), Err(Error::SnapshotOrder));
    }

    /// `cargo test --release -p linked-realms-core -- --ignored --nocapture full_block`
    #[test]
    #[ignore = "a measurement, run in release"]
    fn full_block() {
        const ACCOUNTS: u32 = 100_000;
        let mut store = Store::new();
        let started = std::time::Instant::now();
        for n in 0..ACCOUNTS {
            insert(&mut store, &key(n), &[0; 82]);
        }
        let filled = started.elapsed();
        // A full Block: 397 senders, 397 new recipients and the reward address.
        let started = std::time::Instant::now();
        for n in 0..397 {
            insert(&mut store, &key(n * 251), &[1; 82]);
            insert(&mut store, &key(ACCOUNTS + n), &[2; 82]);
        }
        insert(&mut store, &key(ACCOUNTS + 1000), &[3; 82]);
        let block = started.elapsed();
        println!(
            "{ACCOUNTS} accounts in {filled:?}; one full Block (795 changes) in {block:?}; {:.2} entries per account",
            store.len() as f64 / f64::from(ACCOUNTS + 398)
        );
    }
}
