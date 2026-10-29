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
  {
    id: "002-sponsorship",
    statements: [
      // sponsored transactions per UTC day; identity is a lowercase address, or '*' for the whole world
      `CREATE TABLE sponsorship (
         identity text NOT NULL,
         day      integer NOT NULL,
         count    integer NOT NULL,
         PRIMARY KEY (identity, day)
       )`,
    ],
  },
  // Step 2B: the world leaves the chain. The old rows are testnet data and are wiped.
  { id: "003-drop-sponsorship", statements: ["DROP TABLE sponsorship"] },
  {
    id: "004-lands",
    statements: [
      "DROP TABLE delegation",
      // the newest Map server statement per key (docs/protocols/map-server-hub-relay.md)
      `CREATE TABLE map_server (
         key        text PRIMARY KEY,
         owner      text NOT NULL,
         statement  text NOT NULL,
         public_key text NOT NULL,
         signature  text NOT NULL,
         issued_at  bigint NOT NULL
       )`,
      // one Land per Character; statement, public_key and signature are its newest Delegation
      `CREATE TABLE land (
         id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
         owner             text NOT NULL UNIQUE,
         map_server_key    text NOT NULL UNIQUE,
         statement         text NOT NULL,
         public_key        text NOT NULL,
         signature         text NOT NULL,
         issued_at         bigint NOT NULL,
         cell              integer UNIQUE,
         cell_lost_at      bigint,
         last_online_at    bigint,
         domain            text UNIQUE,
         domain_checked_at bigint,
         hidden            boolean NOT NULL DEFAULT false,
         created_at        bigint NOT NULL,
         updated_at        bigint NOT NULL
       )`,
      `CREATE TABLE character (
         address    text PRIMARY KEY,
         name       text NOT NULL,
         updated_at bigint NOT NULL
       )`,
      // new Lands per network address (IPv4, or IPv6 /64) per UTC day
      `CREATE TABLE land_quota (
         network text NOT NULL,
         day     integer NOT NULL,
         count   integer NOT NULL,
         PRIMARY KEY (network, day)
       )`,
    ],
  },
  // its Land ids were the chain's
  { id: "005-empty-report", statements: ["DELETE FROM report"] },
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
