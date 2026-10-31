# 0010 — A Land from one command

Status: accepted, 2026-10-29 — by the project owner

## Context

Until now a Land owner built the image from the repository, then wrote four settings by hand: their address, the Hub's URL, the relay's URL and the Hub's ticket signer, which they looked up with `curl`. Each step was a chance to get something wrong before the first try on two machines. The owner asked for the fewest possible steps.

## Decisions

1. **The Hub publishes its relay.**
   - `GET /keys` returns `relayUrl` next to the ticket key: the relay's `ws://` or `wss://` URL as Map servers dial it (`RELAY_PUBLIC_URL`), or `null` when the world has none.
2. **A Map server reads the ticket signer and the relay from the Hub.**
   - When `HUB_TICKET_SIGNER` or `RELAY_URL` is unset, the reference Map server reads `GET /keys` at start, retrying while the Hub is unreachable, and fills in what is missing. Both settings stay as optional pins.
   - Trust does not change. The Map server already trusts the Hub at `HUB_URL` to tell it which Land it serves and who owns it; the ticket signer comes over the same connection. Pinning remains for an owner who wants a Hub that changes its ticket key to be refused rather than followed.
   - A Hub that replaces its ticket key now reaches Map servers that did not pin it at their next start.
   - Rejected: keeping both settings required. It is safer only against a Hub that already controls the Land's registration.
3. **The project publishes the Map server image.**
   - `.github/workflows/image.yml` pushes `ghcr.io/dinhdu002/linked-realms-node` for amd64 and arm64 from `main` (`latest`) and the working branch (its name), with the commit as a second tag.
   - The WebAssembly core and the web pages are built on the build machine's platform, so only the last stage runs under emulation.
   - Rejected: building on the owner's machine, which takes minutes and needs the repository's build tools in Docker.
4. **The Shell writes the command.**
   - "Your Land" shows one `docker run` line with the Character's address, the Hub's URL and the image (`VITE_LAND_IMAGE`, `LAND_IMAGE` in the public deployment), and a button that copies it.
   - The line has no quotes or shell syntax, so it pastes the same into sh, zsh, bash and PowerShell.

## Consequences

- A Land owner needs Docker, a Character and one pasted command.
- The image in the command must be public. A new GHCR package is private until the project owner makes it public.
- Every Land owner runs code the project built. Anyone can still build their own image from the repository and run it instead.
