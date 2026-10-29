//! The vectors in `test-vectors/`: NIST's ML-DSA-44 vectors, the BIP-39 reference vectors and our
//! own `identity.json`. `UPDATE_VECTORS=1 cargo test` rewrites `identity.json`; otherwise it is
//! checked byte for byte.

use std::path::PathBuf;

use linked_realms_core::{
    Address, SCHEME_ML_DSA_44, SigningKey, character_seed, entropy_from_words, verify,
    words_from_entropy,
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
    let json = serde_json::to_string_pretty(&generated).unwrap() + "\n";
    if std::env::var_os("UPDATE_VECTORS").is_some() {
        std::fs::write(path("identity.json"), json).unwrap();
    } else {
        assert_eq!(
            std::fs::read_to_string(path("identity.json")).unwrap(),
            json,
            "identity.json differs from this code; regenerate it only on purpose"
        );
    }
}
