# LR

LR is a Proof-of-Work chain that holds money and nothing else: Gold, in Accounts, under rules every Node checks. It is a product of its own; Linked Realms, the game in this repository, is its first application (`CONTEXT-MAP.md`).

## Language

### The chain

**LR**:
The chain: Gold and the Accounts that hold it, sealed into Blocks by Mines and checked by every Node. It holds money only, plus a few fixed money rules added one at a time.
_Avoid_: the game's chain, Linked Realms chain

**Main network**:
The LR network whose Gold counts. It is never reset; its rules change only through network upgrades.
_Avoid_: mainnet

**Test network**:
The LR network that serves step 2C's acceptance test. It may be reset, and it stops once the main network starts.
_Avoid_: testnet (in prose)

**Dev network**:
An LR network for local work and for testing network upgrades, with an easy, fixed Target.
_Avoid_: devnet, local chain

**Network upgrade**:
A change to LR's rules that every Node must run to stay on the network; the only way the main network's rules change.
_Avoid_: hard fork, soft fork (on their own)

**Node**:
The process that keeps LR, checks every transaction and Block, and passes them on to other Nodes.
_Avoid_: peer, full node (on its own)

**Public node**:
A Node run by the company that browsers read LR from and send transactions to by default; anyone may use any other Node instead.
_Avoid_: RPC endpoint, gateway

### Gold

**Gold**:
LR's currency (`GOLD`), and the money of Linked Realms. It is created only as Block rewards, on a fixed schedule that halves the reward every four years and then keeps a small constant reward per Block forever.
_Avoid_: coin, token (on its own)

**Account**:
What LR holds for one address: its Gold balance, a count of the transactions it has sent, and, once it has sent one, its public key. It belongs to an address, not to a person: LR knows only addresses.
_Avoid_: wallet (on its own), balance (for the whole record)

**Mine**:
A mining process that runs beside a Node and mines for one address. It runs only when its owner switches it on, with a CPU limit. All Mines compete for every Block, with odds in proportion to their hash rate.
_Avoid_: miner, pool

**Block**:
A batch of transactions sealed by Proof of Work; the Mine that seals it wins the Block reward.
_Avoid_: Round, epoch

**Target**:
The threshold a Solution's hash must fall below. A lower Target means harder mining.
_Avoid_: difficulty (as a stored value)

**Solution**:
A nonce that makes a Block's header hash fall below the Target.
_Avoid_: proof, answer

**Retarget**:
The Target adjustment after every Block that keeps the average time between Blocks near the goal.
_Avoid_: difficulty update

**Halving**:
The scheduled halving of the Block reward.

### Checkpoints

**Checkpoint**:
A point in LR's history signed by the Checkpoint signer; no Node accepts a history that changes anything before it. Checkpoints end at a height written in the genesis code, or earlier through a network upgrade.
_Avoid_: finality, snapshot

**Checkpoint signer**:
The service whose key signs Checkpoints. The project owner holds the key, and it signs nothing once Checkpoints end.
_Avoid_: notary, validator
