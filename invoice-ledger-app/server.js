/**
 * 2MG Invoice Ledger — self-hosted server
 *
 * Serves the static frontend (public/) and a tiny JSON-file-backed API that
 * holds the ONE shared invoice archive everyone in Finance reads and writes.
 *
 *   GET  /api/state   -> { version, invoices }
 *   PUT  /api/state   -> body { version, invoices }
 *                        200 { version, invoices }               on success
 *                        409 { error:"conflict", version, invoices }
 *                          if someone else saved since your last GET —
 *                          adopt the returned version/invoices and retry.
 *
 * Storage is a single JSON file (data/state.json). Writes are serialized
 * in-process (writeQueue) so two overlapping PUTs never corrupt the file,
 * and each write goes to a temp file then renames over the original so a
 * crash mid-write can't leave a half-written file behind.
 *
 * Run:
 *   npm install
 *   npm start          (defaults to http://localhost:3000)
 *   PORT=8080 npm start
 */

const express = require("express");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ---- storage helpers ----

async function ensureStateFile(){
  await fsp.mkdir(DATA_DIR, { recursive: true });
  try {
    await fsp.access(STATE_FILE);
  } catch {
    // First run: seed with the two real historical invoices from the
    // original Excel template, so the archive isn't empty on day one.
    const seed = require("./seed-state.json");
    await writeStateFile(seed);
  }
}

async function readStateFile(){
  const raw = await fsp.readFile(STATE_FILE, "utf8");
  return JSON.parse(raw);
}

async function writeStateFile(state){
  const tmp = STATE_FILE + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await fsp.rename(tmp, STATE_FILE);
}

// Serializes writes so concurrent PUTs can't interleave and corrupt the file.
let writeQueue = Promise.resolve();
function withWriteLock(fn){
  const result = writeQueue.then(fn, fn);
  // swallow errors here so one failed write doesn't wedge the queue forever
  writeQueue = result.catch(() => {});
  return result;
}

// ---- routes ----

app.get("/api/state", async (req, res) => {
  try {
    const state = await readStateFile();
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
    const result = await withWriteLock(async () => {
      const current = await readStateFile();
      if (typeof version !== "number" || version !== current.version) {
        // stale write — someone else saved first
        return { conflict: true, current };
      }
      const next = { version: current.version + 1, invoices };
      await writeStateFile(next);
      return { conflict: false, next };
    });

    if (result.conflict) {
      return res.status(409).json({
        error: "conflict",
        version: result.current.version,
        invoices: result.current.invoices
      });
    }
    res.json(result.next);
  } catch (err) {
    console.error("PUT /api/state failed:", err);
    res.status(500).json({ error: "write_failed" });
  }
});

// ---- boot ----

ensureStateFile()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`2MG Invoice Ledger running at http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Failed to initialize data/state.json:", err);
    process.exit(1);
  });
