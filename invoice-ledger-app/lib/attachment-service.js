/**
 * Attachment core: validate -> encrypt -> store, and retrieve -> decrypt.
 *
 * This is the only place that sequences the three concerns, and it is
 * deliberately runtime-agnostic: it takes Buffers and plain options and knows
 * nothing about Express, Vercel, req or res. The HTTP adapters come later.
 *
 * SERVER VALIDATION IS AUTHORITATIVE. The browser also validates before
 * uploading, but only to give the user a fast, specific error. Nothing the
 * client claims is trusted here: size, signature, parseability, encryption
 * status and page count are all re-checked on these bytes.
 *
 * Ordering guarantee: a PDF is validated BEFORE it is encrypted, and encrypted
 * BEFORE anything is sent to Sanity. lib/sanity-assets.js additionally refuses
 * any payload that is not a sealed 2MGENC blob, so plaintext cannot reach
 * Sanity even if this sequence were changed by mistake.
 */

const { PDFDocument } = require("pdf-lib");
const {
  newAttachmentId, sealAttachment, openAttachment, describeBlob
} = require("./attachment-crypto");
const { uploadCiphertext, fetchCiphertext, deleteAsset } = require("./sanity-assets");

// Deliberately below Vercel's 4.5 MB request/response ceiling, which applies
// to the upload AND to the decrypted download.
const MAX_PLAINTEXT_BYTES = 4000000;

class AttachmentValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AttachmentValidationError";
    this.code = code;
  }
}

// The PDF spec allows the %PDF- header anywhere in the first 1024 bytes, so
// scan that window rather than testing only offset 0.
function hasPdfSignature(bytes) {
  const limit = Math.min(bytes.length, 1024);
  for (let i = 0; i + 4 < limit; i++) {
    if (bytes[i] === 0x25 && bytes[i + 1] === 0x50 && bytes[i + 2] === 0x44 &&
      bytes[i + 3] === 0x46 && bytes[i + 4] === 0x2D) return true;
  }
  return false;
}

/**
 * Authoritative server-side PDF validation.
 * Resolves to { pageCount } or throws AttachmentValidationError.
 */
async function validatePdf(bytes) {
  if (!Buffer.isBuffer(bytes)) {
    throw new AttachmentValidationError("BAD_INPUT", "expected a Buffer of PDF bytes");
  }
  if (bytes.length === 0) {
    throw new AttachmentValidationError("EMPTY", "the uploaded file is empty");
  }
  if (bytes.length > MAX_PLAINTEXT_BYTES) {
    throw new AttachmentValidationError(
      "TOO_LARGE",
      "the PDF is " + bytes.length + " bytes; the maximum is " + MAX_PLAINTEXT_BYTES
    );
  }
  if (!hasPdfSignature(bytes)) {
    throw new AttachmentValidationError("NOT_PDF", "the uploaded file is not a PDF");
  }

  // Both the load AND the structural inspection have to sit inside this try.
  // pdf-lib is lenient: it will happily "recover" a badly damaged file far
  // enough to hand back a PDFDocument whose page tree is still unusable, and
  // the failure then surfaces later as a raw TypeError from getPageCount() or
  // getPage(). Left outside the catch, that escapes as an untyped error and
  // would become a 500 instead of a clean rejection.
  let pageCount;
  try {
    // No ignoreEncryption: a password-protected PDF must fail HERE, while the
    // user is still uploading, rather than at export time when Finance is
    // trying to send the document.
    const doc = await PDFDocument.load(bytes);
    pageCount = doc.getPageCount();
    // Touching a page is what actually proves the page tree is readable, and
    // it is the same thing the export merge (copyPages) will do later. Skipped
    // when there are no pages, so the NO_PAGES case keeps its own error below.
    if (pageCount > 0) doc.getPage(0);
  } catch (e) {
    const name = e && e.name;
    const msg = String((e && e.message) || "");
    if (name === "EncryptedPDFError" || /encrypted/i.test(msg)) {
      throw new AttachmentValidationError(
        "ENCRYPTED_PDF",
        "the PDF is password-protected or encrypted; please supply an unprotected copy"
      );
    }
    throw new AttachmentValidationError("CORRUPT_PDF", "the PDF could not be parsed; it may be corrupt");
  }

  // Deliberately outside the try, so this intentional rejection can never be
  // re-wrapped as CORRUPT_PDF.
  if (!Number.isInteger(pageCount) || pageCount < 1) {
    throw new AttachmentValidationError("NO_PAGES", "the PDF contains no pages");
  }

  return { pageCount };
}

/**
 * validate -> encrypt -> upload.
 * Returns the metadata that will later live inside the invoice JSON. Note what
 * is absent: no filename, no plaintext, no key material, no Sanity URL.
 */
async function storeAttachment(opts) {
  opts = opts || {};
  const invoiceId = opts.invoiceId;
  const plaintext = opts.plaintext;

  if (typeof invoiceId !== "string" || invoiceId.length === 0) {
    throw new AttachmentValidationError("BAD_INPUT", "invoiceId is required");
  }

  const { pageCount } = await validatePdf(plaintext);

  const attachmentId = newAttachmentId();
  const blob = sealAttachment({ plaintext, invoiceId, attachmentId });
  const uploaded = await uploadCiphertext(blob, { attachmentId });

  return {
    attachmentId: attachmentId,
    assetId: uploaded.assetId,
    encVersion: describeBlob(blob).version,
    pageCount: pageCount,
    byteSize: plaintext.length,
    uploadedAt: Date.now()
  };
}

/**
 * retrieve -> decrypt.
 * `invoiceId` and `attachmentId` must be the ones the blob was sealed with, or
 * GCM authentication fails and this throws. Callers resolve them from the
 * stored invoice metadata, never from client input.
 */
async function loadAttachment(opts) {
  opts = opts || {};
  const blob = await fetchCiphertext(opts.assetId);
  return openAttachment({
    blob: blob,
    invoiceId: opts.invoiceId,
    attachmentId: opts.attachmentId
  });
}

async function removeAttachment(assetId) {
  return deleteAsset(assetId);
}

module.exports = {
  AttachmentValidationError,
  MAX_PLAINTEXT_BYTES,
  hasPdfSignature,
  validatePdf,
  storeAttachment,
  loadAttachment,
  removeAttachment
};
