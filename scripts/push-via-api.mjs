#!/usr/bin/env node
// Push commits to gargantuanick/holdem via the GitHub REST API, bypassing the
// local .git directory. This exists because Cowork's sandbox can't write to
// .git/, so `git commit` and `git push` don't work from there. From a normal
// shell or Claude Code, prefer `git` directly.
//
// Pinned to one repo on purpose: the script refuses to run if the resolved
// repo isn't gargantuanick/holdem, and the GH_TOKEN should be a fine-grained
// PAT scoped to only this repo.
//
// Usage:
//   GH_TOKEN=ghp_xxx node scripts/push-via-api.mjs \
//     --message "commit message here" \
//     [--file path1 --file path2 ...] \
//     [--dry-run] [--with-migration]
//
//   GH_TOKEN=ghp_xxx node scripts/push-via-api.mjs --revert <sha> \
//     [--message "reason"] [--dry-run]
//
// If no --file flags are passed, the script defaults to the staged files in
// `git diff --name-only origin/main` — but this script is intended to be
// driven by an explicit list passed by the caller. NEVER add globs.
//
// Safety:
//   - Repo is pinned to gargantuanick/holdem.
//   - main ref is updated with `expected-parent-sha` semantics: if the ref
//     has moved since we read it, GitHub returns 422 and we abort.
//   - Refuses if no files would change (empty commit).
//   - Refuses if any file under server/migrations/ is in the file list,
//     unless --with-migration is passed.
//   - --dry-run logs what would be sent and exits without writing anything.
//   - Token is read from GH_TOKEN env var only. Never logged.

import { readFile, stat } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";
import { execSync } from "node:child_process";

const REPO_OWNER = "gargantuanick";
const REPO_NAME = "holdem";
const REPO_FULL = `${REPO_OWNER}/${REPO_NAME}`;
const BRANCH = "main";

// ---- arg parsing ------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    message: null,
    files: [],
    dryRun: false,
    withMigration: false,
    revert: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--with-migration") args.withMigration = true;
    else if (a === "--message" || a === "-m") args.message = argv[++i];
    else if (a === "--file" || a === "-f") args.files.push(argv[++i]);
    else if (a === "--revert") args.revert = argv[++i];
    else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return args;
}

// ---- env validation ---------------------------------------------------------

function getToken() {
  const t = process.env.GH_TOKEN;
  if (!t) {
    throw new Error(
      "GH_TOKEN not set. Provide a fine-grained PAT scoped to " +
        `${REPO_FULL} with contents:write.`,
    );
  }
  return t;
}

function assertRepoPinned() {
  // Read the configured remote so we don't accidentally push elsewhere if
  // someone copies this script. We *also* hard-code the repo name above as a
  // belt-and-suspenders check.
  let remoteUrl = "";
  try {
    remoteUrl = execSync("git config --get remote.origin.url", {
      encoding: "utf8",
    }).trim();
  } catch {
    // No git available is fine — we don't actually need a working .git here.
  }
  if (remoteUrl) {
    const matches =
      remoteUrl.includes(REPO_FULL) ||
      remoteUrl.endsWith(`${REPO_FULL}.git`);
    if (!matches) {
      throw new Error(
        `repo origin is "${remoteUrl}", expected ${REPO_FULL}. ` +
          `This script is pinned to ${REPO_FULL} only.`,
      );
    }
  }
}

// ---- GitHub helpers ---------------------------------------------------------

async function gh(token, method, path, body) {
  const url = `https://api.github.com${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": `holdem-push-via-api`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const msg = json?.message ?? text ?? `HTTP ${res.status}`;
    throw new Error(`GitHub API ${method} ${path} → ${res.status}: ${msg}`);
  }
  return json;
}

async function getRefSha(token, ref) {
  const j = await gh(token, "GET", `/repos/${REPO_FULL}/git/ref/${ref}`);
  return j.object.sha;
}

async function getCommit(token, sha) {
  return gh(token, "GET", `/repos/${REPO_FULL}/git/commits/${sha}`);
}

async function createBlob(token, contentBuffer) {
  const j = await gh(token, "POST", `/repos/${REPO_FULL}/git/blobs`, {
    content: contentBuffer.toString("base64"),
    encoding: "base64",
  });
  return j.sha;
}

async function createTree(token, baseTreeSha, entries) {
  const j = await gh(token, "POST", `/repos/${REPO_FULL}/git/trees`, {
    base_tree: baseTreeSha,
    tree: entries,
  });
  return j.sha;
}

async function createCommit(token, message, treeSha, parentSha) {
  const j = await gh(token, "POST", `/repos/${REPO_FULL}/git/commits`, {
    message,
    tree: treeSha,
    parents: [parentSha],
  });
  return j.sha;
}

async function updateRef(token, ref, newSha, expectedOldSha) {
  // GitHub's PATCH /git/refs/{ref} performs a fast-forward by default. With
  // force=false (the default), GitHub will reject if the new SHA isn't a
  // descendant of the current ref. That gives us the expected-parent-SHA
  // safety: if anyone else pushed in between, the update fails.
  void expectedOldSha; // (informational; not sent — server enforces FF)
  return gh(token, "PATCH", `/repos/${REPO_FULL}/git/refs/${ref}`, {
    sha: newSha,
    force: false,
  });
}

// ---- file collection --------------------------------------------------------

async function readFileEntry(repoRoot, relPath) {
  const abs = resolve(repoRoot, relPath);
  const st = await stat(abs).catch(() => null);
  if (!st) {
    throw new Error(`file not found: ${relPath}`);
  }
  if (!st.isFile()) {
    throw new Error(`not a regular file: ${relPath} (dirs not supported)`);
  }
  // Normalise path separators to forward slashes for git tree.
  const treePath = relPath.split(sep).join("/");
  if (treePath.startsWith("/") || treePath.includes("..")) {
    throw new Error(`unsafe path: ${relPath}`);
  }
  const buf = await readFile(abs);
  return { path: treePath, buf };
}

function findRepoRoot() {
  // The script lives at <repo>/scripts/push-via-api.mjs.
  return resolve(new URL(".", import.meta.url).pathname, "..");
}

// ---- main flows -------------------------------------------------------------

async function pushFiles(token, args) {
  if (!args.message) throw new Error("--message is required");
  if (args.files.length === 0) {
    throw new Error(
      "no --file arguments. Pass each file explicitly. NEVER use globs.",
    );
  }
  const repoRoot = findRepoRoot();
  // Normalise / validate paths first.
  const normalised = args.files.map((f) => {
    const r = relative(repoRoot, resolve(repoRoot, f));
    if (r.startsWith("..")) {
      throw new Error(`file outside repo: ${f}`);
    }
    return r;
  });
  // Migration guard.
  const hasMigration = normalised.some((p) =>
    p.replace(/\\/g, "/").startsWith("server/migrations/"),
  );
  if (hasMigration && !args.withMigration) {
    throw new Error(
      `refusing: ${normalised.find((p) => p.replace(/\\/g, "/").startsWith("server/migrations/"))} is a migration. ` +
        `Pass --with-migration to acknowledge schema changes can't be rolled back by reverting code.`,
    );
  }
  // Read all files.
  const entries = [];
  for (const p of normalised) {
    entries.push(await readFileEntry(repoRoot, p));
  }
  console.log(`Files (${entries.length}):`);
  for (const e of entries) console.log(`  ${e.path} (${e.buf.length} bytes)`);

  if (args.dryRun) {
    console.log("\n--dry-run: no API calls made.");
    return;
  }

  // 1. Read current main ref + commit + tree.
  const parentSha = await getRefSha(token, `heads/${BRANCH}`);
  console.log(`Parent commit on ${BRANCH}: ${parentSha}`);
  const parentCommit = await getCommit(token, parentSha);
  const baseTreeSha = parentCommit.tree.sha;

  // 2. Create blobs.
  const blobBySha = [];
  for (const e of entries) {
    const sha = await createBlob(token, e.buf);
    blobBySha.push({ path: e.path, sha, size: e.buf.length });
  }

  // 3. Build tree off the parent's tree (so untouched files are preserved).
  const treeEntries = blobBySha.map((b) => ({
    path: b.path,
    mode: "100644",
    type: "blob",
    sha: b.sha,
  }));
  const newTreeSha = await createTree(token, baseTreeSha, treeEntries);

  // 4. Refuse if the resulting tree is identical to the parent (empty commit).
  if (newTreeSha === baseTreeSha) {
    throw new Error(
      "resulting tree is identical to parent — nothing to commit. Refusing.",
    );
  }

  // 5. Create commit + fast-forward main.
  const commitSha = await createCommit(token, args.message, newTreeSha, parentSha);
  console.log(`Created commit: ${commitSha}`);
  await updateRef(token, `heads/${BRANCH}`, commitSha, parentSha);
  console.log(`✓ Pushed ${commitSha} to ${REPO_FULL}@${BRANCH}`);
  console.log(`  Parent: ${parentSha}`);
  console.log(`  Revert: node scripts/push-via-api.mjs --revert ${commitSha}`);
}

async function revertCommit(token, args) {
  const sha = args.revert;
  if (!sha || !/^[0-9a-f]{7,40}$/.test(sha)) {
    throw new Error(`--revert needs a commit SHA (got "${sha}")`);
  }
  // Fetch the bad commit's tree and its parent.
  const bad = await getCommit(token, sha);
  if (!bad.parents || bad.parents.length === 0) {
    throw new Error(`commit ${sha} has no parent — cannot revert`);
  }
  if (bad.parents.length > 1) {
    throw new Error(
      `commit ${sha} is a merge commit (${bad.parents.length} parents). ` +
        `Revert merges via the GitHub UI.`,
    );
  }
  const parentOfBad = await getCommit(token, bad.parents[0].sha);
  const restoredTree = parentOfBad.tree.sha;

  // Current head.
  const currentHead = await getRefSha(token, `heads/${BRANCH}`);
  console.log(`Reverting ${sha} on top of ${currentHead}`);
  console.log(`Restoring tree: ${restoredTree} (parent of ${sha})`);

  if (args.dryRun) {
    console.log("--dry-run: no API calls made.");
    return;
  }

  const message =
    args.message ?? `Revert ${sha.slice(0, 7)}\n\nThis reverts commit ${sha}.`;
  const newCommit = await createCommit(token, message, restoredTree, currentHead);
  console.log(`Created revert commit: ${newCommit}`);
  await updateRef(token, `heads/${BRANCH}`, newCommit, currentHead);
  console.log(`✓ Reverted ${sha}. ${BRANCH} is now at ${newCommit}`);
}

// ---- entry ------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);
  assertRepoPinned();
  // Token is required for any API call. For pushFiles we early-return on
  // --dry-run before making any calls, so it's optional there. For revert
  // we always read the bad commit, so we need a token even in dry-run.
  const token = args.revert || !args.dryRun ? getToken() : "";
  if (args.revert) {
    await revertCommit(token, args);
  } else {
    await pushFiles(token, args);
  }
}

main().catch((err) => {
  console.error(`✗ ${err.message}`);
  process.exit(1);
});
