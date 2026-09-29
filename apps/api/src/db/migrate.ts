/**
 * Minimal migration runner — reads numbered SQL files from ./migrations
 * and executes them in order, skipping any already recorded in schema_migrations.
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import { Pool } from "pg";

async function migrate() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        run_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const migrationsDir = path.join(__dirname, "../../migrations");
    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    for (const file of files) {
      const version = file.replace(".sql", "");
      const { rowCount } = await client.query(
        "SELECT 1 FROM schema_migrations WHERE version = $1",
        [version]
      );
      if (rowCount && rowCount > 0) {
        console.log(`[migrate] skip  ${version}`);
        continue;
      }

      const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (version) VALUES ($1)",
        [version]
      );
      await client.query("COMMIT");
      console.log(`[migrate] ran   ${version}`);
    }

    console.log("[migrate] done");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[migrate] error", err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
export { migrate };
