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
A Map server's own wallet. It holds no assets and only pays fees for submitting Solutions.
_Avoid_: hot wallet, server key

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
