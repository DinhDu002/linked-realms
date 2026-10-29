# Identity: keys, addresses and signed statements

Status: mandatory (ADR 0008, ADR 0009). Every Land, Shell, NPC runner and Hub implements this exactly. The reference implementation is `crates/core` (keys, signatures, addresses) and `packages/shared/src/identity.ts` (statements, exported as `@linked-realms/shared/identity`).

## Keys

**Scheme 1: ML-DSA-44** (FIPS 204).
- Public keys are `pkEncode` (1,312 bytes) and signatures are `sigEncode` (2,420 bytes).
- Signing uses the pure, external interface `ML-DSA.Sign(sk, M, ctx)`, where the context `ctx` is the ASCII string listed for each statement below.
- Signing is hedged: 32 fresh random bytes per signature. A verifier cannot tell the difference, and deterministic signatures still verify.

**A Character's key** comes from 24 words:
1. `entropy`: 32 random bytes.
2. The words: BIP-39 over `entropy`, using the English word list and its 8-bit checksum.
3. `seed`: the BIP-39 seed, PBKDF2-HMAC-SHA512 over the NFKD-normalised words with the salt `"mnemonic"` and an empty passphrase, 2048 rounds, 64 bytes.
4. `xi = HKDF-SHA512(salt = "linked-realms/ml-dsa-44/v1", ikm = seed, info = "character/" + index, length = 32)`. `index` is a decimal number without leading zeros; a Player's own Character is index `0`.
5. `(pk, sk) = ML-DSA-44.KeyGen_internal(xi)`, the key generation from a seed in FIPS 204.

**Other keys.** A Map server key and the Hub's ticket key are generated from 32 random bytes of `xi` and stored on their server. They are never derived from words.

## Addresses

An address is Bech32m (BIP-350) with the human-readable part `tlr` (the test network) over a 34-byte payload:

| Bytes | Field |
|---|---|
| 0 | version, `0` |
| 1 | scheme id, `1` for ML-DSA-44 |
| 2–33 | `keccak256(scheme id ‖ public key)` |

- keccak256 is the original Keccak with 256-bit output, the variant Ethereum uses, not SHA3-256.
- An address is always written in lowercase and is about 65 characters long, starting with `tlr1`. Readers reject uppercase, mixed case, another prefix, a Bech32 (not Bech32m) checksum, a bad checksum, a payload of another length, an unknown version, an unknown scheme, or non-zero padding bits in the last 5-bit group. The simplest correct check is to decode, encode again and compare the strings.
- Two addresses are equal exactly when their strings are equal.
- When space is short, show `tlr1`, then the first six characters after `tlr1`, `…`, and the last six characters. The first characters after `tlr1` are the same for every scheme-1 address, so they are not enough on their own.

## Signed statements

A statement is UTF-8 text that one key signs. Its grammar is strict, so every implementation reads the same fields from the same bytes.

1. Lines are separated by a single line feed (U+000A). There is no carriage return and no line feed after the last line.
2. The first line is the statement's title, exactly as in the table below.
3. Every following line is `Key: value`: the key exactly as listed, a colon, one space and the value. The keys appear in the listed order, each exactly once, and no other lines are present.
4. A value never contains a code point of Unicode general category Cc (control), Cf (format, which includes bidi controls and zero-width characters), Zl (line separator) or Zp (paragraph separator). It never contains an unpaired surrogate, and it does not start or end with white space.
5. Each value has the format given for its key (below). `Name` may be empty; every other value is non-empty.

| Title | Signed by | Context | Keys after the title |
|---|---|---|---|
| `linked-realms Hub sign-in` | Character | `linked-realms/hub-sign-in/v1` | `Hub`, `Nonce`, `Issued` |
| `linked-realms Map server` | Map server key | `linked-realms/map-server/v1` | `Hub`, `Owner`, `Map server key`, `Issued` |
| `linked-realms Delegation` | Land owner | `linked-realms/delegation/v1` | `Hub`, `Owner`, `Map server key`, `Issued` |
| `linked-realms Travel ticket` | the Hub's ticket key | `linked-realms/travel-ticket/v1` | `Hub`, `Character`, `Name`, `Land`, `Gate`, `Issued`, `Expires`, `Nonce` |
| `linked-realms arrival` | Character | `linked-realms/arrival/v1` | `Land`, `Ticket nonce`, `Driven by AI` |
| `linked-realms relay host` | Map server key | `linked-realms/relay-host/v1` | `Relay`, `Land`, `Nonce` |
| `linked-realms Land message` | Character | `linked-realms/land-message/v1` | `Land`, `Land URL`, `Character`, `Issued`, `Message` |

### Value formats

| Keys | Format |
|---|---|
| `Hub`, `Relay` | A host name in lowercase ASCII, optionally followed by `:port`, for example `hub.example.org` or `localhost:8787` |
| `Owner`, `Map server key`, `Character` | An address |
| `Name` | A Character's name: up to 32 code points, which may be empty |
| `Land` | A Land id: a decimal integer from 1 to 2^53 − 1, with no leading zeros |
| `Gate` | `0`, `1`, `2`, `3` or `4` (`gate-travel.md`) |
| `Issued`, `Expires` | Unix time in seconds: a decimal integer from 0 to 2^53 − 1, with no leading zeros |
| `Nonce`, `Ticket nonce` | 32 lowercase hexadecimal characters (16 random bytes) |
| `Driven by AI` | `yes` or `no` |
| `Land URL` | An origin: `https://` or `http://`, then a host, and an optional `:port`, with no path |
| `Message` | A JSON string literal (RFC 8259), as described below |

- **`Message`.** Every code point outside printable ASCII (U+0020 to U+007E) is written as a `\uXXXX` escape with lowercase hex digits, using a surrogate pair above U+FFFF, so the line is plain ASCII. `"` and `\` are written `\"` and `\\`; no other escape is used, and printable ASCII is never escaped. So each text has exactly one encoding: a reader decodes the value, encodes it again and refuses it if the result differs. The decoded text is valid Unicode (no unpaired surrogate) of at most 1,000 code points. Rule 4 applies to the ASCII line.
- **Example.** A message containing a line break is still one line in the statement: `Message: "line one\u000aline two"`.

### Sending and checking a statement

On the wire a statement travels as JSON:

```json
{ "statement": "<text>", "publicKey": "<base64>", "signature": "<base64>" }
```

Base64 is standard base64 with padding (RFC 4648 section 4).

A verifier:
1. decodes `publicKey` and `signature` and checks their lengths;
2. verifies the signature over the statement's UTF-8 bytes with the statement's context, and refuses on failure without parsing anything;
3. parses the statement with the grammar above and refuses on any deviation;
4. derives the address from `publicKey`. Where the statement names its signer, that field must equal the address:
   - `Character` for Land messages;
   - `Owner` for Delegations;
   - `Map server key` for Map server statements.

   The other statements name no signer, so the protocol that uses them checks the address: a sign-in identifies the Character by it; an arrival's must be its ticket's `Character` (`arrival.md`); a Travel ticket's must be the Hub's ticket key; a relay hello's must be the Land's `mapServerKey`.
5. checks the times, nonces and other rules of the protocol that uses the statement.

## Test vectors

- `crates/core/test-vectors/identity.json`: words, the seed, `xi`, the public key and the address for several entropies and indexes, one signed statement per context, and one invalid address for each rule above.
- `packages/shared/test-vectors/statements.json`: statements that must parse, with their fields, and statements that must be refused, each with the rule it breaks. Refused cases include a repeated key, a missing key, an extra line, a carriage return, U+2028 in a name, a bidi control in a name, a trailing space, an uppercase address and every non-canonical `Message`.
