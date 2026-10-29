//! The JavaScript API of `packages/core`. Callers pass `rnd` from their own secure random source,
//! because `wasm32-unknown-unknown` has none.

use wasm_bindgen::prelude::*;

use crate::{Address, SigningKey};

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
