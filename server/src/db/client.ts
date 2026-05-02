import postgres from "postgres";

let _sql: ReturnType<typeof postgres> | null = null;

export function getSql() {
  if (_sql) return _sql;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL not set");
  }
  // Supabase pooled (transaction-mode) connection: port 6543.
  // We keep a small pool because the pooler is shared across processes.
  _sql = postgres(url, {
    max: Number(process.env.DB_POOL_MAX ?? 10),
    idle_timeout: 20,
    connect_timeout: 15,
    prepare: false, // required for Supabase transaction-mode pooler
    onnotice: () => {},
  });
  return _sql;
}

export async function closePool() {
  if (_sql) {
    await _sql.end({ timeout: 5 });
    _sql = null;
  }
}
