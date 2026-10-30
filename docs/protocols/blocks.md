# Blocks

Status: mandatory (ADR 0006, ADR 0011, ADR 0015). Every Node reads and checks Blocks and computes the Retarget exactly this way. The reference implementation is `crates/core` (`block.rs`, `retarget.rs`, `u256.rs`); the vectors are `crates/core/test-vectors/chain.json` (`blocks` and `retarget`).

## Header

A header is 187 bytes, integers big-endian, in this order:

| Field | Bytes | |
|---|---|---|
| `version` | 1 | 1 |
| `height` | 8 | the genesis is height 0 |
| `prev_id` | 32 | the parent's id; 32 zero bytes in the genesis |
| `timestamp` | 8 | Unix seconds |
| `target` | 32 | see "Target" |
| `tx_root` | 32 | the root of the Block's transaction ids (`docs/protocols/transactions.md`) |
| `state_root` | 32 | the state root after this Block (`docs/protocols/transactions.md`) |
| `reward_address` | 34 | an address's bytes (ADR 0011 decision 2) |
| `nonce` | 8 | the last 8 bytes, at offset 179: the only bytes a Mine changes |

A Block's id is `keccak256(header)`. Its Proof-of-Work hash is RandomX v2 over the same 187 bytes, with the key below, read as a 256-bit big-endian number; the nonce is a Solution when that number is below `target`. The id is not the Proof-of-Work hash, so it cannot be mined lower by chance.

**RandomX key.** The key of the Block at height `h` is the id of the Block at height `key_height(h)` on the same chain: 0 for `h < 2112`, otherwise `floor((h - 64) / 2048) · 2048`. A key changes every 2048 Blocks and is used from 64 Blocks after its Block. This follows Monero's pattern, not checked against Monero's code (**UNVERIFIED**); plan item 9 fixes its edges in ADR 0012, with vectors.

## Block

A Block is its header, then `tx_count` (`u16`), then that many transactions (`docs/protocols/transactions.md`) one after another. A transaction's own fields tell where it ends, so no length comes before it. A whole Block is at most 1,000,000 bytes, and it may have no transactions. There is no coinbase transaction: the reward is credited by a rule (check 5).

## Checks

A Node checks a Block on top of its parent and against the accounts after the parent, in this order, cheap checks first; the first check that fails gives the error, and a refused Block changes nothing.

1. **Reading.** More than 1,000,000 bytes is refused before anything is read (`BlockTooLarge`). Then the fields are read in order: `version` must be 1 (`UnknownVersion`), `reward_address` a valid address (`BadAddress`, `UnknownScheme`), and each transaction must read (its own errors). Bytes that end before `tx_count` transactions are read give `Truncated`; bytes left after them give `TrailingBytes`.
2. **Parent.** `height` is the parent's height plus 1 (`WrongHeight`), and `prev_id` is the parent's id (`WrongParent`).
3. **Timestamp and Target.** `timestamp` is at most `2^62` (`TimestampTooLate`) and greater than the median of the last 11 (`TimestampTooEarly`, below). `target` equals the Target the Retarget gives for this height (`WrongTarget`), which is always between 1 and the maximum Target.
4. **Proof of Work.** The Proof-of-Work hash is below `target` (`InsufficientWork`). It is the expensive check of the header, so it runs before the transactions.
5. **Transactions, reward and state.** `tx_root` is the root of the transaction ids in Block order (`WrongTxRoot`). Each transaction in order is then checked and applied as `docs/protocols/transactions.md` says (its errors). After all of them, the reward address is credited `reward(height)` plus the Block's fees, so a reward address that also sends in the Block cannot spend that credit there. A sum past `2^64 - 1` gives `Overflow`. After each transaction and after the credit, the Block may have created at most 50 Accounts (`TooManyNewAccounts`, "New Accounts" below). Last, `state_root` is the state root of the accounts after the Block (`WrongStateRoot`).

**The genesis** (height 0) is checked by no rule. A Node starts from the genesis in its network's values and accepts only Blocks on top of it; the genesis and its check arrive with plan item 9.

**Median of the last 11.** Take the timestamps of the Blocks at heights `max(0, h - 11)` to `h - 1`, sort them, and take the one at position `floor(count / 2)`, counting from 0. Below height 11 there are fewer than 11; with an even number, this is the later of the two in the middle.

**Clock.** A Node also refuses any Block whose timestamp is more than 300 seconds ahead of its own clock: a new tip, an ancestor arriving with one, or a Block fetched during sync, whose old timestamp passes. It does not mark such a Block invalid, and takes it once its clock has caught up. That is a Node's policy, not a rule here: it needs a clock. The Retarget relies on it: a timestamp ahead of the real time makes the Blocks after it count 1 second each until a timestamp passes it (Retarget, step 1), which makes the Target harder. Within 300 seconds that is a few Blocks. Checking only the tip is not enough: a Block stamped a day ahead, followed by one stamped at the real time, would hold the chain back for about a day.

## New Accounts

A Block creates at most 50 Accounts (ADR 0015): the number of Accounts after the Block minus the number before it, the reward address included when it had no Account. Accounts are never removed, so this is the number of addresses the Block gives an Account. It is counted after each transaction and after the reward credit, so a Block stops at the transaction that creates the 51st. At 1,440 Blocks a day that is at most 72,000 new Accounts a day.

## Target

A Target is a 256-bit unsigned number, written as 32 bytes big-endian. A Solution's hash, read the same way, must be below it, so a lower Target is harder. Every Target in a header is at least 1 and at most the network's maximum Target, `2^240 - 1`.

## Retarget

Each network fixes:

| Value | Test network | Dev network |
|---|---|---|
| `T`, the goal time between Blocks | 60 seconds | 60 seconds |
| `N`, the window | 60 Blocks | 60 Blocks |
| maximum Target | `2^240 - 1` | `2^240 - 1` |
| initial Target | set by plan item 9 | set by plan item 9 |
| Retarget | on | off |

`N` and the clamps below were set by the simulation of plan item 6 (`crates/core/tests/retarget_simulation.rs`); the initial Targets come from plan item 9 (ADR 0012).

The Target of the Block at height `h`:

- If the Retarget is off, or `h <= N`: the initial Target.
- Otherwise it reads the `N + 1` headers at heights `h - N - 1` to `h - 1`; at `h = N + 1` they start at the genesis. Number them 0 (the oldest) to `N` (the parent). Then:
  1. Count the timestamps in order: `c_0` is header 0's timestamp, and for `i` from 1 to `N`, `c_i` is header `i`'s timestamp, or `c_(i-1) + 1` if that is larger. The solvetime `s_i` is `c_i - c_(i-1)`, lowered to at most `6T`; it is at least 1. A timestamp at or below the one counted before it counts as 1 second after it, and the next solvetime starts from there, so time taken from one Block is given back to the next and timestamps out of order cannot add time to the window (zawy12's LWMA-1).
  2. `weighted = 1·s_1 + 2·s_2 + … + N·s_N`, so the newest solvetime weighs most.
  3. `sum` is the sum of the Targets of headers 1 to `N`. Header 0's Target is not read.
  4. `next = floor(floor(sum / N) · weighted / k)`, with `k = T · N(N + 1) / 2` (109,800). The two roundings happen in this order.
  5. With `parent` the Target of header `N`, `next` is raised to at least `max(floor(parent / 2), 1)`, then lowered to at most `min(2 · parent, maximum Target)`.

Solvetimes of exactly `T` give `weighted = k`, so equal Targets stay the same.

**Sizes.** With valid headers (Targets at most `2^240 - 1`; timestamps at most `2^62`, check 3), `sum` is below `2^246`, `weighted` is at most 658,800, and `floor(sum / N) · weighted` can pass `2^256`, so that product needs at least 320 bits; `next` stays below `2^243`. A counted timestamp is at most `2^62 + N`, so it fits in an unsigned 64-bit number.
