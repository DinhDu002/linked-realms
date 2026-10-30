use std::collections::HashMap;
use std::path::PathBuf;

use linked_realms_core::block::{NONCE_OFFSET, check_genesis};
use linked_realms_core::issuance::reward;
use linked_realms_core::merkle::tx_root;
use linked_realms_core::params::{DEV, DEV_CHECKPOINT_SEED, TESTNET};
use linked_realms_core::smt::Node;
use linked_realms_core::tx::{Kind, Tx, apply_tx};
use linked_realms_core::{ADDRESS_LEN, SCHEME_ML_DSA_44, SigningKey};

use super::*;

/// Half of all hashes pass, and the Retarget is off, so every Block proves the same work.
const PARAMS: ChainParams = ChainParams {
    max_target: U256::ones(255),
    initial_target: U256::ones(255),
    ..DEV
};

/// Proof of Work by the nonce alone: 0 fails, anything else passes.
fn fake_hash(header: &[u8], _key: &[u8; 32]) -> [u8; 32] {
    match header[NONCE_OFFSET..] == [0; 8] {
        true => [0xff; 32],
        false => [0; 32],
    }
}

type Test = Chain<fn(&[u8], &[u8; 32]) -> [u8; 32]>;

/// A database file of its own, removed when the test ends.
struct File(PathBuf);

impl File {
    fn new(name: &str) -> Self {
        let path = std::env::temp_dir().join(format!("lr-node-{}-{name}.redb", std::process::id()));
        let _ = std::fs::remove_file(&path);
        File(path)
    }

    fn open(&self) -> Test {
        Chain::open(
            &self.0,
            PARAMS,
            fake_hash as fn(&[u8], &[u8; 32]) -> [u8; 32],
        )
        .unwrap()
    }
}

impl Drop for File {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// An address nobody has the key of.
fn nobody(n: u8) -> Address {
    let mut bytes = [n; ADDRESS_LEN];
    bytes[..2].copy_from_slice(&[0, SCHEME_ML_DSA_44]);
    Address::from_bytes(&bytes).unwrap()
}

fn transfer(from: &SigningKey, nonce: u64, to: Address, amount: u64) -> Tx {
    let mut tx = Tx {
        scheme: SCHEME_ML_DSA_44,
        sender: from.address(),
        nonce,
        fee: 10,
        kind: Kind::Transfer {
            to,
            amount,
            memo: Vec::new(),
        },
        public_key: (nonce == 0).then(|| from.public_key().to_vec()),
        signature: Vec::new(),
    };
    tx.sign(&PARAMS, from, &[0; 32]).unwrap();
    tx
}

type Accounts = HashMap<Address, Account>;

/// Valid Blocks on any branch, from the accounts after each Block it built.
struct Builder(HashMap<[u8; 32], Accounts>);

impl Builder {
    fn new() -> Self {
        Builder(HashMap::from([(PARAMS.genesis().id(), Accounts::new())]))
    }

    fn genesis(&self) -> Block {
        Block {
            header: PARAMS.genesis(),
            txs: Vec::new(),
        }
    }

    /// A Block on `parent` paying `reward_address`, with `txs`.
    fn child(&mut self, parent: &Block, reward_address: Address, txs: Vec<Tx>) -> Block {
        let mut after = self.0[&parent.header.id()].clone();
        for tx in &txs {
            apply_tx(&PARAMS, &mut after, tx).unwrap();
        }
        let height = parent.header.height + 1;
        let fees: u64 = txs.iter().map(|tx| tx.fee).sum();
        after.entry(reward_address).or_default().balance += reward(height) + fees;
        let mut tree = HashMap::<(u16, [u8; 32]), Node>::new();
        for (address, account) in &after {
            smt::insert(
                &mut tree,
                &tree_key(address),
                &account.hashed_bytes(address),
            );
        }
        let ids: Vec<_> = txs.iter().map(|tx| tx.id(&PARAMS)).collect();
        let block = Block {
            header: Header {
                height,
                prev_id: parent.header.id(),
                timestamp: parent.header.timestamp + 60,
                target: PARAMS.initial_target,
                tx_root: tx_root(&ids),
                state_root: smt::root(&tree),
                reward_address,
                nonce: 1,
            },
            txs,
        };
        self.0.insert(block.header.id(), after);
        block
    }

    /// `n` Blocks on `parent` paying `reward_address`, lowest first.
    fn branch(&mut self, parent: &Block, reward_address: Address, n: usize) -> Vec<Block> {
        let mut blocks: Vec<Block> = Vec::new();
        for _ in 0..n {
            let parent = blocks.last().unwrap_or(parent).clone();
            blocks.push(self.child(&parent, reward_address, Vec::new()));
        }
        blocks
    }
}

fn submit_all(chain: &Test, blocks: &[Block]) {
    for block in blocks {
        chain.submit_block(block).unwrap();
    }
}

fn balance(chain: &Test, address: &Address) -> Option<u64> {
    chain
        .account(address)
        .unwrap()
        .map(|account| account.balance)
}

fn checkpoint(height: u64, block_id: [u8; 32]) -> Checkpoint {
    let signer = SigningKey::from_seed(&DEV_CHECKPOINT_SEED);
    Checkpoint::sign(&PARAMS, &signer, height, block_id, &[0; 32]).unwrap()
}

#[test]
fn starts_from_the_genesis_and_reopens_where_it_was() {
    let file = File::new("reopen");
    let mut build = Builder::new();
    let genesis = build.genesis();
    assert_eq!(check_genesis(&PARAMS, &genesis), Ok(()));
    {
        let chain = file.open();
        assert_eq!(chain.tip().unwrap(), genesis.header);
        submit_all(&chain, &build.branch(&genesis, nobody(1), 2));
        // The genesis again is nothing new.
        chain.submit_block(&genesis).unwrap();
    }
    let chain = file.open();
    assert_eq!(chain.tip().unwrap().height, 2);
    assert_eq!(balance(&chain, &nobody(1)), Some(reward(1) + reward(2)));
    drop(chain);
    let other = Chain::open(&file.0, TESTNET, fake_hash);
    assert!(matches!(other, Err(Error::OtherNetwork)));
}

#[test]
fn stores_only_what_passes_without_the_accounts() {
    let file = File::new("refuse");
    let chain = file.open();
    let mut build = Builder::new();
    let genesis = build.genesis();
    let [a1, a2] = build.branch(&genesis, nobody(1), 2).try_into().unwrap();
    assert!(matches!(chain.submit_block(&a2), Err(Error::UnknownParent)));
    let mut no_work = a1.clone();
    no_work.header.nonce = 0;
    assert!(matches!(
        chain.submit_block(&no_work),
        Err(Error::Rule(RuleError::InsufficientWork))
    ));
    let mut other_body = a1.clone();
    other_body.txs = vec![transfer(&SigningKey::from_seed(&[1; 32]), 0, nobody(2), 5)];
    assert!(matches!(
        chain.submit_block(&other_body),
        Err(Error::Rule(RuleError::WrongTxRoot))
    ));
    let mut other_genesis = genesis.clone();
    other_genesis.header.timestamp += 1;
    assert!(matches!(
        chain.submit_block(&other_genesis),
        Err(Error::Rule(RuleError::WrongGenesis))
    ));
    // None of them was kept: the good copies go in as if they never came.
    assert_eq!(chain.tip().unwrap(), genesis.header);
    submit_all(&chain, &[a1, a2.clone()]);
    assert_eq!(chain.tip().unwrap(), a2.header);
}

#[test]
fn follows_the_most_work_and_undoes_the_branch_it_leaves() {
    let file = File::new("reorg");
    let chain = file.open();
    let mut build = Builder::new();
    let genesis = build.genesis();
    // Branch A pays a key that then sends Gold to a new address, so leaving it removes accounts,
    // takes a stored key back off, and restores a balance.
    let key = SigningKey::from_seed(&[1; 32]);
    let a1 = build.child(&genesis, key.address(), Vec::new());
    let a2 = build.child(&a1, nobody(1), vec![transfer(&key, 0, nobody(2), 5)]);
    submit_all(&chain, &[a1.clone(), a2.clone()]);
    assert_eq!(chain.tip().unwrap(), a2.header);
    assert!(
        chain
            .account(&key.address())
            .unwrap()
            .unwrap()
            .key
            .is_some()
    );
    // Branch B: as much work does not move the Node, more does.
    let b = build.branch(&genesis, nobody(3), 3);
    submit_all(&chain, &b[..2]);
    assert_eq!(chain.tip().unwrap(), a2.header);
    chain.submit_block(&b[2]).unwrap();
    assert_eq!(chain.tip().unwrap(), b[2].header);
    assert_eq!(
        balance(&chain, &nobody(3)),
        Some(reward(1) + reward(2) + reward(3))
    );
    for gone in [key.address(), nobody(1), nobody(2)] {
        assert_eq!(chain.account(&gone).unwrap(), None);
    }
    // Back to A when it has more work, with everything as it was.
    let a = build.branch(&a2, nobody(4), 2);
    submit_all(&chain, &a);
    assert_eq!(chain.tip().unwrap(), a[1].header);
    assert_eq!(balance(&chain, &nobody(3)), None);
    assert_eq!(balance(&chain, &nobody(2)), Some(5));
    let sender = chain.account(&key.address()).unwrap().unwrap();
    assert_eq!((sender.balance, sender.nonce), (reward(1) - 15, 1));
    assert!(sender.key.is_some());
}

#[test]
fn a_block_a_rule_refuses_is_never_followed() {
    let file = File::new("refused");
    let chain = file.open();
    let mut build = Builder::new();
    let genesis = build.genesis();
    let a = build.branch(&genesis, nobody(1), 2);
    submit_all(&chain, &a);
    // B2's state root is wrong: only its accounts show it, when B3 gives B more work.
    let b1 = build.child(&genesis, nobody(2), Vec::new());
    let mut b2 = build.child(&b1, nobody(2), Vec::new());
    let after_b2 = build.0[&b2.header.id()].clone();
    b2.header.state_root = [7; 32];
    build.0.insert(b2.header.id(), after_b2);
    let b3 = build.child(&b2, nobody(2), Vec::new());
    submit_all(&chain, &[b1, b2.clone(), b3.clone()]);
    // The move applied B1 before B2 failed, and left nothing of it.
    assert_eq!(chain.tip().unwrap(), a[1].header);
    assert_eq!(balance(&chain, &nobody(2)), None);
    assert_eq!(balance(&chain, &nobody(1)), Some(reward(1) + reward(2)));
    for refused in [&b2, &b3] {
        assert!(matches!(
            chain.submit_block(refused),
            Err(Error::RefusedBranch)
        ));
    }
    let b4 = build.child(&b3, nobody(2), Vec::new());
    assert!(matches!(chain.submit_block(&b4), Err(Error::RefusedBranch)));
    // A Block that is itself refused says why.
    let mut a3 = build.child(&a[1], nobody(1), Vec::new());
    a3.header.state_root = [7; 32];
    assert!(matches!(
        chain.submit_block(&a3),
        Err(Error::Rule(RuleError::WrongStateRoot))
    ));
    assert_eq!(chain.tip().unwrap(), a[1].header);
}

#[test]
fn a_changed_signature_refuses_the_copy_not_the_block() {
    let file = File::new("signature");
    let chain = file.open();
    let mut build = Builder::new();
    let genesis = build.genesis();
    let key = SigningKey::from_seed(&[1; 32]);
    let a1 = build.child(&genesis, key.address(), Vec::new());
    let a2 = build.child(&a1, nobody(1), vec![transfer(&key, 0, nobody(2), 5)]);
    chain.submit_block(&a1).unwrap();
    let mut changed = a2.clone();
    changed.txs[0].signature[0] ^= 1;
    assert_eq!(changed.header.id(), a2.header.id());
    assert!(matches!(
        chain.submit_block(&changed),
        Err(Error::Rule(RuleError::BadSignature))
    ));
    assert_eq!(chain.tip().unwrap(), a1.header);
    chain.submit_block(&a2).unwrap();
    assert_eq!(chain.tip().unwrap(), a2.header);
}

#[test]
fn a_checkpoint_overrides_more_work() {
    let file = File::new("checkpoint");
    let chain = file.open();
    let mut build = Builder::new();
    let genesis = build.genesis();
    let a = build.branch(&genesis, nobody(1), 12);
    let b = build.branch(&genesis, nobody(2), 10);
    submit_all(&chain, &a);
    submit_all(&chain, &b);
    assert_eq!(chain.tip().unwrap(), a[11].header);
    chain
        .add_checkpoint(&checkpoint(10, b[9].header.id()))
        .unwrap();
    assert_eq!(chain.tip().unwrap(), b[9].header);
    assert_eq!(balance(&chain, &nobody(1)), None);
    // More work on A does not bring the Node back; B goes on.
    let a13 = build.child(&a[11], nobody(1), Vec::new());
    chain.submit_block(&a13).unwrap();
    assert_eq!(chain.tip().unwrap(), b[9].header);
    let b11 = build.child(&b[9], nobody(2), Vec::new());
    chain.submit_block(&b11).unwrap();
    assert_eq!(chain.tip().unwrap(), b11.header);
    // Taken again after a restart.
    drop(chain);
    assert_eq!(file.open().tip().unwrap(), b11.header);
}

#[test]
fn a_branch_that_contradicts_the_checkpoint_ends_below_it() {
    let file = File::new("contradicts");
    let chain = file.open();
    let mut build = Builder::new();
    let genesis = build.genesis();
    let a = build.branch(&genesis, nobody(1), 12);
    submit_all(&chain, &a);
    // The Checkpoint names B10, which this Node does not have yet.
    let b = build.branch(&genesis, nobody(2), 10);
    chain
        .add_checkpoint(&checkpoint(10, b[9].header.id()))
        .unwrap();
    assert_eq!(chain.tip().unwrap(), a[8].header);
    // A branch below the Checkpoint's height does not contradict it.
    submit_all(&chain, &b[..9]);
    assert_eq!(chain.tip().unwrap(), a[8].header);
    chain.submit_block(&b[9]).unwrap();
    assert_eq!(chain.tip().unwrap(), b[9].header);
}

#[test]
fn a_higher_checkpoint_does_not_lift_a_lower_one() {
    let file = File::new("lower");
    let chain = file.open();
    let mut build = Builder::new();
    let genesis = build.genesis();
    let a = build.branch(&genesis, nobody(1), 12);
    submit_all(&chain, &a);
    chain
        .add_checkpoint(&checkpoint(10, a[9].header.id()))
        .unwrap();
    // No branch reaches this one yet.
    chain.add_checkpoint(&checkpoint(20, [1; 32])).unwrap();
    let c = build.branch(&genesis, nobody(2), 14);
    submit_all(&chain, &c);
    assert_eq!(chain.tip().unwrap(), a[11].header);
    // A branch that holds A10 goes on past it.
    let d = build.branch(&a[10], nobody(3), 3);
    submit_all(&chain, &d);
    assert_eq!(chain.tip().unwrap(), d[2].header);
}

#[test]
fn refuses_a_checkpoint_the_signer_did_not_sign() {
    let file = File::new("bad-checkpoint");
    let chain = file.open();
    let mut forged = checkpoint(10, [1; 32]);
    forged.block_id = [2; 32];
    assert!(matches!(
        chain.add_checkpoint(&forged),
        Err(Error::Rule(RuleError::BadSignature))
    ));
    let other = SigningKey::from_seed(&[9; 32]);
    let unsigned = Checkpoint::sign(&PARAMS, &other, 10, [1; 32], &[0; 32]).unwrap();
    assert!(matches!(
        chain.add_checkpoint(&unsigned),
        Err(Error::Rule(RuleError::BadSignature))
    ));
    let mut height = checkpoint(10, [1; 32]);
    height.height = 15;
    assert!(matches!(
        chain.add_checkpoint(&height),
        Err(Error::Rule(RuleError::CheckpointHeight))
    ));
    assert!(matches!(
        chain.add_checkpoint(&checkpoint(0, [1; 32])),
        Err(Error::Rule(RuleError::WrongGenesis))
    ));
    chain
        .add_checkpoint(&checkpoint(0, PARAMS.genesis().id()))
        .unwrap();
}

#[test]
fn applying_is_atomic_after_a_failure() {
    let file = File::new("atomic");
    let mut build = Builder::new();
    let genesis = build.genesis();
    let key = SigningKey::from_seed(&[1; 32]);
    let a1 = build.child(&genesis, key.address(), Vec::new());
    let a2 = build.child(&a1, nobody(1), vec![transfer(&key, 0, nobody(2), 5)]);
    let chain = file.open();
    chain.submit_block(&a1).unwrap();
    chain.fail_moves.set(true);
    // A2 is stored, then its move fails after every write and before the commit.
    assert!(matches!(chain.submit_block(&a2), Err(Error::Storage(_))));
    assert_eq!(chain.tip().unwrap(), a1.header);
    assert_eq!(balance(&chain, &key.address()), Some(reward(1)));
    assert_eq!(balance(&chain, &nobody(2)), None);
    // On disk too: opening again finishes the move, once.
    drop(chain);
    let reopened = file.open();
    assert_eq!(reopened.tip().unwrap(), a2.header);
    assert_eq!(balance(&reopened, &key.address()), Some(reward(1) - 15));
    assert_eq!(balance(&reopened, &nobody(2)), Some(5));
    assert_eq!(balance(&reopened, &nobody(1)), Some(reward(2) + 10));
}

/// With the Retarget, a branch can hold more work in fewer Blocks; the stored work stands in for
/// that here, since every Block above proves the same.
#[test]
fn matching_the_checkpoint_comes_before_work() {
    let file = File::new("before-work");
    let chain = file.open();
    let mut build = Builder::new();
    let genesis = build.genesis();
    let m = build.branch(&genesis, nobody(1), 10);
    let x = build.branch(&genesis, nobody(2), 5);
    let n = |n: u64| U256::ONE.mul_div(n, 1);
    let best = |chain: &Test| chain.write(|t| Ok::<_, Error>(best_candidate(t))).unwrap();
    chain
        .write(|t| {
            for (block, work) in m.iter().zip(1..).chain(x.iter().zip([100; 5])) {
                let header = block.header;
                let stored = Stored {
                    header,
                    work: n(work),
                    refused: false,
                };
                t.put_header(&header.id(), stored);
                t.put_block(&header.id(), block);
            }
            Ok::<_, Error>(())
        })
        .unwrap();
    assert_eq!(best(&chain), x[4].header.id());
    chain
        .write(|t| {
            t.put_checkpoint(10, &[&m[9].header.id()[..], &[0; 2420]].concat());
            Ok::<_, Error>(())
        })
        .unwrap();
    assert_eq!(best(&chain), m[9].header.id());
}

/// `cargo test --release -p linked-realms-node -- --ignored --nocapture bytes_per_account`
#[test]
#[ignore = "a measurement, run in release"]
fn bytes_per_account() {
    const ACCOUNTS: u32 = 100_000;
    let file = File::new("measure");
    let size = || {
        let mut db = Database::open(&file.0).unwrap();
        while db.compact().unwrap() {}
        drop(db);
        std::fs::metadata(&file.0).unwrap().len() as f64
    };
    drop(file.open());
    let empty = size();
    // New Accounts as transfers create them, with no key, 50 to a transaction as a full Block
    // makes them (`block::MAX_NEW_ACCOUNTS`).
    let chain = file.open();
    for batch in 0..ACCOUNTS / 50 {
        chain
            .write(|t| {
                for n in batch * 50..(batch + 1) * 50 {
                    // Spread evenly, as hashes are.
                    let mut bytes = [0; ADDRESS_LEN];
                    bytes[1] = SCHEME_ML_DSA_44;
                    bytes[2..6].copy_from_slice(&n.to_be_bytes());
                    let spread = tree_key(&Address::from_bytes(&bytes).unwrap());
                    bytes[2..].copy_from_slice(&spread);
                    let address = Address::from_bytes(&bytes).unwrap();
                    let account = Account {
                        balance: 1,
                        ..Account::default()
                    };
                    let value = account.hashed_bytes(&address);
                    smt::insert(&mut t.tree, &tree_key(&address), &value);
                    t.accounts.set_account(address, account);
                }
                Ok::<_, Error>(())
            })
            .unwrap();
    }
    drop(chain);
    let written = std::fs::metadata(&file.0).unwrap().len() as f64;
    let compacted = size();
    let per = |size: f64| (size - empty) / f64::from(ACCOUNTS);
    println!(
        "{ACCOUNTS} Accounts: {:.0} bytes each as written, {:.0} after compaction",
        per(written),
        per(compacted)
    );
}
