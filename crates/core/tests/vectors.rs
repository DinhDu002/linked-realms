//! The vectors in `test-vectors/`: NIST's ML-DSA-44 vectors, the BIP-39 reference vectors and our
//! own `identity.json` and `chain.json`. `UPDATE_VECTORS=1 cargo test` rewrites our own files;
//! otherwise they are checked byte for byte.

use std::collections::HashMap;
use std::path::PathBuf;

use linked_realms_core::block::{
    Block, HEADER_LEN, Header, MAX_BLOCK_SIZE, MAX_NEW_ACCOUNTS, NONCE_OFFSET, validate_block,
};
use linked_realms_core::issuance::{BASE_UNITS_PER_GOLD, HALVING_INTERVAL, reward};
use linked_realms_core::merkle::tx_root;
use linked_realms_core::params::{ChainParams, DEV, TESTNET};
use linked_realms_core::retarget::next_target;
use linked_realms_core::smt::{self, Node};
use linked_realms_core::state::{Account, PublicKey, tree_key};
use linked_realms_core::tx::{Kind, Tx, apply_tx, check_tx};
use linked_realms_core::u256::U256;
use linked_realms_core::{
    ADDRESS_LEN, Address, Error, SCHEME_ML_DSA_44, SigningKey, character_seed, entropy_from_words,
    verify, words_from_entropy,
};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

fn path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("test-vectors")
        .join(name)
}

fn read<T: DeserializeOwned>(name: &str) -> T {
    serde_json::from_str(&std::fs::read_to_string(path(name)).unwrap()).unwrap()
}

fn bytes<const N: usize>(text: &str) -> [u8; N] {
    hex::decode(text).unwrap().try_into().unwrap()
}

/// Writes our own vector file with `UPDATE_VECTORS=1`; otherwise checks it byte for byte.
fn check_or_update<T: Serialize>(name: &str, generated: &T) {
    let json = serde_json::to_string_pretty(generated).unwrap() + "\n";
    if std::env::var_os("UPDATE_VECTORS").is_some() {
        std::fs::write(path(name), json).unwrap();
    } else {
        assert_eq!(
            std::fs::read_to_string(path(name)).unwrap(),
            json,
            "{name} differs from this code; regenerate it only on purpose"
        );
    }
}

#[derive(Deserialize)]
struct Cases<T> {
    tests: Vec<T>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct KeyGenCase {
    tc_id: u32,
    seed: String,
    pk: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SigVerCase {
    tc_id: u32,
    pk: String,
    message: String,
    context: String,
    signature: String,
    test_passed: bool,
}

#[derive(Deserialize)]
struct Bip39Case {
    entropy: String,
    words: String,
    seed: String,
}

#[test]
fn nist_key_generation() {
    let cases: Cases<KeyGenCase> = read("nist-ml-dsa-44-keygen.json");
    assert_eq!(cases.tests.len(), 25);
    for case in cases.tests {
        let key = SigningKey::from_seed(&bytes(&case.seed));
        assert_eq!(
            key.public_key().as_slice(),
            hex::decode(&case.pk).unwrap(),
            "tcId {}",
            case.tc_id
        );
    }
}

#[test]
fn nist_signature_verification() {
    let cases: Cases<SigVerCase> = read("nist-ml-dsa-44-sigver.json");
    assert!(cases.tests.iter().any(|c| c.test_passed));
    assert!(cases.tests.iter().any(|c| !c.test_passed));
    for case in cases.tests {
        let valid = verify(
            SCHEME_ML_DSA_44,
            &hex::decode(&case.pk).unwrap(),
            &hex::decode(&case.context).unwrap(),
            &hex::decode(&case.message).unwrap(),
            &hex::decode(&case.signature).unwrap(),
        );
        assert_eq!(valid, case.test_passed, "tcId {}", case.tc_id);
    }
}

#[test]
fn matches_the_ml_dsa_crate() {
    use ml_dsa::{B32, EncodedSignature, ExpandedSigningKey, MlDsa44, Signature};

    for i in 0..8u8 {
        let xi = [i.wrapping_mul(37); 32];
        let ours = SigningKey::from_seed(&xi);
        let theirs = ExpandedSigningKey::<MlDsa44>::from_seed(&B32::from(xi));
        let their_public = theirs.verifying_key();
        assert_eq!(
            ours.public_key().as_slice(),
            their_public.encode().as_slice()
        );

        let (context, message) = (b"linked-realms/test/v1".as_slice(), [i; 100]);
        let deterministic = ours.sign(context, &message, &[0; 32]).unwrap();
        let theirs_signed = theirs.sign_deterministic(&message, context).unwrap();
        assert_eq!(deterministic.as_slice(), theirs_signed.encode().as_slice());

        let hedged = ours.sign(context, &message, &[i; 32]).unwrap();
        let decoded = Signature::<MlDsa44>::decode(
            &EncodedSignature::<MlDsa44>::try_from(hedged.as_slice()).unwrap(),
        )
        .unwrap();
        assert!(their_public.verify_with_context(&message, context, &decoded));
        assert!(verify(
            SCHEME_ML_DSA_44,
            ours.public_key(),
            context,
            &message,
            &theirs_signed.encode()
        ));
    }
}

#[test]
fn bip39_reference_vectors() {
    let cases: Cases<Bip39Case> = read("bip39.json");
    assert!(!cases.tests.is_empty());
    for case in cases.tests {
        let entropy = bytes(&case.entropy);
        assert_eq!(words_from_entropy(&entropy), case.words);
        assert_eq!(*entropy_from_words(&case.words).unwrap(), entropy);
        // The reference seeds use the passphrase "TREZOR"; ours use an empty one.
        let mnemonic = bip39::Mnemonic::parse_normalized(&case.words).unwrap();
        assert_eq!(
            mnemonic.to_seed_normalized("TREZOR").as_slice(),
            hex::decode(&case.seed).unwrap()
        );
    }
}

/// `identity.json`. Field order is the order a reader follows the derivation.
#[derive(Serialize, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
struct Identity {
    note: String,
    characters: Vec<CharacterVector>,
    statements: Vec<StatementVector>,
    /// Strings every reader must refuse as an address, each with the rule it breaks.
    invalid_addresses: Vec<InvalidAddress>,
}

#[derive(Serialize, Deserialize, PartialEq, Debug)]
struct InvalidAddress {
    reason: String,
    address: String,
}

#[derive(Serialize, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
struct CharacterVector {
    entropy: String,
    words: String,
    /// The BIP-39 seed with an empty passphrase.
    seed: String,
    index: u32,
    xi: String,
    public_key: String,
    address: String,
}

#[derive(Serialize, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
struct StatementVector {
    context: String,
    statement: String,
    signer_xi: String,
    public_key: String,
    address: String,
    signature: String,
}

const NOTE: &str = "docs/protocols/identity.md. Bytes are lowercase hex. Signatures use rnd = 32 \
zero bytes (the deterministic variant) so they can be reproduced; real signers use fresh random \
bytes. Regenerate with UPDATE_VECTORS=1 cargo test -p linked-realms-core.";

fn generate() -> Identity {
    let entropies: [[u8; 32]; 3] = [[0; 32], core::array::from_fn(|i| i as u8), [0xff; 32]];
    let mut characters = Vec::new();
    for (entropy, index) in [
        (entropies[0], 0),
        (entropies[0], 1),
        (entropies[1], 0),
        (entropies[1], 7),
        (entropies[2], 0),
        (entropies[2], u32::MAX),
    ] {
        let words = words_from_entropy(&entropy);
        let seed = bip39::Mnemonic::parse_normalized(&words)
            .unwrap()
            .to_seed_normalized("");
        let xi = character_seed(&entropy, index);
        let key = SigningKey::from_seed(&xi);
        characters.push(CharacterVector {
            entropy: hex::encode(entropy),
            words,
            seed: hex::encode(seed),
            index,
            xi: hex::encode(*xi),
            public_key: hex::encode(key.public_key()),
            address: key.address().to_string(),
        });
    }

    let character_xi = *character_seed(&entropies[1], 0);
    let map_server_xi = [0x4d; 32];
    let hub_xi = [0x48; 32];
    let character = SigningKey::from_seed(&character_xi).address();
    let map_server = SigningKey::from_seed(&map_server_xi).address();
    let (hub, issued, nonce) = (
        "hub.example.org",
        1_793_232_000,
        "00112233445566778899aabbccddeeff",
    );
    let unsigned = [
        (
            "hub-sign-in",
            character_xi,
            format!("linked-realms Hub sign-in\nHub: {hub}\nNonce: {nonce}\nIssued: {issued}"),
        ),
        (
            "map-server",
            map_server_xi,
            format!(
                "linked-realms Map server\nHub: {hub}\nOwner: {character}\nMap server key: {map_server}\nIssued: {issued}"
            ),
        ),
        (
            "delegation",
            character_xi,
            format!(
                "linked-realms Delegation\nHub: {hub}\nOwner: {character}\nMap server key: {map_server}\nIssued: {issued}"
            ),
        ),
        (
            "travel-ticket",
            hub_xi,
            format!(
                "linked-realms Travel ticket\nHub: {hub}\nCharacter: {character}\nName: Mai\nLand: 7\nGate: 4\nIssued: {issued}\nExpires: {}\nNonce: {nonce}",
                issued + 60
            ),
        ),
        (
            "arrival",
            character_xi,
            format!("linked-realms arrival\nLand: 7\nTicket nonce: {nonce}\nDriven by AI: no"),
        ),
        (
            "relay-host",
            map_server_xi,
            format!("linked-realms relay host\nRelay: localhost:8788\nLand: 7\nNonce: {nonce}"),
        ),
        (
            "land-message",
            character_xi,
            format!(
                "linked-realms Land message\nLand: 7\nLand URL: https://7.lands.example\nCharacter: {character}\nIssued: {issued}\nMessage: \"Xin ch\\u00e0o \\\"Mai\\\"\\u000aSee you at the \\ud83c\\udff0\""
            ),
        ),
    ];
    let statements = unsigned
        .into_iter()
        .map(|(name, xi, statement)| {
            let key = SigningKey::from_seed(&xi);
            let context = format!("linked-realms/{name}/v1");
            let signature = key
                .sign(context.as_bytes(), statement.as_bytes(), &[0; 32])
                .unwrap();
            StatementVector {
                context,
                statement,
                signer_xi: hex::encode(xi),
                public_key: hex::encode(key.public_key()),
                address: key.address().to_string(),
                signature: hex::encode(signature),
            }
        })
        .collect();

    Identity {
        note: NOTE.into(),
        characters,
        statements,
        invalid_addresses: invalid_addresses(&character),
    }
}

/// Every way `identity.md` says an address can be wrong, built from a valid one.
fn invalid_addresses(valid: &Address) -> Vec<InvalidAddress> {
    use bech32::primitives::iter::{ByteIterExt, Fe32IterExt};
    use bech32::{Bech32, Bech32m, Fe32, Hrp};

    let tlr = Hrp::parse_unchecked("tlr");
    let mut payload = vec![0, valid.scheme()];
    payload.extend_from_slice(valid.hash());
    let with = |index: usize, byte: u8| {
        let mut changed = payload.clone();
        changed[index] = byte;
        bech32::encode_lower::<Bech32m>(tlr, &changed).unwrap()
    };
    let text = valid.to_string();
    let mut bad_checksum = text.clone();
    let last = bad_checksum.pop().unwrap();
    bad_checksum.push(if last == 'q' { 'p' } else { 'q' });
    // 34 bytes are 55 five-bit groups; the last one ends in 3 padding bits, which must be zero.
    let mut groups: Vec<Fe32> = payload.iter().copied().bytes_to_fes().collect();
    let end = groups.pop().unwrap();
    groups.push(Fe32::try_from(end.to_u8() | 1).unwrap());
    let padding: String = groups
        .into_iter()
        .with_checksum::<Bech32m>(&tlr)
        .chars()
        .collect();

    [
        ("uppercase", text.to_uppercase()),
        (
            "mixed case",
            format!("tlr1{}", text[4..].replacen('q', "Q", 1)),
        ),
        (
            "another prefix",
            bech32::encode_lower::<Bech32m>(Hrp::parse_unchecked("tlx"), &payload).unwrap(),
        ),
        (
            "a Bech32 checksum instead of Bech32m",
            bech32::encode_lower::<Bech32>(tlr, &payload).unwrap(),
        ),
        ("a bad checksum", bad_checksum),
        (
            "a 33-byte payload",
            bech32::encode_lower::<Bech32m>(tlr, &payload[..33]).unwrap(),
        ),
        (
            "a 35-byte payload",
            bech32::encode_lower::<Bech32m>(tlr, &[payload.as_slice(), &[0]].concat()).unwrap(),
        ),
        ("an unknown version", with(0, 1)),
        ("an unknown scheme", with(1, 2)),
        ("non-zero padding bits", padding),
    ]
    .into_iter()
    .map(|(reason, address)| InvalidAddress {
        reason: reason.into(),
        address,
    })
    .collect()
}

#[test]
fn identity_vectors() {
    let generated = generate();
    for statement in &generated.statements {
        let signature = hex::decode(&statement.signature).unwrap();
        let public_key = hex::decode(&statement.public_key).unwrap();
        let (context, message) = (statement.context.as_bytes(), statement.statement.as_bytes());
        assert!(verify(
            SCHEME_ML_DSA_44,
            &public_key,
            context,
            message,
            &signature
        ));
        assert!(!verify(
            SCHEME_ML_DSA_44,
            &public_key,
            b"linked-realms/other/v1",
            message,
            &signature
        ));
        assert!(statement.address.parse::<Address>().is_ok());
    }
    for invalid in &generated.invalid_addresses {
        assert!(
            invalid.address.parse::<Address>().is_err(),
            "accepted an address with {}",
            invalid.reason
        );
    }
    check_or_update("identity.json", &generated);
}

/// `chain.json`: the chain rules of ADR 0011. Amounts are decimal strings of base units, so
/// JavaScript reads them exactly. Later items of step 2C add headers and Blocks.
#[derive(Serialize, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
struct Chain {
    note: String,
    networks: Vec<Network>,
    addresses: Vec<AddressBytes>,
    invalid_address_bytes: Vec<InvalidAddressBytes>,
    issuance: Issuance,
    tx_roots: Vec<TxRoot>,
    transactions: Ledger,
    state_tree: StateTree,
    state_snapshots: StateSnapshots,
    retarget: Retarget,
    blocks: Blocks,
}

#[derive(Serialize, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
struct Network {
    name: String,
    network_id: u32,
}

#[derive(Serialize, Deserialize, PartialEq, Debug)]
struct AddressBytes {
    address: String,
    bytes: String,
}

#[derive(Serialize, Deserialize, PartialEq, Debug)]
struct InvalidAddressBytes {
    reason: String,
    bytes: String,
}

#[derive(Serialize, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
struct Issuance {
    base_units_per_gold: String,
    halving_interval: u64,
    rewards: Vec<Reward>,
    /// All Gold issued by the end of the fourth era (height 8,400,000), before the tail reward.
    total_before_tail: String,
}

#[derive(Serialize, Deserialize, PartialEq, Debug)]
struct Reward {
    height: u64,
    reward: String,
}

#[derive(Serialize, Deserialize, PartialEq, Debug)]
struct TxRoot {
    ids: Vec<String>,
    root: String,
}

const CHAIN_NOTE: &str = "docs/decisions/0011-chain-encodings-and-issuance.md. Bytes are \
lowercase hex; amounts are decimal strings of base units (1 GOLD = 100000000). Regenerate with \
UPDATE_VECTORS=1 cargo test -p linked-realms-core.";

fn generate_chain() -> Chain {
    let (ledger, final_state) = generate_ledger();
    let state_snapshots = generate_state_snapshots(&final_state, &ledger);
    let networks = [("testnet", &TESTNET), ("dev", &DEV)]
        .into_iter()
        .map(|(name, params)| Network {
            name: name.into(),
            network_id: params.network_id,
        })
        .collect();

    let addresses = [[0x4d; 32], [0x48; 32]]
        .iter()
        .map(|xi| {
            let address = SigningKey::from_seed(xi).address();
            AddressBytes {
                address: address.to_string(),
                bytes: hex::encode(address.to_bytes()),
            }
        })
        .collect();
    let valid = SigningKey::from_seed(&[0x4d; 32]).address().to_bytes();
    let with = |index: usize, byte: u8| {
        let mut changed = valid;
        changed[index] = byte;
        hex::encode(changed)
    };
    let invalid_address_bytes = [
        ("an unknown version", with(0, 1)),
        ("an unknown scheme", with(1, 2)),
        ("33 bytes", hex::encode(&valid[..33])),
        ("35 bytes", hex::encode([valid.as_slice(), &[0]].concat())),
    ]
    .into_iter()
    .map(|(reason, bytes)| InvalidAddressBytes {
        reason: reason.into(),
        bytes,
    })
    .collect();

    let edges = [
        0,
        1,
        2_100_000,
        2_100_001,
        4_200_001,
        6_300_001,
        8_400_000,
        8_400_001,
        8_400_002,
        100_000_000,
    ];
    let total_before_tail: u64 = (0..4)
        .map(|era| reward(era * HALVING_INTERVAL + 1) * HALVING_INTERVAL)
        .sum();
    let issuance = Issuance {
        base_units_per_gold: BASE_UNITS_PER_GOLD.to_string(),
        halving_interval: HALVING_INTERVAL,
        rewards: edges
            .into_iter()
            .map(|height| Reward {
                height,
                reward: reward(height).to_string(),
            })
            .collect(),
        total_before_tail: total_before_tail.to_string(),
    };

    let tx_roots = [0, 1, 2, 3, 4, 5, 8]
        .into_iter()
        .map(|count| {
            // Ids are opaque 32-byte values here; real ones are transaction hashes.
            let ids: Vec<[u8; 32]> = (1..=count).map(|i| [i; 32]).collect();
            TxRoot {
                ids: ids.iter().map(hex::encode).collect(),
                root: hex::encode(tx_root(&ids)),
            }
        })
        .collect();

    Chain {
        note: CHAIN_NOTE.into(),
        networks,
        addresses,
        invalid_address_bytes,
        issuance,
        tx_roots,
        transactions: ledger,
        state_tree: generate_state_tree(),
        state_snapshots,
        retarget: generate_retarget(),
        blocks: generate_blocks(),
    }
}

/// Transactions replayed in order on one ledger of the test network: start from `start`, read
/// each step's bytes with `Tx::from_bytes`, then check and apply it on the step's network. A
/// refused step changes nothing.
#[derive(Serialize, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
struct Ledger {
    start: Vec<AccountVector>,
    /// The state root of `start`.
    start_root: String,
    steps: Vec<TxStep>,
}

#[derive(Serialize, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
struct AccountVector {
    address: String,
    balance: String,
    nonce: String,
    /// `keccak256(scheme ‖ public key)` of the stored key, or null before the first transaction.
    key_hash: Option<String>,
    /// The hashed form, `Account::hashed_bytes`.
    bytes: String,
}

#[derive(Serialize, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
struct TxStep {
    note: String,
    network: String,
    tx: String,
    /// Null when the bytes are not a transaction.
    id: Option<String>,
    /// "ok", or the error of `docs/protocols/transactions.md`.
    verdict: String,
    /// The accounts the step changed, as they are after it, ordered by address.
    changed: Vec<AccountVector>,
    /// The state root after the step.
    state_root: String,
}

const GOLD: u64 = BASE_UNITS_PER_GOLD;

fn account_vectors<'a>(
    accounts: impl Iterator<Item = (&'a Address, &'a Account)>,
) -> Vec<AccountVector> {
    let mut vectors: Vec<AccountVector> = accounts
        .map(|(address, account)| AccountVector {
            address: address.to_string(),
            balance: account.balance.to_string(),
            nonce: account.nonce.to_string(),
            key_hash: account.key.as_ref().map(|key| hex::encode(key.hash())),
            bytes: hex::encode(account.hashed_bytes(address)),
        })
        .collect();
    vectors.sort_by(|a, b| a.address.cmp(&b.address));
    vectors
}

/// A signed transaction's bytes. `signer` may differ from `sender` to build refused cases.
fn signed(
    params: &ChainParams,
    signer: &SigningKey,
    sender: Address,
    nonce: u64,
    fee: u64,
    kind: Kind,
    public_key: Option<&SigningKey>,
) -> Vec<u8> {
    let mut tx = Tx {
        scheme: SCHEME_ML_DSA_44,
        sender,
        nonce,
        fee,
        kind,
        public_key: public_key.map(|key| key.public_key().to_vec()),
        signature: Vec::new(),
    };
    tx.sign(params, signer, &[0; 32]).unwrap();
    tx.to_bytes()
}

fn send(to: Address, amount: u64, memo: &[u8]) -> Kind {
    Kind::Transfer {
        to,
        amount,
        memo: memo.to_vec(),
    }
}

fn rotate_to(key: &SigningKey) -> Kind {
    Kind::Rotation {
        new_key: PublicKey {
            scheme: SCHEME_ML_DSA_44,
            bytes: key.public_key().to_vec(),
        },
    }
}

/// A note, the network, the bytes and the expected verdict.
type Step<'a> = (&'a str, &'a ChainParams, Vec<u8>, Result<(), Error>);

type Tree = HashMap<(u16, [u8; 32]), Node>;

/// The state tree of a whole state, built from scratch.
fn tree_of(state: &HashMap<Address, Account>) -> Tree {
    let mut tree = Tree::new();
    for (address, account) in state {
        smt::insert(
            &mut tree,
            &tree_key(address),
            &account.hashed_bytes(address),
        );
    }
    tree
}

/// The ledger's vectors, and its accounts at the end.
fn generate_ledger() -> (Ledger, HashMap<Address, Account>) {
    let key = |seed: u8| SigningKey::from_seed(&[seed; 32]);
    let (a, a2, b, b2, c, d) = (
        key(0x41),
        key(0x61),
        key(0x42),
        key(0x62),
        key(0x43),
        key(0x44),
    );
    let (a_at, b_at, c_at) = (a.address(), b.address(), c.address());
    let mut state = HashMap::from([
        (
            a_at,
            Account {
                balance: 10 * GOLD,
                ..Account::default()
            },
        ),
        (
            b_at,
            Account {
                balance: GOLD,
                ..Account::default()
            },
        ),
    ]);
    let start = account_vectors(state.iter());
    let mut tree = tree_of(&state);
    let start_root = hex::encode(smt::root(&tree));
    let t = &TESTNET;
    let memo = b"An 80-byte memo: a Land can say what a payment is for, in any bytes it likes....";
    assert_eq!(memo.len(), 80);

    let first = signed(t, &a, a_at, 0, 40_000, send(b_at, GOLD, b""), Some(&a));
    let second = signed(t, &a, a_at, 1, 30_000, send(c_at, 2 * GOLD, memo), None);
    let third = signed(t, &a, a_at, 2, 30_000, send(b_at, GOLD, b""), None);
    let mut flipped = signed(t, &a, a_at, 3, 30_000, send(b_at, GOLD, b""), None);
    let middle_of_signature = flipped.len() - 1200;
    flipped[middle_of_signature] ^= 1;
    // `third` is a transfer with no memo and no key: its memo length is byte 95 and its key
    // flag byte 96. In `second` the memo length is byte 95 too.
    let patched = |index: usize, byte: u8| {
        let mut bytes = third.clone();
        bytes[index] = byte;
        bytes
    };
    let mut long_memo = second.clone();
    long_memo[95] = 81;
    long_memo.insert(96 + 80, b'.');

    use Error::*;
    let steps: Vec<Step> = vec![
        (
            "A's first transaction carries A's public key",
            t,
            first,
            Ok(()),
        ),
        (
            "a later one carries none; C had no account and gets one; an 80-byte memo",
            t,
            second.clone(),
            Ok(()),
        ),
        (
            "the same bytes again (a replay)",
            t,
            second,
            Err(WrongNonce),
        ),
        (
            "A's public key on a later transaction",
            t,
            signed(t, &a, a_at, 2, 30_000, send(b_at, 1, b""), Some(&a)),
            Err(RepeatedKey),
        ),
        (
            "B's first transaction without B's public key",
            t,
            signed(t, &b, b_at, 0, 30_000, send(a_at, 1, b""), None),
            Err(MissingKey),
        ),
        (
            "B's first transaction with A's public key, signed by A",
            t,
            signed(t, &a, b_at, 0, 40_000, send(a_at, 1, b""), Some(&a)),
            Err(KeyMismatch),
        ),
        (
            "B sends all it has, with nothing left for the fee",
            t,
            signed(t, &b, b_at, 0, 40_000, send(a_at, 2 * GOLD, b""), Some(&b)),
            Err(InsufficientBalance),
        ),
        (
            "amount plus fee passes u64::MAX",
            t,
            signed(t, &b, b_at, 0, 1, send(a_at, u64::MAX, b""), Some(&b)),
            Err(Overflow),
        ),
        (
            "an amount of 0",
            t,
            signed(t, &b, b_at, 0, 40_000, send(a_at, 0, b""), Some(&b)),
            Err(ZeroAmount),
        ),
        (
            "signed for the dev network, checked on the test network",
            t,
            signed(&DEV, &a, a_at, 2, 30_000, send(b_at, GOLD, b""), None),
            Err(BadSignature),
        ),
        (
            "signed for the test network, checked on the dev network",
            &DEV,
            third.clone(),
            Err(BadSignature),
        ),
        (
            "the same bytes on the test network",
            t,
            third.clone(),
            Ok(()),
        ),
        (
            "one bit of the signature flipped",
            t,
            flipped,
            Err(BadSignature),
        ),
        (
            "D has never received Gold",
            t,
            signed(t, &d, d.address(), 0, 0, rotate_to(&d), Some(&d)),
            Err(NoAccount),
        ),
        (
            "B's first transaction rotates B's key; the address stays",
            t,
            signed(t, &b, b_at, 0, 50_000, rotate_to(&b2), Some(&b)),
            Ok(()),
        ),
        (
            "B signs with the old key after the rotation",
            t,
            signed(t, &b, b_at, 1, 30_000, send(b_at, GOLD, b""), None),
            Err(BadSignature),
        ),
        (
            "B signs with the new key; a transfer to oneself costs only the fee",
            t,
            signed(t, &b2, b_at, 1, 30_000, send(b_at, GOLD, b""), None),
            Ok(()),
        ),
        (
            "A rotates its key with a fee of 0",
            t,
            signed(t, &a, a_at, 3, 0, rotate_to(&a2), None),
            Ok(()),
        ),
        (
            "C sends all it has but the fee; its emptied account stays",
            t,
            signed(
                t,
                &c,
                c_at,
                0,
                40_000,
                send(a_at, 2 * GOLD - 40_000, b""),
                Some(&c),
            ),
            Ok(()),
        ),
        (
            "one byte short",
            t,
            third[..third.len() - 1].to_vec(),
            Err(Truncated),
        ),
        (
            "one byte too many",
            t,
            [third.as_slice(), &[0]].concat(),
            Err(TrailingBytes),
        ),
        ("version 2", t, patched(0, 2), Err(UnknownVersion)),
        ("kind 2", t, patched(1, 2), Err(UnknownKind)),
        ("signing scheme 2", t, patched(2, 2), Err(UnknownScheme)),
        (
            "a sender address with version 1",
            t,
            patched(3, 1),
            Err(BadAddress),
        ),
        (
            "a recipient address with scheme 2",
            t,
            patched(3 + 34 + 16 + 1, 2),
            Err(UnknownScheme),
        ),
        ("an 81-byte memo", t, long_memo, Err(MemoTooLong)),
        ("a public key flag of 2", t, patched(96, 2), Err(BadKeyFlag)),
    ];

    let total =
        |state: &HashMap<Address, Account>| -> u64 { state.values().map(|a| a.balance).sum() };
    let (supply, mut fees) = (total(&state), 0);
    let steps = steps
        .into_iter()
        .map(|(note, params, bytes, expected)| {
            let before = state.clone();
            let (id, verdict) = match Tx::from_bytes(&bytes) {
                Err(error) => (None, Err(error)),
                Ok(tx) => {
                    assert_eq!(tx.to_bytes(), bytes, "{note}: one encoding");
                    let checked = check_tx(params, &state, &tx);
                    let applied = apply_tx(params, &mut state, &tx);
                    assert_eq!(checked, applied, "{note}: check and apply agree");
                    if applied.is_ok() {
                        fees += tx.fee;
                    }
                    (Some(hex::encode(tx.id(params))), applied)
                }
            };
            assert_eq!(verdict, expected, "{note}");
            if verdict.is_err() {
                assert_eq!(state, before, "{note}: a refused step writes nothing");
            }
            let changed: Vec<_> = state
                .iter()
                .filter(|(address, account)| before.get(address) != Some(account))
                .collect();
            for (address, account) in &changed {
                smt::insert(
                    &mut tree,
                    &tree_key(address),
                    &account.hashed_bytes(address),
                );
            }
            assert_eq!(
                tree,
                tree_of(&state),
                "{note}: the tree follows the accounts"
            );
            TxStep {
                note: note.into(),
                network: if params == &TESTNET { "testnet" } else { "dev" }.into(),
                tx: hex::encode(&bytes),
                id,
                verdict: verdict.map_or_else(|error| format!("{error:?}"), |()| "ok".into()),
                changed: account_vectors(changed.into_iter()),
                state_root: hex::encode(smt::root(&tree)),
            }
        })
        .collect();
    assert_eq!(
        total(&state) + fees,
        supply,
        "Gold is neither made nor lost"
    );
    let emptied = &state[&c_at];
    assert_eq!((emptied.balance, emptied.nonce), (0, 1));
    (
        Ledger {
            start,
            start_root,
            steps,
        },
        state,
    )
}

/// The state tree (`smt`) on chosen keys and values, so no address has to be ground to get keys
/// that share a given number of bits.
#[derive(Serialize, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
struct StateTree {
    /// `E[0]` to `E[256]`, the hashes of empty subtrees by height. `E[256]` is the root with no
    /// account, so the genesis state's root.
    empty_subtrees: Vec<String>,
    one_key: OneKey,
    trees: Vec<TreeCase>,
}

#[derive(Serialize, Deserialize, PartialEq, Debug)]
struct OneKey {
    key: String,
    value: String,
    /// `keccak256(0x00 ‖ key ‖ value)`.
    leaf: String,
    /// The fold rule's hash at each height, from 0 (the leaf) to 256 (the root).
    path: Vec<String>,
}

#[derive(Serialize, Deserialize, PartialEq, Debug)]
struct TreeCase {
    note: String,
    /// Inserted in this order; a key that is already there gets the new value.
    entries: Vec<Entry>,
    /// Then removed, in this order.
    removed: Vec<String>,
    root: String,
}

#[derive(Serialize, Deserialize, PartialEq, Debug)]
struct Entry {
    key: String,
    value: String,
}

fn keccak(parts: &[&[u8]]) -> [u8; 32] {
    use sha3::{Digest, Keccak256};
    let mut hasher = Keccak256::new();
    for part in parts {
        hasher.update(part);
    }
    hasher.finalize().into()
}

fn generate_state_tree() -> StateTree {
    let flipped = |key: [u8; 32], i: usize| {
        let mut key = key;
        key[i / 8] ^= 0x80 >> (i % 8);
        key
    };
    let base = [0x5a; 32];
    let case = |note: &str, entries: &[([u8; 32], &[u8])], removed: &[[u8; 32]]| {
        let mut tree = Tree::new();
        for (key, value) in entries {
            smt::insert(&mut tree, key, value);
        }
        for key in removed {
            smt::remove(&mut tree, key);
        }
        TreeCase {
            note: note.into(),
            entries: entries
                .iter()
                .map(|(key, value)| Entry {
                    key: hex::encode(key),
                    value: hex::encode(value),
                })
                .collect(),
            removed: removed.iter().map(hex::encode).collect(),
            root: hex::encode(smt::root(&tree)),
        }
    };
    let pair = |i: usize| [(base, &b"first"[..]), (flipped(base, i), b"second")];
    let three = [
        ([0x11; 32], &b"first"[..]),
        ([0x22; 32], b"second"),
        ([0x33; 32], b"third"),
    ];
    let trees = vec![
        case("one key", &[(base, b"first")], &[]),
        case("two keys that differ only in the last bit", &pair(255), &[]),
        case(
            "two keys that share exactly their first 100 bits",
            &pair(100),
            &[],
        ),
        case("two keys that differ in the first bit", &pair(0), &[]),
        case("three keys", &three, &[]),
        case(
            "the same three keys in reverse order: the same root",
            &[three[2], three[1], three[0]],
            &[],
        ),
        case(
            "two keys, then the second removed: the root of the first alone",
            &pair(100),
            &[flipped(base, 100)],
        ),
        case(
            "a key set twice: the second value counts",
            &[(base, b"old"), (base, b"first")],
            &[],
        ),
    ];
    assert_eq!(trees[4].root, trees[5].root);
    assert_eq!(trees[6].root, trees[0].root);
    assert_eq!(trees[7].root, trees[0].root);
    for order in [[0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1]] {
        let entries = order.map(|i| three[i]);
        assert_eq!(case("", &entries, &[]).root, trees[4].root, "every order");
    }

    // The fold rule, written out with this file's own keccak256.
    let empty: Vec<[u8; 32]> = (0..=256).map(smt::empty).collect();
    assert_eq!(empty[0], [0; 32]);
    for h in 0..256 {
        assert_eq!(empty[h + 1], keccak(&[&[1], &empty[h], &empty[h]]));
    }
    let (key, value) = (base, b"first");
    let leaf = keccak(&[&[0], &key, value]);
    assert_eq!(leaf, smt::leaf_hash(&key, value));
    let mut path = vec![leaf];
    for j in 0..256 {
        let (c, b) = (path[j], 255 - j);
        path.push(match (key[b / 8] >> (7 - b % 8)) & 1 {
            0 => keccak(&[&[1], &c, &empty[j]]),
            _ => keccak(&[&[1], &empty[j], &c]),
        });
    }
    assert_eq!(
        hex::encode(path[256]),
        trees[0].root,
        "the fold rule gives the root"
    );
    StateTree {
        empty_subtrees: empty.iter().map(hex::encode).collect(),
        one_key: OneKey {
            key: hex::encode(key),
            value: hex::encode(value),
            leaf: hex::encode(leaf),
            path: path.iter().map(hex::encode).collect(),
        },
        trees,
    }
}

/// State snapshots of the ledger's last state. An account is given here in its hashed form, whose
/// first 34 bytes are the address; its tree key is `keccak256` of the byte 0 (the account kind)
/// and them. (The full accounts a Node sends, with public keys, are plan item 14's.)
#[derive(Serialize, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
struct StateSnapshots {
    /// The ledger's last state root.
    state_root: String,
    cases: Vec<SnapshotCase>,
}

#[derive(Serialize, Deserialize, PartialEq, Debug)]
struct SnapshotCase {
    note: String,
    accounts: Vec<String>,
    /// "ok", or the error.
    verdict: String,
}

fn generate_state_snapshots(state: &HashMap<Address, Account>, ledger: &Ledger) -> StateSnapshots {
    let root = smt::root(&tree_of(state));
    assert_eq!(hex::encode(root), ledger.steps.last().unwrap().state_root);
    let in_key_order = |accounts: &mut Vec<Vec<u8>>| {
        accounts.sort_by_key(|bytes| keccak(&[&[0], &bytes[..ADDRESS_LEN]]));
    };
    let mut sorted: Vec<Vec<u8>> = state
        .iter()
        .map(|(address, account)| account.hashed_bytes(address).to_vec())
        .collect();
    in_key_order(&mut sorted);
    assert!(sorted.len() >= 3);

    let mut changed = sorted.clone();
    changed[1][41] ^= 1; // the last byte of the balance
    let mut extra = sorted.clone();
    let newcomer = SigningKey::from_seed(&[0x45; 32]).address();
    let newcomer = Account {
        balance: 1,
        ..Account::default()
    }
    .hashed_bytes(&newcomer);
    extra.push(newcomer.to_vec());
    in_key_order(&mut extra);
    let mut repeated = sorted.clone();
    repeated.insert(1, sorted[1].clone());
    let mut swapped = sorted.clone();
    swapped.swap(0, 1);

    let cases = [
        ("every account, in key order", sorted.clone(), Ok(())),
        ("one balance changed", changed, Err(Error::WrongStateRoot)),
        (
            "one account missing",
            sorted[1..].to_vec(),
            Err(Error::WrongStateRoot),
        ),
        ("one account too many", extra, Err(Error::WrongStateRoot)),
        ("one account twice", repeated, Err(Error::SnapshotOrder)),
        ("two accounts swapped", swapped, Err(Error::SnapshotOrder)),
    ]
    .into_iter()
    .map(|(note, accounts, expected)| {
        let entries = accounts
            .iter()
            .map(|bytes| (keccak(&[&[0], &bytes[..ADDRESS_LEN]]), bytes.clone()));
        let verdict = smt::check_snapshot(&mut Tree::new(), entries, &root);
        assert_eq!(verdict, expected, "{note}");
        SnapshotCase {
            note: note.into(),
            accounts: accounts.iter().map(hex::encode).collect(),
            verdict: verdict.map_or_else(|error| format!("{error:?}"), |()| "ok".into()),
        }
    })
    .collect();
    StateSnapshots {
        state_root: hex::encode(root),
        cases,
    }
}

/// The Retarget (`retarget::next_target`) with the test network's values, except the initial
/// Target, chosen here. Each case gives the headers at heights `height - N - 1` to `height - 1`,
/// oldest first; the oldest header's Target is never read, so it is set to the maximum.
#[derive(Serialize, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
struct Retarget {
    block_time: u64,
    retarget_window: u64,
    max_target: String,
    initial_target: String,
    cases: Vec<RetargetCase>,
}

#[derive(Serialize, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
struct RetargetCase {
    note: String,
    retarget_enabled: bool,
    height: u64,
    /// Empty when the rule reads no header.
    headers: Vec<RetargetHeader>,
    next_target: String,
}

#[derive(Serialize, Deserialize, PartialEq, Debug)]
struct RetargetHeader {
    timestamp: u64,
    target: String,
}

fn generate_retarget() -> Retarget {
    // Targets with many nonzero digits, so every rounding shows.
    let below = |seed: &[u8], zero_bytes: usize| {
        let mut bytes = keccak(&[seed]);
        bytes[..zero_bytes].fill(0);
        U256::from_be_bytes(bytes)
    };
    let (x, initial) = (below(b"x", 3), below(b"initial", 4));
    let params = ChainParams {
        initial_target: initial,
        ..TESTNET
    };
    let (n, max) = (params.retarget_window, params.max_target);
    // The N + 1 headers of a window: solvetimes and Targets by position, 1 to N.
    let window = |solvetime: &dyn Fn(u64) -> i64, target: &dyn Fn(u64) -> U256| {
        let mut timestamp = 1_800_000_000u64;
        (0..=n)
            .map(|p| {
                if p == 0 {
                    return (timestamp, max);
                }
                timestamp = timestamp.checked_add_signed(solvetime(p)).unwrap();
                (timestamp, target(p))
            })
            .collect::<Vec<_>>()
    };
    let steady = |solvetime: i64, target: U256| window(&|_| solvetime, &|_| target);
    let case = |note: &str, enabled: bool, height: u64, headers: Vec<(u64, U256)>| {
        let p = ChainParams {
            retarget_enabled: enabled,
            ..params.clone()
        };
        let start = height.saturating_sub(n + 1);
        let next = next_target(&p, height, |j| headers[usize::try_from(j - start).unwrap()]);
        let vector = RetargetCase {
            note: note.into(),
            retarget_enabled: enabled,
            height,
            headers: headers
                .iter()
                .map(|(timestamp, target)| RetargetHeader {
                    timestamp: *timestamp,
                    target: hex::encode(target.to_be_bytes()),
                })
                .collect(),
            next_target: hex::encode(next.to_be_bytes()),
        };
        (vector, next)
    };

    let mut genesis = steady(60, initial);
    genesis[0].1 = initial;
    // Targets from x up to 2x, the parent's, so the parent differs from the mean (about 1.5x).
    let mixed: Vec<U256> = (0..=n).map(|p| x.mul_div(n + p, n)).collect();
    let mixed_sum = mixed[1..]
        .iter()
        .fold(U256::ZERO, |s, t| s.saturating_add(*t));
    let mixed_window = |solvetime: &dyn Fn(u64) -> i64| window(solvetime, &|p| mixed[p as usize]);
    let late = |slow_at: u64| window(&|p| if p == slow_at { 360 } else { 60 }, &|_| x);
    let half_max = max.mul_div(1, 2);
    let cases = [
        (
            "height 1: the initial Target",
            true,
            1,
            vec![],
            Some(initial),
        ),
        (
            "height N: still the initial Target",
            true,
            n,
            vec![],
            Some(initial),
        ),
        (
            "the Retarget switched off, as on the dev network",
            false,
            1_000,
            vec![],
            Some(initial),
        ),
        (
            "height N + 1: the window starts at the genesis; steady Blocks keep the Target",
            true,
            n + 1,
            genesis,
            Some(initial),
        ),
        (
            "steady Blocks keep the Target",
            true,
            1_000,
            steady(60, x),
            Some(x),
        ),
        (
            "steady Blocks over differing Targets: their mean, rounded down",
            true,
            1_000,
            mixed_window(&|_| 60),
            Some(mixed_sum.mul_div(1, n)),
        ),
        (
            "fast Blocks (40 s) lower the Target",
            true,
            1_000,
            steady(40, x),
            Some(x.mul_div(40, 60)),
        ),
        (
            "slow Blocks (90 s) raise it",
            true,
            1_000,
            steady(90, x),
            Some(x.mul_div(90, 60)),
        ),
        (
            "solvetimes of 0 count as 1; the Target stops at half the parent's",
            true,
            1_000,
            steady(0, x),
            Some(x.mul_div(1, 2)),
        ),
        (
            "timestamps going backwards: a negative solvetime counts as 1",
            true,
            1_000,
            window(&|p| if p % 2 == 0 { -30 } else { 150 }, &|_| x),
            None,
        ),
        (
            "solvetimes over 6T count as 6T; the Target stops at double the parent's",
            true,
            1_000,
            steady(1_000, x),
            Some(x.mul_div(2, 1)),
        ),
        (
            "one slow Block, the oldest: weight 1",
            true,
            1_000,
            late(1),
            Some(x.mul_div(109_800 + 300, 109_800)),
        ),
        (
            "one slow Block, the newest: weight N",
            true,
            1_000,
            late(n),
            Some(x.mul_div(109_800 + 300 * 60, 109_800)),
        ),
        (
            "every Target at the maximum, steady: the sum is near 2^246",
            true,
            1_000,
            steady(60, max),
            Some(max),
        ),
        (
            "every Target at the maximum, slow: the product passes 2^256 and double the parent passes the maximum",
            true,
            1_000,
            steady(1_000, max),
            Some(max),
        ),
        (
            "Targets at half the maximum, slow (90 s): the product passes 2^256, the result is not clamped",
            true,
            1_000,
            steady(90, half_max),
            Some(half_max.mul_div(90, 60)),
        ),
        (
            "the smallest Target, fast: never below 1",
            true,
            1_000,
            steady(0, U256::ONE),
            Some(U256::ONE),
        ),
        (
            "differing Targets, one slow Block at position 4: the mean is rounded down before the weights",
            true,
            1_000,
            mixed_window(&|p| if p == 4 { 360 } else { 60 }),
            Some(mixed_sum.mul_div(1, n).mul_div(109_800 + 300 * 4, 109_800)),
        ),
        (
            "differing Targets, solvetimes of 0: half the parent's Target, not half the mean",
            true,
            1_000,
            mixed_window(&|_| 0),
            Some(mixed[n as usize].mul_div(1, 2)),
        ),
        (
            "differing Targets, solvetimes over 6T: double the parent's Target, not double the mean",
            true,
            1_000,
            mixed_window(&|_| 1_000),
            Some(mixed[n as usize].mul_div(2, 1)),
        ),
    ];
    // Rounding once, floor(sum * weighted / (N * k)), gives another Target here.
    assert_ne!(
        mixed_sum.mul_div(1, n).mul_div(111_000, 109_800),
        mixed_sum.mul_div(111_000, n * 109_800)
    );
    // The mean's clamps would differ from the parent's.
    let mean = mixed_sum.mul_div(1, n);
    assert!(mean.mul_div(1, 2) < mixed[n as usize].mul_div(1, 2));
    assert!(mean.mul_div(2, 1) < mixed[n as usize].mul_div(2, 1));
    // The overflow cases overflow where their notes say.
    assert!(max.mul_div(n, 1) > U256::ones(245) && max.mul_div(n, 1) < U256::ones(246));
    assert_eq!(max.mul_div(6 * 1_830 * 60, 1), U256::MAX, "past 2^256");
    assert_eq!(half_max.mul_div(90 * 1_830, 1), U256::MAX, "past 2^256");
    assert!(half_max.mul_div(90, 60) < max);

    let cases = cases
        .into_iter()
        .map(|(note, enabled, height, headers, expected)| {
            let (vector, next) = case(note, enabled, height, headers);
            if let Some(expected) = expected {
                assert_eq!(next, expected, "{note}");
            }
            vector
        })
        .collect::<Vec<_>>();
    assert_ne!(
        cases[9].next_target, cases[4].next_target,
        "backwards timestamps change it"
    );
    Retarget {
        block_time: params.block_time,
        retarget_window: n,
        max_target: hex::encode(max.to_be_bytes()),
        initial_target: hex::encode(initial.to_be_bytes()),
        cases,
    }
}

/// Blocks checked with `block::validate_block` on the dev network, with both Targets set to
/// `2^255 - 1` (the Retarget is off) and a fake Proof-of-Work hash in place of RandomX:
/// `keccak256(key ‖ header)`, read as a big-endian number. Below height 2112 the key is the
/// genesis id. Every nonce is the lowest that passes, except where a case says otherwise.
#[derive(Serialize, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
struct Blocks {
    network: String,
    target: String,
    header_len: usize,
    nonce_offset: usize,
    max_block_size: usize,
    max_new_accounts: usize,
    /// Checked by no rule: a Node starts from it.
    genesis: BlockVector,
    /// Valid, each applied on top of the one before, from no account at all.
    chain: Vec<BlockVector>,
    /// Each checked on top of the chain's last Block and the accounts after it; none is applied.
    /// A Block over `maxBlockSize` bytes is refused before it is read (`BlockTooLarge`); a
    /// megabyte of hex is left out.
    cases: Vec<BlockCase>,
    new_accounts: NewAccounts,
}

#[derive(Serialize, Deserialize, PartialEq, Debug)]
struct BlockVector {
    bytes: String,
    id: String,
    /// The fake Proof-of-Work hash, below the Target; null for the genesis.
    pow: Option<String>,
}

#[derive(Serialize, Deserialize, PartialEq, Debug)]
struct BlockCase {
    note: String,
    bytes: String,
    /// "ok", or the error of `docs/protocols/blocks.md`.
    verdict: String,
}

/// The cap on new Accounts. Each case's Block, on top of the chain like `cases`, is its header,
/// then the count 50 (`0032`), then these 50 transactions.
#[derive(Serialize, Deserialize, PartialEq, Debug)]
struct NewAccounts {
    note: String,
    transactions: Vec<String>,
    cases: Vec<HeaderCase>,
}

#[derive(Serialize, Deserialize, PartialEq, Debug)]
struct HeaderCase {
    note: String,
    header: String,
    verdict: String,
}

fn generate_blocks() -> Blocks {
    let params = ChainParams {
        max_target: U256::ones(255),
        initial_target: U256::ones(255),
        ..DEV
    };
    let p = &params;
    let fake = |header: &[u8], key: &[u8; 32]| keccak(&[key, header]);
    let key = |seed: u8| SigningKey::from_seed(&[seed; 32]);
    let (a, b, c, d) = (key(0x51), key(0x52), key(0x53), key(0x54));
    let tx = |nonce: u64, fee: u64, to: Address, amount: u64| {
        let bytes = signed(
            p,
            &a,
            a.address(),
            nonce,
            fee,
            send(to, amount, b""),
            (nonce == 0).then_some(&a),
        );
        Tx::from_bytes(&bytes).unwrap()
    };
    // An address nobody has the key of.
    let nobody = |n: u8| {
        let mut bytes = [n; ADDRESS_LEN];
        bytes[..2].copy_from_slice(&[0, SCHEME_ML_DSA_44]);
        Address::from_bytes(&bytes).unwrap()
    };

    let genesis = Header {
        height: 0,
        prev_id: [0; 32],
        timestamp: 1_800_000_000,
        target: params.initial_target,
        tx_root: tx_root(&[]),
        state_root: smt::empty(256),
        reward_address: nobody(0),
        nonce: 0,
    };
    let key_id = genesis.id();
    let mine = |mut header: Header, from: u64, pass: bool| {
        header.nonce = from;
        while (U256::from_be_bytes(fake(&header.to_bytes(), &key_id)) < header.target) != pass {
            header.nonce += 1;
        }
        header
    };
    // A Block on top of `headers` with every field right, its state root from applying the
    // transactions and the reward to a copy of `state`.
    let build = |headers: &[Header],
                 state: &HashMap<Address, Account>,
                 reward_to: Address,
                 txs: Vec<Tx>| {
        let parent = headers.last().unwrap();
        let mut after = state.clone();
        for tx in &txs {
            apply_tx(p, &mut after, tx).unwrap();
        }
        let fees: u64 = txs.iter().map(|tx| tx.fee).sum();
        after.entry(reward_to).or_default().balance += reward(parent.height + 1) + fees;
        let ids: Vec<[u8; 32]> = txs.iter().map(|tx| tx.id(p)).collect();
        let header = Header {
            height: parent.height + 1,
            prev_id: parent.id(),
            timestamp: parent.timestamp + 60,
            target: params.initial_target,
            tx_root: tx_root(&ids),
            state_root: smt::root(&tree_of(&after)),
            reward_address: reward_to,
            nonce: 0,
        };
        Block {
            header: mine(header, 0, true),
            txs,
        }
    };
    let vector = |block: &Block, pow: bool| BlockVector {
        bytes: hex::encode(block.to_bytes()),
        id: hex::encode(block.header.id()),
        pow: pow.then(|| hex::encode(fake(&block.header.to_bytes(), &key_id))),
    };
    let verdict = |result: Result<(), Error>| {
        result.map_or_else(|error| format!("{error:?}"), |()| "ok".into())
    };

    // The chain: a reward to A, then A's first transfer, to B, with a reward to C.
    let mut headers = vec![genesis];
    let (mut state, mut tree) = (HashMap::new(), Tree::new());
    let mut chain = Vec::new();
    for (reward_to, txs) in [
        (a.address(), Vec::new()),
        (c.address(), vec![tx(0, 40_000, b.address(), GOLD)]),
    ] {
        let block = build(&headers, &state, reward_to, txs);
        assert_eq!(
            block.header.to_bytes()[NONCE_OFFSET..],
            block.header.nonce.to_be_bytes()
        );
        validate_block(p, &block, &headers[..], &state, &tree, fake)
            .unwrap()
            .apply(&mut state, &mut tree);
        assert_eq!(smt::root(&tree), block.header.state_root);
        chain.push(vector(&block, true));
        headers.push(block.header);
    }

    // Height 3: A sends half a GOLD to B and gets the reward.
    let valid = build(
        &headers,
        &state,
        a.address(),
        vec![tx(1, 30_000, b.address(), GOLD / 2)],
    );
    let changed = |change: &dyn Fn(&mut Block)| {
        let mut block = valid.clone();
        change(&mut block);
        block.header = mine(block.header, 0, true);
        block.to_bytes()
    };
    let with_txs = |block: &mut Block, txs: Vec<Tx>| {
        block.header.tx_root = tx_root(&txs.iter().map(|tx| tx.id(p)).collect::<Vec<_>>());
        block.txs = txs;
    };
    let valid_bytes = valid.to_bytes();
    let byte = |at: usize, value: u8| {
        let mut bytes = valid_bytes.clone();
        bytes[at] = value;
        bytes
    };
    let mut no_work = valid.clone();
    no_work.header = mine(no_work.header, 0, false);
    let cases: Vec<(&str, Vec<u8>, Result<(), Error>)> = vec![
        (
            "valid: A sends 0.5 GOLD to B and gets the reward",
            valid_bytes.clone(),
            Ok(()),
        ),
        ("unknown version", byte(0, 2), Err(Error::UnknownVersion)),
        (
            "reward address with an unknown version",
            byte(145, 1),
            Err(Error::BadAddress),
        ),
        (
            "reward address with an unknown scheme",
            byte(146, 2),
            Err(Error::UnknownScheme),
        ),
        (
            "transaction count 2 for 1 transaction",
            byte(HEADER_LEN + 1, 2),
            Err(Error::Truncated),
        ),
        (
            "transaction count 0 for 1 transaction",
            byte(HEADER_LEN + 1, 0),
            Err(Error::TrailingBytes),
        ),
        (
            "a byte after the last transaction",
            [valid_bytes.as_slice(), &[0]].concat(),
            Err(Error::TrailingBytes),
        ),
        (
            "height 4 on a parent at height 2",
            changed(&|b| b.header.height = 4),
            Err(Error::WrongHeight),
        ),
        (
            "prev_id of the parent's parent",
            changed(&|b| b.header.prev_id = headers[1].id()),
            Err(Error::WrongParent),
        ),
        (
            "timestamp after 2^62",
            changed(&|b| b.header.timestamp = (1 << 62) + 1),
            Err(Error::TimestampTooLate),
        ),
        (
            "timestamp equal to the median of the 3 before it (heights 0 to 2)",
            changed(&|b| b.header.timestamp = headers[1].timestamp),
            Err(Error::TimestampTooEarly),
        ),
        (
            "Target 2^254 - 1, not the initial Target",
            changed(&|b| b.header.target = U256::ones(254)),
            Err(Error::WrongTarget),
        ),
        (
            "the lowest nonce whose hash is not below the Target",
            no_work.to_bytes(),
            Err(Error::InsufficientWork),
        ),
        (
            "tx_root of no transactions",
            changed(&|b| b.header.tx_root = tx_root(&[])),
            Err(Error::WrongTxRoot),
        ),
        (
            "a refused transaction: A's nonce 0 again",
            changed(&|block| with_txs(block, vec![tx(0, 30_000, b.address(), GOLD / 2)])),
            Err(Error::WrongNonce),
        ),
        (
            "the reward is credited after the transactions: A, the reward address, sends 4 GOLD \
             with 3.9996 GOLD, which the reward would cover",
            changed(&|block| with_txs(block, vec![tx(1, 30_000, b.address(), 4 * GOLD)])),
            Err(Error::InsufficientBalance),
        ),
        (
            "wrong state_root",
            changed(&|b| b.header.state_root = headers[2].state_root),
            Err(Error::WrongStateRoot),
        ),
    ];
    let cases = cases
        .into_iter()
        .map(|(note, bytes, expected)| {
            let result = Block::from_bytes(&bytes)
                .and_then(|block| validate_block(p, &block, &headers[..], &state, &tree, fake))
                .map(|_| ());
            assert_eq!(result, expected, "{note}");
            BlockCase {
                note: note.into(),
                bytes: hex::encode(bytes),
                verdict: verdict(result),
            }
        })
        .collect();

    // 50 transfers to new addresses: with the reward to A the Block creates 50 Accounts, with the
    // reward to D, which has none, 51.
    let txs: Vec<Tx> = (1..=50)
        .map(|n| tx(n, 30_000, nobody(n as u8), 1_000))
        .collect();
    let new_accounts = [
        ("the reward to A: 50 new Accounts", a.address(), Ok(())),
        (
            "the reward to the first recipient, new too: 50 new Accounts, each counted once",
            nobody(1),
            Ok(()),
        ),
        (
            "the reward to D, a new address: 51 new Accounts",
            d.address(),
            Err(Error::TooManyNewAccounts),
        ),
    ]
    .into_iter()
    .map(|(note, reward_to, expected)| {
        let block = build(&headers, &state, reward_to, txs.clone());
        assert_eq!(&block.to_bytes()[HEADER_LEN..HEADER_LEN + 2], [0, 50]);
        let result = validate_block(p, &block, &headers[..], &state, &tree, fake).map(|_| ());
        assert_eq!(result, expected, "{note}");
        HeaderCase {
            note: note.into(),
            header: hex::encode(block.header.to_bytes()),
            verdict: verdict(result),
        }
    })
    .collect();

    Blocks {
        network: "dev".into(),
        target: hex::encode(params.initial_target.to_be_bytes()),
        header_len: HEADER_LEN,
        nonce_offset: NONCE_OFFSET,
        max_block_size: MAX_BLOCK_SIZE,
        max_new_accounts: MAX_NEW_ACCOUNTS,
        genesis: vector(
            &Block {
                header: genesis,
                txs: Vec::new(),
            },
            false,
        ),
        chain,
        cases,
        new_accounts: NewAccounts {
            note: "A has an Account; the 50 recipients and D do not.".into(),
            transactions: txs.iter().map(|tx| hex::encode(tx.to_bytes())).collect(),
            cases: new_accounts,
        },
    }
}

#[test]
fn chain_vectors() {
    let generated = generate_chain();
    for vector in &generated.addresses {
        let address: Address = vector.address.parse().unwrap();
        assert_eq!(Address::from_bytes(&bytes(&vector.bytes)), Ok(address));
    }
    for invalid in &generated.invalid_address_bytes {
        let decoded = hex::decode(&invalid.bytes).unwrap();
        let refused = match <[u8; ADDRESS_LEN]>::try_from(decoded.as_slice()) {
            Ok(array) => Address::from_bytes(&array).is_err(),
            Err(_) => true,
        };
        assert!(refused, "accepted address bytes with {}", invalid.reason);
    }
    assert_eq!(
        Address::from_bytes(&bytes(&generated.invalid_address_bytes[1].bytes)),
        Err(Error::UnknownScheme)
    );
    assert_eq!(
        generated.issuance.total_before_tail, "1968750000000000",
        "ADR 0006: 19,687,500 GOLD before the tail reward"
    );
    check_or_update("chain.json", &generated);
}
