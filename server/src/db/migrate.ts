import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getSql } from "./client.js";

const here = dirname(fileURLToPath(import.meta.url));
// migrations live at /server/migrations regardless of build dir.
// from src: ../migrations; from dist: ../../migrations
async function findMigrationsDir(): Promise<string> {
  const candidates = [
    join(here, "..", "..", "migrations"),
    join(here, "..", "migrations"),
  ];
  for (const c of candidates) {
    try {
      await readdir(c);
      return c;
    } catch {
      // try next
    }
  }
  throw new Error(
    `migrations dir not found; tried: ${candidates.join(", ")}`,
  );
}

export async function runMigrations(): Promise<void> {
  const sql = getSql();
  const dir = await findMigrationsDir();
  const files = (await readdir(dir))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  const appliedRows = await sql<{ filename: string }[]>`
    SELECT filename FROM schema_migrations
  `;
  const applied = new Set(appliedRows.map((r) => r.filename));

  for (const file of files) {
    if (applied.has(file)) continue;
    const path = join(dir, file);
    const sqlText = await readFile(path, "utf8");
    console.log(`[migrate] applying ${file}`);
    await sql.unsafe(sqlText);
    await sql`
      INSERT INTO schema_migrations (filename) VALUES (${file})
    `;
  }
}
