# 0009 — Identities, addresses and signed statements

Status: accepted, 2026-10-29 — by the project owner, with the step 2B plan (`docs/plans/phase-2b-world-without-chain.md`)

## Context

ADR 0006 chose ML-DSA-44 keys from 24 words, with a scheme id in every address and transaction. ADR 0008 made several protocols mandatory, so Lands in any language must check the same signatures. Step 2B is the first time keys are used: to sign in to the Hub, to register Lands and to arrive at a Land. The chain reuses the same keys and addresses in step 2C, so these choices are hard to change later. The full specification is `docs/protocols/identity.md`.

## Decisions

1. **One signature scheme everywhere.**
   - Characters, Map server keys and the Hub's ticket key are all ML-DSA-44, so every party needs one verifier.
   - Signing is hedged with 32 fresh random bytes.
   - Rejected: Ed25519 for the Hub and Map servers. It is smaller and faster, but it needs a second verifier in every Land.
2. **Character keys from 24 words.**
   - The words are BIP-39 over 32 bytes of entropy, which gives the BIP-39 seed (PBKDF2-HMAC-SHA512, empty passphrase).
   - The ML-DSA-44 seed is `HKDF-SHA512(salt = "linked-realms/ml-dsa-44/v1", ikm = seed, info = "character/<index>")`.
   - No standard exists for BIP-39 to ML-DSA. This profile is our own, frozen by test vectors.
   - The index lets one set of words hold more Characters (NPCs, step 2E). The version in the salt lets a later scheme use the same words.
   - Rejected: using the BIP-39 seed's first 32 bytes directly, which has no domain separation; BIP-32 paths, which are defined for elliptic curves only; and the experimental PQM-1 profile.
3. **Addresses.**
   - Bech32m with the prefix `tlr` (test network) over version `0`, scheme id `1` and the full 32-byte `keccak256(scheme id ‖ public key)`. That is about 65 characters, starting `tlr1`.
   - Bech32m catches typing mistakes.
   - The full hash keeps preimage resistance against quantum computers at the level that is the reason for choosing ML-DSA.
   - The version and scheme id satisfy P10.
   - Rejected: a 20-byte hash (about 46 characters), which is shorter but has less quantum margin; and hexadecimal, which has no checksum.
4. **Signed statements.**
   - Everything a key signs outside the chain is a short UTF-8 text with fixed lines, in a strict grammar: fixed keys in a fixed order, no control, format or separator characters, and free text only as an escaped JSON string on the last line.
   - Every statement has its own ML-DSA context string, so a signature made for one purpose never verifies for another.
   - Text is readable in the Shell's prompt and easy to produce and parse in any language. The strict grammar stops line-injection attacks.
   - Rejected:
     - JSON with canonicalisation (RFC 8785), which every Land would need a library for;
     - Protocol Buffers, which are not readable in a prompt;
     - EIP-712, which went with the EVM.
5. **The arrival challenge is the ticket's nonce.**
   - A Character proves its key by signing the Hub's ticket nonce together with the Land and the "driven by AI" field. There is no extra round trip to the Land.
   - A Land accepts each nonce once, and refuses tickets issued before it started, so a restart cannot reopen old tickets.
6. **A Map server proves its key before it gets a Land.**
   - The Map server signs a statement naming its owner, and the owner signs a Delegation naming the Map server key. The Hub needs both.
   - Without the Map server's statement, anyone who saw a Map server key's address could register it first.
7. **Where the code lives.**
   - `crates/core` implements keys, signatures and addresses once (P9).
   - The Shell, `hub-api`, the relay and the reference Map server all use its WASM build.
   - The statement grammar lives in `packages/shared`, because the chain does not use it.
   - Rejected: Node's built-in ML-DSA in the TypeScript servers, which would be a second implementation of the address encoding.

## Consequences

- Every TypeScript test and the container image need Rust and `wasm-bindgen-cli` to build `packages/core`.
- Signatures are 2,420 bytes, so a Travel ticket with its arrival is about 10 KB on the wire. That is fine once per arrival, but too large to sign every game message.
- A Player's address is long. The Shell shows the name with the first and last six characters after `tlr1`, and payments (step 2C) show the full address.
- Changing any of these choices after step 2C means a network upgrade and new addresses for everyone.
