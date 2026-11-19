// Fake claude.ai API for the demo page.
// It answers the same requests the userscript sends to claude.ai, using made-up files kept in this
// browser's localStorage. No request leaves the page.
//
// It also copies a quirk of the real list: when a page holds more than one file, files from the same
// Code / Cowork session are collapsed to one, so the normal 50-per-page list never shows all of them.
(() => {
  'use strict';
  const ORG = { uuid: '9f1c2e4a-0d3b-4c56-8e7f-1a2b3c4d5e6f', name: "demo@example.com's Organization" };
  const STORE = 'cfcDemoFiles.v1';
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // Seeded random numbers, so every visitor gets the same set of files.
  function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  const uuid = r => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const v = Math.floor(r() * 16); return (c === 'x' ? v : (v & 3) | 8).toString(16); });

  const CHAT_NAMES = [
    'IMG_2041.jpg', 'IMG_2077.jpg', 'IMG_3112.HEIC', 'Screenshot 2026-10-03 at 14.22.10.png', 'Screenshot 2026-09-18 at 09.05.44.png',
    'invoice-acme-2026-09.pdf', 'invoice-acme-2026-10.pdf', 'lease-agreement-draft.pdf', 'trip-itinerary-kyoto.pdf', 'menu-photo.jpg',
    'budget-q3.xlsx', 'budget-q4-v2.xlsx', 'meeting-notes-oct.md', 'resume-2026.pdf', 'cover-letter.docx', 'receipt-0931.png',
    'whiteboard.jpg', 'floorplan.png', 'contract-scan-p1.jpg', 'contract-scan-p2.jpg', 'tax-summary-2025.pdf', 'slides-kickoff.pptx',
    'error-log.txt', 'dataset-sample.csv', 'report-final.pdf', 'report-final-v3.pdf', 'chart.png', 'diagram.svg', 'bank-statement-aug.pdf',
    'passport-scan.jpg', 'recipe.jpg', 'notes.txt', 'thesis-chapter-2.pdf', 'logo-ideas.png', 'quote-request.pdf',
  ];
  const SESSION_NAMES = ['image.png', 'screenshot.png', 'pasted-image.png', 'photo.jpg', 'build-error.png', 'design-mock.png', 'stack-trace.png', 'ui-bug.jpg'];
  const MIME = n => /\.(jpe?g|heic)$/i.test(n) ? 'image/jpeg' : /\.png$/i.test(n) ? 'image/png' : /\.svg$/i.test(n) ? 'image/svg+xml' : /\.pdf$/i.test(n) ? 'application/pdf'
    : /\.xlsx$/i.test(n) ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : /\.docx$/i.test(n) ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    : /\.pptx$/i.test(n) ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation' : /\.csv$/i.test(n) ? 'text/csv' : 'text/plain';

  // created_at with microseconds, like claude.ai
  const iso = micro => new Date(Math.floor(micro / 1000)).toISOString().replace(/\.\d{3}Z$/, '.' + String(micro % 1000000).padStart(6, '0') + 'Z');
  const tsMicro = s => { const m = /\.(\d+)Z$/.exec(s); return Date.parse(s.replace(/\.\d+Z$/, 'Z')) * 1000 + (m ? Number((m[1] + '000000').slice(0, 6)) : 0); };

  function generate() {
    const r = rng(20261118);
    const now = Date.now() * 1000;
    const files = [];
    const add = (name, surface, linked, group) => {
      const ageDays = Math.pow(r(), 1.15) * 380;
      const micro = Math.floor(now - ageDays * 86400e6 - r() * 1e6);
      const named = r() > 0.06;
      files.push({
        file_uuid: uuid(r), file_name: named ? name : '', size_bytes: r() > 0.05 ? Math.floor(4000 + Math.pow(r(), 2.2) * 5e6) : null,
        mime_type: MIME(name), created_at: iso(micro), surface,
        conversation_uuids: linked ? [uuid(r)] : [], conversation_session_ids: {}, project: null, _group: group,
      });
    };
    for (let i = 0; i < 92; i++) add(CHAT_NAMES[i % CHAT_NAMES.length], 'chat', true, null);
    for (let i = 0; i < 22; i++) add(CHAT_NAMES[(i * 7 + 3) % CHAT_NAMES.length], 'chat', false, null);
    for (let i = 0; i < 38; i++) add(SESSION_NAMES[i % SESSION_NAMES.length], 'session', false, 'session-' + (i % 5));
    files.sort((a, b) => tsMicro(b.created_at) - tsMicro(a.created_at));
    return files;
  }

  const load = () => { try { const v = JSON.parse(localStorage.getItem(STORE) || 'null'); if (Array.isArray(v)) return v; } catch (e) {} const f = generate(); save(f); return f; };
  const save = f => { try { localStorage.setItem(STORE, JSON.stringify(f)); } catch (e) {} };
  let files = load();

  const after = (f, cursor) => { // true if f comes after the cursor in newest-first order
    const [cts, cid] = cursor; const t = tsMicro(f.created_at);
    return t < cts || (t === cts && f.file_uuid < cid);
  };
  const publicFile = f => { const { _group, ...rest } = f; return rest; };

  function listPage(limit, cursorStr) {
    let start = 0;
    if (cursorStr) {
      const m = /^(\d+)\.([0-9a-f-]{36})$/.exec(cursorStr);
      if (!m) return { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'Cursor is not valid.' } } };
      const cur = [Number(m[1]), m[2]];
      start = files.findIndex(f => after(f, cur)); if (start < 0) start = files.length;
    }
    const window_ = files.slice(start, start + limit);
    const seen = new Set();
    const shown = limit > 1 ? window_.filter(f => { if (!f._group) return true; if (seen.has(f._group)) return false; seen.add(f._group); return true; }) : window_;
    const last = window_[window_.length - 1];
    const more = start + limit < files.length;
    return { status: 200, body: { files: shown.map(publicFile), next_cursor: more && last ? `${tsMicro(last.created_at)}.${last.file_uuid}` : null } };
  }

  const json = (status, body) => new Response(body == null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const realFetch = window.fetch.bind(window);

  window.fetch = async function (input, init = {}) {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    const method = String(init.method || (typeof input !== 'string' && input.method) || 'GET').toUpperCase();
    const p = url.pathname;
    if (!/\/api\/organizations/.test(p)) return realFetch(input, init);
    await sleep(120 + Math.random() * 180); // network-ish delay
    if (/\/api\/organizations\/?$/.test(p) && method === 'GET') return json(200, [ORG]);
    let m = /\/api\/organizations\/([^/]+)\/account\/files\/?$/.exec(p);
    if (m && method === 'GET') {
      if (m[1] !== ORG.uuid) return json(404, { error: 'not found' });
      const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit')) || 50));
      if (Number(url.searchParams.get('limit')) > 100) return json(400, { error: 'limit too large' });
      const r = listPage(limit, url.searchParams.get('cursor'));
      return json(r.status, r.body);
    }
    m = /\/api\/organizations\/([^/]+)\/account\/files\/([^/]+)\/?$/.exec(p);
    if (m && method === 'DELETE') {
      const i = files.findIndex(f => f.file_uuid === m[2]);
      if (i < 0) return json(404, { error: 'not found' });
      files.splice(i, 1); save(files);
      return new Response(null, { status: 204 });
    }
    return json(404, { error: 'not found' });
  };

  // The userscript reads the active account from this cookie, as on claude.ai.
  document.cookie = `lastActiveOrg=${ORG.uuid}; path=/; SameSite=Lax`;
  if (!/lastActiveOrg=/.test(document.cookie)) { // file:// pages can't store cookies
    const desc = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
    Object.defineProperty(document, 'cookie', { configurable: true, get: () => `lastActiveOrg=${ORG.uuid}`, set: v => { try { desc.set.call(document, v); } catch (e) {} } });
  }

  window.cfcDemo = {
    reset() { files = generate(); save(files); },
    count: () => files.length,
    counts: () => ({ total: files.length, chatLinked: files.filter(f => f.surface === 'chat' && f.conversation_uuids.length).length, chatUnlinked: files.filter(f => f.surface === 'chat' && !f.conversation_uuids.length).length, session: files.filter(f => f.surface !== 'chat').length }),
  };
})();
