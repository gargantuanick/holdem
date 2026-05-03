#!/usr/bin/env node
// Quick diagnostic: takes the DATABASE_URL value from Railway, walks through
// the same parsing the server does, then attempts a connection. Reports the
// exact reason auth fails so you don't have to keep redeploying to learn.
//
// Usage:
//   DATABASE_URL='postgresql://...' node scripts/diagnose-db.mjs
//
// Or paste the URL directly:
//   node scripts/diagnose-db.mjs 'postgresql://postgres.xxx:pw@host:6543/postgres'

import postgres from "postgres";

const url = process.argv[2] ?? process.env.DATABASE_URL;
if (!url) {
  console.error("No URL provided. Pass via env or arg.");
  process.exit(1);
}

console.log("=== input ===");
console.log("length:", url.length);
console.log(
  "starts with :",
  JSON.stringify(url.slice(0, 30)) + (url.length > 30 ? "..." : ""),
);
console.log("ends with   :", JSON.stringify(url.slice(-30)));

// Common silent gotchas
const issues = [];
if (url !== url.trim()) issues.push("LEADING/TRAILING WHITESPACE — trim it");
if (/\n|\r/.test(url)) issues.push("NEWLINE inside the value");
if (url.includes("[YOUR-PASSWORD]") || url.includes("[YOUR_PASSWORD]")) {
  issues.push("Placeholder '[YOUR-PASSWORD]' was never replaced with the real password");
}
if (url.includes("[pw]")) issues.push("Placeholder '[pw]' was never replaced");
if (/[‘’“”]/.test(url)) issues.push("smart quotes pasted into the value");

console.log("\n=== smell test ===");
if (issues.length === 0) console.log("  no obvious format issues");
else issues.forEach((i) => console.log("  ⚠️ " + i));

// Show parsed components
try {
  let host = url;
  host = host.slice(host.indexOf("://") + 3).split(/[?/]/)[0];
  host = decodeURIComponent(host.slice(host.indexOf("@") + 1));
  const urlObj = new URL(url.replace(host, host.split(",")[0]));
  console.log("\n=== parsed ===");
  console.log("  user:    ", JSON.stringify(decodeURIComponent(urlObj.username)));
  console.log("  pass len:", decodeURIComponent(urlObj.password).length, "chars");
  console.log(
    "  pass start/end:",
    JSON.stringify(decodeURIComponent(urlObj.password).slice(0, 2)) +
      "…" +
      JSON.stringify(decodeURIComponent(urlObj.password).slice(-2)),
  );
  console.log("  host:    ", urlObj.host);
  console.log("  db:      ", urlObj.pathname);
} catch (e) {
  console.log("\n=== parsed ===");
  console.log("  parse THREW:", e.message);
}

// Live connection attempt
console.log("\n=== live connection test ===");
const sql = postgres(url, {
  max: 1,
  idle_timeout: 5,
  connect_timeout: 10,
  prepare: false,
  onnotice: () => {},
});
try {
  const r = await sql`SELECT current_user as u, current_database() as db, version() as v`;
  console.log("  ✓ connected. server says:", r[0]);
} catch (e) {
  console.log("  ✗ failed:");
  console.log("    code:    ", e.code);
  console.log("    message: ", e.message);
  if (e.code === "28P01") {
    console.log(
      "\n  → 28P01 = wrong password. Reset it in Supabase or copy a fresh connection string.",
    );
  }
} finally {
  await sql.end({ timeout: 1 });
}
