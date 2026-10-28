import pg from "pg";

/** The only database surface hub-api needs; pg.Pool (via createPool) and PGlite both fit. */
export interface Db {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

// Single statements only (PGlite's query() runs one at a time). Never edit an applied entry: append.
const MIGRATIONS: { id: string; statements: string[] }[] = [
  {
    id: "001-hub",
    statements: [
      `CREATE TABLE delegation (
         land_id    bigint PRIMARY KEY,
         owner      text NOT NULL,
         x          integer NOT NULL,
         y          integer NOT NULL,
         mining_key text NOT NULL,
         issued_at  bigint NOT NULL,
         signature  text NOT NULL,
         hidden     boolean NOT NULL DEFAULT false,
         updated_at bigint NOT NULL
       )`,
      `CREATE TABLE report (
         id         integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
         land_id    bigint NOT NULL,
         reporter   text NOT NULL,
         reason     text NOT NULL,
         created_at bigint NOT NULL,
         resolved   boolean NOT NULL DEFAULT false
       )`,
    ],
  },
];

/** Applies pending migrations; safe to run on every start-up. */
export async function migrate(db: Db): Promise<void> {
  await db.query("CREATE TABLE IF NOT EXISTS migration (id text PRIMARY KEY)");
  const done = new Set(
    (await db.query<{ id: string }>("SELECT id FROM migration")).rows.map(
      (r) => r.id,
    ),
  );
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    for (const statement of m.statements) await db.query(statement);
    await db.query("INSERT INTO migration (id) VALUES ($1)", [m.id]);
  }
}

export function createPool(
  databaseUrl: string,
  log: (message: string) => void = console.error,
): Db & { end(): Promise<void> } {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10_000,
  });
  // without a listener, an idle client dying (database restart) crashes the process
  pool.on("error", (err) => log(`database pool error: ${err.name}`));
  return {
    async query<T>(sql: string, params?: unknown[]) {
      const result = await pool.query(sql, params);
      return { rows: result.rows as T[] };
    },
    end: () => pool.end(),
  };
}
