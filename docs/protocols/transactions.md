# Transactions and accounts

Status: mandatory (ADR 0006, ADR 0011). Every Node checks transactions exactly this way, and every Shell builds them this way. The reference implementation is `crates/core` (`tx.rs`, `state.rs`, `smt.rs`); the vectors are `crates/core/test-vectors/chain.json` (`transactions`, `stateTree`, `stateSnapshots`).

All integers are big-endian and fixed width. An address is its 34-byte payload (`docs/protocols/identity.md`). Amounts and fees are in base units: 1 GOLD is 100,000,000.

## Layout

| Field | Bytes | |
|---|---|---|
| version | 1 | `1` |
| kind | 1 | `0` transfer, `1` key rotation |
| scheme | 1 | the scheme of the key that signs; `1` is ML-DSA-44 |
| sender | 34 | address |
| nonce | 8 | |
| fee | 8 | |
| **transfer:** to | 34 | address |
| amount | 8 | |
| memo length | 1 | at most 80 |
| memo | memo length | any bytes |
| **rotation:** new scheme | 1 | |
| new public key | by new scheme | 1,312 for scheme 1 |
| key flag | 1 | `1` on the sender's first transaction, else `0` |
| public key | by scheme, only if the flag is `1` | the sender's key |
| signature | by scheme | 2,420 for scheme 1 |

Sizes for scheme 1: a transfer is 2,517 bytes plus the memo, and 1,312 more on the sender's first transaction, so at most 3,909 bytes. A rotation is 3,787 bytes, or 5,099 as the first transaction.

## Signed bytes, signature and id

- **Signed bytes:** the network id (4 bytes: `1` on the test network, `2` on the dev network), then every field above except the signature. The network id is not in the transaction; the Node and the Shell take it from the network they are on.
- **Signature:** ML-DSA over the signed bytes, with the context `linked-realms/tx/v1`, by the key the sender's account holds, or the key in the transaction on the first one. A signature made for one network does not verify on another.
- **Id:** `keccak256(signed bytes)`. A new signature of the same transaction keeps its id.

## Accounts

An account belongs to an address: a balance, a nonce (the number of transactions the address has sent) and, from its first transaction on, a public key. An address has no account until it receives Gold. Accounts are never removed: an emptied account keeps its nonce, so its old transactions cannot be replayed.

**Hashed form**, for the state root: `address (34) ‖ balance (8) ‖ nonce (8) ‖ key hash (32)`, 82 bytes. The key hash is `keccak256(scheme ‖ public key)` of the current key, or 32 zero bytes before the first transaction.

## Reading

Fields are read in order, and the first field that is wrong gives the error:

| Error | When |
|---|---|
| `Truncated` | the bytes end before a field |
| `UnknownVersion` | version is not `1` |
| `UnknownKind` | kind is not `0` or `1` |
| `UnknownScheme` | an unknown signing scheme, address scheme or new scheme |
| `BadAddress` | an address version other than `0` |
| `MemoTooLong` | memo length over 80 |
| `BadKeyFlag` | key flag not `0` or `1` |
| `TrailingBytes` | bytes left after the signature |

## Checks, in order

A transaction that reads correctly is checked against the accounts. The first failing check gives the error:

1. `ZeroAmount`: a transfer of 0. A transfer to oneself is allowed.
2. `NoAccount`: the sender has no account.
3. `WrongNonce`: the nonce is not the account's nonce.
4. The public key:
   - `MissingKey`: the account has no key and the key flag is `0`.
   - `RepeatedKey`: the account has a key and the key flag is `1`.
   - `KeyMismatch`: the account has no key and the key in the transaction is not the one the sender's address was made from.
5. `Overflow`: amount plus fee, the sender's nonce plus 1, or the recipient's balance plus the amount passes `2^64 - 1`.
6. `InsufficientBalance`: the balance is less than amount plus fee. A fee of 0 is valid here; a Node's minimum relay fee is its own policy.
7. `BadSignature`: the scheme is not the scheme of the key in use, or the signature does not verify.

## Applying

All of these happen together, or none:

- The sender's balance falls by amount plus fee, its nonce rises by 1, and its key becomes the transaction's key on the first transaction, or the new key after a rotation. The address never changes.
- A transfer adds the amount to the recipient's balance, making the account if there is none. A transfer to oneself costs only the fee.
- The fee goes to the reward address of the Block that holds the transaction, after all of the Block's transactions.

## State root

The state root is the root of a sparse Merkle tree of depth 256 that holds every account. All hashes are keccak256.

- **Key:** `keccak256(address)`, over the 34-byte address. Bit `i` of a key is `(key[i / 8] >> (7 - i % 8)) & 1`. A node at depth `d` (the root is at depth 0) has its left child on bit `d` = 0 and its right child on 1, so each account's leaf sits at depth 256 on its key's path.
- **Leaf:** `keccak256(0x00 ‖ key ‖ hashed form)`.
- **Node:** `keccak256(0x01 ‖ left ‖ right)`.
- **Empty subtrees:** `E[0]` is 32 zero bytes; `E[h + 1] = keccak256(0x01 ‖ E[h] ‖ E[h])`. A subtree of height `h` with no account hashes to `E[h]`.
- **Root:** the node at depth 0. With no account it is `E[256]`; the genesis state has no account, so that is the genesis state root. The root depends only on the accounts, never on the order in which they changed.
- **One account** (the fold rule): start with `c` = its leaf. For `j` from 0 to 255, with `b` = bit `255 - j` of its key, set `c = keccak256(0x01 ‖ c ‖ E[j])` if `b` is 0, else `c = keccak256(0x01 ‖ E[j] ‖ c)`. Then `c` is the root of a tree that holds only this account.

How a Node stores the tree is its own choice; only the hashes above count. `crates/core` stores one entry for each node over two or more accounts and one for each account alone in its subtree, about 2.4 entries per account, instead of 256 nodes per account.

**Checking a state snapshot.** A state snapshot is every account at a Checkpoint's height, in ascending key order (keys compared as unsigned bytes), each once. The receiving Node builds the tree from it and compares the root with the state root in the Checkpoint's header:

| Error | When |
|---|---|
| `SnapshotOrder` | a key is not greater than the one before it (a repeated or out-of-order account) |
| `WrongStateRoot` | the root differs: an account is changed, missing or extra |

Keys are checked as the accounts are read, so a snapshot that is out of order gives `SnapshotOrder` even if its root would also differ.

How a Node sends and receives a state snapshot comes with pruning (plan item 14).
