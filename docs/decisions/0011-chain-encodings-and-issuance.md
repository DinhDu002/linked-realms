# 0011 — Chain encodings and issuance

Status: accepted, 2026-10-30 — by the project owner, with the step 2C plan (`docs/plans/phase-2c-the-chain.md`, answers 1 and 2)

## Context

Step 2C writes the chain rules in `crates/core` (P9). Transaction ids, signatures and Merkle roots are hashes of bytes, so the Node, the Mine and the Shell must write every field the same way, byte for byte, or they disagree about which Blocks are valid. ADR 0006 fixed the issuance in GOLD; the chain needs it in exact integers, with a genesis height that makes the totals come out exactly. Once the test network has Blocks, changing any of this means resetting it.

## Decisions

1. **Hand-written byte layouts, big-endian, fixed width.**
   - Fields follow one another in a fixed order. Integers are big-endian (`u8`, `u32`, `u64`). Only the memo has a length (one byte before it); every other length is fixed or follows from a scheme id.
   - A reader refuses bytes that end before the last field and bytes left over after it (`codec::Reader`), so one value has exactly one encoding.
   - Rejected: a serialization library (`serde`, `bincode`, Protocol Buffers). Its format is not ours to pin, and a hash of its output would change with it.
   - Rejected: little-endian, as in Bitcoin. Big-endian reads in the order it is written and compares a Target as bytes.
2. **An address on the chain is its 34-byte payload.**
   - `version 0 ‖ scheme ‖ keccak256(scheme ‖ public key)`: the same bytes the Bech32m text carries (ADR 0009, `docs/protocols/identity.md`).
   - An unknown version or scheme is refused, as in the text form.
3. **Networks have ids, and every signature binds one.**
   - `testnet` is 1 and `dev` is 2. There is no id for a main network (P7). Each network is a `ChainParams` value, passed to the rules instead of global constants; the genesis, the Targets and the Checkpoint signer's key join it in later items.
   - The network id (`u32`) is the first field of the signed bytes of every transaction and every Checkpoint, and is not stored in them. A Character's key survives a reset of the test network and also signs on the dev network, so a transaction signed for one network must not verify on another.
4. **A transaction's id is the keccak256 of its signed bytes.**
   - The id includes the network id and leaves out the signature. ML-DSA signatures are hedged (fresh random bytes each time), so an id over the signature would change each time the same transaction is signed.
   - The layout, the checks and how a transaction changes the accounts are in `docs/protocols/transactions.md`, which follows decisions 1 to 3.
   - A sender must already have an account, that is, must have received Gold. Otherwise a transaction with a fee of 0 could make accounts that never held any Gold. (Chosen while building plan item 2; waiting for the project owner's confirmation.)
5. **Heights and issuance.**
   - The genesis Block is height 0 and pays nothing; the first mined Block is height 1.
   - 1 GOLD is 100,000,000 base units, in a `u64`.
   - `reward(h) = 500_000_000 >> min((h - 1) / 2_100_000, 4)` base units for `h >= 1`: 5 GOLD up to height 2,100,000, then 2.5, 1.25 and 0.625, and 0.3125 GOLD per Block forever from height 8,400,001. 500,000,000 / 16 is exact, so no rounding happens anywhere.
   - Halvings count from height 1, so each era before the tail has exactly 2,100,000 paying Blocks and the total before the tail is exactly 19,687,500 GOLD (1,968,750,000,000,000 base units), as ADR 0006 says. Rejected: counting from height 0, which leaves the first era one paying Block short.
   - A Block's reward address gets the reward plus the Block's fees, applied after all the Block's transactions. There is no coinbase transaction.
6. **`tx_root` is a binary Merkle tree over the Block's transaction ids, in Block order.**
   - Leaf `keccak256(0x00 ‖ id)`, inner node `keccak256(0x01 ‖ left ‖ right)`, so a leaf never passes for a node. With no transactions the root is `keccak256("")`.
   - An odd node at the end of a level moves up unchanged. Rejected: pairing it with itself, as Bitcoin does, which gives two different lists of transactions the same root.
   - The state root, a sparse Merkle tree (plan answer 5), and the bound on state growth are added here with the tree's code (plan item 3).

## Consequences

- `crates/core/test-vectors/chain.json` holds vectors for all of this; Rust checks them byte for byte, and the TypeScript side reads the same file from plan item 10.
- Amounts in vectors and APIs are decimal strings of base units, because JavaScript numbers are exact only up to 2^53.
- A Node in another language can be written from this ADR, the plan's layouts and the vectors.
