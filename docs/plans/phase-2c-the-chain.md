# Step 2C — The chain

Status: approved, 2026-10-30, by the project owner. Nothing below is built. The project owner chose the recommended option of every question except 5 (a sparse Merkle tree for the state root now), 13 (seed node, Public node and archive as a separate compose project on the carthings server, the Checkpoint signer on a separate machine), 19 (their own answer, "No Land, no Mine": no standalone Mine) and 22 (no `MIN_NEW_ACCOUNT`; the state-growth bound is recorded and accepted on the test network). Question 20 was put again at their request, and the answer stayed: keep PLAN.md 2C's order. Work branches are stacked, one per item, on top of `phase-2/2b-world` (see "Order of work" and Answer 21).

**Done when** (PLAN.md section 6, step 2C): on the test network, at least 3 Players on 3 different machines each host a Land, run a Mine that wins Blocks, send Gold to each other through the Shell, and walk into each other's Lands.

Decisions come from ADR 0006 (the own chain), ADR 0007 (the world off the chain), ADR 0009 (identities and signed statements) and ADR 0010 (a Land from one command), and principles P1, P2, P3, P4, P5, P6, P9 and P10. Encodings in "`crates/core` additions" are hard to reverse once a network runs: they are frozen by vectors and then reused by the Node, the Mine and the Shell (P9). They go into ADR 0011 once approved. The test network may be reset, so vectors, `chain.json` and the genesis may be regenerated before the Done-when check; after that they change only by a network upgrade.

Marks: **UNVERIFIED** means a fact I could not check offline or in the tree. It is carried as an open check instead of being stated as fact.

## Project owner decisions of 2026-10-30 (already decided)

1. **The Mine's switch lives in the Land.** The Land owner, in their own Land, taps the Mine to switch it on or off and to choose the CPU threads. The request is signed with the Character key through the Shell's signing prompt (P6, the existing `signMessage` of `docs/protocols/shell-land-ui.md`). The Map server checks that the signature is the Land owner's and tells the Mine. It works from a phone through the relay.
2. **Everyone in the Land sees a win.** While mining, the Mine on the map is animated (P5: it shows clearly that it is mining). When the Mine wins a Block it flashes and "+N GOLD" rises, where N is the Block reward at that height plus the Block's fees ("+5" only in era 0 with no fees; never a constant).
3. **Build order follows PLAN.md 2C as listed:** `crates/core` chain rules, then `crates/node`, then the Mine, then company services, the Shell, the Docker stack, the dashboard and the simulation. See "Order of work" for how small pieces that do not depend on the Node are placed.

## Flows

1. **Mining a Block.**
   1. The Mine asks its Node for a Block template for a reward address. The Node returns the header without the Solution, the Target, the RandomX key and the transactions chosen by fee rate.
   2. Mine threads change the nonce (the last 8 bytes of the header) and hash the header with RandomX v2. A hash below the Target is a Solution.
   3. The Mine submits the Block to its Node. The Node checks it like any Block (P3): Proof of Work, transactions, state root. If it is valid and in the best chain, the Node broadcasts it.
   4. A new tip from another Node makes the Mine drop its template and ask for a new one.
   5. The reward and the fees go to the address in the header. No key is involved (P2, ADR 0006 decision 11).
2. **The Land owner switches the Mine in the Land.** (decision 1)
   1. The Map server sends everyone `MineState` after `welcome` and on every change. The Land owner's session copy also holds that session's `challenge` and the `Map server key` to put in the text.
   2. The Land owner (the Land UI knows `isOwner`) taps the Mine. The Land UI asks for on or off, and for threads from 1 to `maxThreads`.
   3. The Land UI sends the Shell `signMessage` with one line of text (see "Switch statement").
   4. The Shell shows its prompt outside the frame, with its 1 second armed delay. On Approve it returns the signed `linked-realms Land message`.
   5. The Land UI sends it to the Map server as `MineSwitch`.
   6. The Map server runs the checks below. If they pass, it calls `mine_start` or `mine_stop` on its Node over the authenticated control path (see "The Mine"), then answers `MineSwitchResult` and broadcasts the new `MineState`.
   - Every switch costs one prompt. If the Player denies, the Shell's limits (busy 10 seconds, blocked after 3 refusals) apply and the UI says so in plain words.
   - A restart of the Node or the container leaves the Mine off (P5). Nothing "on" is stored.
3. **Everyone sees a won Block.** (decision 2)
   1. A Mine's own `submit` (flow 1, step 3) produced a Block; the Node remembers its Block id against that Mine. When the Node accepts a Block with that id into its best chain, the Mine has won. Attribution is by Block id, not by reward address: addresses are public, so a Block from another Node, or from the Land owner's second machine, that names the same address is not a win of this Mine and flashes nothing here.
   2. The Node sends `mine_blockFound { id, height, hash, reward, rewardAddress, time }` (`id` is the Mine id) to the Map server.
   3. The Map server broadcasts `MineWon { height, reward, rewardAddress }` to every connected client.
   4. Every Land UI plays the ring and the rising "+N GOLD", and puts a line in the HUD.
   - `reward` is the Block reward at that height plus the Block's fees, from the Node. The Land UI formats it with trailing zeros trimmed.
   - One Mine per Land (id `land`) wins only the Blocks its own `submit` produced, and reports under its id; the Land shows that Mine.
   - **What a visitor can trust:** nothing here. A Land can fake `MineState` and `MineWon` (P1: Land servers are not trusted), so a visitor cannot verify that a Mine runs or won. The P5 claim is limited to what the Land owner sees from their own Node (its console log and `mine_status`, which report what is really running). The HUD and the flash are the Land's statement, not proof; Gold is only what the chain says.
4. **Sending Gold.**
   1. In the Shell, the Player enters a recipient, an amount (up to 8 decimals) and an optional memo (at most 80 bytes). The Shell reads the sender's balance and nonce from the Public node (`lr_getAccount`) and the fee rate (`lr_estimateFee`).
   2. The Shell builds the transaction in WASM, shows the amount, the full recipient address, the memo and the fee in a prompt of its own, and signs only on Approve.
   3. The Shell sends it with `lr_sendTransaction`. The Node checks it, puts it in its mempool and relays it.
   4. A Mine includes it in a Block. The Shell shows it as confirmed once a Block holds it.
   - A Land can ask for the same flow with `pay { id, amount, recipient, memo }`. The Shell shows its own prompt, and the Land only learns the result.
5. **A Node joining the network.**
   1. The Node dials the seed Nodes of its configuration (about 8 outbound connections to other Nodes) and exchanges `version`.
   2. It takes the latest Checkpoint, fetches headers up to it, and checks Proof of Work and the Checkpoint signature.
   3. It fetches a state snapshot (the accounts at the Checkpoint height, in key order and in chunks; not a Checkpoint), builds the state tree from it, checks the root against the state root in the Checkpoint's header, and fetches Blocks after it.
   4. It then follows the tip. It keeps headers forever and Block bodies from the latest Checkpoint upward (plus a margin).
6. **Checkpoints.**
   1. The Checkpoint signer watches a Public node. Every 10 Blocks it signs the Block at height `H` where `H` is a multiple of 10 and `H` is at least `CHECKPOINT_LAG` Blocks below the tip.
   2. It publishes the signature with `lr_submitCheckpoint`. Anyone may call it, because the Node checks the signature.
   3. Nodes get Checkpoints by P2P `checkpoint`, by `getcheckpoint` after `version`, or by RPC. One for a header not yet known is held and applied when the header arrives.
   4. A Node never accepts a chain whose block at a Checkpoint height differs from the Checkpoint. If the current tip's branch contradicts a Checkpoint, it switches to the checkpointed branch once its Blocks are fetched, even with less work.

## `crates/core` additions

Core stays pure (no I/O, no clock, no threads) and keeps building to WASM. Everything is a hand-written byte layout, because `serde` is only a dev-dependency (`crates/core/Cargo.toml:28-30`) and ids and Merkle roots hash these bytes. All integers are big-endian and fixed width. Byte strings are length-prefixed only for the memo.

New modules: `codec`, `tx`, `state`, `merkle` (for `tx_root`), `smt` (the state root), `block`, `issuance`, `retarget`, `u256`, `checkpoint`, `params`.

### Chain parameters (`params`)

No chain constant is a global. A `ChainParams` value is chosen by network id and passed into `validate_block`, `next_target`, `verify_checkpoint` and the Node. Fields: `network_id: u32`, `magic`, genesis header, `initial_target`, `max_target`, `checkpoint_signer_key`, `T`, `N`, `retarget_enabled`. Only two networks exist: `testnet` (id 1) and `dev` (id 2). There is no main network (P7), and no id for one. `dev` has an easy `initial_target`, its own Checkpoint key from a published test seed, and `retarget_enabled = false` (the Target stays fixed, so the `world` profile and the e2e test keep producing Blocks quickly). `MAX_TARGET` is `2^240 - 1` for both networks; every header Target must be nonzero and at most `max_target`. Existing `lib.rs` gains `Address::to_bytes()` and `Address::from_bytes()` for the 34-byte payload (`version 0 ‖ scheme ‖ hash`); there is no raw form today (`crates/core/src/lib.rs:161-236`).

### Transaction

```
version    u8    = 1
kind       u8    0 transfer, 1 key rotation
scheme     u8    signing scheme of this transaction (1 = ML-DSA-44)
sender     34 B  address payload
nonce      u64
fee        u64
kind 0:  to 34 B, amount u64, memo_len u8 (<= 80), memo bytes
kind 1:  new_scheme u8, new_public_key (length implied by new_scheme; 1312 B for 1)
has_pk     u8    0 or 1; if 1, public_key (1312 B)
signature  2420 B (length implied by scheme)
```

- **Signing bytes:** `network_id (u32) ‖` every field above except the signature. The network id is not stored in the transaction; it comes from the `ChainParams` of the Node or the Shell, so a transaction signed for one network does not verify on another (Shell keys persist across test network resets and the dev network). The signature is ML-DSA-44 under the context `linked-realms/tx/v1` (one context; `kind` is inside the signed bytes). It differs from every statement context (`linked-realms/<name>/v1`). The WASM `sign` takes the context as a string, so this works unchanged.
- **Transaction id:** `keccak256(signing bytes)`, so it also binds the network. It excludes the signature, so hedged signatures (random `rnd`) cannot change an id.
- **Size:** a transfer without a public key is `2517 + memo` bytes, with one `3829 + memo`. So about 397 non-first transfers fit in 1,000,000 bytes (ADR 0006 says about 400).
- **Public key rule:** the sender's first transaction must have `has_pk = 1` and `address_of(public_key) == sender`. The account then stores the key. Every later transaction must have `has_pk = 0`.
- **Key rotation:** signed with the stored key; if the account has no key yet (rotation as the sender's first transaction), it must carry `has_pk = 1` with `address_of(public_key) == sender`, and is signed with that key. Either way, rotation sets the stored key to `new_public_key` and increments the nonce. The address does not change. From then on verification uses the stored key, not the address hash. Rotation does not rescue a stolen key (whoever holds it can rotate first); it exists for scheme upgrades (P10).
- **Checks** (`check_tx(&impl StateView, &Tx)`):
  - `version == 1`, scheme known, sender and recipient payloads well-formed (version 0, known scheme);
  - memo at most 80 bytes (no UTF-8 requirement in core; the Shell shows it escaped);
  - `amount > 0`; a self-transfer is allowed; a transfer to an address with no account creates the account (no minimum amount; see "State growth");
  - `nonce == account.nonce` (exact match; this is the replay protection);
  - `balance >= amount + fee` with `checked_add` (no overflow);
  - the signature verifies under the stored key (or the included one on first use);
  - truncated bytes and trailing bytes are errors.

### Account state and state root

- **Account:** keyed by the address payload (34 B): `{ balance u64, nonce u64, key: Option<(scheme, public key)> }`. Accounts are never removed: an account at balance 0 stays, because its nonce is the replay protection and its stored key is still needed. A transfer to an address with no account creates it with nonce 0 and no key. (A reorg restores the earlier state from the `undo` table; that is storage, not a rule.)
- **Account bytes (the hashed form):** `address (34 B) ‖ balance (u64) ‖ nonce (u64) ‖ key_hash (32 B)`, 82 bytes, integers big-endian, with `key_hash = keccak256(scheme ‖ public key)` of the account's current key (after a rotation, the new scheme and key) or 32 zero bytes when there is no key. The key is hashed to keep leaves small; a state snapshot carries the full account and the checker computes `key_hash`.
- **State root (Answer 5):** the root of a sparse Merkle tree (SMT) of depth 256, all hashes keccak256.
  - **Tree key:** `key = keccak256(address payload)`, 32 bytes. The hash is chosen over the raw address because it binds the whole payload (version and scheme), spreads keys evenly, and gives a fixed 256-bit width whatever address formats come later (P10). Bit `i` of the key is `(key[i / 8] >> (7 - i % 8)) & 1`. A node at depth `d` (height `256 - d`; the root is depth 0) picks its child by bit `d`: 0 left, 1 right.
  - **Leaf:** `keccak256(0x00 ‖ key ‖ account bytes)`. **Internal node:** `keccak256(0x01 ‖ left ‖ right)`. The prefixes separate leaves from nodes, so a leaf cannot pass as a node. The tree takes `(key, value bytes)` and never reads the value; the state root uses the account bytes as the value. The `tx_root` tree uses the same `0x00` and `0x01` prefixes on purpose: the two roots sit in fixed header fields and are never mixed.
  - **Empty subtrees:** `E[0]` = 32 zero bytes (an empty leaf slot); `E[h+1] = keccak256(0x01 ‖ E[h] ‖ E[h])`. A subtree of height `h` with no account has hash `E[h]`. **The empty-tree root is `E[256]`.** All 257 values are in `chain.json`. The genesis state has no account (no premine), so the genesis `state_root` is `E[256]`, with a vector.
  - **Root:** the hash at height 256, where each account's leaf sits at height 0 on its key's path. It depends only on the set of (key, account), never on the order of changes. **Fold rule** (a one-leaf subtree, and the vectors): start with `c` = the leaf; for height `j` from 0 to 255, with `b` = bit `255 - j` of the key, set `c = keccak256(0x01 ‖ c ‖ E[j])` if `b` is 0, else `c = keccak256(0x01 ‖ E[j] ‖ c)`. A tree with one account has root `c`. The storage shortcut below stores these same hashes, so the root does not depend on it.
  - **Cost:** changing one account re-hashes one path, at most 256 hashes. A Block recomputes the union of the changed paths bottom-up, so shared upper nodes are hashed once: a full Block touches at most about 800 accounts (397 senders, 397 recipients, the reward address), so at most about 205,000 hashes (an upper bound, 800 × 256; shared upper nodes make it fewer), which I estimate at well under a second (keccak256 of 65 bytes; **not measured**, item 3 benches it).
  - **Storage in `redb` (a shortcut in storage only; no hash changes):** table `smt`, key = `depth u16 ‖ path` (the 32-byte path with the bits from `depth` on set to zero), value = `Inner(node hash)` or `Leaf(key 32 B, leaf hash, node hash)`. A subtree that holds exactly one account is one `Leaf` entry at its highest node, not a chain of up to 256 inner nodes; its node hash (the leaf folded upward with `E[..]` siblings) is stored with it, so a read costs no hashing. A missing entry is an empty subtree. When a second account arrives in a one-leaf subtree, the `Leaf` is split down to the first bit where the two keys differ. That is about 2 entries per account, not 256. The `accounts` table holds the full account by address payload; `smt` holds only hashes. Both are written in the Block's one `redb` transaction, and the `undo` table restores both.
  - **Where the code lives:** `crates/core` `smt` holds the algorithm over a small `SmtStore` trait (read a node, write a node), so core stays pure; the Node implements the trait on `redb` and tests use an in-memory map.
  - **Checking a state snapshot:** it is served only at Checkpoint heights, as full accounts in key order (sorted by `keccak256(address payload)` as unsigned bytes, ascending, byte by byte), in chunks. The receiving Node builds the tree from them in a scratch table, in one pass because the order is sorted, and compares the root with `state_root` in the Checkpoint's header (whose Proof of Work and signature it has already checked). A wrong, missing or extra account, a duplicate key or a wrong order gives a different root or a format error: the scratch table is dropped, nothing is committed and the sender is banned.
- **Merkle tree for `tx_root`** (binary, not sparse): leaf `keccak256(0x00 ‖ transaction id)`, inner node `keccak256(0x01 ‖ left ‖ right)`, an odd node promoted unchanged (never duplicated, which avoids the Bitcoin duplicate-leaf weakness; CVE-2012-2459 details UNVERIFIED beyond that). The empty tree's root is `keccak256("")`.
- **State growth:** a transfer to a new address creates the account for the fee alone: no minimum amount and no state rent (Answer 22). The bound is the Block size: at most about 397 new accounts per Block (the 1,000,000-byte limit), about 571,680 a day (1,440 Blocks). A new account with no key stores about 250 bytes: about 51 in `accounts` (the 34-byte address, balance, nonce, no key) and about 200 in `smt` (about 2 entries, one `Leaf` and one `Inner`, each with its 34-byte table key). With `redb` page overhead that is about 250 to 350 bytes, so about 140 to 200 MB a day at worst. These are my estimates, not measured; item 3's bench and item 11 measure them. The project owner accepted the bound on the test network when it was put as about 57 MB a day; that figure counted about 100 bytes per account and left out the `smt` entries, so the corrected figure goes back to the project owner (Answer 22). ADR 0011 records it.

### Issuance (exact integers)

- 1 GOLD = 100,000,000 base units.
- `reward(h) = 500_000_000 >> min((h - 1) / 2_100_000, 4)` for `h >= 1`; height 0 is the genesis Block and pays nothing.
  - Eras 0 to 3 give 5, 2.5, 1.25 and 0.625 GOLD; from era 4 the tail is `31_250_000` (0.3125 GOLD), because 5e8 / 16 is exact.
  - Era 0..3 total: `2_100_000 × 9.375 = 19,687,500` GOLD = `1_968_750_000_000_000` base units. This matches ADR 0006.
  - Tail: `0.3125 × 525,600` Blocks a year = 164,250 GOLD a year, also matching.
- The Block's reward address gets `reward(h) + sum of fees` as a state change, applied after all the Block's transactions (so a reward address that is also a sender is checked against its balance before the reward). There is no coinbase transaction.
- Supply stays far below `u64::MAX`; all sums use `checked_add`.

### Block

Header, fixed 187 bytes, in this order:

```
version        u8
height         u64
prev_id        32 B   id of the previous Block (32 zero bytes in the genesis)
timestamp      u64    Unix seconds
target         32 B   big-endian 256-bit; higher = easier
tx_root        32 B
state_root     32 B   state after applying this Block
reward_address 34 B   address payload
nonce          u64    last 8 bytes, at offset 179
```

- **Block id:** `keccak256(header)`. The Proof-of-Work value is the RandomX v2 hash of the same header bytes, read as a big-endian 256-bit number; a Solution is a value below `target`. The id is not the PoW value, so it cannot be mined into a lower number by chance.
- **Body:** `tx_count u16`, then transactions. The whole Block (header, count, transactions) is at most 1,000,000 bytes. A Block may have no transactions.
- **Validation order, cheap first** (`validate_block(params, header, chain_view, state, hasher)`):
  1. size; no trailing bytes; `version`; `reward_address` well-formed; `tx_count` equals the number of transactions parsed;
  2. height equals parent height plus 1 and `prev_id` equals the parent's id; the genesis (height 0) is not validated by rules, it must equal `params.genesis`, and its `prev_id` is 32 zero bytes;
  3. timestamp rule; `target <= max_target`, nonzero, and equal to `next_target(params, ...)`;
  4. Proof of Work (RandomX light mode, an expensive step, so it runs before the transactions to stop CPU abuse by fake Blocks);
  5. `tx_root`; each transaction in order (`check_tx` then apply); the reward credit last; `state_root`.
- **Timestamp:** core requires `timestamp > median of the last 11` timestamps and `timestamp <= 2^62` (so signed solvetimes cannot overflow). The "not too far ahead of my clock" rule needs a clock, so it is Node policy (default 300 seconds), not core. It applies only to live tips a Node receives, not to Blocks fetched during sync (their timestamps are old and the Checkpoints cover them). The Retarget relies on it: without a future-time limit on live Blocks, a Mine could set far-future timestamps and push the Target easier, limited only by the solvetime clamp.
- **PoW input injection:** core's `validate_block` takes the hasher as a function (`Fn(&[u8], key) -> [u8; 32]`) so core tests run with a fake hash and the WASM build has no RandomX.
- **RandomX key** (P9: defined in core, tested by vectors): `key_height(h) = 0` for `h < 2112`, else `((h - 64) / 2048) * 2048`; the key is the id of the Block at `key_height` on the chain being checked (the genesis id for height 0). This follows the 2048/64 pattern of Monero's key block, whose exact consensus code I did not read (**UNVERIFIED**; the formula and its edges are fixed by our vectors, not by a citation). At 60 seconds a key lasts about 34 hours and the lag is about 64 minutes, far more than any reorg the Checkpoints allow. Question 4.

### Retarget (LWMA)

Variant: LWMA after every Block (ADR 0006 decision 6). The exact LWMA-1 text of zawy12 and its recommended window are **UNVERIFIED** (not read); the formula below is my own statement of a linearly weighted moving average, checked only by its sanity property (constant solvetimes of `T` leave the Target unchanged), and is fixed by vectors, not by a citation. A lower Target is harder (CONTEXT.md), so slow Blocks raise the Target.

```
T = 60, N = 60, MAX_TARGET = 2^240 - 1        (provisional until item 6)
for a Block at height h > N, with H_j the header at height j:
    ts_i     = H_(h-N-1+i).timestamp   for i in 0..=N     (N+1 timestamps, H_(h-N-1) .. H_(h-1))
    target_i = H_(h-N-1+i).target      for i in 1..=N     (the N parents, H_(h-N) .. H_(h-1))
for i in 1..=N (oldest to newest):
    st_i      = clamp(ts_i - ts_(i-1), 1, 6*T)            (i64 arithmetic; may be negative before the clamp)
    weighted += st_i * i                                  (u64, at most 360 * 1830 < 2^20)
    sum_t    += target_i                                  (u256, at most 60 * 2^240 < 2^246)
k           = N*(N+1)/2 * T                               (109,800)
next_target = mul_div(sum_t / N, weighted, k)             (320-bit intermediate, below 2^260)
next_target = clamp(next_target, max(parent_target / 2, 1), min(parent_target.saturating_mul(2), MAX_TARGET))
```

- The first computed height is `N + 1`; its window starts at the genesis (`H_0`). For heights 1 to `N` the Target is `INITIAL_TARGET` (pinned; simplest to vector-test).
- **Arithmetic:** with `MAX_TARGET = 2^240 - 1`, the sum of Targets and `parent_target * 2` fit in `u256`, and `(sum_t / N) * weighted` fits in a 320-bit intermediate. `u256` is a small hand-written module (add, compare, saturating mul by 2, `mul_div` with a `u320` intermediate) with vectors, no new dependency. The alternative is a compact 32-bit Target like Bitcoin's `nBits`. Question 3.
- `N`, the solvetime clamps and the adjustment clamp are **provisional** until the simulation in item 6 sets them. If they change after the vectors, `chain.json` and the genesis are regenerated (the test network may reset) before ADR 0012 is final.

### Fees and sizes

- Core: `fee >= 0`; any fee that the sender can pay is valid in a Block. The minimum relay fee is Node policy (default 10 base units per byte, so a 2.5 KB transfer costs 25,000 units = 0.00025 GOLD; tunable). A transfer's maximum size is 3,909 bytes (fixed by the layout).
- The fee auction (order by fee divided by size) is mempool policy in `crates/node`, not a consensus rule.

### Checkpoint

- **Signed bytes:** ML-DSA-44 over `network_id (u32) ‖ height (u64) ‖ block_id (32 B)` under the context `linked-realms/checkpoint/v1`. This is binary, not the text statement grammar: that grammar is only in TypeScript (`packages/shared/src/identity.ts`) and a Checkpoint is signed by a service, never shown to a Player. Question 9.
- Valid only when `height % 10 == 0`. The Checkpoint signer's public key and the network id are constants in `params`, replaceable only by a network upgrade (ADR 0006). They live in the `ChainParams` of each network.
- Core provides `verify_checkpoint(...)` and `branch_matches_checkpoint(...)`; fork choice itself is in the Node.

### Vectors (`crates/core/test-vectors/chain.json`)

Generated deterministically like `identity.json` (fixed seeds, `rnd = [0; 32]`, rewritten only with `UPDATE_VECTORS=1`, compared byte for byte). It holds:

- **Transactions:** first transfer with a key, a later one without, an 80-byte memo, a rotation (also as a first transaction); each with bytes, id, signature and the verdict. The same transaction signed for the dev network is rejected on the testnet (wrong network id) and the reverse.
- **Invalid transactions:** unknown version, unknown scheme, 81-byte memo, wrong nonce, overspend, missing key on the first transaction, key not matching the sender, repeated key, truncated and trailing bytes, `amount + fee` overflow, wrong network id.
- **`tx_root`:** empty, one, two, three (odd) and a power of two.
- **State root (SMT):** `E[0]` to `E[3]` and `E[256]` (the empty-tree root); one account (account bytes, leaf hash, every sibling on the path, root); two accounts whose keys differ only in the last bit (255 shared bits), two sharing exactly 100 bits and two differing in the first bit (these give 32-byte keys to `smt` directly, so no address grinding is needed); three accounts inserted in every order give one root; an update (balance and nonce changed, old and new root); a rotated key; an account at balance 0 stays; the internal removal used by undo (insert two, remove one: equals the one-account root byte for byte; accounts are never removed by a rule); a small ledger of accounts built through `apply`.
- **State snapshot check:** a valid snapshot (accounts in key order) gives the Checkpoint's root; a changed balance, a missing account, an extra account, a duplicate key and a wrong order are each refused.
- **Issuance:** `reward` at heights 0, 1, 2,100,000, 2,100,001, 4,200,001, 6,300,001, 8,400,001, 8,400,002 and 100,000,000, and the total at the end of era 3.
- **Retarget:** constant solvetimes keep the Target; all-fast and all-slow windows; solvetimes of 0, negative (timestamps going backwards) and over `6T`; both clamps; the pinned start and height `N + 1` reaching the genesis; overflow cases: all Targets equal to `MAX_TARGET` (sum near `2^246`), a parent at `MAX_TARGET` (the doubled parent passes `MAX_TARGET` and the result is capped), and a case where `(sum_t / N) * weighted` passes 256 bits.
- **Header:** bytes, id, nonce offset, the PoW comparison with a fake hash, the key function at heights 0, 2111, 2112, 4159 and 4160 (keys 0, 0, 2048, 2048, 4096; edges to be fixed in ADR 0012; the formula is **UNVERIFIED** against Monero).
- **Blocks:** one valid Block and one invalid for each check of `validate_block`: bad `reward_address`, wrong `tx_count`, trailing bytes, genesis with a nonzero `prev_id`, a reward credited after the transactions (a reward address that is also a sender).
- The Rust tests read it; a Vitest in `packages/core` reads it too, as `identity.json` is read today.

### WASM API additions (`crates/core/src/wasm.rs`, `packages/core/src/api.ts`)

Build and sign a transfer and a rotation (given nonce, fee, memo, optional public key), return bytes and id, parse and format amounts with 8 decimals, and `Address` to and from bytes. No RandomX in WASM: the Shell never checks Proof of Work.

## The RandomX binding (`crates/randomx`, new)

A separate workspace member (`publish = false`), so `crates/core` and its WASM build stay free of C++ (the `wasm` stage of the Dockerfile builds only `linked-realms-core`).

- **Source:** RandomX tag `v2.0.1`, commit `aaafe71322df6602c21a5c72937ac284724ae561` (published 2026-05-10, not marked "Latest" on GitHub, so it must be pinned by commit). Versions before it can produce wrong hashes (about 1 in 268 million, a figure from the RandomX README that I did not verify: **UNVERIFIED**) on ARM and RISC-V, which would split consensus between x86 and ARM Nodes. Vendored in the crate at that commit with a checksum test; nothing is downloaded at build time.
- **Build:** `build.rs` with the `cmake` crate, `ARCH=default` (portable; never `native` in an image), `Release`, only the `randomx` target, static link, plus the C++ runtime. Needs CMake and a C++ compiler. `cmake` is not installed on this Mac (`brew install cmake`).
- **FFI:** hand-written `extern "C"` block of about 14 functions (cache, dataset, VM, `randomx_calculate_hash`, the `_first/_next/_last` trio). No `bindgen`. No Rust crate supports v2 (`randomx-rs` 1.6.0 has no `RANDOMX_FLAG_V2`), so ADR 0006's own binding stands.
- **Safety:** `RANDOMX_FLAG_V2` (128) is always set and cannot be cleared, because a VM without it silently computes v1 hashes. `randomx_get_flags()` does not return it. Allocation failure returns an error, not an abort, so the Mine can fall back from fast to light mode. If `randomx_create_vm` fails with JIT, retry without it and report which flags were used. The JIT and the interpreter must give the same hash; vectors check both.
- **Types:** `Cache` and `Dataset` are shared read-only after init (`Arc`); a `Vm` is `Send`, not `Sync`, one per mining thread. The "read-only after init, shareable" rule is the documented contract but I did not find it verbatim in `randomx.h` (**UNVERIFIED**); read it again before writing `unsafe impl`.
- **Official vectors:** the five v2 hashes in `src/tests/tests.cpp` (keys `"test key 000"` and `"test key 001"`; for example `"This is a test"` gives `22ec6b86…cdb6f`), copied with file and tag next to each. They run in light mode, in fast mode (must match light), and with and without JIT, on x86 and (if a runner exists; **UNVERIFIED**, Question 17) ARM in CI. Our header vectors are generated by us and cross-checked the same way.
- **Modes:** fast about 2080 MiB, light 256 MiB, identical hashes. v1 benchmark numbers must not be quoted as v2; v2 speed is **UNVERIFIED** until measured.
- **macOS arm64:** whether the v2.0.1 ARM64 JIT runs on Apple Silicon is **UNVERIFIED**; the interpreter is the fallback and is slower (matters for dev mining speed only).

## `crates/node` (new; one package, two binaries' worth of code in one process)

Everything consensus-related is a call into `crates/core`. The Node only does storage, networking and orchestration. One binary, `lr-node`, holds the Node and the Mine (ADR 0006 decision 2), so the Mine takes templates and submits Blocks by calling the chain code directly, and the Map server talks to one process.

Layout: `chain/{store, fork_choice, template}`, `mempool`, `store/{tables, state_snapshot, prune}`, `p2p/{mod, message, codec, tcp, nodes, sync}`, `rpc/{methods, types, subscriptions}`, `checkpoint`, `mine/{mod, control, worker}`, `config`, `tests/` with an in-memory `Network` for multi-node tests.

- **Storage:** `redb`, one write transaction per Block so applying is atomic, on a dedicated blocking thread. Tables: `headers` (with cumulative work), `height_index`, `blocks`, `undo`, `accounts`, `smt`, `addr_txs`, `checkpoints`, `meta`. Whether `redb` 4.4.0 and `jsonrpsee` 0.26.1 build on Rust 1.99.1 and how stable the `redb` file format is: **UNVERIFIED** (no `cargo` available in the research shell); the first item of the Node checks them.
- **Fork choice:** most cumulative work, subject to the Checkpoint rule above. Reorgs use the `undo` table.
- **Mempool:** ordered by fee rate with a per-sender nonce chain; rejects below the minimum relay fee; same sender and nonce replaces only for a higher fee rate by a margin; total bytes capped, lowest fee rate evicted first; re-checked against the new tip after a reorg. Block template: greedy by fee rate in nonce order up to 1,000,000 bytes.
- **Pruning:** all headers kept. Bodies and `undo` kept from the latest Checkpoint (plus a margin). Safe because no history before a Checkpoint changes.
- **P2P** (behind `trait Network`, `p2p/tcp.rs` the only implementation, so libp2p can replace it):
  - Frame: 4-byte magic, command, `u32` length, 4-byte checksum (start of `keccak256(payload)`), payload; messages at most about 2 MiB.
  - Messages: `version`, `verack`, `ping`, `pong`, `inv`, `getdata`, `notfound`, `getheaders`, `headers`, `block`, `tx`, `checkpoint`, `getcheckpoint`, and beyond the spec's list `getnodes`, `nodes`, `getstatesnapshot`, `statesnapshot` (needed for discovery of other Nodes and pruned bootstrap).
  - Home Nodes behind NAT only dial out. They listen only with `--listen` and say "reachable" only after an inbound test. A misbehaviour score for each connected Node leads to a ban.
- **JSON-RPC** (`jsonrpsee`, HTTP and WebSocket, namespace `lr_`):
  - Public: `lr_getInfo`, `lr_getHeader(s)`, `lr_getBlock` (error if pruned), `lr_getAccount(address, includeMempool)`, `lr_getTransaction`, `lr_getAddressTxs`, `lr_getMempoolInfo`, `lr_estimateFee`, `lr_getCheckpoint`, `lr_sendTransaction`, `lr_submitCheckpoint`, `lr_subscribeBlocks`, `lr_subscribeAddress`. CORS and per-client rate limits, because browsers call it.
  - `lr_getAddressTxs` needs a retained transaction index (pruned like bodies); Question 7. The state snapshot is served by P2P only for Checkpoint heights.
  - Admin methods `lr_getConnections`, `lr_addNode`, `node_info` and every `mine_*` method are never served on the public RPC listener. They live only on the control listener described under "The Mine" (Unix socket, or authenticated).
- **Ports:** proposed P2P TCP 9444 and public RPC 9445 (compose-internal and loopback); the control listener has no published port. Neither is reserved anywhere yet; Hub 8787, relay 8080, Shell 8788 and Postgres 5432 are taken (`.env.example`).

## The Mine (`crates/node/src/mine`)

- A Mine is a set of OS threads with an id, and it exists only as part of a Land ("No Land, no Mine", Answer 19): one Mine per Land, id `land` (the id stays in the control API as a field), run by that Land's `lr-node` and switched by the Land owner in the Land. There is no standalone `lr-node mine` command; a newcomer without a Land gets Gold only by being sent some. ADR 0014 records this and marks ADR 0006 point 11 superseded. Each thread owns a VM over a shared dataset (fast) or cache (light).
- **Off at every start (P5).** Nothing about "on" is persisted. The control API reports what is really running (threads, mode, measured hash rate), not what was asked.
- **CPU limit:** default 1 thread; maximum `max(1, cores - 1)` with `cores` from `std::thread::available_parallelism()` (honours cgroup quotas on Linux; **UNVERIFIED** under Docker Desktop VMs), optionally lowered by `MINE_MAX_THREADS`. Threads run at low priority so the Land is not starved (mechanism **UNVERIFIED**: `setpriority` per thread on Linux, unknown on macOS).
- **Fast or light:** chosen at each switch-on. Fast if available memory is at least 2.5 GiB, else light. Available memory is `min(MemAvailable, cgroup limit minus usage)`, because `/proc/meminfo` shows the host's memory in Docker. States: `off`, `starting` (the dataset takes seconds to build), `on`.
- **Key change:** the Node builds the next RandomX cache during the lag before the key switches. The Mine keeps hashing on the old dataset while it builds the new one (needs about 4 GiB in fast mode), or pauses briefly and falls back to light mode if memory is short.
- **Reward address:** always the Land owner's address (Answer 14): the Map server passes the verified switch statement's `Character` as `rewardAddress`, and check 2 of "Checks, in order" requires it to equal the Hub's `land.owner`. The Node remembers, per Mine, the ids of Blocks its own `submit` produced; `mine_blockFound` is for those ids only (flow 3).
- **Control path and authentication** (P5: a Mine starts only when its Land owner turns it on, so nothing else may start one):
  - The control API is its own listener, separate from the public RPC. Default when the Map server spawns `lr-node` itself: a Unix socket in `/data` (mode 0600, owned by the Map server's user).
  - For an external or compose-separate Node (`NODE_CONTROL_URL`), a TCP/WebSocket control listener is allowed only with a shared secret: a file of at least 32 random bytes (`NODE_CONTROL_SECRET_FILE` on both sides), sent on connect and compared in constant time. Compose mounts it as a secret file, like `HUB_TICKET_KEY`; it is never in an image.
  - `lr-node` serves the control API only on the Unix socket or on a TCP listener that checks the shared secret on every connection, loopback included; it refuses to start a TCP control listener without a secret, and never serves any `mine_*` or admin method on the public RPC listener. Tests: a TCP control listener without a secret fails to start; `mine_start` on the public RPC listener answers method-not-found; a wrong or missing secret is refused; a Unix socket with loose permissions is refused.
  - So only the Map server (holding the socket or the secret) can start a Mine; another program with network access to the Node's ports cannot.
- **Control API** (JSON-RPC over WebSocket on that listener; whether `jsonrpsee` can serve a Unix socket is **UNVERIFIED**, and if not, item 17 writes a small line-delimited JSON server; amounts are decimal strings of base units):

```
node_info()  -> { height, tip, connections, synced, maxThreads, memoryAvailableMiB }
mine_status({ id }) -> { id, state: "off"|"starting"|"on", threads, mode: "fast"|"light"|null,
                         hashRate /* H/s, 10 s window */, blocksWon, rewardAddress }
mine_start({ id, rewardAddress, threads, mode: "auto"|"fast"|"light" }) -> status
mine_stop({ id }) -> status
mine_subscribe({ id })  // notifications mine_status (on change, at most every 2 s) and
                        // mine_blockFound { id, height, hash, reward, rewardAddress, time }
```

Errors: `node-unavailable` (Node off or not synced), `bad-address`, `bad-threads`, `unauthorized`. `mine_blockFound` fires only after the Node has accepted the Block into its best chain (P3). The Map server never asks the Node to sign anything.

## Map server <-> Node protocol (`docs/protocols/map-server-node.md`)

The control API and its authentication above, plus the Public RPC. Written in the style of the other protocol documents: status line, reference implementation, flows, JSON examples, error list. It also states the Land-side rules of the switch (reference-kit behaviour, not mandatory: ADR 0008 lets each Land make its own rules).

## Switch statement and Map server checks (decision 1)

**Reuse `linked-realms Land message`** (no change to the Shell or `identity.md`: `signMessage` already builds it with the Land id, the Land URL, the Character and `Issued`). The switch goes in `Message`, as one line of printable ASCII so the Shell's prompt reads it (the Shell escapes `\n`; `packages/shell/src/escape.ts:5-23`):

```
linked-realms Mine switch; Map server key: <address>; Mine: on; Threads: 2; Nonce: <32 hex>
```

- `Mine` is `on` or `off`; `Threads` is 1 to `maxThreads` when on, `0` when off. Fixed field order, each once, `; ` between. A strict `parseMineSwitch` in `packages/shared` decodes, parses and re-encodes to compare (as `identity.md` does for `Message`), with vectors beside `packages/shared/test-vectors/statements.json`.
- **Learning the Map server key:** the Land UI puts into the text the `map_server_key` that the Map server sends in the Land owner's copy of `MineState` (new field). It is the server's own address; the Shell shows it in the prompt, and a wrong one fails check 3.
- **Replay protection:** the Map server keeps one random challenge in memory per Land owner session (so a phone and a laptop do not spend each other's), and sends it only in that session's `MineState`. A challenge expires 300 seconds after it was issued (the same window as `Issued`); a fresh one comes in the next `MineState` after it is spent or expires. It is spent only when the submitted nonce equals it, compared first and before any signature work; a wrong nonce spends nothing. A replayed signature fails because its nonce is spent. No extra round trip.
- **Checks, in order** (cheap first):
  1. at most one switch per 2 seconds per session and one verification in flight;
  2. the sending session is the Land owner's (`land.ts:197` sets `isOwner` from the Hub's `land.owner`), and the statement's `Character` equals `land.owner`;
  3. the text parses; `Map server key` is this server's own address; `Nonce` equals this session's unexpired challenge (the challenge is spent here);
  4. `Issued` is within 300 seconds of the Map server's clock; `Land` equals the served Land id;
  5. `verifyStatement(signed, "land-message")` passes (signature, and `Character` equals the signer);
  6. for `on`: `Threads` is 1 to `maxThreads` and the Node is up.
- `Land URL` is not checked strictly: with an own domain the Shell may load the Land from a host other than the Hub's `url`, and the Land id already binds the statement.
- **Relay frame size:** a signed Land message is about 5.3 KB (public key about 1.75 KB and signature about 3.2 KB in base64), under the relay's default player frame limit of 16,384 bytes (`packages/relay/README.md:26`). So signing works from a phone through the relay.

## `packages/shared`, `packages/map-server`, `packages/client`

- **`land.proto`** (reserved slots 20 to 29 in both messages, `land.proto:21` and `:48`):
  - `ClientMessage.mine_switch = 20` with `MineSwitch { SignedStatement signed }`.
  - `ServerMessage.mine_state = 20`, `mine_switch_result = 21`, `mine_won = 22`.
  - `MineState { status (off, starting, on, unavailable), threads, max_threads, hash_rate, mode, reward_address, blocks_won, challenge, map_server_key }`; `MineSwitchResult { ok, code }` with codes `not-owner`, `bad-statement`, `stale`, `wrong-nonce`, `bad-threads`, `unavailable`, `rate-limited`; `MineWon { height, reward, rewardAddress }`.
  - `MineState` goes to everyone after `welcome` and on change (and about every 2 seconds while on), with `challenge` and `map_server_key` only in the Land owner's copy (the challenge is per session).
- **Map server** (`packages/map-server`):
  - `onMessage` (`land.ts:249-270`) refuses everything but `hello` and `input`, so `mine_switch` is a new branch.
  - New settings: `NODE_ENABLED` (default true), `NODE_BIN`, `NODE_CONTROL_URL` and `NODE_CONTROL_SECRET_FILE` (use an external Node instead of spawning one; the secret is required, see "The Mine"), `NODE_RPC_URL` (public RPC only, for reading the chain), `MINE_MAX_THREADS`.
  - When it spawns `lr-node` itself it uses the Unix socket control path, with no secret to configure. It spawns `lr-node` as a supervised child, restarts it on a crash (the Mine stays off), stops it on shutdown (`main.ts:29-36`). It subscribes to `mine_subscribe` and relays `MineState` and `MineWon`.
  - It logs "Mine ON: threads, mode, reward address" and "Mine OFF" to the console each time.
- **Client** (`packages/client`):
  - `shell.ts:134-161` handles only `init` and `travelRefused` and sends only `travel`; add `signMessage`, an id-to-promise map and `signResult` parsing (plus the `ShellMessage` union and `parseShellMessage`). It is also a gap against `shell-land-ui.md:3`, which names this file as the reference implementation.
  - The Land owner's control (visible only if `isOwner`, disabled when `unavailable`): tap the Mine or a HUD button, choose on or off and threads. Each `signResult.error` (`denied`, `busy`, `blocked`, `locked`, `invalid`, `unsupported`) gets a plain-words message.
  - All server data is untrusted (P1): validate `MineState` and `MineWon` as `readCharacter` does (`players.ts:15`).

### The effect (decision 2, `scene.ts`)

- Split the Mine out of the shared Graphics `g` (`scene.ts:135-144`; the Gates are drawn into the same `g` at lines 147-155 and stay there) into its own container at depth 1.
- **While `on` or `starting`** (as the Land says it; see "What a visitor can trust"): a pulsing gold glow (a yoyo tween on alpha and scale, about 1 s), a gear or pickaxe drawn in code that spins faster with more threads, small gold sparks rising at a rate that grows with the hash rate, capped. `starting` is dimmer and slower. Visible to every visitor.
- **On `MineWon`:** an expanding gold ring (scale 1 to 4, fading, about 600 ms), a burst of sparks, a Phaser text "+N GOLD" at the Mine's centre rising about 48 px and fading over about 1.6 s with a dark stroke at the top depth, and a HUD line "The Mine won Block #H (+N GOLD)". `N` comes from `reward`, which is the Block reward at that height plus fees, never a constant, trailing zeros trimmed ("+5 GOLD" in era 0 with no fees, "+2.50012 GOLD" after the first halving with fees).
- **Always-visible HUD line (P5; accurate in the Land owner's own view, for a visitor only what the Land claims):** "Mine ON · 2 threads · fast · 1.2 kH/s · rewards to <name or short address> · 3 Blocks won".
- **`prefers-reduced-motion`:** no pulse, spin or sparks; only the text and the HUD line.
- Tweens, Graphics and Text only, drawn in code like `scene.ts:132`, no assets. Phaser here is 4.2.1 and its particle API differs from Phaser 3.60 and later; I did not verify it, so the plan avoids it.
- The reward address shown is the one `MineState` reports: the Land owner's, from the verified switch. A visitor cannot check it (Answer 16; see "What a visitor can trust").

## `packages/shell` chain features

- **WASM:** the exports above. The Shell reads `lr_getAccount` and `lr_estimateFee` from a Node URL: the Public node by default, changeable by the Player (ADR 0006 decision 10).
- **UI:** balance, send with memo (80 bytes) and a fee choice (auto by size by default), and a list of recent transactions.
- **Payment prompt:** the Shell's own wording with amount, the full recipient address (not the shortened form), memo (escaped like `escape.ts`) and fee, with the existing guard: Approve armed after 1 second, pointer click only.
- **`pay`:** replaces the `unsupported` answer (`portHandler.ts:190`). Strict checks on amount, recipient and memo; the same limits as `signMessage` (one open request, `busy` 10 seconds after a refusal, `blocked` after 3). Update `shell-land-ui.md` for the new `signResult` payload and error codes. Default: the Shell submits the transaction and the Land gets the transaction id, never the signed bytes. Question 8.
- **Key rotation:** supported in core and Node. The Shell's UI for it waits on the identity question: after a rotation the address no longer equals the hash of the current key, but the Hub's sign-in and `verifyStatement` derive the address from the signing key (`identity.md`). Question 6.
- **Tests:** a Playwright spec for `pay` next to `packages/shell/e2e/shell.spec.ts` (hostile Land cannot pay without Approve; rate limits).

## Company services

- **Checkpoint signer:** the same `lr-node` code in a signer role: no public ports, on a separate machine from the carthings server (Answer 13), so its key is never on carthings (a leak of that key allows deep rewrites). The key is in a secret file or volume on that machine (like `HUB_TICKET_KEY`), never in an image. It reads a Public node and signs only as in flow 6. Its config is `deploy/compose.signer.yaml`. The Hub signs no Checkpoints (CONTEXT.md). Its public key is in the `ChainParams` of each network, not read from the Hub (P3).
- **Seed node, Public node, archive** (pruning off): `restart: unless-stopped` with persistent `redb` volumes, in a new `deploy/compose.chain.yaml` beside `deploy/compose.public.yaml`, as a separate compose project on the carthings server (Answer 13), not part of the `lr-world` project. The signer is not in it.
- **Public node RPC** needs a Caddy vhost (one more hostname). The shared Caddy on the carthings server has stock Caddy without the DNS module and only vhosts for `1-4.lands`; a new hostname needs a PR to `carthings-vn/infra`, and recreating that Caddy drops the manual network join. P2P TCP is a new inbound port. Any Caddy, firewall or port change needs the project owner's confirmation, which he gives when item 18 comes (Answer 13); it is not done by this plan. The carthings server's current state is **UNVERIFIED** (not touched). The Land owner's Land 1 container (`linked-realms-land-du1`) must not be removed or truncated in any redeploy.
- **Genesis and network id:** one `ChainParams` value per network id in `crates/core` `params` (genesis header, Checkpoint signer key, `INITIAL_TARGET`, magic; testnet and dev only), written in ADR 0012.
- **Runbook:** a chain section in `docs/runbooks/public-world.md`.

## Docker stack and self-hosting

- **Dockerfile:** a new Rust build stage for `lr-node` with CMake and a C++ compiler. The final image is `node:26.12.1-alpine3.24` (musl), and a glibc binary will not run there. Default: build `lr-node` in a musl stage (`rust:1.99.1-alpine`) so the binary matches the image, and run the vectors in that stage. Whether RandomX and its JIT build and run correctly on musl is **UNVERIFIED** (never built); item 8 proves it or switches that stage to a glibc image (Question 11). Multi-arch: `image.yml` builds amd64 and arm64 under QEMU, which will be slow for C++; prefer native arm runners (availability **UNVERIFIED**, Question 17).
- **`docker run` line (ADR 0010):** unchanged, still no `-p`. `/data` now also holds the chain database. Huge pages need privileges and are unavailable in a default `docker run`, so mining there is slower (by how much: **UNVERIFIED**).
- **`compose.yaml` `world` profile:** a seed Node service from the same image; `map-1` and `map-2` spawn their own Node (Unix socket in their own `/data`) or, for a separate Node container, use `NODE_CONTROL_URL` with a `NODE_CONTROL_SECRET_FILE` mounted as a compose secret (the control port is on the compose network only); memory and CPU limits so fast mode and the thread cap are exercised; the `dev` network (id 2) with a high (easy) fixed Target so tests do not wait 60 seconds.
- **Documents:** `docs/self-hosting.md` ("There is no Gold yet" at line 5 and the last bullet), `packages/map-server/README.md`, `docs/protocols/map-server-hub-relay.md:3`, `README.md`, and `docs/protocols/shell-land-ui.md`.
- **Port in the Land owner's firewall:** none (Answer 12). A Node behind NAT dials out to other Nodes and follows the chain without an inbound port; Land owners are not asked to open P2P. The control listener is never published and needs no firewall rule.

## Dashboard

Rebuilt on the Public node's `lr_getHeaders` and the Hub's `GET /directory`: Lands online, Mines mining (distinct reward addresses that won in 24 hours), mean Block time over the last 100 Blocks, estimated hash rate (from the Target and the mean Block time), top winners. The old one is recoverable with `git show 86b1118^:packages/indexer/src/dashboard.ts` (server-rendered HTML with no script, a pure `computeDashboard` with tests); its inputs change from Rounds to Blocks. It runs as a small read-only service beside the Shell (Answer 10).

## Simulation

Two parts.

- **Retarget simulation in `crates/core` (item 6, after the LWMA in item 4 and the Block in item 5):** a plain test with a fake Proof of Work and a modelled hash rate. The hash rate rises four times, then falls to half; Block time returns to about 60 seconds. It runs the real `next_target` and sets the final `N` and clamps before ADR 0012 is written. Project owner decision 3 fixes the order of whole areas, so this small check does not break it.
- **Network simulation in `crates/node/tests` (item 26):** the same case through Nodes on the in-memory `Network`, and a competing branch with more work that forks before the last Checkpoint is rejected.

Together they replace the deleted EVM simulation (`contracts/test/GoldMine.simulation.t.sol`).

## CI

- `.github/workflows/ci.yml` (`rust` job): CMake and a C++ compiler (`ubuntu-24.04` probably has both; **UNVERIFIED** for the current image, so install and pin explicitly), plus an ARM job on `ubuntu-24.04-arm` for the RandomX vectors (availability for this repository: **UNVERIFIED**, Question 17; until verified the ARM vectors are a manual check). No QEMU for the vector test if a native runner exists.
- `image.yml` triggers only on `main` and `phase-2/2b-world` (line 8); with stacked PRs (Answer 21) the item branches are `phase-2/2c-<n>-<name>`, so add `phase-2/2c-*` to its branch list when an item first needs an image (item 24 at the latest).
- Vendoring RandomX needs a supply-chain note in ADR 0012.

## Order of work

**Each item is one PR that the project owner approves and merges** (each merge needs a fresh approval; nothing is pushed or merged without it). PRs are stacked: item `n` is a branch `phase-2/2c-<n>-<name>` made from item `n-1`'s branch, and its PR targets that branch until the one below is merged, then `main`. The project owner chose one PR per item (Answer 21). PLAN.md section 12 and its Log are updated in each PR. The order is PLAN.md 2C's (decision 3).

1. **`crates/core` codec, `Address` bytes, `ChainParams`, issuance, `tx_root` Merkle.** Verifies: `chain.json` vectors for issuance and `tx_root`; rewards at all era edges; `cargo fmt`, `clippy`, `test`. ADR 0011 (encodings, byte order, genesis height, reward formula, network id in signing bytes).
2. **Transactions and accounts.** `check_tx`, `apply` over a `StateView`, the account and its hashed bytes (no tree yet). Verifies: valid and every invalid vector (including wrong network id); `apply` and `check_tx` leave no partial state on error; a transfer to an address with no account creates it.
3. **Sparse Merkle tree and state root (`smt`).** The tree of "Account state and state root": the `SmtStore` trait with an in-memory store, the empty-subtree table, update, the internal removal used by undo, and the snapshot check. Verifies: every SMT vector; the same root for any insertion order; a one-leaf shortcut split at the first differing bit; a bench of the hashes per full Block (turns the cost estimate into a measurement). Completes ADR 0011 with the state-root definition and the state-growth bound (Answer 22).
4. **`u256` and LWMA.** Verifies: the Retarget vectors including each overflow case, the `N + 1` start, and constant solvetimes leaving the Target unchanged.
5. **Block and `validate_block`.** Verifies: header bytes, id, nonce offset, size, timestamp rules, every check of the validation list and its order, with a fake hash and a test `ChainParams` (the real genesis and `INITIAL_TARGET` come in item 9).
6. **Retarget simulation in core.** Verifies: Block time returns to about 60 seconds after a 4x rise and a halving of hash rate; sets `N` and the clamps; vectors regenerated if they change.
7. **`crates/randomx`.** Vendored source, build script, FFI, safe wrapper. Verifies: official v2 hashes in light, fast, JIT and interpreter modes on this Mac and x86; a test that fails if a v1 hash appears.
8. **CI and Docker toolchain.** CMake, C++, the ARM job (if a runner exists: **UNVERIFIED**), the musl build of `crates/randomx`. Verifies: the vectors pass in CI and in the musl stage, or the stage switches to glibc (Question 11).
9. **Key function, `INITIAL_TARGET`, genesis, Checkpoint verification.** A bench measures hashes per second per thread for light and fast mode on the project owner's machine. ADR 0012 records the RandomX pin, key schedule, `INITIAL_TARGET`, reference machine and mode, and the genesis (from the final `N`). A genesis Target easier than measured is safer, and the Retarget corrects it. Verifies: key-function vectors at 2111, 2112, 4159, 4160; Checkpoint accept and reject vectors.
10. **WASM and TypeScript exports** for transactions. Verifies: Vitest reads `chain.json`; the TypeScript bytes and ids equal the Rust ones.
11. **`crates/node` storage and chain.** `redb` table layer, apply, undo, fork choice, Checkpoint rule. Verifies: reorg tests, a Checkpoint overriding more work, apply atomic after a failure. First step checks that `redb` and `jsonrpsee` build on Rust 1.99.1.
12. **Mempool and Block template.** Verifies: fee ordering, nonce chains, eviction, replacement, the template never exceeds 1,000,000 bytes and always validates.
13. **P2P and sync** behind `trait Network`: framing, messages, discovery of other Nodes, header and Block sync, ban. Verifies: with the in-memory network 3 Nodes converge; an oversize message and a ban are handled.
14. **Pruning and state snapshots.** Verifies: a new Node bootstraps from a Checkpoint and a state snapshot; a bad state snapshot is refused.
15. **JSON-RPC and Checkpoint intake.** Verifies: each method against a running test Node, error codes, rate limit, `lr_submitCheckpoint` refuses a wrong signature, no admin method on the public listener. Protocol documents `node-p2p.md` and `node-rpc.md`; ADR 0013.
16. **The Mine workers:** threads, fast or light choice, `starting` state, off at every start, key change handling, attribution by Block id. Verifies: a dev-network Node plus a Mine win Blocks; the Mine's status, read in-process (`mine_status` comes with item 17), reports real hashing; a restart leaves it off; the thread cap holds; a Block with the same reward address from another Node is not attributed.
17. **The Mine control path:** control listener, Unix socket or shared secret, the API, refusal of `mine_*` off the control path (tests in "The Mine"). There is no standalone mine command (Answer 19).
18. **Company services:** the Checkpoint signer role (`deploy/compose.signer.yaml`, for a separate machine), the seed, Public node and archive configs, `deploy/compose.chain.yaml` (a separate compose project for the carthings server), runbook. Verifies: signer and seed reach Checkpoints on a local stack; the signer's key is never in an image. Nothing is deployed to carthings without the project owner, who confirms the Caddy vhost and the P2P port at this item (Answer 13); the signer's key is never placed on carthings.
19. **Shell: balance and send.** Verifies: unit tests; a Shell on a dev Public node sends Gold between two Characters.
20. **Shell: `pay` prompt.** The rotation UI stays out (Answer 6). Verifies: the Playwright `pay` spec (a hostile Land cannot pay without Approve; rate limits).
21. **Land side, protocol:** `docs/protocols/map-server-node.md`, ADR 0014 (the switch and the effect; also records "No Land, no Mine" and marks ADR 0006 point 11 superseded, Answer 19), `land.proto`, `parseMineSwitch` with vectors.
22. **Land side, client:** `signMessage` plumbing, the Land owner's control, and the effect driven by a fake `MineState`. Items 21 and 22 need no Node, but they follow the Node and the Mine (Answer 20: PLAN.md 2C's order).
23. **Land side, Map server:** verification of the switch, supervision of `lr-node`, `NODE_*` settings. Verifies: every check in "Checks, in order" has a refusal test (not the Land owner, bad statement, wrong Land, stale, wrong nonce, replay, two sessions, expired challenge, too many threads, rate limit).
24. **Docker stack:** Dockerfile `lr-node` stage, `compose.yaml` `world` profile, self-hosting guide. Verifies: a Playwright test with a stub Shell shows the Land owner's switch and a win flash for a second client; `docker compose --profile world up` runs a Land whose Mine is off, and the Land owner switches it on.
25. **Dashboard.** Verifies: tests of the pure figures on recorded Blocks; the page against a dev Public node.
26. **Network simulation** (second part of "Simulation"). Verifies: both cases in `cargo test`.
27. **Close-out:** `README.md`, PLAN.md sections 6 and 12 and the Log, `e2e:chain`, the three-machine check below.

## Verification

1. **Rust:** `cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test`: vectors, RandomX official hashes, Node and simulation tests. On x86 in CI, and on ARM if a runner exists (**UNVERIFIED**).
2. **TypeScript:** `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`. Statements and transactions agree with the Rust vectors; Map server switch checks and refusals; client validation of `MineState` and `MineWon`.
3. **Playwright:** the `pay` prompt cannot be skipped; the Land owner's Mine switch asks the Shell and does nothing on Deny; a visitor sees the animation and the "+N GOLD" flash but has no control.
4. **`pnpm e2e:chain`** against `docker compose --profile world up -d` with a dev Target: two Characters, two Lands; the Land owner of Land 1 switches the Mine on; a Block is won; the effect appears in a second client; one Character sends Gold with a memo to the other; the balance changes; the Mine is off after `docker compose restart`.
5. **Measurements:** hash rate per thread (light and fast) and light-mode verification time on this Mac, the Docker host and an ARM board; cache rebuild time at a key change. All are **UNVERIFIED** today and go into ADR 0012.
6. **Manual check** on a phone through the relay: sign the switch in the Shell, see the flash.
7. **Three Players on three machines** on a public test network (the Done-when check): needs the project owner, a seed Node, a Public node and the Checkpoint signer running.

## Defaults chosen in this plan (say if you disagree)

- **Encodings:** big-endian, fixed width, hand-written; one transaction context `linked-realms/tx/v1`; signing bytes start with the network id; transaction id over the signing bytes.
- **Networks:** `testnet` (1) and `dev` (2) only, as `ChainParams` values; no main network.
- **Height:** genesis is height 0 and pays nothing; the first mined Block is height 1; halvings count from height 1.
- **Hash:** `prev_id` is the keccak256 of the header; the Proof-of-Work value is RandomX over the header, compared as a big-endian number.
- **Target:** 256-bit with a small hand-written `u256`.
- **Keys:** first transaction carries the public key exactly once; the address is account-bound and survives a rotation.
- **Block:** at most 1,000,000 bytes in total; an empty Block is valid; no coinbase transaction.
- **Fees:** the minimum relay fee is Node policy, 10 base units per byte.
- **LWMA:** `T = 60`, `N = 60`, solvetime clamp `[1, 6T]`, result clamp half to double of the parent, Target pinned to `INITIAL_TARGET` for the first `N` Blocks; `MAX_TARGET = 2^240 - 1`; all provisional until item 6.
- **RandomX:** stock configuration (no custom salt, so the official vectors apply), v2.0.1 vendored, key schedule 2048/64.
- **Checkpoints:** binary signed bytes; signed at least `CHECKPOINT_LAG` (default 6) Blocks below the tip so an orphan is not signed.
- **Mine:** one per Land (no Land, no Mine; Answer 19), inside `lr-node`, controlled over a Unix socket or an authenticated listener (never the public RPC); nothing persisted; threads default 1, cap `max(1, cores - 1)`; fast mode at 2.5 GiB available.
- **Switch:** reuses `linked-realms Land message`, replay protection by a per-session server challenge that expires in 300 seconds; the reward address is the Land owner's (Answer 14).
- **"+N GOLD":** N is reward plus fees; fires when the Node accepts a Block produced by this Mine's own `submit` into its best chain; there is no maturity rule (ADR 0006 has none; UNVERIFIED that none is wanted).
- **Other Nodes:** static seed Nodes plus `nodes` gossip.
- **State root and growth:** a sparse Merkle tree of depth 256 with key `keccak256(address payload)`; accounts are never removed; no state rent and no minimum for a transfer to a new address. The bound is the Block size (about 397 new accounts per Block, an estimate), accepted on the test network (Answer 22).
- **Delivery:** one stacked branch and one PR per item; nothing is pushed, merged, deployed or opened as a PR until the project owner asks, and each merge needs their fresh approval.

## Answers of the project owner (2026-10-30)

The numbers are those of the original questions; "Question N" elsewhere in this plan points to the answer here. The project owner chose the recommended option, except where marked.

1. **Byte order and the transaction id.** Big-endian fixed width; the id is over the signing bytes.
2. **Genesis and halvings.** Genesis at height 0 without a reward; halvings from height 1, so the era 0 to 3 total is exactly 19,687,500 GOLD.
3. **Target encoding.** 256-bit with a hand-written `u256`.
4. **RandomX key schedule and the LWMA parameters.** Key every 2048 Blocks with a 64-Block lag; `N = 60`, clamps as above, tuned by the simulation and recorded in ADR 0012. The Monero values and the LWMA reference text stay **UNVERIFIED**.
5. **State root. Alternative chosen: a sparse Merkle tree now.** Not the O(n) sorted-account root. Depth 256, keccak256, as defined in "Account state and state root"; more code and vectors (its own item 3), and no later network upgrade for the state root.
6. **Key rotation and identity.** Ship rotation in core and the Node; keep the Shell's rotation button out until an ADR says how the Hub and statements treat a rotated key.
7. **Address transaction index.** The Public node keeps `lr_getAddressTxs` data for the same window as Block bodies.
8. **What `pay` returns.** The Shell submits and returns the transaction id.
9. **Checkpoint format.** Binary signed bytes.
10. **Dashboard location.** A small read-only service beside the Shell that reads the Public node and the Hub's directory.
11. **Image base.** Keep Alpine and build `lr-node` for musl; item 8 decides with evidence.
12. **Inbound P2P for Land owners.** Not required: Nodes behind NAT dial out only.
13. **Where the chain services run. Own answer.** The seed node, the Public node and the archive run as a separate compose project on the carthings server; the project owner confirms the Caddy vhost and the P2P port when that item comes (item 18). The Checkpoint signer runs on a separate machine, so its key is never on carthings.
14. **Reward address in the Land.** Always the Land owner's address (the signer). This departs from PLAN.md 5.3, which the main session updates.
15. **A won Block that is later lost.** Flash at acceptance, no maturity rule.
16. **Visitor detail in the HUD.** On or off, threads, mode, hash rate and the reward address to everyone, and "+N" as reward plus fees; a visitor cannot verify any of it.
17. **ARM runner and vendoring.** Use `ubuntu-24.04-arm` if the repository has it (**UNVERIFIED** today), and vendor RandomX at the pinned commit with a checksum.
18. **Reference machine and mode for `INITIAL_TARGET`.** The project owner's Apple M5, fast mode if the Mine runs fast, with a Target easier than measured.
19. **Mines without a Land. Own answer: "No Land, no Mine."** A Mine exists only as part of a Land: that Land's `lr-node` runs it, the Land owner switches it in the Land, and the rewards go to the Land owner (Answer 14). There is no standalone `lr-node mine` command. So: one Mine per Land (id `land`), because the reward address is fixed and the hash rate is set by threads; a newcomer without a Land gets Gold only by being sent some. ADR 0014 (written with the switch and the effect, item 21) records this and marks ADR 0006 point 11 ("A Mine can run before its Player has a Land") superseded. PLAN.md 5.3, the 2C Mine item and CONTEXT.md's Mine definition change in the main session.
20. **Early Land-side items.** Keep PLAN.md 2C's order: items 21 and 22 come after the Node and the Mine. The question was put again at the project owner's request, and they chose the same answer.
21. **PR shape.** Stacked PRs, one per item, each approved and merged by the project owner in order.
22. **State growth bound. Alternative chosen: no `MIN_NEW_ACCOUNT`.** The bound is recorded and accepted on the test network: the Block size allows about 397 new accounts per Block, about 571,680 a day, about 57 MB of state a day at worst (my estimate, not measured). Corrected after the answer: with the `smt` entries it is about 140 to 200 MB a day at worst (see "State growth"); the project owner has been told and may change this answer.
