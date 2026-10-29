# linked-realms

A shared game world stitched together from Lands that players host themselves, joined through the Hub. Gold lives on the chain, under rules every Node checks. The Hub keeps the map of Lands and lets Characters and NPCs travel between them. Everything inside a Land, including items and Character stats, is up to the Land owner.

## Language

### World

**Land**:
One cell of the shared world's grid, which the Hub assigns to a Character that hosts the Land on its own server. What lies inside a Land, and how large it is, is up to its owner. A Character creates at most one Land, and a Land is never transferred. A Land that stays offline too long loses its cell and gets a new one when it returns.
_Avoid_: realm, map, room, plot

**Cell**:
One square of the world's grid, numbered along a spiral from the centre. The Hub gives a Land a cell once its Map server is online and takes it back after the Land has been offline too long.
_Avoid_: tile, slot, plot

**Land owner**:
The Character that created a Land; it never changes.
_Avoid_: host, landlord

**Land item**:
An item a Land owner creates and keeps in their own Land's records, usable only in that Land. The chain never holds it; buying one is a Gold payment on the chain.
_Avoid_: token, NFT, asset

**Player**:
A real person who plays a Character through the Shell. The chain and the Hub know only Characters, never Players.
_Avoid_: account, user

**Character**:
Someone in the world with its own address and private key, played by a Player through the Shell or driven by a program. It may carry a short name, which need not be unique. Troops are not Characters.
_Avoid_: avatar, hero, account

**NPC**:
A Character that another Character creates to work for it, driven by a program such as an AI model. Its key is kept on its owner's server, so its owner can take back what it holds. Nothing records who owns it; other Lands see a Character that may declare an AI drives it.
_Avoid_: AI bot, bot, agent

**Shell**:
The open-source page that holds a Player's keys and shows each Land UI in an isolated frame. A Land can only ask the Shell to sign; the Player approves each request in the Shell.
_Avoid_: wallet (on its own), launcher, portal

**Land UI**:
A Land's own interface, served by its Map server and shown by the Shell in an isolated frame. It can ask the Shell to sign, but it never holds a key.
_Avoid_: frontend, Land page

**Quest**:
A job a Land offers to visiting Characters and NPCs, under that Land's own rules, rewarded in Gold that the Land owner pays.
_Avoid_: mission, job

**Gate**:
The passage on each of a Land's four edges that leads to the adjacent Land.
_Avoid_: portal, door

**Travel ticket**:
A short-lived permit, signed by the Hub, that lets a Character or an NPC enter another Land.
_Avoid_: pass, visa

### Network

**Map server**:
The player-hosted process that runs exactly one Land in real time.
_Avoid_: land server, realm server, game server

**Node**:
The process that keeps the chain, checks every transaction and Block, and passes them on to other Nodes. A Land runs one beside its Map server unless its owner turns it off.
_Avoid_: peer, full node (on its own)

**Hub**:
The company-operated service that connects Lands and lets Characters and NPCs travel between them. It can remove a Land from the Directory; it holds no keys of Players and signs no Checkpoints.
_Avoid_: master server, lobby

**Checkpoint signer**:
The company service, separate from the Hub, whose key signs Checkpoints.
_Avoid_: notary, validator

**Public node**:
A Node run by the company that browsers read the chain from and send transactions to by default; a Player may use any other Node instead.
_Avoid_: RPC endpoint, gateway

**Directory**:
The Hub's list of Lands, with each Land's cell, owner and Map server, and whether it is online.
_Avoid_: registry, server list

**Map server key**:
A Map server's own key. It holds nothing; under a Delegation it identifies the Map server to the Hub and the relay.
_Avoid_: mining key, server key, hot wallet

**Delegation**:
The Land owner's signature naming the Map server key allowed to host their Land.
_Avoid_: authorisation, registration token

### Gold

**Gold**:
The game currency (`GOLD`). It is created only as Block rewards, on a fixed schedule that halves the reward every four years and then keeps a small constant reward per Block forever.
_Avoid_: coin, token (on its own)

**Mine**:
One mining process that runs beside a Node on a Player's own server and mines for one Character's address. A Player may run any number of Mines there; each starts switched off. All Mines compete for every Block, with odds in proportion to their hash rate.
_Avoid_: miner, gold mine contract, pool

**Checkpoint**:
A point in the chain's history signed by the Checkpoint signer; no Node accepts a history that changes anything before it.
_Avoid_: finality, snapshot

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
