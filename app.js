'use strict';

// Google Apps Script web app (apps-script/Code.gs). Redeploying as a new version keeps this URL.
const GAS_URL = 'https://script.google.com/macros/s/AKfycbwlb41Tjx_VEUJ8_mGbxP8ypPXnANwhrmc14BArEKOQZYWeQlhG8iHhsJxhYKO3T8xi8g/exec';

const MAX_IMAGE_EDGE = 1600;           // px; keeps screenshot text legible
const MAX_IMAGE_DATA_URL = 1_500_000;  // chars (~1.1 MB of JPEG); far below Apps Script limits
const THUMB_EDGE = 720;
const KEEP_SYNCED = 50;                // synced captures kept in the on-device feed
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_RETRY_DELAY_MS = 5 * 60_000;
const DRAFT_KEY = 'ingest.draft';

const $ = (id) => document.getElementById(id);
const els = {
    app: $('app'), feed: $('feed'), list: $('list'), empty: $('empty'),
    pill: $('statusPill'), toast: $('toast'),
    form: $('form'), input: $('input'), fileInput: $('fileInput'),
    photoBtn: $('photoBtn'), pasteBtn: $('pasteBtn'), micBtn: $('micBtn'), sendBtn: $('sendBtn'),
    attachment: $('attachment'), attachmentImg: $('attachmentImg'), removeImage: $('removeImage'),
};

const ICONS = {
    clock: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    spinner: '<svg class="spin" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.2-8.56"/></svg>',
    check: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    retry: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 21v-5h5"/></svg>',
};

// ---------------------------------------------------------------------------
// Storage: IndexedDB outbox + feed. Falls back to memory if IndexedDB is unavailable.
// ---------------------------------------------------------------------------

const store = (() => {
    const memory = new Map();
    let dbPromise = null;
    let warned = false;

    function open() {
        if (!dbPromise) {
            dbPromise = new Promise((resolve, reject) => {
                const req = indexedDB.open('os-ingestion', 1);
                req.onupgradeneeded = () => req.result.createObjectStore('items', { keyPath: 'id' });
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
        }
        return dbPromise;
    }

    async function run(mode, fn) {
        const db = await open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('items', mode);
            const req = fn(tx.objectStore('items'));
            tx.oncomplete = () => resolve(req.result);
            tx.onerror = tx.onabort = () => reject(tx.error);
        });
    }

    async function safely(op, fallback) {
        try {
            return await op();
        } catch (err) {
            console.warn('IndexedDB unavailable, using memory', err);
            if (!warned) {
                warned = true;
                toast('Storage unavailable — keep the app open until captures sync.');
            }
            return fallback();
        }
    }

    return {
        all: () => safely(() => run('readonly', (s) => s.getAll()), () => [...memory.values()]),
        put: (item) => {
            memory.set(item.id, item);
            return safely(() => run('readwrite', (s) => s.put(item)), () => undefined);
        },
        remove: (id) => {
            memory.delete(id);
            return safely(() => run('readwrite', (s) => s.delete(id)), () => undefined);
        },
    };
})();

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const items = new Map();   // id → capture
const cards = new Map();   // id → <li>
let attachment = null;     // { dataUrl, thumbUrl }
let syncing = false;
let retryDelay = 5_000;
let retryTimer = null;

function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const newestFirst = (a, b) => b.createdAt.localeCompare(a.createdAt);

// ---------------------------------------------------------------------------
// Image compression
// ---------------------------------------------------------------------------

async function decodeImage(blob) {
    if ('createImageBitmap' in window) {
        try {
            return await createImageBitmap(blob);
        } catch (_) { /* e.g. HEIC on some engines: fall back to <img> */ }
    }
    const url = URL.createObjectURL(blob);
    try {
        const img = new Image();
        img.src = url;
        await img.decode();
        return img;
    } finally {
        // Decoded pixels stay usable after the object URL is released.
        setTimeout(() => URL.revokeObjectURL(url), 0);
    }
}

function renderJpeg(source, maxEdge, quality) {
    const w0 = source.naturalWidth || source.width;
    const h0 = source.naturalHeight || source.height;
    const scale = Math.min(1, maxEdge / Math.max(w0, h0));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w0 * scale));
    canvas.height = Math.max(1, Math.round(h0 * scale));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; // transparent PNG screenshots would otherwise turn black in JPEG
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', quality);
}

/** Downscale + re-encode until the upload fits the payload budget, stepping quality first, then size. */
async function compressImage(blob) {
    const source = await decodeImage(blob);
    try {
        let edge = MAX_IMAGE_EDGE;
        let quality = 0.82;
        let dataUrl = renderJpeg(source, edge, quality);
        for (let i = 0; i < 10 && dataUrl.length > MAX_IMAGE_DATA_URL; i++) {
            if (quality > 0.55) quality -= 0.09;
            else edge = Math.round(edge * 0.8);
            dataUrl = renderJpeg(source, edge, quality);
        }
        const thumbUrl = renderJpeg(source, THUMB_EDGE, 0.7);
        return { dataUrl, thumbUrl };
    } finally {
        if (source.close) source.close();
    }
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

let toastTimer = null;

function toast(message, { action, onAction, duration = 3200 } = {}) {
    const text = els.toast.querySelector('.toast-text');
    const button = els.toast.querySelector('.toast-action');
    text.textContent = message;
    button.hidden = !action;
    button.textContent = action || '';
    button.onclick = action ? () => { hideToast(); onAction(); } : null;
    els.toast.hidden = false;
    // Restart the entry animation.
    els.toast.style.animation = 'none';
    void els.toast.offsetWidth;
    els.toast.style.animation = '';
    clearTimeout(toastTimer);
    if (duration) toastTimer = setTimeout(hideToast, duration);
}

function hideToast() {
    els.toast.hidden = true;
}

// ---------------------------------------------------------------------------
// Feed rendering
// ---------------------------------------------------------------------------

function formatTime(iso) {
    const d = new Date(iso);
    const now = new Date();
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (d.toDateString() === now.toDateString()) return time;
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`;
    return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}

function statusElement(item) {
    let el;
    if (item.status === 'synced' && (item.fileUrl || item.docUrl)) {
        el = document.createElement('a');
        el.href = item.fileUrl || item.docUrl;
        el.target = '_blank';
        el.rel = 'noopener';
        el.setAttribute('aria-label', item.fileUrl ? 'Synced — open image in Drive' : 'Synced — open Doc');
    } else if (item.status === 'failed') {
        el = document.createElement('button');
        el.type = 'button';
        el.addEventListener('click', () => retry(item.id));
        el.title = item.error || '';
    } else {
        el = document.createElement('span');
    }
    el.className = 'status';
    el.dataset.status = item.status;
    const [icon, label] = {
        queued: [ICONS.clock, 'Queued'],
        sending: [ICONS.spinner, 'Syncing'],
        synced: [ICONS.check, 'Synced'],
        failed: [ICONS.retry, 'Failed · Retry'],
    }[item.status];
    el.innerHTML = icon;
    el.append(label);
    return el;
}

function renderCard(item, { animate = false } = {}) {
    let card = cards.get(item.id);
    if (!card) {
        card = document.createElement('li');
        card.className = animate ? 'card enter' : 'card';
        card.addEventListener('animationend', () => card.classList.remove('enter'), { once: true });

        const src = item.thumb || item.image;
        if (src) {
            const img = document.createElement('img');
            img.className = 'card-img';
            img.alt = 'Captured image';
            img.decoding = 'async';
            img.src = src;
            card.append(img);
        }
        if (item.text) {
            const p = document.createElement('p');
            p.className = 'card-text';
            p.textContent = item.text;
            card.append(p);
        }
        const meta = document.createElement('div');
        meta.className = 'card-meta';
        const time = document.createElement('time');
        time.dateTime = item.createdAt;
        time.textContent = formatTime(item.createdAt);
        meta.append(time, statusElement(item));
        card.append(meta);

        cards.set(item.id, card);
        insertCard(item, card);
    } else {
        const meta = card.querySelector('.card-meta');
        meta.replaceChild(statusElement(item), meta.lastChild);
    }
    els.empty.hidden = cards.size > 0;
}

function insertCard(item, card) {
    const next = [...items.values()]
        .filter((other) => other.id !== item.id && cards.has(other.id) && other.createdAt < item.createdAt)
        .sort(newestFirst)[0];
    els.list.insertBefore(card, next ? cards.get(next.id) : null);
}

function removeCard(id) {
    const card = cards.get(id);
    if (card) card.remove();
    cards.delete(id);
    els.empty.hidden = cards.size > 0;
}

function updatePill() {
    const all = [...items.values()];
    const pending = all.filter((i) => i.status === 'queued' || i.status === 'sending').length;
    const failed = all.filter((i) => i.status === 'failed').length;
    let state;
    let label;
    if (!navigator.onLine) {
        state = 'offline';
        label = pending ? `Offline · ${pending} queued` : 'Offline';
    } else if (failed) {
        state = 'failed';
        label = `${failed} failed`;
    } else if (pending) {
        state = 'syncing';
        label = `Syncing ${pending}`;
    } else {
        state = 'ok';
        label = all.length ? 'All synced' : 'Ready';
    }
    els.pill.dataset.state = state;
    els.pill.querySelector('.pill-label').textContent = label;
}

// ---------------------------------------------------------------------------
// Sync: oldest queued capture first; success only when Apps Script replies { ok: true }.
// ---------------------------------------------------------------------------

async function send(item) {
    const payload = {
        id: item.id,
        createdAt: item.createdAt,
        text: item.text,
        image: item.image ? { data: item.image.split(',')[1], mimeType: 'image/jpeg' } : null,
        source: 'ios-pwa',
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        // text/plain keeps this a CORS "simple request": no preflight, which Apps Script cannot answer.
        const res = await fetch(GAS_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify(payload),
            redirect: 'follow',
            signal: controller.signal,
        });
        const body = await res.text();
        let data;
        try {
            data = JSON.parse(body);
        } catch (_) {
            return { ok: false, retryable: res.status >= 500 || res.status === 429, error: `Unexpected response (HTTP ${res.status})` };
        }
        if (data.ok) return data;
        return { ok: false, retryable: Boolean(data.retryable), error: data.error || 'Rejected by server' };
    } catch (err) {
        return { ok: false, retryable: true, error: err.name === 'AbortError' ? 'Timed out' : 'Network unavailable' };
    } finally {
        clearTimeout(timer);
    }
}

async function sync() {
    if (syncing) return;
    syncing = true;
    clearTimeout(retryTimer);
    try {
        for (;;) {
            const next = [...items.values()].filter((i) => i.status === 'queued').sort(newestFirst).pop();
            if (!next) break;

            next.status = 'sending';
            renderCard(next);
            updatePill();

            const result = await send(next);
            if (result.ok) {
                next.status = 'synced';
                next.fileUrl = result.fileUrl || null;
                next.docUrl = result.docUrl || null;
                next.image = null; // full-size upload no longer needed; the thumbnail stays
                delete next.error;
                retryDelay = 5_000;
            } else if (result.retryable) {
                next.status = 'queued';
                next.error = result.error;
                await store.put(next);
                renderCard(next);
                retryTimer = setTimeout(sync, retryDelay);
                retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY_MS);
                break;
            } else {
                next.status = 'failed';
                next.error = result.error;
                toast(`Couldn't save: ${result.error}`);
            }
            await store.put(next);
            renderCard(next);
        }
    } finally {
        syncing = false;
        await prune();
        updatePill();
    }
}

function retry(id) {
    const item = items.get(id);
    if (!item) return;
    item.status = 'queued';
    store.put(item);
    renderCard(item);
    updatePill();
    sync();
}

async function prune() {
    const synced = [...items.values()].filter((i) => i.status === 'synced').sort(newestFirst);
    for (const item of synced.slice(KEEP_SYNCED)) {
        items.delete(item.id);
        removeCard(item.id);
        await store.remove(item.id);
    }
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

function hasContent() {
    return Boolean(els.input.value.trim() || attachment);
}

function updateComposer() {
    els.sendBtn.disabled = !hasContent();
}

function autosize() {
    els.input.style.height = 'auto';
    els.input.style.height = `${Math.min(els.input.scrollHeight, 168)}px`;
}

function saveDraft() {
    try {
        localStorage.setItem(DRAFT_KEY, els.input.value);
    } catch (_) { /* private mode */ }
}

function setText(value) {
    els.input.value = value;
    autosize();
    saveDraft();
    updateComposer();
}

async function attachImage(blob) {
    if (!blob || !blob.type.startsWith('image/')) return;
    els.sendBtn.disabled = true;
    try {
        attachment = await compressImage(blob);
        els.attachmentImg.src = attachment.thumbUrl;
        els.attachment.hidden = false;
    } catch (err) {
        console.error('Image processing failed', err);
        toast("Couldn't read that image.");
    } finally {
        updateComposer();
    }
}

function clearAttachment() {
    attachment = null;
    els.attachment.hidden = true;
    els.attachmentImg.removeAttribute('src');
    els.fileInput.value = '';
    updateComposer();
}

async function submit() {
    if (!hasContent()) return;
    if (recognition) {
        // Drop late results so they don't refill the composer after sending.
        recognition.onresult = null;
        recognition.abort();
    }

    const item = {
        id: uuid(),
        createdAt: new Date().toISOString(),
        text: els.input.value.trim(),
        image: attachment ? attachment.dataUrl : null,
        thumb: attachment ? attachment.thumbUrl : null,
        status: 'queued',
    };

    setText('');
    clearAttachment();

    items.set(item.id, item);
    renderCard(item, { animate: true });
    els.feed.scrollTo({ top: 0, behavior: 'smooth' });
    updatePill();

    await store.put(item);
    sync();
}

async function pasteFromClipboard() {
    if (!navigator.clipboard || !navigator.clipboard.read) {
        els.input.focus();
        toast('Long-press the text field and tap Paste.');
        return;
    }
    try {
        const clipboardItems = await navigator.clipboard.read();
        for (const entry of clipboardItems) {
            const imageType = entry.types.find((t) => t.startsWith('image/'));
            if (imageType) {
                await attachImage(await entry.getType(imageType));
                return;
            }
        }
        for (const entry of clipboardItems) {
            if (entry.types.includes('text/plain')) {
                const text = await (await entry.getType('text/plain')).text();
                if (text) {
                    setText(els.input.value ? `${els.input.value} ${text}` : text);
                    return;
                }
            }
        }
        toast('Clipboard is empty.');
    } catch (err) {
        // NotAllowedError: the user dismissed iOS's Paste prompt.
        if (err.name !== 'NotAllowedError') toast("Couldn't read the clipboard.");
    }
}

// ---------------------------------------------------------------------------
// Voice dictation (Web Speech API). iOS sends audio to Apple for recognition, so it needs a network.
// ---------------------------------------------------------------------------

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;

function toggleDictation() {
    if (recognition) {
        recognition.stop();
        return;
    }
    if (!SpeechRecognition) {
        els.input.focus();
        toast('Dictation isn\'t available here — use the mic on your keyboard.');
        return;
    }
    if (!navigator.onLine) {
        els.input.focus();
        toast('Dictation needs a connection. Use the keyboard mic — captures still save offline.');
        return;
    }

    const rec = new SpeechRecognition();
    rec.lang = navigator.language || 'en-US';
    rec.continuous = true;
    rec.interimResults = true;
    const base = els.input.value.trim();

    rec.onresult = (event) => {
        // Rebuild from all results each time; avoids duplicated phrases from iOS's continuous mode.
        let transcript = '';
        for (let i = 0; i < event.results.length; i++) transcript += event.results[i][0].transcript;
        transcript = transcript.trim();
        setText(base && transcript ? `${base} ${transcript}` : base || transcript);
    };
    rec.onerror = (event) => {
        if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
            toast('Microphone access is off. Enable it in Settings, or use the keyboard mic.');
        } else if (event.error === 'network') {
            toast('Dictation needs a connection.');
        } else if (event.error !== 'no-speech' && event.error !== 'aborted') {
            toast('Dictation stopped.');
        }
    };
    rec.onend = () => {
        recognition = null;
        els.app.classList.remove('recording');
        els.micBtn.setAttribute('aria-pressed', 'false');
        els.input.placeholder = 'Capture a thought…';
    };

    try {
        rec.start();
    } catch (err) {
        toast('Couldn\'t start dictation.');
        return;
    }
    recognition = rec;
    els.app.classList.add('recording');
    els.micBtn.setAttribute('aria-pressed', 'true');
    els.input.placeholder = 'Listening…';
}

// ---------------------------------------------------------------------------
// Keyboard: pin the app to the visual viewport so the composer rides on top of the iOS keyboard.
// ---------------------------------------------------------------------------

function trackViewport() {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    const update = () => {
        root.style.setProperty('--vv-height', `${vv.height}px`);
        root.style.setProperty('--vv-top', `${vv.offsetTop}px`);
        document.body.classList.toggle('keyboard-open', window.innerHeight - vv.height > 120);
    };
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    update();
}

// ---------------------------------------------------------------------------
// Service worker
// ---------------------------------------------------------------------------

function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    const hadController = Boolean(navigator.serviceWorker.controller);
    navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('Service worker failed', err));
    navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (hadController) toast('A new version is ready.', { action: 'Reload', onAction: () => location.reload(), duration: 0 });
    });
}

// ---------------------------------------------------------------------------
// Wire up
// ---------------------------------------------------------------------------

function bindEvents() {
    els.form.addEventListener('submit', (e) => {
        e.preventDefault();
        submit();
    });
    els.input.addEventListener('input', () => {
        autosize();
        saveDraft();
        updateComposer();
    });
    els.input.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || e.isComposing) return;
        // Return sends on hardware keyboards; on the iPhone keyboard it inserts a newline (use the send button).
        const hardwareKeyboard = window.matchMedia('(hover: hover)').matches;
        if (e.metaKey || e.ctrlKey || (hardwareKeyboard && !e.shiftKey)) {
            e.preventDefault();
            submit();
        }
    });

    els.photoBtn.addEventListener('click', () => els.fileInput.click());
    els.fileInput.addEventListener('change', () => attachImage(els.fileInput.files[0]));
    els.pasteBtn.addEventListener('click', pasteFromClipboard);
    els.removeImage.addEventListener('click', clearAttachment);
    els.micBtn.addEventListener('click', toggleDictation);
    els.pill.addEventListener('click', () => {
        for (const item of items.values()) if (item.status === 'failed') retry(item.id);
        sync();
    });

    // Global paste: screenshots pasted anywhere in the app (iPad keyboards, long-press Paste in the field).
    document.addEventListener('paste', (e) => {
        const file = [...(e.clipboardData?.items || [])].find((i) => i.kind === 'file' && i.type.startsWith('image/'));
        if (!file) return;
        e.preventDefault();
        attachImage(file.getAsFile());
    });

    window.addEventListener('online', () => {
        updatePill();
        retryDelay = 5_000;
        sync();
    });
    window.addEventListener('offline', updatePill);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') sync();
    });
}

async function init() {
    bindEvents();
    trackViewport();
    registerServiceWorker();

    try {
        setText(localStorage.getItem(DRAFT_KEY) || '');
    } catch (_) {
        updateComposer();
    }

    const saved = await store.all();
    for (const item of saved.sort(newestFirst)) {
        if (item.status === 'sending') item.status = 'queued'; // app was closed mid-upload
        items.set(item.id, item);
        renderCard(item);
    }
    updatePill();

    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    sync();
}

init();
