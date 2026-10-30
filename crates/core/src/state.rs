//! Accounts: what the chain holds for each address (ADR 0011, docs/protocols/transactions.md).

use std::collections::HashMap;

use crate::{ADDRESS_LEN, Address, keccak256};

/// A public key with the scheme it belongs to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublicKey {
    pub scheme: u8,
    pub bytes: Vec<u8>,
}

impl PublicKey {
    /// `keccak256(scheme ‖ public key)`. For a key that was never rotated it equals the
    /// address's hash.
    pub fn hash(&self) -> [u8; 32] {
        keccak256(&[&[self.scheme], &self.bytes])
    }
}

/// An address with no account reads as `Account::default()` when it receives Gold. Accounts are
/// never removed: the nonce of an emptied account still stops replays.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Account {
    /// In base units.
    pub balance: u64,
    /// How many transactions the address has sent; the next must carry this number.
    pub nonce: u64,
    /// Stored by the first transaction and replaced by a rotation.
    pub key: Option<PublicKey>,
}

/// `address ‖ balance ‖ nonce ‖ key_hash`.
pub const ACCOUNT_BYTES_LEN: usize = ADDRESS_LEN + 8 + 8 + 32;

impl Account {
    /// The form the state root hashes. `key_hash` is the current key's hash, or 32 zero bytes
    /// while the account has no key, so the full key need not be in the tree.
    pub fn hashed_bytes(&self, address: &Address) -> [u8; ACCOUNT_BYTES_LEN] {
        let mut bytes = [0u8; ACCOUNT_BYTES_LEN];
        bytes[..34].copy_from_slice(&address.to_bytes());
        bytes[34..42].copy_from_slice(&self.balance.to_be_bytes());
        bytes[42..50].copy_from_slice(&self.nonce.to_be_bytes());
        if let Some(key) = &self.key {
            bytes[50..].copy_from_slice(&key.hash());
        }
        bytes
    }
}

/// An account's key in the state tree (`smt`): `keccak256(address bytes)`. Its value is
/// `Account::hashed_bytes`.
pub fn tree_key(address: &Address) -> [u8; 32] {
    keccak256(&[&address.to_bytes()])
}

/// Reading accounts: the Node implements it on its database, tests on a map.
pub trait StateView {
    fn account(&self, address: &Address) -> Option<Account>;
}

/// Writing accounts. A write cannot fail, so a rule that has checked everything first leaves no
/// partial change.
pub trait State: StateView {
    fn set_account(&mut self, address: Address, account: Account);
}

impl StateView for HashMap<Address, Account> {
    fn account(&self, address: &Address) -> Option<Account> {
        self.get(address).cloned()
    }
}

impl State for HashMap<Address, Account> {
    fn set_account(&mut self, address: Address, account: Account) {
        self.insert(address, account);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{SEED_LEN, SigningKey};

    #[test]
    fn hashed_bytes() {
        let signer = SigningKey::from_seed(&[7u8; SEED_LEN]);
        let address = signer.address();
        let mut account = Account {
            balance: 0x0102,
            nonce: 3,
            key: None,
        };
        let bytes = account.hashed_bytes(&address);
        assert_eq!(bytes[..34], address.to_bytes());
        assert_eq!(bytes[34..42], [0, 0, 0, 0, 0, 0, 1, 2]);
        assert_eq!(bytes[42..50], [0, 0, 0, 0, 0, 0, 0, 3]);
        assert_eq!(bytes[50..], [0; 32]);

        account.key = Some(PublicKey {
            scheme: 1,
            bytes: signer.public_key().to_vec(),
        });
        assert_eq!(&account.hashed_bytes(&address)[50..], address.hash());
    }
}
