/**
 * Authenticated HTTP surface for persistent invoice attachments.
 *
 * Shared by BOTH runtimes — api/attachments.js (Vercel function) and server.js
 * (local/self-hosted Express) — so there is exactly one implementation of the
 * behavior. It works against plain Node IncomingMessage / ServerResponse, and
 * reads the request body in a way that is correct whether Vercel pre-parsed it
 * into a Buffer, Express left the stream untouched, or a captured Node server
 * provided neither helper.
 *
 *   POST   /api/attachments?invoiceId=<id>
 *          body: raw PDF bytes, Content-Type: application/octet-stream
 *          -> 201 { attachmentId, assetId, encVersion, pageCount, byteSize, uploadedAt }
 *
 *   GET    /api/attachments?invoiceId=<id>
 *          -> 200 application/pdf  (decrypted bytes)
 *
 *   DELETE /api/attachments?assetId=<id>
 *          -> 200 { deleted: true }
 *
 * SECURITY PROPERTIES
 *
 *  - Every method requires a valid session (Checkpoint 1). Fails closed if auth
 *    is not configured.
 *  - The browser never receives the Sanity token, the Sanity asset URL, or the
 *    encryption key. It sends plaintext PDF bytes up, and receives plaintext
 *    PDF bytes back; everything in between is server-side only.
 *  - GET resolves the assetId and attachmentId from the CURRENT invoice state
 *    on the server. The client supplies only an invoiceId, so it cannot ask for
 *    an arbitrary asset, and cannot influence the AAD used to decrypt.
 *  - DELETE refuses to remove an asset that any invoice still references, so a
 *    live invoice can never be left pointing at a deleted file.
 */

const { requireSession, sendUnauthorized, isConfigured, sendNotConfigured, sendJson } = require("./auth");
const { readState } = require("./db");
const {
  storeAttachment, loadAttachment, removeAttachment, MAX_PLAINTEXT_BYTES
} = require("./attachment-service");

/* ------------------------------ request I/O ------------------------------- */

function getQuery(req) {
  // Express and Vercel both provide req.query; a captured Node server does not.
  if (req && req.query && typeof req.query === "object") return req.query;
  try {
    return Object.fromEntries(new URL(req.url, "http://localhost").searchParams);
  } catch (e) {
    return {};
  }
}

function readBinaryBody(req, maxBytes) {
  return new Promise(function (resolve, reject) {
    let existing;
    try {
      // On Vercel, application/octet-stream arrives here already as a Buffer.
      existing = req.body;
    } catch (e) {
      existing = undefined;
    }

    if (Buffer.isBuffer(existing)) {
      if (existing.length > maxBytes) return reject(makeTooLarge());
      return resolve(existing);
    }
    if (typeof existing === "string" && existing.length > 0) {
      const buf = Buffer.from(existing, "binary");
      if (buf.length > maxBytes) return reject(makeTooLarge());
      return resolve(buf);
    }

    // Express (express.json ignores octet-stream, so the stream is untouched)
    // and captured Node servers land here.
    const chunks = [];
    let total = 0;
    let aborted = false;
    req.on("data", function (chunk) {
      if (aborted) return;
      total += chunk.length;
      if (total > maxBytes) {
        aborted = true;
        reject(makeTooLarge());
        try { req.destroy(); } catch (e) { /* already closing */ }
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", function () {
      if (!aborted) resolve(Buffer.concat(chunks, total));
    });
    req.on("error", function (err) {
      if (!aborted) reject(err);
    });
  });
}

function makeTooLarge() {
  const e = new Error("the PDF exceeds the maximum size of " + MAX_PLAINTEXT_BYTES + " bytes");
  e.code = "TOO_LARGE";
  return e;
}

function sendPdf(res, bytes) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Length", String(bytes.length));
  // Attachments are Finance documents: never let a proxy or the browser keep a
  // decrypted copy.
  res.setHeader("Cache-Control", "no-store, private");
  res.end(bytes);
}

// Maps a thrown error onto an HTTP status without leaking internals. Validation
// problems are the caller's fault (4xx); Sanity problems are ours (502).
function sendError(res, err, context) {
  const code = (err && err.code) || "";
  if (code === "TOO_LARGE") {
    return sendJson(res, 413, { error: code, message: err.message });
  }
  if (["EMPTY", "NOT_PDF", "CORRUPT_PDF", "ENCRYPTED_PDF", "NO_PAGES", "BAD_INPUT"].indexOf(code) !== -1) {
    return sendJson(res, 400, { error: code, message: err.message });
  }
  if (["NETWORK", "UPLOAD_FAILED", "QUERY_FAILED", "DOWNLOAD_FAILED", "DELETE_FAILED",
    "NOT_FOUND", "NOT_ENCRYPTED"].indexOf(code) !== -1) {
    console.error(context + " (sanity):", code, err.message);
    return sendJson(res, 502, { error: "storage_unavailable" });
  }
  if (["AUTH_FAILED", "MAGIC_MISMATCH", "TRUNCATED_BLOB", "UNSUPPORTED_VERSION",
    "KEY_MISSING", "KEY_INVALID", "BAD_AAD"].indexOf(code) !== -1) {
    console.error(context + " (crypto):", code, err.message);
    return sendJson(res, 500, { error: "decryption_failed" });
  }
  console.error(context + ":", err && err.stack ? err.stack : err);
  return sendJson(res, 500, { error: "internal_error" });
}

/* -------------------------------- handlers -------------------------------- */

async function handleUpload(req, res, query) {
  const invoiceId = query.invoiceId;
  if (typeof invoiceId !== "string" || invoiceId.length === 0) {
    return sendJson(res, 400, { error: "BAD_INPUT", message: "invoiceId is required" });
  }

  let plaintext;
  try {
    plaintext = await readBinaryBody(req, MAX_PLAINTEXT_BYTES);
  } catch (err) {
    return sendError(res, err, "POST /api/attachments");
  }

  try {
    // validate -> encrypt -> upload. Server validation is authoritative; the
    // client's own checks are only there to give a faster error message.
    const meta = await storeAttachment({ invoiceId: invoiceId, plaintext: plaintext });
    return sendJson(res, 201, meta);
  } catch (err) {
    return sendError(res, err, "POST /api/attachments");
  }
}

async function handleDownload(req, res, query) {
  const invoiceId = query.invoiceId;
  if (typeof invoiceId !== "string" || invoiceId.length === 0) {
    return sendJson(res, 400, { error: "BAD_INPUT", message: "invoiceId is required" });
  }

  try {
    // Resolve from server-side state, never from client input.
    const state = await readState();
    const inv = (state.invoices || []).find(function (i) { return i && i.id === invoiceId; });
    if (!inv) {
      return sendJson(res, 404, { error: "invoice_not_found" });
    }
    const att = inv.attachment;
    if (!att || !att.assetId || !att.attachmentId) {
      return sendJson(res, 404, { error: "no_attachment" });
    }

    const pdf = await loadAttachment({
      assetId: att.assetId,
      invoiceId: invoiceId,
      attachmentId: att.attachmentId
    });
    return sendPdf(res, pdf);
  } catch (err) {
    return sendError(res, err, "GET /api/attachments");
  }
}

async function handleDelete(req, res, query) {
  const assetId = query.assetId;
  if (typeof assetId !== "string" || assetId.length === 0) {
    return sendJson(res, 400, { error: "BAD_INPUT", message: "assetId is required" });
  }

  try {
    // Refuse to orphan a live invoice. The client is expected to save the
    // invoice WITHOUT the attachment first; only then is the asset deletable.
    const state = await readState();
    const stillReferenced = (state.invoices || []).some(function (i) {
      return i && i.attachment && i.attachment.assetId === assetId;
    });
    if (stillReferenced) {
      return sendJson(res, 409, {
        error: "still_referenced",
        message: "an invoice still references this attachment; save the invoice without it first"
      });
    }

    await removeAttachment(assetId);
    return sendJson(res, 200, { deleted: true });
  } catch (err) {
    return sendError(res, err, "DELETE /api/attachments");
  }
}

/* -------------------------------- entry ----------------------------------- */

async function handleAttachmentRequest(req, res) {
  if (!isConfigured()) return sendNotConfigured(res);
  if (!requireSession(req)) return sendUnauthorized(res);

  const method = String(req.method || "GET").toUpperCase();
  const query = getQuery(req);

  if (method === "POST") return handleUpload(req, res, query);
  if (method === "GET") return handleDownload(req, res, query);
  if (method === "DELETE") return handleDelete(req, res, query);
  return sendJson(res, 405, { error: "method_not_allowed" });
}

module.exports = {
  handleAttachmentRequest,
  // exported for tests
  readBinaryBody,
  getQuery
};
