//! Keys, signatures and addresses (docs/protocols/identity.md, ADR 0009), and the chain rules
//! (ADR 0011), which the Node, the Mine and the Shell all use (P9).

use core::fmt;
use core::str::FromStr;

use bech32::primitives::decode::CheckedHrpstring;
use bech32::{Bech32m, Hrp};
use bip39::{Language, Mnemonic};
use fips204::ml_dsa_44;
use fips204::traits::{KeyGen, SerDes, Signer, Verifier};
use hkdf::Hkdf;
use sha2::Sha512;
use sha3::{Digest, Keccak256};
use zeroize::{Zeroize, Zeroizing};

pub mod amount;
pub mod block;
pub mod checkpoint;
pub mod codec;
pub mod issuance;
pub mod merkle;
pub mod params;
pub mod retarget;
pub mod smt;
pub mod state;
pub mod tx;
pub mod u256;
#[cfg(feature = "wasm")]
mod wasm;

/// Scheme id of ML-DSA-44 (FIPS 204) in addresses and, from step 2C, transactions (P10).
pub const SCHEME_ML_DSA_44: u8 = 1;
/// Address version written before the scheme id.
pub const ADDRESS_VERSION: u8 = 0;
/// Human-readable part of addresses on the test network.
pub const ADDRESS_HRP: &str = "tlr";
/// An address's bytes: `version ‖ scheme ‖ hash`.
pub const ADDRESS_LEN: usize = 34;
pub const PUBLIC_KEY_LEN: usize = ml_dsa_44::PK_LEN;
pub const SIGNATURE_LEN: usize = ml_dsa_44::SIG_LEN;
/// Entropy behind a Character's 24 words.
pub const ENTROPY_LEN: usize = 32;
/// Seed `xi` of ML-DSA key generation.
pub const SEED_LEN: usize = 32;

const DERIVATION_SALT: &[u8] = b"linked-realms/ml-dsa-44/v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    /// Not 24 English BIP-39 words with a valid checksum.
    BadWords,
    BadAddress,
    UnknownScheme,
    BadLength,
    /// Contexts are at most 255 bytes (FIPS 204).
    ContextTooLong,
    /// Bytes ended before the last field.
    Truncated,
    /// Bytes left over after the last field.
    TrailingBytes,
    // Transactions (docs/protocols/transactions.md).
    UnknownVersion,
    UnknownKind,
    MemoTooLong,
    /// The byte before the public key is neither 0 nor 1.
    BadKeyFlag,
    ZeroAmount,
    /// The sender has never received Gold.
    NoAccount,
    WrongNonce,
    /// The sender's first transaction carries no public key.
    MissingKey,
    /// A public key on a transaction after the sender's first.
    RepeatedKey,
    /// The public key is not the one the sender's address was made from.
    KeyMismatch,
    /// A sum passes `u64::MAX`.
    Overflow,
    /// Not GOLD with at most 8 decimals (`amount::parse_amount`).
    BadAmount,
    InsufficientBalance,
    BadSignature,
    /// A state snapshot's keys are not in ascending order, each once.
    SnapshotOrder,
    /// A state snapshot or a Block does not give the state root it should.
    WrongStateRoot,
    // Blocks (docs/protocols/blocks.md).
    /// A Block of more than 1,000,000 bytes.
    BlockTooLarge,
    /// The height is not the parent's plus 1.
    WrongHeight,
    /// `prev_id` is not the parent's id.
    WrongParent,
    /// The timestamp is not after the median of the 11 before it.
    TimestampTooEarly,
    /// The timestamp is after 2^62.
    TimestampTooLate,
    /// The Target is not the one the Retarget gives.
    WrongTarget,
    /// The Proof-of-Work hash is not below the Target.
    InsufficientWork,
    WrongTxRoot,
    /// The Block creates more than 50 Accounts.
    TooManyNewAccounts,
    /// A Block at height 0 that is not the network's genesis.
    WrongGenesis,
    // Checkpoints (docs/protocols/blocks.md).
    /// A Checkpoint at a height that is not a multiple of 10.
    CheckpointHeight,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Error::BadWords => "not 24 valid words",
            Error::BadAddress => "not a valid address",
            Error::UnknownScheme => "unknown signature scheme",
            Error::BadLength => "wrong length",
            Error::ContextTooLong => "context longer than 255 bytes",
            Error::Truncated => "bytes end too early",
            Error::TrailingBytes => "bytes left over",
            Error::UnknownVersion => "unknown version",
            Error::UnknownKind => "unknown kind of transaction",
            Error::MemoTooLong => "memo longer than 80 bytes",
            Error::BadKeyFlag => "public key flag is neither 0 nor 1",
            Error::ZeroAmount => "amount is zero",
            Error::NoAccount => "the sender has no account",
            Error::WrongNonce => "wrong nonce",
            Error::MissingKey => "the first transaction must carry the public key",
            Error::RepeatedKey => "only the first transaction carries the public key",
            Error::KeyMismatch => "the public key does not match the sender",
            Error::Overflow => "amount too large",
            Error::BadAmount => "not an amount in GOLD with at most 8 decimals",
            Error::InsufficientBalance => "not enough Gold",
            Error::BadSignature => "bad signature",
            Error::SnapshotOrder => "state snapshot out of order",
            Error::WrongStateRoot => "wrong state root",
            Error::BlockTooLarge => "Block larger than 1,000,000 bytes",
            Error::WrongHeight => "wrong height",
            Error::WrongParent => "wrong parent",
            Error::TimestampTooEarly => "timestamp not after the median of the last 11",
            Error::TimestampTooLate => "timestamp after 2^62",
            Error::WrongTarget => "wrong Target",
            Error::InsufficientWork => "Proof-of-Work hash not below the Target",
            Error::WrongTxRoot => "wrong transaction root",
            Error::TooManyNewAccounts => "more than 50 new Accounts",
            Error::WrongGenesis => "not the network's genesis",
            Error::CheckpointHeight => "Checkpoint height not a multiple of 10",
        })
    }
}

impl std::error::Error for Error {}

/// The 24 words for `entropy` (BIP-39, English).
pub fn words_from_entropy(entropy: &[u8; ENTROPY_LEN]) -> String {
    Mnemonic::from_entropy_in(Language::English, entropy)
        .expect("32 bytes is a valid BIP-39 entropy length")
        .to_string()
}

/// The entropy behind 24 words. Words are lowercase and separated by single spaces.
pub fn entropy_from_words(words: &str) -> Result<Zeroizing<[u8; ENTROPY_LEN]>, Error> {
    let mnemonic =
        Mnemonic::parse_in_normalized(Language::English, words).map_err(|_| Error::BadWords)?;
    if mnemonic.word_count() != 24 {
        return Err(Error::BadWords);
    }
    let (mut array, len) = mnemonic.to_entropy_array();
    let mut entropy = Zeroizing::new([0u8; ENTROPY_LEN]);
    entropy.copy_from_slice(&array[..len]);
    array.zeroize();
    Ok(entropy)
}

/// The ML-DSA-44 seed `xi` of Character `index` behind `entropy`: the BIP-39 seed with an empty
/// passphrase, then HKDF-SHA512 (identity.md, "Keys").
pub fn character_seed(entropy: &[u8; ENTROPY_LEN], index: u32) -> Zeroizing<[u8; SEED_LEN]> {
    let words = Mnemonic::from_entropy_in(Language::English, entropy)
        .expect("32 bytes is a valid BIP-39 entropy length");
    let bip39_seed = Zeroizing::new(words.to_seed_normalized(""));
    let mut xi = Zeroizing::new([0u8; SEED_LEN]);
    Hkdf::<Sha512>::new(Some(DERIVATION_SALT), bip39_seed.as_slice())
        .expand(format!("character/{index}").as_bytes(), xi.as_mut_slice())
        .expect("32 bytes is a valid HKDF-SHA512 output length");
    xi
}

/// An ML-DSA-44 key pair. The private key is wiped when it is dropped.
pub struct SigningKey {
    private: ml_dsa_44::PrivateKey,
    public: [u8; PUBLIC_KEY_LEN],
}

impl SigningKey {
    /// `ML-DSA-44.KeyGen_internal(xi)`.
    pub fn from_seed(xi: &[u8; SEED_LEN]) -> Self {
        let (public, private) = ml_dsa_44::KG::keygen_from_seed(xi);
        SigningKey {
            private,
            public: public.into_bytes(),
        }
    }

    pub fn public_key(&self) -> &[u8; PUBLIC_KEY_LEN] {
        &self.public
    }

    pub fn address(&self) -> Address {
        Address::from_public_key(SCHEME_ML_DSA_44, &self.public)
            .expect("an ML-DSA-44 public key has the right length")
    }

    /// Signs `message` under `context` (pure ML-DSA, external interface). `rnd` must be 32 fresh
    /// random bytes (hedged signing); all zeros gives the deterministic variant.
    pub fn sign(
        &self,
        context: &[u8],
        message: &[u8],
        rnd: &[u8; 32],
    ) -> Result<[u8; SIGNATURE_LEN], Error> {
        if context.len() > 255 {
            return Err(Error::ContextTooLong);
        }
        self.private
            .try_sign_with_seed(rnd, message, context)
            .map_err(|_| Error::ContextTooLong)
    }
}

/// Whether `signature` is `public_key`'s signature of `message` under `context`. Anything
/// malformed, including an unknown scheme, is simply not valid.
pub fn verify(
    scheme: u8,
    public_key: &[u8],
    context: &[u8],
    message: &[u8],
    signature: &[u8],
) -> bool {
    if scheme != SCHEME_ML_DSA_44 {
        return false;
    }
    let (Ok(pk), Ok(sig)) = (
        <[u8; PUBLIC_KEY_LEN]>::try_from(public_key),
        <[u8; SIGNATURE_LEN]>::try_from(signature),
    ) else {
        return false;
    };
    match ml_dsa_44::PublicKey::try_from_bytes(pk) {
        Ok(pk) => pk.verify(message, &sig, context),
        Err(_) => false,
    }
}

/// `version ‖ scheme ‖ keccak256(scheme ‖ public key)`, written as Bech32m with the prefix `tlr`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Address {
    scheme: u8,
    hash: [u8; 32],
}

impl Address {
    pub fn from_public_key(scheme: u8, public_key: &[u8]) -> Result<Self, Error> {
        if scheme != SCHEME_ML_DSA_44 {
            return Err(Error::UnknownScheme);
        }
        if public_key.len() != PUBLIC_KEY_LEN {
            return Err(Error::BadLength);
        }
        let mut hasher = Keccak256::new();
        hasher.update([scheme]);
        hasher.update(public_key);
        Ok(Address {
            scheme,
            hash: hasher.finalize().into(),
        })
    }

    pub fn scheme(&self) -> u8 {
        self.scheme
    }

    pub fn hash(&self) -> &[u8; 32] {
        &self.hash
    }

    /// The bytes on the chain, which are also the Bech32m payload.
    pub fn to_bytes(&self) -> [u8; ADDRESS_LEN] {
        let mut bytes = [0u8; ADDRESS_LEN];
        bytes[0] = ADDRESS_VERSION;
        bytes[1] = self.scheme;
        bytes[2..].copy_from_slice(&self.hash);
        bytes
    }

    /// Refuses an unknown version or scheme, like the text form.
    pub fn from_bytes(bytes: &[u8; ADDRESS_LEN]) -> Result<Self, Error> {
        if bytes[0] != ADDRESS_VERSION {
            return Err(Error::BadAddress);
        }
        if bytes[1] != SCHEME_ML_DSA_44 {
            return Err(Error::UnknownScheme);
        }
        let mut hash = [0u8; 32];
        hash.copy_from_slice(&bytes[2..]);
        Ok(Address {
            scheme: bytes[1],
            hash,
        })
    }
}

impl fmt::Display for Address {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let hrp = Hrp::parse_unchecked(ADDRESS_HRP);
        bech32::encode_lower_to_fmt::<Bech32m, _>(f, hrp, &self.to_bytes()).map_err(|_| fmt::Error)
    }
}

impl FromStr for Address {
    type Err = Error;

    /// Accepts only the form `Display` writes (lowercase, zero padding bits), so two addresses
    /// are equal exactly when their strings are.
    fn from_str(s: &str) -> Result<Self, Error> {
        let checked = CheckedHrpstring::new::<Bech32m>(s).map_err(|_| Error::BadAddress)?;
        if checked.hrp().as_str() != ADDRESS_HRP {
            return Err(Error::BadAddress);
        }
        let payload: Vec<u8> = checked.byte_iter().collect();
        let bytes = payload
            .as_slice()
            .try_into()
            .map_err(|_| Error::BadAddress)?;
        let address = Address::from_bytes(bytes)?;
        if address.to_string() != s {
            return Err(Error::BadAddress);
        }
        Ok(address)
    }
}

/// keccak256 of `parts` written one after another.
pub(crate) fn keccak256(parts: &[&[u8]]) -> [u8; 32] {
    let mut hasher = Keccak256::new();
    for part in parts {
        hasher.update(part);
    }
    hasher.finalize().into()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key() -> SigningKey {
        SigningKey::from_seed(&[7u8; SEED_LEN])
    }

    #[test]
    fn words_round_trip() {
        let entropy = [0xa5u8; ENTROPY_LEN];
        let words = words_from_entropy(&entropy);
        assert_eq!(words.split(' ').count(), 24);
        assert_eq!(*entropy_from_words(&words).unwrap(), entropy);
    }

    #[test]
    fn words_are_checked() {
        let words = words_from_entropy(&[0u8; ENTROPY_LEN]);
        let wrong_checksum = words.replacen("abandon", "ability", 1);
        assert_eq!(entropy_from_words(&wrong_checksum), Err(Error::BadWords));
        let twelve = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
        assert_eq!(entropy_from_words(twelve), Err(Error::BadWords));
    }

    #[test]
    fn characters_differ_by_index() {
        let entropy = [1u8; ENTROPY_LEN];
        assert_ne!(*character_seed(&entropy, 0), *character_seed(&entropy, 1));
        assert_eq!(*character_seed(&entropy, 0), *character_seed(&entropy, 0));
    }

    #[test]
    fn sign_and_verify() {
        let key = key();
        let sig = key.sign(b"ctx", b"message", &[3u8; 32]).unwrap();
        let pk = key.public_key();
        assert!(verify(SCHEME_ML_DSA_44, pk, b"ctx", b"message", &sig));
        assert!(!verify(SCHEME_ML_DSA_44, pk, b"other", b"message", &sig));
        assert!(!verify(SCHEME_ML_DSA_44, pk, b"ctx", b"messagf", &sig));
        assert!(!verify(2, pk, b"ctx", b"message", &sig));
        let mut flipped = sig;
        flipped[100] ^= 1;
        assert!(!verify(SCHEME_ML_DSA_44, pk, b"ctx", b"message", &flipped));
        assert!(!verify(
            SCHEME_ML_DSA_44,
            &pk[1..],
            b"ctx",
            b"message",
            &sig
        ));
        assert_eq!(
            key.sign(&[0u8; 256], b"m", &[0u8; 32]),
            Err(Error::ContextTooLong)
        );
    }

    #[test]
    fn hedged_signatures_differ_but_verify() {
        let key = key();
        let a = key.sign(b"c", b"m", &[1u8; 32]).unwrap();
        let b = key.sign(b"c", b"m", &[2u8; 32]).unwrap();
        assert_ne!(a, b);
        assert!(verify(SCHEME_ML_DSA_44, key.public_key(), b"c", b"m", &b));
    }

    #[test]
    fn address_round_trip() {
        let address = key().address();
        let text = address.to_string();
        assert!(text.starts_with("tlr1"));
        assert_eq!(text.parse::<Address>(), Ok(address));
    }

    #[test]
    fn address_bytes_round_trip() {
        let address = key().address();
        let bytes = address.to_bytes();
        assert_eq!(bytes[..2], [ADDRESS_VERSION, SCHEME_ML_DSA_44]);
        assert_eq!(&bytes[2..], address.hash());
        assert_eq!(Address::from_bytes(&bytes), Ok(address));
        let mut version = bytes;
        version[0] = 1;
        assert_eq!(Address::from_bytes(&version), Err(Error::BadAddress));
        let mut scheme = bytes;
        scheme[1] = 2;
        assert_eq!(Address::from_bytes(&scheme), Err(Error::UnknownScheme));
    }

    #[test]
    fn address_rejects_variants() {
        let text = key().address().to_string();
        assert_eq!(
            text.to_uppercase().parse::<Address>(),
            Err(Error::BadAddress)
        );
        let mut bad_checksum = text.clone();
        let last = bad_checksum.pop().unwrap();
        bad_checksum.push(if last == 'q' { 'p' } else { 'q' });
        assert_eq!(bad_checksum.parse::<Address>(), Err(Error::BadAddress));
        let hrp = Hrp::parse_unchecked("tlx");
        let other_prefix =
            bech32::encode_lower::<Bech32m>(hrp, &key().address().to_bytes()).unwrap();
        assert_eq!(other_prefix.parse::<Address>(), Err(Error::BadAddress));
        let bech32 = bech32::encode_lower::<bech32::Bech32>(
            Hrp::parse_unchecked(ADDRESS_HRP),
            &key().address().to_bytes(),
        )
        .unwrap();
        assert_eq!(bech32.parse::<Address>(), Err(Error::BadAddress));
        let mut payload = key().address().to_bytes();
        payload[1] = 2;
        let unknown =
            bech32::encode_lower::<Bech32m>(Hrp::parse_unchecked(ADDRESS_HRP), &payload).unwrap();
        assert_eq!(unknown.parse::<Address>(), Err(Error::UnknownScheme));
        let short =
            bech32::encode_lower::<Bech32m>(Hrp::parse_unchecked(ADDRESS_HRP), &payload[..33])
                .unwrap();
        assert_eq!(short.parse::<Address>(), Err(Error::BadAddress));
    }
}
