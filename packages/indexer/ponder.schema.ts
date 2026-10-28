import { onchainTable, primaryKey } from "ponder";

export const character = onchainTable("character", (t) => ({
  player: t.hex().primaryKey(),
  landId: t.bigint().notNull(),
  createdAtBlock: t.bigint().notNull(),
  createdAtTimestamp: t.bigint().notNull(),
}));

// Stats are key-value pairs (P9): a new stat key is a new row, not a new column.
export const characterStat = onchainTable(
  "character_stat",
  (t) => ({
    player: t.hex().notNull(),
    key: t.text().notNull(),
    value: t.bigint().notNull(),
  }),
  (table) => ({ pk: primaryKey({ columns: [table.player, table.key] }) }),
);

export const land = onchainTable("land", (t) => ({
  id: t.bigint().primaryKey(),
  owner: t.hex().notNull(),
  x: t.integer().notNull(),
  y: t.integer().notNull(),
  designHash: t.hex(),
  mintedAtBlock: t.bigint().notNull(),
  mintedAtTimestamp: t.bigint().notNull(),
}));
