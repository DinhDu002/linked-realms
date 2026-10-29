# 0008 — The Shell, open Lands and AI-driven NPCs

Status: accepted, 2026-10-29 — by the project owner

Supersedes ADR 0005 (Passkey wallet and CDP Paymaster) and decisions D2 (Colyseus as the Map server networking) and D5 (Passkey wallet) in ADR 0001. Replaces principle P6 "Maps are data, not code".

## Context

The project owner wants every Land to be free to make its own rules and its own interface, in any language. Land owners take responsibility for their own security. A Land's interface is therefore code from a stranger, while visitors carry keys that hold Gold. The old P6, under which the client never runs another server's code, cannot hold. The owner also wants NPCs driven by AI models that work in other Lands to earn Gold for their owners.

## Decisions

1. **The Shell holds the keys.**
   - The Shell is an open-source static page. It creates or restores a Player's key from 24 words, which it asks for only on its own setup page.
   - It stores the key encrypted with a password the Player sets, and it locks itself after a period of inactivity. Unlocking with a passkey or fingerprint can be added later.
   - The Public node is its default way to read the chain and send transactions.
2. **A Land's interface runs only in an isolated frame (P6).** Each Land's UI loads in a cross-origin iframe on the Land's own subdomain. The relay serves it there by default, and a Land owner may use their own domain. A Land can only ask the Shell to sign. The Shell shows every request outside the frame, and the Player approves it there.
3. **A few protocols are mandatory, the rest are reference.**
   - Mandatory:
     - the Shell ↔ Land UI API;
     - arrival at a Land: a Travel ticket plus a signed challenge, with a self-declared "driven by AI" field;
     - Map server ↔ Hub and relay;
     - Map server ↔ Node over JSON-RPC;
     - the message that carries a traveller through a Gate.
   - Reference only:
     - the reference Land kit's game protocol, WebSocket + Protocol Buffers, which replaces Colyseus. Colyseus's wire format is undocumented and its server is TypeScript-only.
     - the NPC action standard (decision 5).
   - Land owners may define their own protocols. NPC owners set up their NPCs to understand them.
4. **NPCs are driven by an AI model through an API.**
   - A Character creates an NPC and gives it work. The NPC works in its own Land or travels to other Lands to do Quests (ADR 0007).
   - The owner chooses the model and pays for it with their own API key on their own server. The company provides no AI.
   - The reference kit ships a Claude API adapter first, then an OpenAI-compatible one, which also covers local models.
5. **The NPC action standard.** A Land that welcomes NPCs publishes two things: what an NPC sees, as text, and the actions it may take. Actions use the tool format that AI APIs already accept: a name, a description and parameters as JSON Schema. The NPC runner hands that list to the model as tools. MCP is a candidate transport, chosen at implementation. Lands that publish nothing simply receive no NPCs that use the standard.
6. **The AI never holds the key.**
   - Other Lands write text that the model reads, so prompt injection is the expected attack.
   - The model only proposes actions. The NPC runner on the owner's server checks each one against limits the owner sets, such as Gold per day and allowed Lands, and only then signs.
   - Earnings are paid to the owner directly, so an NPC holds little.
7. **NPCs say they are AI.** The reference NPC always sets the "driven by AI" field at arrival, and Lands show it. Article 50(1) of the EU AI Act has applied since 2 August 2026 and requires people to be told when they are interacting with an AI system. A legal review is in Phase 3.

## Consequences

- The Passkey wallet, Backup passkey, Sponsored transactions and `POST /aa` go away. A Player who loses their 24 words and their password loses their key; nobody can recover it.
- The Hub signs Travel tickets for ML-DSA identities instead of SIWE/EIP-712 wallets.
- The relay becomes protocol-neutral: it forwards each Land's HTTP and WebSocket traffic on that Land's subdomain.
- A Land can show anything inside its frame, including scams. The Shell's signing prompt is the only trusted surface, so it must state the amount, the recipient and the memo in plain words.
