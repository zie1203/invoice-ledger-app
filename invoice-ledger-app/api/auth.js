/**
 * Vercel serverless function for authentication.
 *
 * Deployed at /api/auth (file-based routing: this file's path IS the route).
 * All of the logic lives in lib/auth.js, which server.js also uses, so there is
 * exactly one implementation of the auth behavior across both deployment paths.
 *
 *   GET    /api/auth  -> 200 { authenticated: boolean }
 *   POST   /api/auth  -> body { passphrase }
 *                        200 { authenticated: true } + Set-Cookie  on success
 *                        401 { error: "invalid_passphrase" }       on failure
 *   DELETE /api/auth  -> 200 { authenticated: false } + cleared cookie
 *
 * This is the ONE endpoint under /api that does not require an existing
 * session — it is how a session is established and checked in the first place.
 * It never reveals the passphrase, its hash, or the session secret.
 */

const { handleAuthRequest } = require("../lib/auth");

module.exports = async (req, res) => {
  await handleAuthRequest(req, res);
};
