//! The vectors in `test-vectors/`: NIST's ML-DSA-44 vectors, the BIP-39 reference vectors and our
//! own `identity.json` and `chain.json`. `UPDATE_VECTORS=1 cargo test` rewrites our own files;
//! otherwise they are checked byte for byte.

use std::path::PathBuf;

use linked_realms_core::issuance::{BASE_UNITS_PER_GOLD, HALVING_INTERVAL, reward};
use linked_realms_core::merkle::tx_root;
use linked_realms_core::params::{DEV, TESTNET};
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
/// JavaScript reads them exactly. Later items of step 2C add transactions, the state root, the
/// Retarget, headers and Blocks.
#[derive(Serialize, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
struct Chain {
    note: String,
    networks: Vec<Network>,
    addresses: Vec<AddressBytes>,
    invalid_address_bytes: Vec<InvalidAddressBytes>,
    issuance: Issuance,
    tx_roots: Vec<TxRoot>,
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
