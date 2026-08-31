/**
 * 2MG Invoice Ledger — self-hosted server (for local dev, or hosting this
 * the traditional way on your own server/VPS instead of Vercel)
 *
 * Serves the static frontend (public/) and the same /api/state API that
 * the Vercel deployment uses (api/state.js) — both share lib/db.js, so
 * there's exactly one implementation of the storage/versioning logic.
 *
 *   GET  /api/state   -> { version, invoices }
 *   PUT  /api/state   -> body { version, invoices }
 *                        200 { version, invoices }               on success
 *                        409 { error:"conflict", version, invoices }
 *                          if someone else saved since your last GET —
 *                          adopt the returned version/invoices and retry.
 *
 * Storage: Turso (hosted libSQL) if TURSO_DATABASE_URL is set, otherwise a
 * local SQLite-compatible file at data/invoices.db — see lib/db.js.
 *
 * Run:
 *   npm install
 *   npm start          (defaults to http://localhost:3000)
 *   PORT=8080 npm start
 */

const express = require("express");
const path = require("path");
const fs = require("fs");

loadDotEnvIfPresent();

const { readState, writeState } = require("./lib/db");

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/state", async (req, res) => {
  try {
    const state = await readState();
    res.json(state);
  } catch (err) {
    console.error("GET /api/state failed:", err);
    res.status(500).json({ error: "read_failed" });
  }
});

app.put("/api/state", async (req, res) => {
  const { version, invoices } = req.body || {};
  if (!Array.isArray(invoices)) {
    return res.status(400).json({ error: "invoices must be an array" });
  }

  try {
    const result = await writeState(version, invoices);
    if (result.conflict) {
      return res.status(409).json({ error: "conflict", version: result.version, invoices: result.invoices });
    }
    res.json({ version: result.version, invoices: result.invoices });
  } catch (err) {
    console.error("PUT /api/state failed:", err);
    res.status(500).json({ error: "write_failed" });
  }
});

app.listen(PORT, () => {
  console.log(`2MG Invoice Ledger running at http://localhost:${PORT}`);
});

// Tiny built-in .env loader (no dotenv dependency) so a local .env file with
// TURSO_DATABASE_URL / TURSO_AUTH_TOKEN "just works" with `npm start`,
// regardless of OS/shell — you don't need to know your terminal's
// env-var syntax. Only used locally; Vercel sets its own env vars directly
// and doesn't read this file at all.
function loadDotEnvIfPresent() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf8").split("\n");
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const eq = trimmed.indexOf("=");
    if (eq === -1) return;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  });
}
