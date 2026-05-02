import postgres from "postgres";

let _sql: ReturnType<typeof postgres> | null = null;

function extractPassword(url: string) {
  const schemeEnd = url.indexOf("://");
  if (schemeEnd < 0) return undefined;

  const rest = url.slice(schemeEnd + 3);
  const at = rest.lastIndexOf("@");
  if (at < 0) return undefined;

  const userInfo = rest.slice(0, at);
  const separator = userInfo.indexOf(":");
  if (separator < 0) return undefined;

  const password = userInfo.slice(separator + 1);
  if (!password) return undefined;

  try {
    return decodeURIComponent(password);
  } catch {
    return password;
  }
}

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
    password: process.env.DATABASE_PASSWORD ?? extractPassword(url),
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
