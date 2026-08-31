/**
 * Vercel serverless function for the shared invoice archive.
 *
 * Deployed at /api/state (file-based routing: this file's path IS the
 * route). Handles the exact same GET/PUT contract the app has always used
 * — see lib/db.js for the storage logic itself and the version-conflict
 * behavior.
 *
 *   GET  /api/state  -> { version, invoices }
 *   PUT  /api/state  -> body { version, invoices }
 *                       200 { version, invoices }             on success
 *                       409 { error:"conflict", version, invoices }
 *                         if someone else saved since your last GET
 */

const { readState, writeState } = require("../lib/db");

module.exports = async (req, res) => {
  if (req.method === "GET") {
    try {
      const state = await readState();
      res.status(200).json(state);
    } catch (err) {
      console.error("GET /api/state failed:", err);
      res.status(500).json({ error: "read_failed" });
    }
    return;
  }

  if (req.method === "PUT") {
    const { version, invoices } = req.body || {};
    if (!Array.isArray(invoices)) {
      res.status(400).json({ error: "invoices must be an array" });
      return;
    }

    try {
      const result = await writeState(version, invoices);
      if (result.conflict) {
        res.status(409).json({ error: "conflict", version: result.version, invoices: result.invoices });
      } else {
        res.status(200).json({ version: result.version, invoices: result.invoices });
      }
    } catch (err) {
      console.error("PUT /api/state failed:", err);
      res.status(500).json({ error: "write_failed" });
    }
    return;
  }

  res.status(405).json({ error: "method_not_allowed" });
};
