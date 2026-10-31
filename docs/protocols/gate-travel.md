# Travelling through a Gate

Status: mandatory (ADR 0008). It covers the message that carries a Character from one Land to the adjacent Land.

## Gates and cells

- The world is a grid of cells: `x` grows east and `y` grows south. The Hub gives each Land one cell along a spiral from the centre (`spiralCoordinates` in `packages/shared/src/rules/world.ts`).
- A Land has a Gate on each of its four edges. Each Gate leads to the adjacent cell:

| Direction | Gate number | Neighbour | Arrival Gate in the neighbour |
|---|---|---|---|
| north | 1 | `(x, y − 1)` | south (3) |
| east | 2 | `(x + 1, y)` | west (4) |
| south | 3 | `(x, y + 1)` | north (1) |
| west | 4 | `(x − 1, y)` | east (2) |

- Gate number 0 means no Gate: the Character entered from the Directory.
- How large a Land is inside, and where its Gates sit, is up to the Land. The reference kit's Land is 64 × 64 tiles, with each Gate two tiles wide at the centre of its edge.

## The message

When a Character steps through a Gate:

1. **The Land UI sends `travel`.** It sends `{ "type": "travel", "direction": "east" }` to the Shell (`shell-land-ui.md`). An NPC runner does the same step itself.
2. **The Shell finds the neighbour.** It looks up the current Land's cell in the Directory (`GET /directory`) and finds the Land in the neighbouring cell. When no Land is there, or that Land is offline, it answers `travelRefused` and the Character stays.
3. **The Shell gets a ticket.** It asks the Hub for one with `POST /tickets`, a session token and the body `{ "landId": <neighbour>, "from": <current Land> }`. The Hub checks that:
   - the target Land has a cell, is not hidden, and is online;
   - `from` has a cell adjacent to the target's.

   It signs a ticket whose `Gate` is the arrival Gate from the table above. Without `from`, `Gate` is 0. A refusal is `404` (unknown Land), `409` (offline, or not adjacent) or `400`.
4. **The Shell hands over and loads.** It signs the arrival statement (`arrival.md`) and loads the neighbour's Land UI with the new handoff.

The Hub does not know where a Character is. `from` only decides the arrival Gate and whether the move is between adjacent cells.
