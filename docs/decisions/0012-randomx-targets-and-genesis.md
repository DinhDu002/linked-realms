# 0012 — RandomX, the Targets, the genesis and Checkpoints

Status: accepted, 2026-10-30 — by the project owner, in step 2C item 9 (plan `docs/plans/phase-2c-the-chain.md`, Answers 4, 17 and 18, and three questions put at item 9).

## Context

ADR 0006 chose RandomX v2 and Checkpoints, and ADR 0011 the byte layouts. The step 2C plan left these values to item 9: the RandomX pin, the key schedule, the Targets (measured, not guessed), the genesis, the Checkpoint signer's key, and how a reset of the test network stops old transactions from being replayed. Item 6 had already set the Retarget's window by simulation, item 7 built the RandomX binding, and item 8 its toolchain. What is written here is permanent only for the test and dev networks; the main network takes its own values at item 29 (ADR 0015).

## Decisions

1. **RandomX v2.0.1, vendored and built from source.**
   - Tag `v2.0.1`, commit `aaafe71322df6602c21a5c72937ac284724ae561` (the tag resolves to it), in `crates/randomx/vendor/` byte for byte. `the_vendored_tree_is_unchanged` holds the SHA-256 listing of the tree, the same as the release's source gives. `build.rs` builds it with CMake (`ARCH=default`, Release, only the `randomx` target); nothing is downloaded at build time.
   - Every VM has the V2 flag, set in the one function that creates a VM: without it RandomX silently computes v1 hashes.
   - Supply chain: the pinned tree is the whole trust in RandomX's code, and a change to it fails the checksum test, so it is a reviewed commit. A change that alters hashes is a network upgrade. The compilers are not pinned to a build but to releases: Ubuntu 24.04's CMake 3.28.3 and GCC 13 in CI, Alpine 3.24's CMake 4.2 and g++ 15.2 in the image (item 8). The official vectors and our header vector run in every mode, on x86 and ARM, with glibc and musl, so a compiler that hashes wrongly fails CI. Versions before 2.0.1 can hash wrongly on ARM and RISC-V (the RandomX README says about 1 in 268 million; that figure is **UNVERIFIED**), which would split x86 and ARM Nodes.
   - Rejected: `randomx-rs` (1.6.0 has no V2 flag), a git submodule or a download at build time (the network at build time, and a tag can move).
2. **Key schedule.**
   - `key_height(h) = 0` for `h < 2112`, else `floor((h - 64) / 2048) · 2048`; the key is the id of the Block at that height on the chain being checked. A key lasts 2048 Blocks, about 34 hours at 60 seconds, and is used from 64 Blocks after its Block, about an hour, far deeper than any reorganisation Checkpoints allow.
   - Monero's `rx_seedheight` (`src/crypto/rx-slow-hash.c`, read at item 9) gives 0 up to height 2112 and `(h - 65)` rounded down to a multiple of 2048 after, so it switches one Block later, at 2113. We keep the plan's formula; `chain.json` fixes it at heights 0, 1, 2111, 2112, 4159 and 4160 (keys 0, 0, 0, 2048, 2048, 4096).
3. **The Retarget's values**, set by item 6's simulation: `T = 60` seconds, `N = 60`, the result clamped to half and double the parent's Target, and timestamps counted as LWMA-1 counts them (`docs/protocols/blocks.md`).
4. **The Targets come from a measurement on the reference machine** (Answer 18), the project owner's Apple M5 (10 cores, 32 GB), with the JIT and one `randomx_calculate_hash` call a hash (`crates/randomx`, test `hash_rate`):

   | Mode | 1 thread | 10 threads |
   |---|---|---|
   | fast | 774 H/s | 5,078 H/s (508 a thread) |
   | light | 73 H/s | 548 H/s |

   The Cache took 0.27 seconds, the Dataset 3.1 seconds on 10 threads. A Node verifying a Block in light mode spends about 14 milliseconds on its Proof of Work.
   - **Test network:** the maximum Target stays `2^240 - 1`, about 65,536 hashes a Block at the easiest: about 13 seconds for the M5 on every thread in fast mode, 85 seconds on one fast thread, 15 minutes on one light thread. The initial Target is that maximum, about 4.6 times easier than the M5 on every thread in fast mode needs for 60 seconds, as Answer 18 asks ("easier than measured"); the Retarget makes it harder from height 61. An easier maximum would only matter if the hash rate fell below one fast thread.
   - **Dev network:** maximum and initial Target `2^246 - 1`, about 1,024 hashes a Block, with the Retarget off: about 1.3 seconds on one fast thread and 14 seconds on one light thread of the M5. A Block must be stamped after the median of the last 11, so Blocks much faster than one a second push timestamps ahead of the clock until Nodes refuse them (300 seconds ahead); this Target keeps clear of that.
   - Rejected: `2^240 - 1` on the dev network too (Blocks of 13 seconds to minutes in tests), and `2^244 - 1` (about 5 and 56 seconds).
5. **The genesis** is fixed by each network's values: version 1, height 0, a zero `prev_id` and nonce, the genesis timestamp, the initial Target, the `tx_root` of no transaction, the state root of no account (`E[256]`), and a reward address nobody holds (version 0, scheme 1, a zero hash). It holds no transaction, pays nothing and needs no Proof of Work. Both networks are stamped 2026-10-30 00:00 UTC (1,793,318,400); their Targets differ, so their genesis ids differ. `block::check_genesis` refuses any other Block at height 0 (`WrongGenesis`).
6. **A reset takes a new network id.** The network id is the first field of every signed transaction and Checkpoint, so a transaction signed before a reset does not verify after it. The test network is id 1 today; a reset takes the next unused id (3, then 4…), and a new genesis timestamp, since the header holds no network id and an unchanged genesis would let old Blocks without transactions back in. The main network is never reset (ADR 0015).
   - Rejected: the genesis id in the signed bytes of every transaction and Checkpoint. It works by itself after every reset, but changes ADR 0011's format and makes the main network carry 32 more signed bytes forever for a test-network concern.
7. **Checkpoints.**
   - The signer signs `network_id (u32) ‖ height (u64) ‖ block_id` with ML-DSA-44 under the context `linked-realms/checkpoint/v1`, at heights that are multiples of 10. `checkpoint::verify_checkpoint` checks the height and the signature against the network's key; `branch_matches_checkpoint` says whether a branch holds the named Block (a branch that does not reach that height does not). Choosing a branch is the Node's (item 11).
   - **The test network's key is the project owner's** (ADR 0015), made at item 9 by `crates/core/examples/checkpoint_key.rs` on the project owner's machine: 32 bytes from `/dev/urandom`, written as 24 BIP-39 words to a file that only its owner may read and that the command never overwrites; the key is ML-DSA-44 with those 32 bytes as its seed `xi`, so the words alone restore it. Only the public key enters the repository (`crates/core/keys/testnet-checkpoint.hex`). At item 18 the words go to the signer's machine, never to an image or to the carthings server.
   - The dev network's key comes from a published seed, 32 bytes `0x02` (`params::DEV_CHECKPOINT_SEED`), so anyone can sign dev Checkpoints in tests.
   - Rejected: a provisional test-network key until item 18; the project owner chose to make the real key now.

## Consequences

- The project owner keeps the words file safe from item 9 until the signer runs at item 18, and after. If it is lost, only a network upgrade replaces the key; on the test network, a reset.
- Each reset of the test network uses up a network id. Ids are 32 bits, and the test network stops once the main network starts.
- The measurements are one machine's, with one hash a call: the Mine's pipelined calls (item 16) and other machines give other rates. Hash rates on the Docker host and an ARM board are still to be measured (plan, Verification 5).
- `chain.json` now holds the networks' genesis and keys, the key function's edges, the genesis check and Checkpoint cases (`crates/core/test-vectors/README.md`); `crates/randomx` holds a header hashed under its genesis id, which every mode and CI machine must agree on.
- The main network's maximum and initial Targets, genesis, key and id are decided at item 29, with these numbers as a start.
