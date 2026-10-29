// The Hub's periodic sweep (docs/plans/phase-2b-world-without-chain.md, flows 6 and 9): main.ts
// runs it every 15 seconds; tests call it directly.
import type { Deps } from "./app.ts";

const DAY_SECONDS = 86_400;
/** A Land not seen online for this long loses its cell (PLAN.md section 5.1). */
export const CELL_KEPT_OFFLINE_SECONDS = 30 * DAY_SECONDS;
/** A Map server statement that serves no Land is forgotten after this long. */
const MAP_SERVER_KEPT_SECONDS = 7 * DAY_SECONDS;

// The lowest free spiral index: with n cells in use, one of 0..n is free.
const LOWEST_FREE_CELL = `(SELECT min(i) FROM generate_series(0, (SELECT count(cell) FROM land)::int) AS i
   WHERE NOT EXISTS (SELECT 1 FROM land l WHERE l.cell = i))`;
// One past the highest index in use: the edge of the spiral.
const EDGE_CELL = "(SELECT coalesce(max(cell), -1) + 1 FROM land)";

export async function sweep(
  deps: Pick<Deps, "db" | "online" | "now" | "log">,
): Promise<void> {
  const { db } = deps;
  const now = Math.floor(deps.now() / 1000);
  let online: number[] | undefined;
  try {
    online = await deps.online();
  } catch (err) {
    // without the relay nothing is known to be online: skip the cells, keep the clean-up
    deps.log(
      `sweep: relay presence unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (online) {
    await db.query(
      "UPDATE land SET last_online_at = $2 WHERE id = ANY($1::bigint[])",
      [online, now],
    );
    // A new Land fills the lowest free index; one that lost its cell returns at the edge.
    const waiting = (
      await db.query<{ id: number | string }>(
        "SELECT id FROM land WHERE cell IS NULL AND NOT hidden AND id = ANY($1::bigint[]) ORDER BY id",
        [online],
      )
    ).rows;
    for (const { id } of waiting) {
      try {
        await db.query(
          `UPDATE land SET cell = CASE WHEN cell_lost_at IS NULL THEN ${LOWEST_FREE_CELL} ELSE ${EDGE_CELL} END,
             updated_at = $2
           WHERE id = $1 AND cell IS NULL`,
          [id, now],
        );
      } catch (err) {
        // the unique index on cell refused a race: the next sweep tries again
        deps.log(
          `sweep: no cell for Land ${id} this time: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  await db.query(
    `UPDATE land SET cell = NULL, cell_lost_at = $1, updated_at = $1
     WHERE cell IS NOT NULL AND last_online_at <= $2`,
    [now, now - CELL_KEPT_OFFLINE_SECONDS],
  );
  await db.query("DELETE FROM land_quota WHERE day < $1", [
    Math.floor(now / DAY_SECONDS) - 1,
  ]);
  await db.query(
    `DELETE FROM map_server m WHERE issued_at < $1
       AND NOT EXISTS (SELECT 1 FROM land WHERE map_server_key = m.key)`,
    [now - MAP_SERVER_KEPT_SECONDS],
  );
}
