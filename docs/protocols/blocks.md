# Blocks

Status: mandatory (ADR 0006, ADR 0011). Every Node computes the Retarget exactly this way. The reference implementation is `crates/core` (`retarget.rs`, `u256.rs`); the vectors are `crates/core/test-vectors/chain.json` (`retarget`). The header and the checks of a Block join this document with plan item 5.

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

`N` and both clamps below are provisional until the simulation of plan item 6; the initial Targets come from plan item 9 (ADR 0012).

The Target of the Block at height `h`:

- If the Retarget is off, or `h <= N`: the initial Target.
- Otherwise it reads the `N + 1` headers at heights `h - N - 1` to `h - 1`; at `h = N + 1` they start at the genesis. Number them 0 (the oldest) to `N` (the parent). Then:
  1. For `i` from 1 to `N`, the solvetime `s_i` is header `i`'s timestamp minus header `i - 1`'s, as a signed number (timestamps may go backwards), clamped to at least 1 and at most `6T`.
  2. `weighted = 1·s_1 + 2·s_2 + … + N·s_N`, so the newest solvetime weighs most.
  3. `sum` is the sum of the Targets of headers 1 to `N`. Header 0's Target is not read.
  4. `next = floor(floor(sum / N) · weighted / k)`, with `k = T · N(N + 1) / 2` (109,800). The two roundings happen in this order.
  5. With `parent` the Target of header `N`, `next` is raised to at least `max(floor(parent / 2), 1)`, then lowered to at most `min(2 · parent, maximum Target)`.

Solvetimes of exactly `T` give `weighted = k`, so equal Targets stay the same.

**Sizes.** With valid headers (Targets at most `2^240 - 1`; timestamps at most `2^62`, a header rule of plan item 5), `sum` is below `2^246`, `weighted` is at most 658,800, and `floor(sum / N) · weighted` can pass `2^256`, so that product needs at least 320 bits; `next` stays below `2^243`. A difference of two timestamps fits in a signed 64-bit number.
