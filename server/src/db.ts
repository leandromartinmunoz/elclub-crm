import pg from "pg";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export type Queryable = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };
export type Db = Queryable & {
  transaction: <T>(work: (tx: Queryable) => Promise<T>) => Promise<T>;
};

function fromPool(pool: pg.Pool): Db {
  return {
    query: (sql, params) => pool.query(sql, params as any[]),
    async transaction(work) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await work({ query: (sql, params) => client.query(sql, params as any[]) });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

let current: Db | null = null;
export function db(): Db {
  if (!current) {
    if (!process.env.DATABASE_URL) throw new Error("Falta DATABASE_URL");
    current = fromPool(new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 }));
  }
  return current;
}
/** Solo para tests. */
export function setDb(next: Db) { current = next; }

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/** Aplica, en orden y una sola vez, los archivos de migrations/*.sql. */
export async function migrate(target: Db = db()) {
  await target.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const done = new Set((await target.query("SELECT name FROM schema_migrations")).rows.map(r => r.name));
  for (const file of readdirSync(migrationsDir).filter(f => f.endsWith(".sql")).sort()) {
    if (done.has(file)) continue;
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    await target.transaction(async tx => {
      await tx.query(sql);
      await tx.query("INSERT INTO schema_migrations(name) VALUES($1)", [file]);
    });
    console.log(`Migración aplicada: ${file}`);
  }
}
