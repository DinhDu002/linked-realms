import { ponder } from "ponder:registry";
import { character, characterStat, land } from "ponder:schema";
import { characterRow, landRow, statRow } from "./rows.ts";

ponder.on("PlayerRegistry:CharacterCreated", async ({ event, context }) => {
  await context.db
    .insert(character)
    .values(characterRow(event.args.player, event.args.landId, event.block));
});

ponder.on("PlayerRegistry:StatChanged", async ({ event, context }) => {
  const { player, key, value } = event.args;
  const row = statRow(player, key, value);
  await context.db
    .insert(characterStat)
    .values(row)
    .onConflictDoUpdate({ value: row.value });
});

ponder.on("Land:LandMinted", async ({ event, context }) => {
  const { landId, owner, x, y } = event.args;
  await context.db
    .insert(land)
    .values(landRow(landId, owner, x, y, event.block));
});

ponder.on("Land:DesignHashSet", async ({ event, context }) => {
  await context.db
    .update(land, { id: event.args.landId })
    .set({ designHash: event.args.designHash });
});
