//! The JavaScript API of `packages/core`. Callers pass `rnd` from their own secure random source,
//! because `wasm32-unknown-unknown` has none.

use wasm_bindgen::prelude::*;

use crate::amount::{format_amount, parse_amount};
use crate::params::{ChainParams, by_network_id};
use crate::state::PublicKey;
use crate::tx::{Kind, MAX_MEMO_LEN, Tx};
use crate::{Address, Error, SCHEME_ML_DSA_44, SigningKey};

fn params(network_id: u32) -> Result<&'static ChainParams, JsError> {
    by_network_id(network_id).ok_or_else(|| JsError::new("unknown network id"))
}

fn array<const N: usize>(bytes: &[u8]) -> Result<&[u8; N], JsError> {
    bytes
        .try_into()
        .map_err(|_| JsError::new(&format!("expected {N} bytes")))
}

/// An ML-DSA-44 key. Call `free()` when done so its private key is wiped.
#[wasm_bindgen]
pub struct Key(SigningKey);

#[wasm_bindgen]
impl Key {
    /// A Map server key or the Hub's ticket key, from its stored 32-byte seed.
    #[wasm_bindgen(js_name = fromSeed)]
    pub fn from_seed(xi: &[u8]) -> Result<Key, JsError> {
        Ok(Key(SigningKey::from_seed(array(xi)?)))
    }

    /// Character `index` behind the entropy of 24 words.
    #[wasm_bindgen(js_name = fromEntropy)]
    pub fn from_entropy(entropy: &[u8], index: u32) -> Result<Key, JsError> {
        let xi = crate::character_seed(array(entropy)?, index);
        Ok(Key(SigningKey::from_seed(&xi)))
    }

    #[wasm_bindgen(getter, js_name = publicKey)]
    pub fn public_key(&self) -> Vec<u8> {
        self.0.public_key().to_vec()
    }

    #[wasm_bindgen(getter)]
    pub fn address(&self) -> String {
        self.0.address().to_string()
    }

    pub fn sign(&self, context: &str, message: &[u8], rnd: &[u8]) -> Result<Vec<u8>, JsError> {
        Ok(self
            .0
            .sign(context.as_bytes(), message, array(rnd)?)?
            .to_vec())
    }

    /// A transfer from `sender`, signed for the network `networkId`, as its bytes (docs/protocols/
    /// transactions.md). `nonce`, `fee` and `amount` are in base units. `withPublicKey` only on the
    /// sender's first transaction.
    #[wasm_bindgen(js_name = signTransfer)]
    #[allow(clippy::too_many_arguments)] // wasm-bindgen takes no options object without serde.
    pub fn sign_transfer(
        &self,
        network_id: u32,
        sender: &str,
        nonce: u64,
        fee: u64,
        to: &str,
        amount: u64,
        memo: &[u8],
        with_public_key: bool,
        rnd: &[u8],
    ) -> Result<Vec<u8>, JsError> {
        if memo.len() > MAX_MEMO_LEN {
            return Err(Error::MemoTooLong.into());
        }
        let kind = Kind::Transfer {
            to: to.parse()?,
            amount,
            memo: memo.to_vec(),
        };
        self.sign_tx(network_id, sender, nonce, fee, kind, with_public_key, rnd)
    }

    /// A rotation of `sender`'s key to `newPublicKey`, signed for the network `networkId`, as its
    /// bytes. As `signTransfer` otherwise.
    #[wasm_bindgen(js_name = signRotation)]
    #[allow(clippy::too_many_arguments)] // wasm-bindgen takes no options object without serde.
    pub fn sign_rotation(
        &self,
        network_id: u32,
        sender: &str,
        nonce: u64,
        fee: u64,
        new_scheme: u8,
        new_public_key: &[u8],
        with_public_key: bool,
        rnd: &[u8],
    ) -> Result<Vec<u8>, JsError> {
        let kind = Kind::Rotation {
            new_key: PublicKey {
                scheme: new_scheme,
                bytes: new_public_key.to_vec(),
            },
        };
        self.sign_tx(network_id, sender, nonce, fee, kind, with_public_key, rnd)
    }
}

impl Key {
    #[allow(clippy::too_many_arguments)] // The arguments of the two calls above.
    fn sign_tx(
        &self,
        network_id: u32,
        sender: &str,
        nonce: u64,
        fee: u64,
        kind: Kind,
        with_public_key: bool,
        rnd: &[u8],
    ) -> Result<Vec<u8>, JsError> {
        let mut tx = Tx {
            scheme: SCHEME_ML_DSA_44,
            sender: sender.parse()?,
            nonce,
            fee,
            kind,
            public_key: with_public_key.then(|| self.0.public_key().to_vec()),
            signature: Vec::new(),
        };
        tx.sign(params(network_id)?, &self.0, array(rnd)?)?;
        let bytes = tx.to_bytes();
        // The format rules every Node applies, such as the length of a rotation's new key.
        Tx::from_bytes(&bytes)?;
        Ok(bytes)
    }
}

/// The id of the transaction `bytes` on the network `networkId`. Throws if they are not a
/// transaction.
#[wasm_bindgen(js_name = transactionId)]
pub fn transaction_id(network_id: u32, bytes: &[u8]) -> Result<Vec<u8>, JsError> {
    Ok(Tx::from_bytes(bytes)?.id(params(network_id)?).to_vec())
}

/// Base units from GOLD as typed: digits, then optionally a dot and 1 to 8 digits.
#[wasm_bindgen(js_name = parseAmount)]
pub fn parse_amount_js(text: &str) -> Result<u64, JsError> {
    Ok(parse_amount(text)?)
}

/// Base units as GOLD, without trailing zeros.
#[wasm_bindgen(js_name = formatAmount)]
pub fn format_amount_js(units: u64) -> String {
    format_amount(units)
}

/// The 34-byte payload of `address`.
#[wasm_bindgen(js_name = addressToBytes)]
pub fn address_to_bytes(address: &str) -> Result<Vec<u8>, JsError> {
    Ok(address.parse::<Address>()?.to_bytes().to_vec())
}

#[wasm_bindgen(js_name = addressFromBytes)]
pub fn address_from_bytes(bytes: &[u8]) -> Result<String, JsError> {
    Ok(Address::from_bytes(array(bytes)?)?.to_string())
}

#[wasm_bindgen(js_name = wordsFromEntropy)]
pub fn words_from_entropy(entropy: &[u8]) -> Result<String, JsError> {
    Ok(crate::words_from_entropy(array(entropy)?))
}

#[wasm_bindgen(js_name = entropyFromWords)]
pub fn entropy_from_words(words: &str) -> Result<Vec<u8>, JsError> {
    Ok(crate::entropy_from_words(words)?.to_vec())
}

#[wasm_bindgen]
pub fn verify(
    scheme: u8,
    public_key: &[u8],
    context: &str,
    message: &[u8],
    signature: &[u8],
) -> bool {
    crate::verify(scheme, public_key, context.as_bytes(), message, signature)
}

#[wasm_bindgen(js_name = addressFromPublicKey)]
pub fn address_from_public_key(scheme: u8, public_key: &[u8]) -> Result<String, JsError> {
    Ok(Address::from_public_key(scheme, public_key)?.to_string())
}

/// Whether `text` is an address in its only valid form: lowercase, `tlr`, a known scheme.
#[wasm_bindgen(js_name = isAddress)]
pub fn is_address(text: &str) -> bool {
    text.parse::<Address>().is_ok()
}
