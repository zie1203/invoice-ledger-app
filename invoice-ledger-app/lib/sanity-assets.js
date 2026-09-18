/**
 * Sanity file-asset storage for encrypted invoice attachments.
 *
 * Sanity is used here as a dumb blob store for CIPHERTEXT ONLY. It never sees
 * a plaintext PDF, a real filename, an invoice number, a consignee, or any
 * other Finance data. Sanity asset files are publicly reachable regardless of
 * dataset privacy, so the confidentiality of the document rests entirely on
 * the AES-256-GCM encryption in lib/attachment-crypto.js — never on the
 * dataset being private, and never on a URL being hard to guess.
 *
 * All credentials come from environment variables and stay server-side. The
 * browser never receives the project id, dataset, token, or asset URL.
 *
 *   SANITY_PROJECT_ID    e.g. "abcd1234"
 *   SANITY_DATASET       e.g. "development"
 *   SANITY_API_VERSION   e.g. "v2021-06-07"   (dated, "v" + YYYY-MM-DD)
 *   SANITY_WRITE_TOKEN   an Editor (read+write) robot token
 *
 * HTTP calls made by this module (and no others):
 *
 *   upload  POST https://{projectId}.api.sanity.io/{apiVersion}/assets/files/{dataset}?filename={neutral}
 *           Authorization: Bearer <token>
 *           Content-Type: application/octet-stream
 *           body: the 2MGENC ciphertext blob
 *
 *   resolve GET  https://{projectId}.api.sanity.io/{apiVersion}/data/query/{dataset}?query=...&$id=...
 *           Authorization: Bearer <token>
 *           (GROQ lookup of the asset document's url by _id)
 *
 *   fetch   GET  <the asset url returned above>
 *           no Authorization header - the asset is public ciphertext
 *
 *   delete  POST https://{projectId}.api.sanity.io/{apiVersion}/data/mutate/{dataset}
 *           Authorization: Bearer <token>
 *           body: {"mutations":[{"delete":{"id":"<assetId>"}}]}
 *
 * The token is never logged, never included in an error message, and never
 * returned to a caller.
 */

const { isSealedBlob } = require("./attachment-crypto");

const API_HOST_SUFFIX = ".api.sanity.io";

class SanityAssetError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SanityAssetError";
    this.code = code;
  }
}

function requireEnv(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new SanityAssetError("CONFIG_MISSING", name + " is not set");
  }
  return value;
}

function config() {
  const projectId = requireEnv("SANITY_PROJECT_ID");
  const dataset = requireEnv("SANITY_DATASET");
  const apiVersion = requireEnv("SANITY_API_VERSION");
  const token = requireEnv("SANITY_WRITE_TOKEN");

  // Shape checks only — these values go straight into a URL, so reject
  // anything that could alter the request path.
  if (!/^[a-z0-9-]+$/i.test(projectId)) {
    throw new SanityAssetError("CONFIG_INVALID", "SANITY_PROJECT_ID has an unexpected format");
  }
  if (!/^[a-z0-9_-]+$/i.test(dataset)) {
    throw new SanityAssetError("CONFIG_INVALID", "SANITY_DATASET has an unexpected format");
  }
  if (!/^v\d{4}-\d{2}-\d{2}$/.test(apiVersion)) {
    throw new SanityAssetError(
      "CONFIG_INVALID",
      'SANITY_API_VERSION must look like "v2021-06-07"'
    );
  }

  return { projectId, dataset, apiVersion, token };
}

function apiBase(cfg) {
  return "https://" + cfg.projectId + API_HOST_SUFFIX + "/" + cfg.apiVersion;
}

function authHeaders(cfg) {
  return { Authorization: "Bearer " + cfg.token };
}

// Neutral by construction: carries no customer name, invoice number, or
// original filename. Sanity stores whatever filename it is given on the asset
// document, so this is the only name it ever learns.
function neutralFilename(attachmentId) {
  return "att-" + String(attachmentId).replace(/[^a-z0-9]/gi, "") + ".bin";
}

// Keeps a failed response readable in logs without risking echoing anything
// sensitive back out.
async function describeFailure(res) {
  let detail = "";
  try {
    detail = (await res.text()).slice(0, 300);
  } catch (e) {
    detail = "(no body)";
  }
  return "HTTP " + res.status + " " + detail;
}

/* -------------------------------- upload --------------------------------- */

async function uploadCiphertext(blob, opts) {
  opts = opts || {};

  // HARD GUARD. This is the single choke point where bytes leave the process
  // for Sanity, and nothing that is not a sealed 2MGENC blob gets past it. A
  // plaintext PDF starts with "%PDF-" and therefore always fails this check.
  if (!isSealedBlob(blob)) {
    throw new SanityAssetError(
      "NOT_ENCRYPTED",
      "refusing to upload: payload is not a sealed 2MGENC blob"
    );
  }

  const cfg = config();
  const filename = neutralFilename(opts.attachmentId || "unnamed");
  const url = apiBase(cfg) + "/assets/files/" + cfg.dataset +
    "?filename=" + encodeURIComponent(filename);

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/octet-stream" }, authHeaders(cfg)),
      body: blob
    });
  } catch (e) {
    throw new SanityAssetError("NETWORK", "could not reach Sanity: " + e.message);
  }

  if (!res.ok) {
    throw new SanityAssetError("UPLOAD_FAILED", "Sanity upload failed: " + (await describeFailure(res)));
  }

  let json;
  try {
    json = await res.json();
  } catch (e) {
    throw new SanityAssetError("UPLOAD_FAILED", "Sanity upload returned an unreadable response");
  }

  const doc = json && json.document;
  if (!doc || !doc._id) {
    throw new SanityAssetError("UPLOAD_FAILED", "Sanity upload response had no asset document");
  }

  return {
    assetId: doc._id,
    url: doc.url,
    size: doc.size,
    mimeType: doc.mimeType,
    originalFilename: doc.originalFilename
  };
}

/* --------------------------------- fetch --------------------------------- */

async function resolveAssetUrl(assetId) {
  if (typeof assetId !== "string" || assetId.length === 0) {
    throw new SanityAssetError("BAD_INPUT", "assetId is required");
  }
  const cfg = config();
  const query = "*[_id == $id][0].url";
  const url = apiBase(cfg) + "/data/query/" + cfg.dataset +
    "?query=" + encodeURIComponent(query) +
    "&$id=" + encodeURIComponent(JSON.stringify(assetId));

  let res;
  try {
    res = await fetch(url, { headers: authHeaders(cfg) });
  } catch (e) {
    throw new SanityAssetError("NETWORK", "could not reach Sanity: " + e.message);
  }
  if (!res.ok) {
    throw new SanityAssetError("QUERY_FAILED", "Sanity query failed: " + (await describeFailure(res)));
  }

  const json = await res.json();
  const assetUrl = json && json.result;
  if (typeof assetUrl !== "string" || assetUrl.length === 0) {
    throw new SanityAssetError("NOT_FOUND", "no asset found for that id");
  }
  return assetUrl;
}

async function fetchCiphertext(assetId) {
  const assetUrl = await resolveAssetUrl(assetId);

  let res;
  try {
    // No Authorization header: this is the public asset CDN, and what it
    // serves is ciphertext by construction.
    res = await fetch(assetUrl);
  } catch (e) {
    throw new SanityAssetError("NETWORK", "could not download asset: " + e.message);
  }
  if (!res.ok) {
    throw new SanityAssetError("DOWNLOAD_FAILED", "asset download failed: " + (await describeFailure(res)));
  }

  const blob = Buffer.from(await res.arrayBuffer());

  // What comes back must still be one of our sealed blobs. If it is not, some
  // other asset was served — fail rather than hand it to the decryptor.
  if (!isSealedBlob(blob)) {
    throw new SanityAssetError("NOT_ENCRYPTED", "downloaded asset is not a 2MGENC blob");
  }
  return blob;
}

/* -------------------------------- delete --------------------------------- */

async function deleteAsset(assetId) {
  if (typeof assetId !== "string" || assetId.length === 0) {
    throw new SanityAssetError("BAD_INPUT", "assetId is required");
  }
  const cfg = config();
  const url = apiBase(cfg) + "/data/mutate/" + cfg.dataset;

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, authHeaders(cfg)),
      body: JSON.stringify({ mutations: [{ delete: { id: assetId } }] })
    });
  } catch (e) {
    throw new SanityAssetError("NETWORK", "could not reach Sanity: " + e.message);
  }
  if (!res.ok) {
    throw new SanityAssetError("DELETE_FAILED", "Sanity delete failed: " + (await describeFailure(res)));
  }
  return true;
}

module.exports = {
  SanityAssetError,
  neutralFilename,
  uploadCiphertext,
  resolveAssetUrl,
  fetchCiphertext,
  deleteAsset,
  // exported for configuration self-checks; never returns the token itself
  describeConfig: function () {
    const cfg = config();
    return {
      projectId: cfg.projectId,
      dataset: cfg.dataset,
      apiVersion: cfg.apiVersion,
      tokenPresent: cfg.token.length > 0
    };
  }
};
