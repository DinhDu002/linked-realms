//! Transactions (ADR 0011, docs/protocols/transactions.md): the byte layout, the signed bytes and
//! the id, and the rules that check and apply one against the accounts.

use crate::codec::Reader;
use crate::params::ChainParams;
use crate::state::{Account, PublicKey, State, StateView};
use crate::{
    Address, Error, PUBLIC_KEY_LEN, SCHEME_ML_DSA_44, SIGNATURE_LEN, SigningKey, keccak256, verify,
};

pub const TX_VERSION: u8 = 1;
/// The ML-DSA context of every transaction signature. The kind is inside the signed bytes.
pub const TX_CONTEXT: &[u8] = b"linked-realms/tx/v1";
pub const MAX_MEMO_LEN: usize = 80;

const KIND_TRANSFER: u8 = 0;
const KIND_ROTATION: u8 = 1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Kind {
    Transfer {
        to: Address,
        /// In base units.
        amount: u64,
        /// Any bytes; a Shell shows it escaped.
        memo: Vec<u8>,
    },
    /// Replaces the sender's stored key. The address stays the same.
    Rotation { new_key: PublicKey },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tx {
    /// The scheme of the key that signs this transaction.
    pub scheme: u8,
    pub sender: Address,
    pub nonce: u64,
    /// In base units, to the reward address of the Block that holds the transaction.
    pub fee: u64,
    pub kind: Kind,
    /// The sender's public key, on its first transaction only.
    pub public_key: Option<Vec<u8>>,
    pub signature: Vec<u8>,
}

/// The lengths of a public key and a signature, which follow from the scheme (P10).
fn lengths(scheme: u8) -> Result<(usize, usize), Error> {
    match scheme {
        SCHEME_ML_DSA_44 => Ok((PUBLIC_KEY_LEN, SIGNATURE_LEN)),
        _ => Err(Error::UnknownScheme),
    }
}

impl Tx {
    /// The network id, then every field but the signature: what is signed and hashed.
    pub fn signing_bytes(&self, params: &ChainParams) -> Vec<u8> {
        let mut bytes = params.network_id.to_be_bytes().to_vec();
        self.write_fields(&mut bytes);
        bytes
    }

    /// `keccak256` of the signing bytes: it binds the network, and a new signature of the same
    /// transaction keeps the id.
    pub fn id(&self, params: &ChainParams) -> [u8; 32] {
        keccak256(&[&self.signing_bytes(params)])
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        let mut bytes = Vec::new();
        self.write_fields(&mut bytes);
        bytes.extend_from_slice(&self.signature);
        bytes
    }

    fn write_fields(&self, bytes: &mut Vec<u8>) {
        let kind = match self.kind {
            Kind::Transfer { .. } => KIND_TRANSFER,
            Kind::Rotation { .. } => KIND_ROTATION,
        };
        bytes.extend_from_slice(&[TX_VERSION, kind, self.scheme]);
        bytes.extend_from_slice(&self.sender.to_bytes());
        bytes.extend_from_slice(&self.nonce.to_be_bytes());
        bytes.extend_from_slice(&self.fee.to_be_bytes());
        match &self.kind {
            Kind::Transfer { to, amount, memo } => {
                bytes.extend_from_slice(&to.to_bytes());
                bytes.extend_from_slice(&amount.to_be_bytes());
                bytes.push(u8::try_from(memo.len()).expect("a memo has at most 255 bytes"));
                bytes.extend_from_slice(memo);
            }
            Kind::Rotation { new_key } => {
                bytes.push(new_key.scheme);
                bytes.extend_from_slice(&new_key.bytes);
            }
        }
        match &self.public_key {
            None => bytes.push(0),
            Some(key) => {
                bytes.push(1);
                bytes.extend_from_slice(key);
            }
        }
    }

    /// Reads the fields in order; the first one that is wrong gives the error.
    pub fn from_bytes(bytes: &[u8]) -> Result<Tx, Error> {
        let mut reader = Reader::new(bytes);
        let tx = Tx::read(&mut reader)?;
        reader.finish()?;
        Ok(tx)
    }

    /// Reads one transaction and stops at its end, which its fields tell, so the transactions of
    /// a Block need no lengths.
    pub(crate) fn read(reader: &mut Reader<'_>) -> Result<Tx, Error> {
        if reader.u8()? != TX_VERSION {
            return Err(Error::UnknownVersion);
        }
        let kind = reader.u8()?;
        if kind != KIND_TRANSFER && kind != KIND_ROTATION {
            return Err(Error::UnknownKind);
        }
        let scheme = reader.u8()?;
        let (key_len, signature_len) = lengths(scheme)?;
        let sender = reader.address()?;
        let nonce = reader.u64()?;
        let fee = reader.u64()?;
        let kind = if kind == KIND_TRANSFER {
            let to = reader.address()?;
            let amount = reader.u64()?;
            let memo_len = usize::from(reader.u8()?);
            if memo_len > MAX_MEMO_LEN {
                return Err(Error::MemoTooLong);
            }
            let memo = reader.bytes(memo_len)?.to_vec();
            Kind::Transfer { to, amount, memo }
        } else {
            let scheme = reader.u8()?;
            let bytes = reader.bytes(lengths(scheme)?.0)?.to_vec();
            Kind::Rotation {
                new_key: PublicKey { scheme, bytes },
            }
        };
        let public_key = match reader.u8()? {
            0 => None,
            1 => Some(reader.bytes(key_len)?.to_vec()),
            _ => return Err(Error::BadKeyFlag),
        };
        let signature = reader.bytes(signature_len)?.to_vec();
        Ok(Tx {
            scheme,
            sender,
            nonce,
            fee,
            kind,
            public_key,
            signature,
        })
    }

    /// Signs with `key` for the network of `params`. `rnd` as in `SigningKey::sign`.
    pub fn sign(
        &mut self,
        params: &ChainParams,
        key: &SigningKey,
        rnd: &[u8; 32],
    ) -> Result<(), Error> {
        self.signature = key
            .sign(TX_CONTEXT, &self.signing_bytes(params), rnd)?
            .to_vec();
        Ok(())
    }

    /// The format rules `from_bytes` applies, for a transaction built in memory.
    fn check_format(&self) -> Result<(), Error> {
        let (key_len, signature_len) = lengths(self.scheme)?;
        let wrong_key = self.public_key.as_ref().is_some_and(|k| k.len() != key_len);
        if wrong_key || self.signature.len() != signature_len {
            return Err(Error::BadLength);
        }
        match &self.kind {
            Kind::Transfer { memo, .. } if memo.len() > MAX_MEMO_LEN => Err(Error::MemoTooLong),
            Kind::Rotation { new_key } if new_key.bytes.len() != lengths(new_key.scheme)?.0 => {
                Err(Error::BadLength)
            }
            _ => Ok(()),
        }
    }
}

/// Whether `tx` can be applied to `state` now.
pub fn check_tx(params: &ChainParams, state: &impl StateView, tx: &Tx) -> Result<(), Error> {
    changes(params, state, tx).map(|_| ())
}

/// Applies `tx`. On an error nothing is written. The fee is not credited here: the Block credits
/// its reward address with all of its fees.
pub fn apply_tx(params: &ChainParams, state: &mut impl State, tx: &Tx) -> Result<(), Error> {
    for (address, account) in changes(params, state, tx)? {
        state.set_account(address, account);
    }
    Ok(())
}

/// The accounts `tx` changes, as they will be, or why it is refused. Cheap checks come first
/// and the signature last.
fn changes(
    params: &ChainParams,
    state: &impl StateView,
    tx: &Tx,
) -> Result<Vec<(Address, Account)>, Error> {
    tx.check_format()?;
    let (amount, to) = match &tx.kind {
        Kind::Transfer { amount: 0, .. } => return Err(Error::ZeroAmount),
        Kind::Transfer { to, amount, .. } => (*amount, Some(to)),
        Kind::Rotation { .. } => (0, None),
    };
    let mut sender = state.account(&tx.sender).ok_or(Error::NoAccount)?;
    if tx.nonce != sender.nonce {
        return Err(Error::WrongNonce);
    }
    let key = match (&sender.key, &tx.public_key) {
        (Some(key), None) => key.clone(),
        (Some(_), Some(_)) => return Err(Error::RepeatedKey),
        (None, None) => return Err(Error::MissingKey),
        (None, Some(bytes)) => {
            if Address::from_public_key(tx.scheme, bytes)? != tx.sender {
                return Err(Error::KeyMismatch);
            }
            PublicKey {
                scheme: tx.scheme,
                bytes: bytes.clone(),
            }
        }
    };
    let cost = amount.checked_add(tx.fee).ok_or(Error::Overflow)?;
    let nonce = sender.nonce.checked_add(1).ok_or(Error::Overflow)?;
    let recipient = match to {
        Some(to) if *to != tx.sender => {
            let mut recipient = state.account(to).unwrap_or_default();
            recipient.balance = recipient
                .balance
                .checked_add(amount)
                .ok_or(Error::Overflow)?;
            Some((*to, recipient))
        }
        _ => None,
    };
    if sender.balance < cost {
        return Err(Error::InsufficientBalance);
    }
    let signed = verify(
        key.scheme,
        &key.bytes,
        TX_CONTEXT,
        &tx.signing_bytes(params),
        &tx.signature,
    );
    if key.scheme != tx.scheme || !signed {
        return Err(Error::BadSignature);
    }

    sender.balance -= cost;
    sender.nonce = nonce;
    sender.key = Some(match &tx.kind {
        Kind::Rotation { new_key } => new_key.clone(),
        Kind::Transfer { .. } => key,
    });
    match recipient {
        Some(recipient) => Ok(vec![(tx.sender, sender), recipient]),
        None => {
            if to.is_some() {
                sender.balance += amount; // to oneself: at most the balance it had before
            }
            Ok(vec![(tx.sender, sender)])
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::params::{DEV, TESTNET};

    fn key(seed: u8) -> SigningKey {
        SigningKey::from_seed(&[seed; 32])
    }

    fn transfer(from: &SigningKey, to: Address, memo: &[u8], with_key: bool) -> Tx {
        let mut tx = Tx {
            scheme: SCHEME_ML_DSA_44,
            sender: from.address(),
            nonce: 0,
            fee: 10,
            kind: Kind::Transfer {
                to,
                amount: 5,
                memo: memo.to_vec(),
            },
            public_key: with_key.then(|| from.public_key().to_vec()),
            signature: Vec::new(),
        };
        tx.sign(&TESTNET, from, &[0; 32]).unwrap();
        tx
    }

    #[test]
    fn sizes_and_round_trip() {
        let (a, b) = (key(1), key(2));
        for (memo, with_key, size) in [
            (&b""[..], false, 2517),
            (&[7; 80][..], false, 2597),
            (&b""[..], true, 3829),
            (&[7; 80][..], true, 3909),
        ] {
            let tx = transfer(&a, b.address(), memo, with_key);
            let bytes = tx.to_bytes();
            assert_eq!(bytes.len(), size);
            assert_eq!(Tx::from_bytes(&bytes), Ok(tx));
        }
    }

    #[test]
    fn the_id_binds_the_network_but_not_the_signature() {
        let (a, b) = (key(1), key(2));
        let mut tx = transfer(&a, b.address(), b"", true);
        let id = tx.id(&TESTNET);
        assert_ne!(id, tx.id(&DEV));
        let first = tx.signature.clone();
        tx.sign(&TESTNET, &a, &[9; 32]).unwrap();
        assert_ne!(tx.signature, first);
        assert_eq!(tx.id(&TESTNET), id);
        assert_eq!(tx.signing_bytes(&TESTNET)[..4], [0, 0, 0, 1]);
    }

    #[test]
    fn every_overflow_comes_before_the_balance_and_the_signature() {
        let (a, b) = (key(1), key(2));
        let mut tx = transfer(&a, b.address(), b"", true);
        tx.signature[100] ^= 1;
        let rich = |balance, nonce| Account {
            balance,
            nonce,
            key: None,
        };
        let full_recipient = std::collections::HashMap::from([
            (a.address(), rich(0, 0)),
            (b.address(), rich(u64::MAX, 0)),
        ]);
        assert_eq!(
            check_tx(&TESTNET, &full_recipient, &tx),
            Err(Error::Overflow)
        );
        let last_nonce = std::collections::HashMap::from([(a.address(), rich(0, u64::MAX))]);
        tx.nonce = u64::MAX;
        assert_eq!(check_tx(&TESTNET, &last_nonce, &tx), Err(Error::Overflow));
    }

    #[test]
    fn rules_refuse_malformed_transactions_built_in_memory() {
        let (a, b) = (key(1), key(2));
        let state = std::collections::HashMap::from([(a.address(), Account::default())]);
        let mut long_memo = transfer(&a, b.address(), &[0; 81], true);
        assert_eq!(
            check_tx(&TESTNET, &state, &long_memo),
            Err(Error::MemoTooLong)
        );
        long_memo.signature.pop();
        assert_eq!(
            check_tx(&TESTNET, &state, &long_memo),
            Err(Error::BadLength)
        );
    }
}
