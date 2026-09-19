/**
 * Shared-passphrase authentication for the 2MG Invoice Ledger.
 *
 * One passphrase is shared by the Finance team. The passphrase itself is never
 * stored anywhere on the server — only a salted scrypt hash of it, in the
 * APP_PASSPHRASE_HASH environment variable. A successful login sets a signed,
 * HttpOnly session cookie; every /api/* request is then authorised by verifying
 * that cookie's HMAC signature and its expiry.
 *
 * Nothing in this file is ever sent to the browser: not the passphrase, not the
 * hash, not the session secret. The client only ever learns
 * `{ authenticated: true|false }` and receives the cookie, which it cannot read
 * because the cookie is HttpOnly.
 *
 * Used by BOTH deployment paths — api/auth.js (Vercel function) and server.js
 * (local/self-hosted Express) — so there is exactly one implementation of the
 * auth logic. Everything here works against plain Node IncomingMessage /
 * ServerResponse objects, so it behaves identically whether Vercel invokes an
 * /api function (which adds req.body/req.cookies helpers) or captures server.js
 * as a Node server (which does not).
 *
 * ---------------------------------------------------------------------------
 * APP_PASSPHRASE_HASH — exact encoding
 * ---------------------------------------------------------------------------
 *
 *   scrypt$<N>$<r>$<p>$<salt>$<hash>
 *
 *   scrypt  literal algorithm tag — only "scrypt" is accepted
 *   N       CPU/memory cost, power of two              e.g. 16384
 *   r       block size                                  e.g. 8
 *   p       parallelisation                             e.g. 1
 *   salt    16 random bytes, base64url, unpadded    -> 22 characters
 *   hash    32-byte scrypt output, base64url, unpadded -> 43 characters
 *
 * Exactly six "$"-separated fields, no spaces, no padding "=" characters.
 * Shape example (NOT a real value — all-zero bytes, never use this):
 *
 *   scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
 *
 * The salt is random per hash and is carried inside the string itself, so the
 * SAME passphrase produces a DIFFERENT APP_PASSPHRASE_HASH every time it is
 * generated. That is expected and correct — do not treat the hash as a constant
 * fingerprint of the passphrase.
 *
 * To generate a value later (run locally; never commit the output, and never
 * paste a real passphrase into a shared terminal or chat):
 *
 *   node -e "const c=require('crypto');const p=process.argv[1];const s=c.randomBytes(16);const N=16384,r=8,pp=1;const h=c.scryptSync(Buffer.from(p,'utf8'),s,32,{N:N,r:r,p:pp,maxmem:256*1024*1024});const b=x=>x.toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');console.log('scrypt$'+N+'$'+r+'$'+pp+'$'+b(s)+'$'+b(h))" "THE PASSPHRASE"
 *
 * ---------------------------------------------------------------------------
 * APP_SESSION_SECRET
 * ---------------------------------------------------------------------------
 * Any high-entropy string — 32+ random bytes, hex or base64url. Used only as
 * the HMAC-SHA256 key for session cookies. Changing it immediately invalidates
 * every existing session, which is the intended "sign everybody out" lever.
 *
 * If either variable is missing the server FAILS CLOSED: no session can be
 * created and no request is authorised. It answers 503 rather than 401 so the
 * operator can tell a misconfigured server from a wrong passphrase.
 */

const crypto = require("crypto");

const SESSION_COOKIE = "ledger_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // explicit 12-hour expiry

function isConfigured() {
  return Boolean(process.env.APP_SESSION_SECRET && process.env.APP_PASSPHRASE_HASH);
}

/* ------------------------------- encoding -------------------------------- */

function b64urlEncode(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str) {
  let s = String(str).replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Buffer.from(s, "base64");
}

/* ------------------------------ passphrase ------------------------------- */

// Returns true only for an exact match. Comparison is timing-safe, and every
// malformed-input path returns false rather than throwing, so a corrupt
// APP_PASSPHRASE_HASH denies access instead of crashing the endpoint.
function verifyPassphrase(passphrase) {
  if (typeof passphrase !== "string" || passphrase.length === 0) return false;

  const parts = String(process.env.APP_PASSPHRASE_HASH || "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const N = parseInt(parts[1], 10);
  const r = parseInt(parts[2], 10);
  const p = parseInt(parts[3], 10);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (N < 2 || (N & (N - 1)) !== 0 || r < 1 || p < 1) return false;

  let salt, expected;
  try {
    salt = b64urlDecode(parts[4]);
    expected = b64urlDecode(parts[5]);
  } catch (e) {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  let actual;
  try {
    actual = crypto.scryptSync(Buffer.from(passphrase, "utf8"), salt, expected.length, {
      N: N, r: r, p: p, maxmem: 256 * 1024 * 1024
    });
  } catch (e) {
    return false;
  }

  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

/* -------------------------------- session -------------------------------- */

function signPayload(payload) {
  return crypto.createHmac("sha256", String(process.env.APP_SESSION_SECRET))
    .update(payload, "utf8")
    .digest();
}

// Cookie value is "<expiryMs>.<base64url(HMAC-SHA256(expiryMs))>". The expiry
// is inside the signed payload, so a client cannot extend its own session.
function createSessionValue(nowMs) {
  const exp = String((typeof nowMs === "number" ? nowMs : Date.now()) + SESSION_TTL_MS);
  return exp + "." + b64urlEncode(signPayload(exp));
}

function verifySessionValue(value) {
  if (!isConfigured()) return false;
  if (typeof value !== "string") return false;

  const dot = value.lastIndexOf(".");
  if (dot <= 0) return false;

  const payload = value.slice(0, dot);
  if (!/^[0-9]+$/.test(payload)) return false;

  let provided;
  try {
    provided = b64urlDecode(value.slice(dot + 1));
  } catch (e) {
    return false;
  }

  const expected = signPayload(payload);
  if (provided.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(provided, expected)) return false;

  const exp = Number(payload);
  return Number.isFinite(exp) && Date.now() < exp;
}

/* --------------------------- request / response --------------------------- */

// Parsed from the raw header rather than req.cookies, because req.cookies only
// exists for Vercel /api functions — not for Express, and not for a captured
// Node server.
function readCookie(req, name) {
  const header = (req && req.headers && req.headers.cookie) || "";
  const parts = header.split(";");
  for (let i = 0; i < parts.length; i++) {
    const eq = parts[i].indexOf("=");
    if (eq === -1) continue;
    if (parts[i].slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(parts[i].slice(eq + 1).trim());
    } catch (e) {
      return null;
    }
  }
  return null;
}

// A "Secure" cookie is silently dropped by browsers over plain http://, which
// would make local development impossible. So Secure is set only when the
// request is genuinely running over HTTPS (or on Vercel / NODE_ENV=production,
// which always are).
function isSecureRequest(req) {
  if (process.env.VERCEL) return true;
  if (String(process.env.NODE_ENV).toLowerCase() === "production") return true;
  const proto = req && req.headers && req.headers["x-forwarded-proto"];
  if (typeof proto === "string" && proto.split(",")[0].trim() === "https") return true;
  return Boolean(req && req.socket && req.socket.encrypted);
}

function setSessionCookie(req, res, value, maxAgeSeconds) {
  const bits = [
    SESSION_COOKIE + "=" + encodeURIComponent(value),
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=" + maxAgeSeconds
  ];
  if (isSecureRequest(req)) bits.push("Secure");
  res.setHeader("Set-Cookie", bits.join("; "));
}

function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
}

function sendUnauthorized(res) {
  sendJson(res, 401, { error: "unauthorized" });
}

function sendNotConfigured(res) {
  sendJson(res, 503, { error: "auth_not_configured" });
}

// The single authorisation check used by every protected endpoint.
function requireSession(req) {
  return verifySessionValue(readCookie(req, SESSION_COOKIE));
}

// Reads a small JSON body across all three runtimes: already-parsed object
// (Express express.json / Vercel helper), a string or Buffer, or an unconsumed
// stream (captured Node server). Capped so an unauthenticated caller cannot
// stream an unbounded body at the login endpoint.
function readJsonBody(req) {
  return new Promise(function (resolve) {
    let existing;
    try {
      // On Vercel req.body is a lazy getter that throws on malformed JSON.
      existing = req.body;
    } catch (e) {
      return resolve(null);
    }

    if (existing && typeof existing === "object" && !Buffer.isBuffer(existing)) {
      return resolve(existing);
    }
    if (typeof existing === "string" || Buffer.isBuffer(existing)) {
      try {
        return resolve(JSON.parse(existing.toString()));
      } catch (e) {
        return resolve(null);
      }
    }

    let raw = "";
    let tooBig = false;
    req.on("data", function (chunk) {
      if (tooBig) return;
      raw += chunk;
      if (raw.length > 64 * 1024) { tooBig = true; raw = ""; }
    });
    req.on("end", function () {
      if (tooBig || !raw) return resolve(null);
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        resolve(null);
      }
    });
    req.on("error", function () { resolve(null); });
  });
}

/* ------------------------------- endpoint -------------------------------- */

// GET    -> { authenticated: boolean }   (no session required; this is how the
//                                         client decides whether to show login)
// POST   -> { passphrase } -> sets cookie on success, 401 on failure
// DELETE -> clears the cookie
async function handleAuthRequest(req, res) {
  const method = String(req.method || "GET").toUpperCase();

  if (!isConfigured()) {
    console.error(
      "Auth is not configured: APP_SESSION_SECRET and/or APP_PASSPHRASE_HASH is missing. " +
      "All API requests will be refused until both are set."
    );
    return sendNotConfigured(res);
  }

  if (method === "GET") {
    return sendJson(res, 200, { authenticated: requireSession(req) });
  }

  if (method === "POST") {
    const body = await readJsonBody(req);
    const passphrase = body && typeof body.passphrase === "string" ? body.passphrase : "";
    if (!verifyPassphrase(passphrase)) {
      return sendJson(res, 401, { error: "invalid_passphrase" });
    }
    setSessionCookie(req, res, createSessionValue(Date.now()), Math.floor(SESSION_TTL_MS / 1000));
    return sendJson(res, 200, { authenticated: true });
  }

  if (method === "DELETE") {
    setSessionCookie(req, res, "", 0);
    return sendJson(res, 200, { authenticated: false });
  }

  return sendJson(res, 405, { error: "method_not_allowed" });
}

module.exports = {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  isConfigured,
  requireSession,
  sendUnauthorized,
  sendNotConfigured,
  handleAuthRequest,
  // exported for future endpoints (attachments) and for tests
  readJsonBody,
  sendJson
};
