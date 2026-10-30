use linked_realms_core::issuance::BASE_UNITS_PER_GOLD as GOLD;
use linked_realms_core::{SCHEME_ML_DSA_44, SigningKey};

use super::*;
use crate::chain::tests::{Builder, File, PARAMS, Test, balance, nobody, submit_all};

pub(crate) fn key(seed: u8) -> SigningKey {
    SigningKey::from_seed(&[seed; 32])
}

/// A transfer paying `rate` base units per byte, its key included with nonce 0.
pub(crate) fn pay(from: &SigningKey, nonce: u64, to: Address, amount: u64, rate: u64) -> Tx {
    pay_with(from, nonce, to, amount, rate, b"")
}

fn pay_with(from: &SigningKey, nonce: u64, to: Address, amount: u64, rate: u64, memo: &[u8]) -> Tx {
    let mut tx = Tx {
        scheme: SCHEME_ML_DSA_44,
        sender: from.address(),
        nonce,
        fee: 0,
        kind: Kind::Transfer {
            to,
            amount,
            memo: memo.to_vec(),
        },
        public_key: (nonce == 0).then(|| from.public_key().to_vec()),
        signature: Vec::new(),
    };
    // Signed first for its length: the fee's own bytes are fixed.
    tx.sign(&PARAMS, from, &[0; 32]).unwrap();
    tx.fee = rate * tx.to_bytes().len() as u64;
    tx.sign(&PARAMS, from, &[0; 32]).unwrap();
    tx
}

/// The funder, which mines the first Block.
fn funder() -> SigningKey {
    key(200)
}

/// A chain whose tip holds `senders` Accounts of 0.1 GOLD each, sent by the funder, and a
/// mempool following it.
fn funded(name: &str, senders: u8, policy: Policy) -> (File, Test, Mempool, Builder, Vec<Block>) {
    let file = File::new(name);
    let chain = file.open();
    let mut build = Builder::new();
    let genesis = build.genesis();
    let f = funder();
    let b1 = build.child(&genesis, f.address(), Vec::new());
    let txs = (0..senders)
        .map(|i| pay(&f, i.into(), key(i).address(), GOLD / 10, 0))
        .collect();
    let b2 = build.child(&b1, f.address(), txs);
    let blocks = vec![genesis, b1, b2];
    submit_all(&chain, &blocks[1..]);
    let mut pool = Mempool::new(PARAMS, policy);
    pool.follow(&chain).unwrap();
    (file, chain, pool, build, blocks)
}

fn add(pool: &mut Mempool, chain: &Test, tx: Tx) -> Result<(), Refused> {
    pool.add(&chain.state().unwrap().1, tx)
}

/// The held transactions' senders and nonces.
fn held(pool: &Mempool) -> Vec<(Address, u64)> {
    let mut held: Vec<_> = pool
        .senders
        .iter()
        .flat_map(|(sender, held)| held.keys().map(|nonce| (*sender, *nonce)))
        .collect();
    held.sort_by_key(|(sender, nonce)| (sender.to_bytes(), *nonce));
    held
}

/// Mines `template` (any nonce but 0 passes) and makes it the tip.
fn mine(chain: &Test, mut template: Block) -> Block {
    template.header.nonce = 1;
    chain.submit_block(&template).unwrap();
    assert_eq!(chain.tip().unwrap(), template.header);
    template
}

fn later(chain: &Test) -> u64 {
    chain.tip().unwrap().timestamp + 60
}

#[test]
fn takes_what_the_policy_and_the_rules_take() {
    let policy = Policy {
        per_sender: 3,
        ..Policy::default()
    };
    let (_file, chain, mut pool, ..) = funded("policy", 3, policy);
    let (a, b, c) = (key(0), key(1), key(2));
    let f = funder().address();
    let mut cheap = pay(&a, 0, f, 1, 10);
    cheap.fee -= 1;
    cheap.sign(&PARAMS, &a, &[0; 32]).unwrap();
    assert_eq!(add(&mut pool, &chain, cheap), Err(Refused::FeeTooLow));
    let dust = policy.dust;
    assert_eq!(dust, 38_290);
    assert_eq!(
        add(&mut pool, &chain, pay(&a, 0, nobody(1), dust - 1, 10)),
        Err(Refused::Dust)
    );
    // Dust to an Account that exists is no new Account.
    add(&mut pool, &chain, pay(&a, 0, f, 1, 10)).unwrap();
    add(&mut pool, &chain, pay(&b, 0, nobody(1), dust, 10)).unwrap();
    assert_eq!(
        add(&mut pool, &chain, pay(&a, 0, f, 1, 10)),
        Err(Refused::Known)
    );
    assert_eq!(
        add(&mut pool, &chain, pay(&a, 2, f, 1, 10)),
        Err(Refused::NonceGap)
    );
    add(&mut pool, &chain, pay(&a, 1, f, 1, 10)).unwrap();
    add(&mut pool, &chain, pay(&a, 2, f, 1, 10)).unwrap();
    assert_eq!(
        add(&mut pool, &chain, pay(&a, 3, f, 1, 10)),
        Err(Refused::TooMany)
    );
    assert_eq!(
        add(&mut pool, &chain, pay(&c, 0, f, GOLD, 10)),
        Err(Refused::Rule(RuleError::InsufficientBalance))
    );
    let mut forged = pay(&c, 0, f, 1, 10);
    forged.signature[0] ^= 1;
    assert_eq!(
        add(&mut pool, &chain, forged),
        Err(Refused::Rule(RuleError::BadSignature))
    );
    assert_eq!(
        add(&mut pool, &chain, pay(&key(9), 0, f, 1, 10)),
        Err(Refused::Rule(RuleError::NoAccount))
    );
    let mut expected = vec![(a.address(), 0), (a.address(), 1), (a.address(), 2)];
    expected.push((b.address(), 0));
    expected.sort_by_key(|(sender, nonce)| (sender.to_bytes(), *nonce));
    assert_eq!(held(&pool), expected);
}

#[test]
fn a_replacement_pays_more_by_the_margin_and_rechecks_what_follows() {
    let (_file, chain, mut pool, ..) = funded("replace", 1, Policy::default());
    let a = key(0);
    let f = funder().address();
    add(&mut pool, &chain, pay(&a, 0, f, 1_000, 100)).unwrap();
    add(&mut pool, &chain, pay(&a, 1, f, 1_000, 100)).unwrap();
    add(&mut pool, &chain, pay(&a, 2, f, 1_000, 100)).unwrap();
    assert_eq!(
        add(&mut pool, &chain, pay(&a, 0, f, 2_000, 109)),
        Err(Refused::ReplacementTooCheap)
    );
    add(&mut pool, &chain, pay(&a, 0, f, 2_000, 110)).unwrap();
    assert_eq!(pool.senders[&a.address()][&0].tx.fee, 110 * 3_829);
    assert_eq!(
        held(&pool),
        [(a.address(), 0), (a.address(), 1), (a.address(), 2)]
    );
    // This one leaves too little for the next.
    let all = GOLD / 10 - 130 * 3_829;
    add(&mut pool, &chain, pay(&a, 0, f, all, 130)).unwrap();
    assert_eq!(held(&pool), [(a.address(), 0)]);
    assert_eq!(pool.bytes, 3_829);
}

#[test]
fn evicts_the_lowest_fee_rate_with_the_senders_later_ones() {
    let first = pay(&key(0), 0, nobody(1), GOLD, 10).to_bytes().len();
    let next = pay(&key(0), 1, nobody(1), GOLD, 10).to_bytes().len();
    let policy = Policy {
        max_bytes: 3 * first + next,
        ..Policy::default()
    };
    let (_file, chain, mut pool, ..) = funded("evict", 4, policy);
    let [a, b, c, d] = [0, 1, 2, 3].map(key);
    let f = funder().address();
    add(&mut pool, &chain, pay(&a, 0, f, 1, 20)).unwrap();
    add(&mut pool, &chain, pay(&a, 1, f, 1, 90)).unwrap();
    add(&mut pool, &chain, pay(&b, 0, f, 1, 30)).unwrap();
    add(&mut pool, &chain, pay(&c, 0, f, 1, 40)).unwrap();
    assert_eq!(pool.bytes, policy.max_bytes);
    // A's first is the lowest: it goes, and A's second with it.
    add(&mut pool, &chain, pay(&d, 0, f, 1, 50)).unwrap();
    let mut expected = vec![(b.address(), 0), (c.address(), 0), (d.address(), 0)];
    expected.sort_by_key(|(sender, nonce)| (sender.to_bytes(), *nonce));
    assert_eq!(held(&pool), expected);
    assert_eq!(pool.bytes, 3 * first);
    // No room, and the new one pays the least: it goes at once.
    assert_eq!(
        add(&mut pool, &chain, pay(&a, 0, f, 1, 25)),
        Err(Refused::Full)
    );
    add(&mut pool, &chain, pay(&a, 0, f, 1, 60)).unwrap();
    let mut expected = vec![(a.address(), 0), (c.address(), 0), (d.address(), 0)];
    expected.sort_by_key(|(sender, nonce)| (sender.to_bytes(), *nonce));
    assert_eq!(held(&pool), expected);
    assert_eq!(pool.bytes, 3 * first);
}

#[test]
fn a_refused_replacement_leaves_the_mempool_as_it_was() {
    let first = pay(&key(0), 0, nobody(1), GOLD, 10).to_bytes().len();
    let next = pay(&key(0), 1, nobody(1), GOLD, 10).to_bytes().len();
    let policy = Policy {
        max_bytes: 2 * first + next,
        ..Policy::default()
    };
    let (_file, chain, mut pool, ..) = funded("refused", 2, policy);
    let (a, b) = (key(0), key(1));
    let f = funder().address();
    let a0 = pay(&a, 0, f, 1, 20);
    add(&mut pool, &chain, a0.clone()).unwrap();
    add(&mut pool, &chain, pay(&a, 1, f, 1, 30)).unwrap();
    add(&mut pool, &chain, pay(&b, 0, f, 1, 25)).unwrap();
    let before = held(&pool);
    // 10 % more per byte, but larger, and then the lowest held.
    assert_eq!(
        add(&mut pool, &chain, pay_with(&a, 0, f, 1, 22, b"memo")),
        Err(Refused::Full)
    );
    assert_eq!(held(&pool), before);
    assert_eq!(pool.senders[&a.address()][&0].tx, a0);
    assert_eq!(pool.bytes, policy.max_bytes);
}

#[test]
fn a_template_passes_every_check_but_the_proof_of_work() {
    let (_file, chain, ..) = funded("checks", 0, Policy::default());
    let f = funder().address();
    let too_late = linked_realms_core::block::MAX_TIMESTAMP + 1;
    assert!(matches!(
        chain.template(f, Vec::new(), too_late),
        Err(Error::Rule(RuleError::TimestampTooLate))
    ));
    // A clock behind the chain gets the earliest timestamp the rules allow.
    let template = chain.template(f, Vec::new(), 0).unwrap();
    assert_eq!(
        template.header.timestamp,
        chain.tip().unwrap().timestamp - 60 + 1
    );
    mine(&chain, template);
}

#[test]
fn the_template_goes_by_fee_rate_in_nonce_order() {
    let (_file, chain, mut pool, ..) = funded("order", 2, Policy::default());
    let (a, b) = (key(0), key(1));
    let f = funder().address();
    let a0 = pay(&a, 0, f, 1, 10);
    let a1 = pay(&a, 1, f, 1, 100);
    let b0 = pay(&b, 0, f, 1, 20);
    for tx in [&a1, &a0, &b0] {
        let _ = add(&mut pool, &chain, tx.clone());
    }
    // A's second came before its first, so it was refused: send it again.
    add(&mut pool, &chain, a1.clone()).unwrap();
    let template = pool.template(&chain, f, later(&chain)).unwrap();
    assert_eq!(template.txs, [b0, a0.clone(), a1.clone()]);
    mine(&chain, template);
    pool.follow(&chain).unwrap();
    assert_eq!(held(&pool), []);
    assert_eq!(pool.bytes, 0);
    let spent = 2 + a0.fee + a1.fee;
    assert_eq!(balance(&chain, &a.address()), Some(GOLD / 10 - spent));
}

#[test]
fn the_template_fits_one_block_and_always_validates() {
    let (_file, chain, mut pool, ..) = funded("full", 20, Policy::default());
    let f = funder().address();
    for i in 0..20 {
        let sender = key(i);
        for nonce in 0..25 {
            let rate = 10 + u64::from(i) + nonce;
            add(&mut pool, &chain, pay(&sender, nonce, f, 1, rate)).unwrap();
        }
    }
    assert!(pool.bytes > MAX_BLOCK_SIZE);
    let template = pool.template(&chain, f, later(&chain)).unwrap();
    assert!(template.size() <= MAX_BLOCK_SIZE);
    assert!(template.size() > MAX_BLOCK_SIZE - 3_829);
    let block = mine(&chain, template);
    pool.follow(&chain).unwrap();
    assert_eq!(held(&pool).len(), 500 - block.txs.len());
    // What is left still makes a valid Block.
    mine(&chain, pool.template(&chain, f, later(&chain)).unwrap());
}

#[test]
fn the_template_creates_at_most_50_accounts() {
    let (_file, chain, mut pool, ..) = funded("accounts", 20, Policy::default());
    let dust = Policy::default().dust;
    for i in 0..20 {
        for nonce in 0..3 {
            let to = nobody(i * 3 + nonce as u8 + 1);
            add(&mut pool, &chain, pay(&key(i), nonce, to, dust, 10)).unwrap();
        }
    }
    // The reward address is new too.
    let template = pool.template(&chain, nobody(99), later(&chain)).unwrap();
    assert_eq!(template.txs.len(), MAX_NEW_ACCOUNTS - 1);
    mine(&chain, template);
}

#[test]
fn a_reorg_brings_back_what_it_took_off_the_chain() {
    let file = File::new("reorg");
    let chain = file.open();
    let mut build = Builder::new();
    let genesis = build.genesis();
    let f = funder();
    let a1 = build.child(&genesis, f.address(), Vec::new());
    chain.submit_block(&a1).unwrap();
    let mut pool = Mempool::new(PARAMS, Policy::default());
    pool.follow(&chain).unwrap();
    let t0 = pay(&f, 0, nobody(1), GOLD, 10);
    let t1 = pay(&f, 1, nobody(2), GOLD, 10);
    add(&mut pool, &chain, t0.clone()).unwrap();
    add(&mut pool, &chain, t1.clone()).unwrap();
    let a2 = build.child(&a1, f.address(), vec![t0.clone()]);
    chain.submit_block(&a2).unwrap();
    pool.follow(&chain).unwrap();
    assert_eq!(held(&pool), [(f.address(), 1)]);
    // A branch with more work, where the funder sent nothing yet.
    let b = build.branch(&genesis, f.address(), 3);
    submit_all(&chain, &b);
    assert_eq!(chain.tip().unwrap(), b[2].header);
    pool.follow(&chain).unwrap();
    assert_eq!(held(&pool), [(f.address(), 0), (f.address(), 1)]);
    let template = pool.template(&chain, f.address(), later(&chain)).unwrap();
    assert_eq!(template.txs, [t0, t1]);
    mine(&chain, template);
}
