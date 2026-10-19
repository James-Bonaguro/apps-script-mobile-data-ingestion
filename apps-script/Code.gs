/**
 * OS Ingestion — Google Apps Script backend.
 *
 * Receives captures from the iOS PWA and writes them into Google Workspace:
 *   - text  → appended to the target Google Doc under a timestamp
 *   - image → saved as a file in the Drive folder that holds the Doc,
 *             with a link to it written into the Doc entry
 *
 * Deploy: Deploy → Manage deployments → edit the existing Web app → Version: New version.
 * Editing the existing deployment keeps the same /exec URL the PWA already uses.
 * Settings: Execute as "Me", Who has access "Anyone".
 *
 * CORS: Apps Script never passes OPTIONS requests to the script, so a doOptions()
 * handler can't run. The PWA avoids the preflight entirely by POSTing with
 * Content-Type: text/plain (a "simple" request). Google adds
 * Access-Control-Allow-Origin: * to ContentService responses, so the app can read the
 * JSON reply below.
 */

// ID of the Google Doc to append to (the long string in its URL: /document/d/<ID>/edit).
const DOC_ID = 'PASTE_YOUR_GOOGLE_DOC_ID_HERE';

const DEDUPE_TTL_SECONDS = 6 * 60 * 60; // Offline retries with the same id are ignored for 6h.
const LOCK_TIMEOUT_MS = 20000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_CHARS = 50000;
const LEGACY_IMAGE_PLACEHOLDER = '[Image Attached - No Text]';

const IMAGE_EXTENSIONS = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic',
};

/** Health check: open the /exec URL in a browser to confirm the deployment is live. */
function doGet() {
  return json_({ ok: true, service: 'os-ingestion', time: new Date().toISOString() });
}

function doPost(e) {
  let capture;
  try {
    capture = parseCapture_(e);
  } catch (err) {
    return json_({ ok: false, retryable: false, error: 'Invalid payload: ' + errorMessage_(err) });
  }

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(LOCK_TIMEOUT_MS);
  } catch (err) {
    return json_({ ok: false, retryable: true, error: 'Server busy, try again' });
  }

  try {
    const cache = CacheService.getScriptCache();
    const cacheKey = capture.id ? 'capture:' + capture.id : null;
    if (cacheKey) {
      const previous = cache.get(cacheKey);
      if (previous) return json_(Object.assign(JSON.parse(previous), { duplicate: true }));
    }

    const result = ingest_(capture);
    if (cacheKey) cache.put(cacheKey, JSON.stringify(result), DEDUPE_TTL_SECONDS);
    return json_(result);
  } catch (err) {
    console.error(err);
    return json_({ ok: false, retryable: true, error: errorMessage_(err) });
  } finally {
    lock.releaseLock();
  }
}

/**
 * Accepts the current payload
 *   { id, createdAt, text, image: { data, mimeType } | null }
 * and the legacy one
 *   { text, image: "data:image/jpeg;base64,...", timestamp }.
 */
function parseCapture_(e) {
  if (!e || !e.postData || !e.postData.contents) throw new Error('empty body');
  const payload = JSON.parse(e.postData.contents);

  let text = typeof payload.text === 'string' ? payload.text.trim() : '';
  if (text === LEGACY_IMAGE_PLACEHOLDER) text = '';
  if (text.length > MAX_TEXT_CHARS) throw new Error('text too long');

  let image = null;
  if (typeof payload.image === 'string' && payload.image) {
    const match = payload.image.match(/^data:([^;,]+);base64,(.+)$/);
    if (!match) throw new Error('image is not a base64 data URL');
    image = { mimeType: match[1], data: match[2] };
  } else if (payload.image && typeof payload.image === 'object') {
    image = { mimeType: String(payload.image.mimeType || 'image/jpeg'), data: String(payload.image.data || '') };
  }
  if (image) {
    if (!/^image\//.test(image.mimeType)) throw new Error('unsupported image type ' + image.mimeType);
    if (!image.data) throw new Error('image data missing');
  }

  if (!text && !image) throw new Error('nothing to save');

  let createdAt = new Date(payload.createdAt || payload.timestamp || Date.now());
  if (isNaN(createdAt.getTime())) createdAt = new Date();

  return {
    id: payload.id ? String(payload.id).slice(0, 100) : null,
    createdAt: createdAt,
    text: text,
    image: image,
  };
}

function ingest_(capture) {
  const tz = Session.getScriptTimeZone();
  const docFile = DriveApp.getFileById(DOC_ID);

  let imageFile = null;
  if (capture.image) {
    const bytes = Utilities.base64Decode(capture.image.data);
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error('image larger than 10 MB');
    const extension = IMAGE_EXTENSIONS[capture.image.mimeType] || 'img';
    const name = 'capture-' + Utilities.formatDate(capture.createdAt, tz, 'yyyy-MM-dd_HHmmss') +
      (capture.id ? '-' + capture.id.slice(0, 8) : '') + '.' + extension;
    const parents = docFile.getParents();
    const folder = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
    imageFile = folder.createFile(Utilities.newBlob(bytes, capture.image.mimeType, name));
  }

  const doc = DocumentApp.openById(DOC_ID);
  const body = doc.getBody();

  appendParagraph_(body, Utilities.formatDate(capture.createdAt, tz, "EEE, MMM d, yyyy 'at' h:mm a"),
    DocumentApp.ParagraphHeading.HEADING3);

  if (capture.text) {
    appendParagraph_(body, capture.text, DocumentApp.ParagraphHeading.NORMAL);
  }

  if (imageFile) {
    const label = '📎 Image: ' + imageFile.getName();
    appendParagraph_(body, label, DocumentApp.ParagraphHeading.NORMAL)
      .editAsText().setLinkUrl(0, label.length - 1, imageFile.getUrl());
  }

  body.appendHorizontalRule();
  doc.saveAndClose();

  return {
    ok: true,
    id: capture.id,
    docUrl: docFile.getUrl(),
    fileUrl: imageFile ? imageFile.getUrl() : null,
  };
}

/** Run once from the editor (select "authorize" → Run) to grant Docs/Drive access and check DOC_ID. */
function authorize() {
  const docFile = DriveApp.getFileById(DOC_ID);
  const parents = docFile.getParents();
  DocumentApp.openById(DOC_ID);
  console.log('Doc: ' + docFile.getName() + ' | Folder: ' + (parents.hasNext() ? parents.next().getName() : 'My Drive'));
}

// Docs copies the previous paragraph's style onto appended ones, so reset heading and link each time.
function appendParagraph_(body, text, heading) {
  return body.appendParagraph(text).setHeading(heading).setLinkUrl(null);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function errorMessage_(err) {
  return String((err && err.message) || err);
}
