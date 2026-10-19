# Edge-to-Enterprise Data Ingestion

A zero-cost, serverless pipeline that routes unstructured edge data (voice, field notes, screenshots) from an iPhone straight into Google Workspace for AI synthesis.

## Architecture

**Edge capture (PWA):** an offline-first Progressive Web App installed to the iOS Home Screen. It runs full-screen with no Safari UI and opens instantly, even in airplane mode. Captures are written to an on-device outbox (IndexedDB) first and sync when the network is back.

**Serverless middleware (Google Apps Script):** `apps-script/Code.gs` receives JSON captures:
- text → appended to the target Google Doc under a timestamp
- image → saved as a file in the Drive folder that holds the Doc, with a link written into the Doc entry

**Data lake (Google Docs + Drive)** feeds **AI synthesis (NotebookLM)**, which indexes the Doc for RAG queries.

## Files

| File | Purpose |
|---|---|
| `index.html` | App shell and iOS meta tags |
| `styles.css` | Dark iOS design system |
| `app.js` | Capture, dictation, paste, image compression, offline outbox, sync |
| `sw.js` | Service worker: caches the app shell for instant offline launch |
| `manifest.json` | PWA manifest |
| `icons/` | App icon (`icon.svg` is the source), PNG sizes, iPhone launch screens |
| `apps-script/Code.gs` | Backend; paste into the Apps Script editor |
| `vercel.json` | Security headers (strict CSP) and service-worker caching rules |

No dependencies, no build step.

## Payload

`POST` to the Apps Script `/exec` URL with `Content-Type: text/plain`:

```json
{
  "id": "uuid",
  "createdAt": "2026-10-19T14:05:00.000Z",
  "text": "Field note…",
  "image": { "data": "<base64 JPEG, no data: prefix>", "mimeType": "image/jpeg" },
  "source": "ios-pwa"
}
```

Response: `{ "ok": true, "id", "docUrl", "fileUrl" }` or `{ "ok": false, "retryable": bool, "error" }`. The `id` makes retries idempotent: a capture resent within 6 hours is not appended twice.

Images are compressed on the phone before upload (long edge ≤ 1600px, JPEG, ≤ ~1.1 MB), keeping screenshots legible and well under Apps Script limits.

## Why there is no `doOptions`

Apps Script never passes HTTP `OPTIONS` requests to the script, so a CORS preflight can't be handled there. The app avoids preflight entirely by sending a "simple" request (`text/plain` body). Google adds `Access-Control-Allow-Origin: *` to the response, so the app can still read the JSON reply.

## Deploy

**Backend**
1. Open the Apps Script project, replace its code with `apps-script/Code.gs`, set `DOC_ID` to the target Doc's ID.
2. Run `authorize` once from the editor to grant Docs/Drive access.
3. Deploy → Manage deployments → edit the existing Web app → Version: **New version**. This keeps the same `/exec` URL. Execute as **Me**, access **Anyone**.
4. Open the `/exec` URL in a browser; it should return `{"ok":true,"service":"os-ingestion",…}`.

**Front-end**
Push to the branch Vercel deploys from. No build settings needed. `GAS_URL` lives at the top of `app.js`.

When you change `sw.js` or the list of cached files, bump `VERSION` in `sw.js`. Other asset edits are fetched in the background and appear on the next launch.

**iPhone**
Open the Vercel URL in Safari → Share → Add to Home Screen. Launch it from the Home Screen icon.

## iOS notes

- **Dictation** (Web Speech API) needs a network on iOS; Apple does the recognition server-side. Offline, use the keyboard's mic. Captures still queue.
- **Paste:** iOS only fires paste events into a focused text field. The Paste button uses the clipboard API (iOS shows its own "Paste" confirmation) and is the reliable one-tap path for screenshots.
- **Background sync** isn't available on iOS. The outbox flushes when the app opens, comes back to the foreground, or regains a connection.
