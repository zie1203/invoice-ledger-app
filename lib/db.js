/**
 * Shared storage layer for the invoice archive, backed by Turso (hosted
 * libSQL — SQLite-compatible, reachable over the network so it works from
 * Vercel's serverless functions, which have no persistent local disk).
 *
 * Both the Vercel serverless function (api/state.js) and the local Express
 * server (server.js, for `npm start` / local development) import from here,
 * so there is exactly one implementation of the storage logic.
 *
 * Configure via environment variables:
 *   TURSO_DATABASE_URL   e.g. libsql://your-db-name.turso.io
 *   TURSO_AUTH_TOKEN     an auth token for that database
 * If TURSO_DATABASE_URL is not set, this falls back to a local file
 * (DATA_DIR/invoices.db, or ./data/invoices.db by default) so the app runs
 * locally with `npm start` and no Turso account at all — useful for
 * development, or for hosting this the old way on your own server/VPS.
 */

const path = require("path");
const fs = require("fs");
const { createClient } = require("@libsql/client");

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, "..", "data");
const LOCAL_DB_FILE = path.join(DATA_DIR, "invoices.db");
const LEGACY_STATE_FILE = path.join(DATA_DIR, "state.json");

let clientPromise = null;

function getClient() {
  if (!clientPromise) {
    clientPromise = initClient().catch((err) => {
      // Let the NEXT call retry from scratch instead of permanently caching a failure.
      clientPromise = null;
      throw err;
    });
  }
  return clientPromise;
}

async function initClient() {
  let client;
  if (process.env.TURSO_DATABASE_URL) {
    client = createClient({
      url: process.env.TURSO_DATABASE_URL,
      authToken: process.env.TURSO_AUTH_TOKEN
    });
  } else {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    client = createClient({ url: "file:" + LOCAL_DB_FILE });
  }

  // Every call here is retry-wrapped: this runs on every cold start, and on
  // Vercel a burst of concurrent cold starts can genuinely collide with
  // each other (or with someone else's save) while creating/checking the
  // schema, not just while writing invoices.
  await retryOnBusy(() => client.execute(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `));
  await retryOnBusy(() => client.execute(`
    CREATE TABLE IF NOT EXISTS invoices (
      id TEXT PRIMARY KEY,
      sort_order INTEGER NOT NULL,
      invoice_no TEXT,
      status TEXT,
      consignee_name TEXT,
      invoice_date TEXT,
      created_at INTEGER,
      updated_at INTEGER,
      data TEXT NOT NULL
    )
  `));
  await retryOnBusy(() => client.execute("CREATE INDEX IF NOT EXISTS idx_invoices_sort_order ON invoices(sort_order)"));
  await retryOnBusy(() => client.execute("CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status)"));
  await retryOnBusy(() => client.execute("CREATE INDEX IF NOT EXISTS idx_invoices_invoice_no ON invoices(invoice_no)"));

  const versionRow = await retryOnBusy(() => client.execute("SELECT value FROM meta WHERE key = 'version'"));
  if (versionRow.rows.length === 0) {
    await seedDatabase(client);
  }

  return client;
}

async function seedDatabase(client) {
  // First run against this (empty) database. Three sources are tried in
  // order, most-current first:
  //
  //  1. A local data/invoices.db from the previous local-SQLite version of
  //     this app, if this machine has one — this is how the one-time move
  //     to Turso actually happens: run `npm start` locally ONCE with
  //     TURSO_DATABASE_URL/TURSO_AUTH_TOKEN set, which connects to the
  //     (empty) Turso database, finds this local file, and imports
  //     everything in it. Note this file never exists in the deployed
  //     Vercel environment (it's gitignored, and lives only on whoever's
  //     machine ran the app locally before) — so on Vercel itself this
  //     branch is always skipped, which is exactly the point: migrate
  //     once from a local machine, then Vercel just reads what's already
  //     in Turso from then on.
  //  2. An even older data/state.json (from the original plain-JSON
  //     version of this app, before local SQLite), same idea.
  //  3. seed-state.json — the original two-invoice template, for a
  //     genuinely fresh install with no prior data anywhere.
  // Only treat LOCAL_DB_FILE as a distinct prior-data source when we're
  // actually connected to Turso right now — in local-file mode LOCAL_DB_FILE
  // *is* the very database being initialized (same path), so checking it
  // here would just read back the empty tables this same call just created.
  const usingTurso = Boolean(process.env.TURSO_DATABASE_URL);

  let seed;
  if (usingTurso && fs.existsSync(LOCAL_DB_FILE)) {
    seed = await readLocalDbFile();
    console.log(
      `Importing existing archive from ${LOCAL_DB_FILE} ` +
      `(${seed.invoices.length} invoice(s), version ${seed.version})...`
    );
  } else if (fs.existsSync(LEGACY_STATE_FILE)) {
    seed = JSON.parse(fs.readFileSync(LEGACY_STATE_FILE, "utf8"));
    console.log(
      `Importing existing archive from ${LEGACY_STATE_FILE} ` +
      `(${seed.invoices.length} invoice(s), version ${seed.version})...`
    );
  } else {
    seed = require("../seed-state.json");
    console.log(`Seeding new archive with ${seed.invoices.length} starter invoice(s)...`);
  }
  const invoices = seed.invoices || [];
  const version = typeof seed.version === "number" ? seed.version : 1;

  const statements = [{ sql: "DELETE FROM invoices", args: [] }];
  invoices.forEach((inv, idx) => statements.push(insertStatement(inv, idx)));
  statements.push({
    sql: "INSERT INTO meta (key, value) VALUES ('version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    args: [String(version)]
  });
  await retryOnBusy(() => client.batch(statements, "write"));
}

// Opens the local data/invoices.db (from the previous local-SQLite version
// of this app) as its own short-lived client, just to read it as a seed
// source for a fresh Turso database — see seedDatabase() above.
async function readLocalDbFile() {
  const localClient = createClient({ url: "file:" + LOCAL_DB_FILE });
  try {
    return await readVersionAndInvoices(localClient);
  } finally {
    localClient.close();
  }
}

function insertStatement(inv, idx) {
  return {
    sql: `INSERT INTO invoices
            (id, sort_order, invoice_no, status, consignee_name, invoice_date, created_at, updated_at, data)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      String(inv.id),
      idx,
      inv.invoiceNo || null,
      inv.status || null,
      inv.consigneeName || null,
      inv.invoiceDate || null,
      typeof inv.createdAt === "number" ? inv.createdAt : null,
      typeof inv.updatedAt === "number" ? inv.updatedAt : null,
      JSON.stringify(inv)
    ]
  };
}

async function readVersionAndInvoices(executor) {
  const [versionRes, invoicesRes] = await Promise.all([
    executor.execute("SELECT value FROM meta WHERE key = 'version'"),
    executor.execute("SELECT data FROM invoices ORDER BY sort_order ASC")
  ]);
  return {
    version: versionRes.rows.length ? parseInt(versionRes.rows[0].value, 10) : 1,
    invoices: invoicesRes.rows.map((r) => JSON.parse(r.data))
  };
}

// ---- public API, used by both server.js and api/state.js ----

async function readState() {
  const client = await getClient();
  return retryOnBusy(() => readVersionAndInvoices(client));
}

// Returns { conflict: true, version, invoices } if `version` is stale, or
// { conflict: false, version, invoices } after a successful save.
//
// Uses an explicit write transaction (SQLite's BEGIN IMMEDIATE under the
// hood) so the version check and the save happen atomically even when
// several requests arrive at once — important on Vercel, where concurrent
// requests are handled by genuinely separate function invocations, not a
// single event loop the way a plain Node server would serialize them.
// A second concurrent writer gets a SQLITE_BUSY error trying to open its
// own write transaction while the first is still open; briefly retried
// (these locks are held for milliseconds), and if it's still busy after
// that, treated the same as a stale-version conflict, since it means
// someone else's save is genuinely in flight right now.
async function writeState(version, invoices) {
  const client = await getClient();

  let tx;
  try {
    tx = await retryOnBusy(() => client.transaction("write"));
  } catch (err) {
    if (isBusyError(err)) {
      const current = await retryOnBusy(() => readVersionAndInvoices(client));
      return Object.assign({ conflict: true }, current);
    }
    throw err;
  }

  try {
    const versionRes = await tx.execute("SELECT value FROM meta WHERE key = 'version'");
    const currentVersion = versionRes.rows.length ? parseInt(versionRes.rows[0].value, 10) : 1;

    if (typeof version !== "number" || version !== currentVersion) {
      const invoicesRes = await tx.execute("SELECT data FROM invoices ORDER BY sort_order ASC");
      await tx.rollback();
      return {
        conflict: true,
        version: currentVersion,
        invoices: invoicesRes.rows.map((r) => JSON.parse(r.data))
      };
    }

    const nextVersion = currentVersion + 1;
    await tx.execute("DELETE FROM invoices");
    for (let idx = 0; idx < invoices.length; idx++) {
      const stmt = insertStatement(invoices[idx], idx);
      await tx.execute(stmt);
    }
    await tx.execute({
      sql: "INSERT INTO meta (key, value) VALUES ('version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      args: [String(nextVersion)]
    });
    await tx.commit();

    return { conflict: false, version: nextVersion, invoices };
  } catch (err) {
    try { await tx.rollback(); } catch (_) { /* transaction may already be closed */ }
    if (isBusyError(err)) {
      const current = await retryOnBusy(() => readVersionAndInvoices(client));
      return Object.assign({ conflict: true }, current);
    }
    throw err;
  }
}

function isBusyError(err) {
  const msg = String((err && err.message) || err || "");
  return msg.includes("SQLITE_BUSY") || msg.includes("database is locked");
}

// SQLITE_BUSY under normal (non-pathological) contention resolves in
// milliseconds — a handful of quick, jittered retries absorbs that instead
// of surfacing an avoidable error to the user. If it's still busy after
// all attempts (many people saving in the same instant), the error
// propagates up and the API returns a plain "try again" failure rather
// than guessing at stale data.
async function retryOnBusy(fn, attempts = 10, baseDelayMs = 50) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      if (!isBusyError(err)) throw err;
      lastErr = err;
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * (i + 1) + Math.floor(Math.random() * 20)));
    }
  }
  throw lastErr;
}

module.exports = { readState, writeState };
