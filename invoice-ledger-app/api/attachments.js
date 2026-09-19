/**
 * Vercel serverless function for persistent invoice attachments.
 *
 * Deployed at /api/attachments (file-based routing: this file's path IS the
 * route). All logic lives in lib/attachment-api.js, which server.js also uses,
 * so there is exactly one implementation across both deployment paths.
 *
 *   POST   /api/attachments?invoiceId=<id>   raw PDF bytes -> encrypted upload
 *   GET    /api/attachments?invoiceId=<id>   -> decrypted PDF bytes
 *   DELETE /api/attachments?assetId=<id>     -> remove the stored asset
 *
 * Every method requires a valid session. The browser never receives the Sanity
 * token, the asset URL, or the encryption key.
 */

const { handleAttachmentRequest } = require("../lib/attachment-api");

module.exports = async (req, res) => {
  await handleAttachmentRequest(req, res);
};
