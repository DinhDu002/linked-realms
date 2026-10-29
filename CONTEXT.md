# linked-realms

A shared game world stitched together from Lands that players host themselves, joined through the Hub. Anything that affects another player (characters, land, gold) is decided on-chain, never by a Map server.

## Language

### World

**Land**:
One 64×64-tile plot at a fixed coordinate in the shared world, owned as an NFT.
_Avoid_: realm, map, room, plot

**Land owner**:
The wallet that currently owns a Land.
_Avoid_: host, landlord

**Player**:
A person acting through one wallet.
_Avoid_: account, user

**Character**:
The single main character bound to a Player. NPCs and troops are not Characters.
_Avoid_: avatar, hero

**Gate**:
The passage on each of a Land's four edges that leads to the adjacent Land.
_Avoid_: portal, door

**Travel ticket**:
A short-lived permit, signed by the Hub, that lets a Character enter another Land.
_Avoid_: pass, visa

### Wallets

**Passkey wallet**:
A Player's wallet that is a smart-contract account controlled by passkeys on the game's site. It needs no browser extension, and its game transactions are sponsored.
_Avoid_: embedded wallet (on its own), smart account, passkey account

**Backup passkey**:
A further passkey added as an owner of a Passkey wallet, so the wallet survives the loss of the first. Without one, a lost passkey means a lost wallet.
_Avoid_: recovery key, guardian

**Sponsored transaction**:
A game transaction whose fee the paymaster pays, within a per-Player and a world-wide daily limit.
_Avoid_: gasless transaction, free transaction

### Network

**Map server**:
The player-hosted process that runs exactly one Land in real time.
_Avoid_: land server, realm server, game server

**Hub**:
The company-operated service that lists Map servers, authenticates Players and routes connections between them. The indexer is not part of the Hub.
_Avoid_: master server, lobby

**Directory**:
The Hub's list of registered Map servers and whether each one is online.
_Avoid_: registry, server list

**Mining key**:
A Map server's own wallet. It holds no assets; it pays fees for submitting Solutions and, under a Delegation, identifies the Map server to the Hub and the relay.
_Avoid_: hot wallet, server key

**Delegation**:
The Land owner's signature naming the Mining key allowed to host their Land.
_Avoid_: authorisation, registration token

### Gold

**Gold**:
The game currency (`GOLD`). It is created only as Round rewards and has a fixed supply cap.
_Avoid_: coin, token (on its own)

**Mine**:
The spot on every Land from which its Land owner takes part in the single shared mining competition. All Mines compete in the same Rounds.
_Avoid_: gold mine contract, pool

**Round**:
One mining competition with a single Challenge and a single winner.
_Avoid_: block, epoch

**Challenge**:
The value every miner hashes during the current Round.
_Avoid_: puzzle seed, work

**Target**:
The threshold a Solution's hash must fall below. A lower Target means harder mining.
_Avoid_: difficulty (as a stored value)

**Solution**:
A nonce whose hash, combined with the Challenge and the reward wallet, falls below the Target.
_Avoid_: proof, answer

**Retarget**:
The periodic Target adjustment that keeps the average Round time near the goal.
_Avoid_: difficulty update

**Halving**:
The scheduled halving of the Round reward.
