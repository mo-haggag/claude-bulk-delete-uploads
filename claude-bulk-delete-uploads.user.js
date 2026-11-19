// ==UserScript==
// @name         Claude: bulk delete uploaded files
// @namespace    https://github.com/mo-haggag/claude-bulk-delete-uploads
// @homepageURL  https://github.com/mo-haggag/claude-bulk-delete-uploads
// @supportURL   https://github.com/mo-haggag/claude-bulk-delete-uploads/issues
// @downloadURL  https://raw.githubusercontent.com/mo-haggag/claude-bulk-delete-uploads/main/claude-bulk-delete-uploads.user.js
// @updateURL    https://raw.githubusercontent.com/mo-haggag/claude-bulk-delete-uploads/main/claude-bulk-delete-uploads.user.js
// @version      2.3
// @description  Delete all your claude.ai uploaded files at once, including the ones the Uploaded files page doesn't show
// @match        https://claude.ai/*
// @grant        none
// @inject-into  page
// @run-at       document-idle
// @noframes
// ==/UserScript==
(() => {
  'use strict';
  const HOST_ID = 'cc-file-cleaner';
  const STORE_KEY = 'ccFileCleaner.v2';
  const PAGE_RE = /uploaded-files/;
  const DELETE_WORKERS = 3;
  const SCAN_WORKERS = 8;
  const MAX_EXTRA_PASSES = 4;
  const MAXU = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
  const DRY = window.__ccCleanerDryRun === true; // test switch: simulates deletes, sends nothing

  // Remove an earlier copy of this panel (re-injection or older version).
  try { window.__ccCleaner && window.__ccCleaner.destroy && window.__ccCleaner.destroy(); } catch (e) {}
  const old = document.getElementById(HOST_ID); if (old) old.remove();
  if (window.__ccCleanerTimer) { clearInterval(window.__ccCleanerTimer); window.__ccCleanerTimer = null; }

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // Requests must go out as the claude.ai page. In page mode that is plain fetch.
  // If a userscript manager runs this in Firefox's isolated content mode, content.fetch sends as the page.
  const pageFetch = (() => {
    try { if (typeof content !== 'undefined' && content && content !== window && typeof content.fetch === 'function') return content.fetch.bind(content); } catch (e) {}
    return window.fetch.bind(window);
  })();

  // ---------- formatting ----------
  const fmtBytes = b => b >= 1073741824 ? (b / 1073741824).toFixed(2) + ' GB' : b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : b >= 1024 ? Math.round(b / 1024) + ' KB' : b + ' B';
  const fmtDate = iso => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); };
  const fmtTime = ts => new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const fmtDur = s => s < 60 ? Math.max(1, Math.round(s)) + ' s' : Math.round(s / 60) + ' min';
  const plural = (n, w) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;
  const sumBytes = fs => fs.reduce((s, f) => s + ((f && f.size_bytes) || 0), 0);
  const fileName = f => (f.file_name && f.file_name.trim()) || `(unnamed ${f.mime_type || 'file'})`;
  const surfaceLabel = s => s === 'chat' ? 'Chat' : s === 'session' ? 'Code / Cowork' : (s || 'Unknown');
  const isLinked = f => Array.isArray(f.conversation_uuids) && f.conversation_uuids.length > 0;
  const ageDays = f => (Date.now() - new Date(f.created_at).getTime()) / 86400000;
  // created_at in microseconds, the unit Claude's list cursor uses
  const tsMicro = iso => { const m = /\.(\d+)Z$/.exec(iso || ''); const base = Date.parse(String(iso).replace(/\.\d+Z$/, 'Z')); return base * 1000 + (m ? Number((m[1] + '000000').slice(0, 6)) : 0); };

  // ---------- API ----------
  class AuthError extends Error {}
  const activeOrgId = () => (document.cookie.match(/(?:^|;\s*)lastActiveOrg=([^;]+)/) || [])[1] || null;

  async function getJSON(url) {
    const r = await pageFetch(url, { credentials: 'include' });
    if (r.status === 401 || r.status === 403) throw new AuthError('You seem to be signed out. Sign in to claude.ai, then press the reload button above.');
    if (!r.ok) throw new Error(`Claude returned HTTP ${r.status}. Press the reload button above to try again.`);
    return r.json();
  }
  async function getOrg() {
    const id = activeOrgId();
    const orgs = await getJSON('/api/organizations');
    const o = Array.isArray(orgs) ? orgs.find(x => x.uuid === id) : null;
    if (!o) throw new Error("Couldn't tell which Claude account is active. Reload the page and try again.");
    // Team and Enterprise workspaces: Claude doesn't offer file deletion to members, and admins control retention.
    const workspace = !!o.raven_type || (Array.isArray(o.capabilities) && o.capabilities.includes('raven'));
    return { uuid: o.uuid, name: o.name, workspace };
  }

  // Reads pages from a cursor. Stops at the end, or once it reaches files older than stopBelow (microseconds).
  async function listPages(orgUuid, limit, cursor, stopBelow, onItems) {
    let pages = 0;
    for (;;) {
      const j = await getJSON(`/api/organizations/${orgUuid}/account/files?limit=${limit}${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`);
      const files = Array.isArray(j.files) ? j.files : [];
      if (onItems) onItems(files);
      if (stopBelow != null && files.some(f => tsMicro(f.created_at) < stopBelow)) return;
      cursor = j.next_cursor || null;
      if (!cursor || ++pages >= 5000) return;
    }
  }

  // Claude's list drops some files when it returns more than one per page (mostly Code / Cowork files),
  // so the Uploaded files page never shows them. Pass 1 reads the list the way the page does.
  // Pass 2 reads it one file per page, which returns everything; it splits the date range into slices
  // and reads them in parallel to keep it fast.
  async function scanAll(orgUuid, onProgress, hintFiles) {
    const all = new Map();
    let checked = 0;
    const add = fs => { for (const f of fs) if (f && f.file_uuid) all.set(f.file_uuid, f); };
    await listPages(orgUuid, 50, null, null, fs => { add(fs); if (onProgress) onProgress({ step: 1, found: all.size, checked }); });
    const visible = all.size;
    // Slice by the dates we know about (this pass plus any earlier scan), so hidden files spread across workers.
    const ts = [...new Set([...all.values(), ...(hintFiles || [])].map(f => tsMicro(f.created_at)).filter(Number.isFinite))].sort((a, b) => b - a);
    const k = Math.max(1, Math.min(SCAN_WORKERS, Math.ceil(ts.length / 12)));
    const cuts = [];
    for (let i = 1; i < k; i++) { const j = Math.floor(i * ts.length / k); if (j > 0 && j < ts.length) cuts.push(Math.floor((ts[j - 1] + ts[j]) / 2)); }
    const bounds = [...new Set(cuts)].sort((a, b) => b - a);
    const slices = [{ start: null, stop: bounds.length ? bounds[0] : null }];
    bounds.forEach((c, i) => slices.push({ start: `${c}.${MAXU}`, stop: i + 1 < bounds.length ? bounds[i + 1] : null }));
    await Promise.all(slices.map(s => listPages(orgUuid, 1, s.start, s.stop, fs => { checked += fs.length; add(fs); if (onProgress) onProgress({ step: 2, found: all.size, checked }); })));
    const files = [...all.values()].sort((a, b) => tsMicro(b.created_at) - tsMicro(a.created_at));
    return { files, visible };
  }

  // Quick check for one file: read the list starting just above its upload time.
  async function stillExists(orgUuid, f) {
    const t = tsMicro(f.created_at);
    let cursor = `${t + 1}.${MAXU}`;
    for (let i = 0; i < 5; i++) {
      const j = await getJSON(`/api/organizations/${orgUuid}/account/files?limit=1&cursor=${encodeURIComponent(cursor)}`);
      const fs = Array.isArray(j.files) ? j.files : [];
      if (fs.some(x => x.file_uuid === f.file_uuid)) return true;
      if (fs.some(x => tsMicro(x.created_at) < t)) return false;
      cursor = j.next_cursor; if (!cursor) return false;
    }
    return false;
  }

  let pausedUntil = 0; // shared back-off: all workers wait when the server says slow down
  async function waitIfPaused() { while (Date.now() < pausedUntil) { updateProgress(); await sleep(250); } }
  async function deleteFile(orgUuid, uuid) {
    if (DRY) { await sleep(40 + Math.random() * 80); return { ok: true }; }
    for (let attempt = 0; attempt < 6; attempt++) {
      await waitIfPaused();
      let r;
      try {
        r = await pageFetch(`/api/organizations/${orgUuid}/account/files/${uuid}`, {
          method: 'DELETE', credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ fileUuid: uuid }),
        });
      } catch (e) { pausedUntil = Math.max(pausedUntil, Date.now() + 2000 * 2 ** attempt); continue; } // network blip
      if (r.ok || r.status === 404) return { ok: true }; // 204 deleted, 404 already gone (both re-checked at the end)
      if (r.status === 401) throw new AuthError('You were signed out during the run. Sign in again and start a new run.');
      if (r.status === 429 || r.status >= 500) {
        const ra = Number(r.headers.get('retry-after'));
        pausedUntil = Math.max(pausedUntil, Date.now() + (ra > 0 ? ra * 1000 : 2000 * 2 ** attempt));
        continue;
      }
      return { ok: false, status: 'HTTP ' + r.status };
    }
    return { ok: false, status: 'no success after 6 tries' };
  }

  // ---------- state ----------
  const saved = (() => { try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); } catch (e) { return {}; } })();
  const SAFE_DEFAULT = { source: 'all', link: 'unlinked', age: 'any' };
  const S = {
    phase: 'idle', // idle | loading | error | ready | confirm | running | done
    error: '', org: null, files: [], visible: 0, loadedAt: 0, progress: { step: 1, found: 0, checked: 0 }, refreshing: false,
    filters: Object.assign({}, SAFE_DEFAULT), customOpen: false,
    collapsed: !!saved.collapsed, listOpen: false, excluded: new Set(), verified: false,
    run: null, confirmText: '',
  };
  const persist = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify({ collapsed: S.collapsed })); } catch (e) {} };

  const FILTERS = {
    source: {
      label: 'Source',
      options: [['all', 'All sources'], ['chat', 'Chats'], ['session', 'Code / Cowork sessions']],
      test: (v, f) => v === 'all' || (v === 'chat' ? f.surface === 'chat' : f.surface !== 'chat'),
    },
    link: {
      label: 'Used by a chat',
      options: [['unlinked', 'No, not attached to any chat'], ['linked', 'Yes, attached to a chat'], ['any', 'Either']],
      test: (v, f) => v === 'any' || (v === 'linked' ? isLinked(f) : !isLinked(f)),
    },
    age: {
      label: 'Uploaded',
      options: [['any', 'Any time'], ['7', 'More than 7 days ago'], ['30', 'More than 30 days ago'], ['90', 'More than 90 days ago'], ['365', 'More than a year ago']],
      test: (v, f) => v === 'any' || ageDays(f) > Number(v),
    },
  };
  const PRESETS = [
    { id: 'unused', label: 'Unused', title: 'Files that no existing chat uses', filters: { source: 'all', link: 'unlinked', age: 'any' } },
    { id: 'sessions', label: 'Code / Cowork', title: 'Files from Code and Cowork sessions', filters: { source: 'session', link: 'any', age: 'any' } },
    { id: 'everything', label: 'Everything', title: 'Every uploaded file in this account', filters: { source: 'all', link: 'any', age: 'any' } },
  ];
  const sameFilters = (a, b) => Object.keys(FILTERS).every(k => a[k] === b[k]);
  const activePreset = () => { const p = PRESETS.find(p => sameFilters(p.filters, S.filters)); return p && !S.customOpen ? p.id : 'custom'; };
  const matches = (f, filters = S.filters) => Object.entries(FILTERS).every(([k, d]) => d.test(filters[k], f));
  const inScope = () => S.files.filter(f => matches(f));
  const selected = () => inScope().filter(f => !S.excluded.has(f.file_uuid));

  function describe() {
    const f = S.filters;
    if (f.source === 'all' && f.link === 'any' && f.age === 'any') return 'Every uploaded file in this account.';
    let s = f.source === 'chat' ? 'Files uploaded in chats' : f.source === 'session' ? 'Files from Code and Cowork sessions' : 'Files from chats, Code and Cowork';
    if (f.link === 'unlinked') s += ' that no existing chat uses';
    if (f.link === 'linked') s += ' that are still attached to a chat';
    if (f.age !== 'any') s += `, uploaded more than ${f.age === '365' ? 'a year' : f.age + ' days'} ago`;
    return s + '.';
  }
  const consequence = () => S.filters.link === 'unlinked'
    ? 'No chat will lose an attachment.'
    : 'Chats that use these files lose the attachment. Text Claude already read from a file stays in the chat.';
  // Why files are outside the current selection, e.g. "99 attached to a chat".
  function notIncludedReasons() {
    const f = S.filters, out = [];
    const count = (k) => S.files.filter(x => !FILTERS[k].test(f[k], x)).length;
    if (f.link !== 'any') { const n = count('link'); if (n) out.push(`${n.toLocaleString()} ${f.link === 'unlinked' ? 'attached to a chat' : 'not attached to any chat'}`); }
    if (f.source !== 'all') { const n = count('source'); if (n) out.push(`${n.toLocaleString()} from ${f.source === 'chat' ? 'Code / Cowork sessions' : 'chats'}`); }
    if (f.age !== 'any') { const n = count('age'); if (n) out.push(`${n.toLocaleString()} uploaded more recently`); }
    return out;
  }

  // ---------- DOM helpers ----------
  let refs = {};
  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'ref') refs[v] = e;
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of kids.flat(Infinity)) if (c != null && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return e;
  }
  const ICONS = {
    refresh: 'M20 11a8 8 0 1 0-2.34 5.66M20 4v7h-7',
    min: 'M6 9l6 6 6-6',
    trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  };
  function icon(name) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: '16', height: '16', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(k, v);
    const p = document.createElementNS(NS, 'path'); p.setAttribute('d', ICONS[name]); svg.append(p);
    return svg;
  }

  // ---------- styles ----------
  const CSS = `
:host { all: initial; position: fixed; right: 16px; bottom: 16px; z-index: 2147483000; display: flex; justify-content: flex-end;
  font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--fg);
  --bg:#ffffff; --fg:#1f1e1d; --muted:#6f6d68; --border:#e4e1da; --soft:#f5f4f0; --soft2:#e9e7e1; --accent:#c96442;
  --danger:#b42318; --danger-fg:#ffffff; --danger-soft:#fdeceb; --ok-soft:#e7f4ec; --warn-soft:#fdf3dc; --info-soft:#eef2fb;
  --shadow: 0 12px 32px rgba(20,20,19,.18), 0 2px 6px rgba(20,20,19,.08); }
:host(.dark) { --bg:#262624; --fg:#efede7; --muted:#a6a39b; --border:#3e3d3a; --soft:#30302d; --soft2:#3a3a37; --accent:#e08a6b;
  --danger:#d9483e; --danger-soft:#3b2421; --ok-soft:#1f3328; --warn-soft:#3a3020; --info-soft:#232a38; --shadow: 0 12px 32px rgba(0,0,0,.55); }
* { box-sizing: border-box; }
.panel { width: 410px; max-width: calc(100vw - 32px); max-height: min(700px, calc(100vh - 32px)); display: flex; flex-direction: column;
  background: var(--bg); color: var(--fg); border: 1px solid var(--border); border-radius: 14px; box-shadow: var(--shadow); overflow: hidden; }
header { display: flex; align-items: center; gap: 4px; padding: 12px 10px 10px 16px; border-bottom: 1px solid var(--border); }
.titles { flex: 1; min-width: 0; }
.title { font-weight: 600; font-size: 14px; }
.sub { color: var(--muted); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
button { font: inherit; color: inherit; }
.icon { width: 30px; height: 30px; border-radius: 8px; border: 0; background: transparent; color: var(--muted); cursor: pointer; display: grid; place-items: center; flex: none; }
.icon:hover:not(:disabled) { background: var(--soft); color: var(--fg); }
.icon:disabled { opacity: .4; cursor: default; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.body { padding: 14px 16px; overflow: auto; display: flex; flex-direction: column; gap: 12px; }
.stats { color: var(--muted); font-size: 12px; }
.label { color: var(--muted); font-size: 12px; margin-bottom: 6px; }
.seg { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; background: var(--soft); padding: 4px; border-radius: 11px; }
.seg button { border: 0; background: transparent; border-radius: 8px; padding: 6px 4px; cursor: pointer; display: flex; flex-direction: column; align-items: center; gap: 1px; color: var(--muted); line-height: 1.25; }
.seg button .n { font-size: 11px; font-weight: 400; }
.seg button[aria-pressed="true"] { background: var(--bg); color: var(--fg); font-weight: 600; box-shadow: 0 1px 3px rgba(0,0,0,.14); }
.seg button:hover:not([aria-pressed="true"]) { color: var(--fg); }
.filters { display: flex; flex-direction: column; gap: 8px; }
.field { display: grid; grid-template-columns: 112px 1fr; align-items: center; gap: 10px; }
.field label { color: var(--muted); }
select, input[type=text] { width: 100%; padding: 7px 9px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg); color: var(--fg); font: inherit; }
select { cursor: pointer; }
.card { background: var(--soft); border-radius: 10px; padding: 11px 12px; display: flex; flex-direction: column; gap: 4px; }
.big { font-size: 15px; font-weight: 600; }
.muted { color: var(--muted); }
.small { font-size: 12px; }
.linkbtn { background: none; border: 0; padding: 0; color: var(--accent); cursor: pointer; text-align: left; font-weight: 500; }
.linkbtn:hover { text-decoration: underline; }
.listhead { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 6px; }
.list { border: 1px solid var(--border); border-radius: 10px; max-height: 230px; overflow: auto; }
.row { display: grid; grid-template-columns: 18px 1fr; gap: 10px; padding: 7px 10px; border-bottom: 1px solid var(--border); cursor: pointer; align-items: start; }
.row:last-child { border-bottom: 0; }
.row:hover { background: var(--soft); }
.row input { margin: 2px 0 0; accent-color: var(--danger); cursor: pointer; }
.row.off .name { text-decoration: line-through; color: var(--muted); }
.rowtext { min-width: 0; }
.name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
footer { padding: 12px 16px; border-top: 1px solid var(--border); display: flex; gap: 8px; justify-content: flex-end; align-items: center; flex-wrap: wrap; }
footer .hint { flex: 1; min-width: 140px; color: var(--muted); font-size: 12px; }
.btn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 14px; border-radius: 9px; border: 1px solid var(--border); background: var(--bg); color: var(--fg); font-weight: 500; cursor: pointer; }
.btn:hover:not(:disabled) { background: var(--soft); }
.btn.danger { background: var(--danger); border-color: var(--danger); color: var(--danger-fg); }
.btn.danger:hover:not(:disabled) { background: var(--danger); filter: brightness(1.1); }
.btn.primary { background: var(--fg); border-color: var(--fg); color: var(--bg); }
.btn.primary:hover:not(:disabled) { background: var(--fg); opacity: .9; }
.btn:disabled { opacity: .45; cursor: not-allowed; }
.banner { border-radius: 10px; padding: 11px 12px; display: flex; flex-direction: column; gap: 4px; }
.banner.ok { background: var(--ok-soft); } .banner.warn { background: var(--warn-soft); } .banner.err { background: var(--danger-soft); } .banner.info { background: var(--info-soft); }
ul { margin: 4px 0 0; padding-left: 18px; } li { margin: 2px 0; }
.bar { height: 8px; background: var(--soft2); border-radius: 99px; overflow: hidden; }
.fill { height: 100%; width: 0; background: var(--danger); border-radius: 99px; transition: width .25s ease; }
.center { display: flex; align-items: center; gap: 10px; padding: 14px 0 4px; }
.spinner { width: 16px; height: 16px; border: 2px solid var(--soft2); border-top-color: var(--accent); border-radius: 50%; animation: spin .8s linear infinite; flex: none; }
@keyframes spin { to { transform: rotate(360deg); } }
details summary { cursor: pointer; color: var(--muted); }
.pill { display: inline-flex; align-items: center; gap: 8px; padding: 10px 16px; border-radius: 99px; background: var(--bg); color: var(--fg);
  border: 1px solid var(--border); box-shadow: var(--shadow); cursor: pointer; font-weight: 500; }
.pill:hover { background: var(--soft); }
.note:empty { display: none; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
@media (max-width: 640px) {
  :host { left: 8px; right: 8px; bottom: 8px; }
  .panel { width: 100%; max-width: none; max-height: 78vh; }
  .field { grid-template-columns: 1fr; gap: 4px; }
  .seg { grid-template-columns: repeat(2, 1fr); }
}
@media (prefers-reduced-motion: reduce) { .spinner { animation: none; } .fill { transition: none; } }
`;

  // ---------- mount ----------
  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.display = 'none';
  const root = host.attachShadow({ mode: 'open' });
  let styleEl = null;
  try { const sheet = new CSSStyleSheet(); sheet.replaceSync(CSS); root.adoptedStyleSheets = [sheet]; }
  catch (e) { styleEl = document.createElement('style'); styleEl.textContent = CSS; }
  const live = h('div', { class: 'sr', 'aria-live': 'polite' });
  const announce = msg => { live.textContent = msg; };
  document.body.appendChild(host);

  const isDark = () => { const m = document.documentElement.getAttribute('data-mode'); return m ? m === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches; };
  const syncTheme = () => host.classList.toggle('dark', isDark());
  syncTheme();
  const mo = new MutationObserver(syncTheme);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-mode', 'class'] });

  // ---------- render ----------
  function render() {
    const active = root.activeElement;
    const keepKey = active && active.dataset ? active.dataset.key : null;
    const listTop = root.querySelector('.list') ? root.querySelector('.list').scrollTop : 0;
    const bodyTop = root.querySelector('.body') ? root.querySelector('.body').scrollTop : 0;
    refs = {};
    root.replaceChildren();
    if (styleEl) root.append(styleEl);
    if (S.collapsed) root.append(renderPill(), live);
    else root.append(h('div', { class: 'panel', role: 'region', 'aria-label': 'Bulk delete uploaded files' }, renderHeader(), h('div', { class: 'body' }, renderBody()), renderFooter()), live);
    if (keepKey) { const el = root.querySelector(`[data-key="${keepKey}"]`); if (el) el.focus(); }
    if (root.querySelector('.list')) root.querySelector('.list').scrollTop = listTop;
    if (root.querySelector('.body')) root.querySelector('.body').scrollTop = bodyTop;
    if (S.phase === 'running') updateProgress();
  }

  function pillLabel() {
    if (S.phase === 'running' && S.run) { const n = S.run.done + S.run.failed; return `Deleting… ${Math.min(100, Math.round(n / Math.max(1, S.run.total) * 100))}%`; }
    if (S.phase === 'loading' || S.phase === 'idle') return 'Bulk delete · finding files…';
    if (S.phase === 'unsupported') return 'Bulk delete · not available here';
    return `Bulk delete · ${plural(S.files.length, 'file')}`;
  }
  function renderPill() {
    return h('button', { class: 'pill', 'data-key': 'pill', title: 'Open the bulk delete panel', onclick: () => { S.collapsed = false; persist(); render(); } },
      icon('trash'), h('span', { ref: 'pillText' }, pillLabel()));
  }

  function renderHeader() {
    const busy = S.phase === 'running' || S.phase === 'loading' || S.refreshing;
    return h('header', {},
      h('div', { class: 'titles' },
        h('div', { class: 'title' }, 'Bulk delete uploaded files', DRY ? ' (test mode)' : ''),
        h('div', { class: 'sub', title: S.org ? S.org.name : '' }, S.org ? 'Account: ' + S.org.name : 'Finding your account…')),
      h('button', { class: 'icon', 'data-key': 'refresh', title: 'Scan the file list again', 'aria-label': 'Scan the file list again', disabled: busy || S.phase === 'confirm', onclick: () => refresh() }, icon('refresh')),
      h('button', { class: 'icon', 'data-key': 'min', title: 'Minimize', 'aria-label': 'Minimize', onclick: () => { S.collapsed = true; persist(); render(); } }, icon('min')));
  }

  function loadingText() {
    const p = S.progress;
    return p.step === 1
      ? `Reading Claude's file list… ${p.found.toLocaleString()} so far`
      : `Looking for files Claude's list doesn't show… ${p.checked.toLocaleString()} checked, ${plural(p.found, 'file')} found`;
  }
  function updateLoading() { if (refs.loadText) refs.loadText.textContent = loadingText(); if (refs.pillText) refs.pillText.textContent = pillLabel(); }

  function renderBody() {
    switch (S.phase) {
      case 'idle':
      case 'loading':
        return [
          h('div', { class: 'center', role: 'status' }, h('span', { class: 'spinner' }), h('span', { ref: 'loadText' }, loadingText())),
          h('div', { class: 'small muted' }, "Claude's list skips some files, so this also reads it one file at a time. Large accounts can take a minute."),
        ];
      case 'error':
        return h('div', { class: 'banner err', role: 'alert' }, h('strong', {}, "Couldn't load your files"), h('div', {}, S.error));
      case 'unsupported':
        return h('div', { class: 'banner warn', role: 'status' }, h('strong', {}, 'Not available in Team or Enterprise workspaces'),
          h('div', {}, "Claude doesn't offer file deletion to members here, and your admins control how long files are kept. Switch to your personal account to use this panel."));
      case 'ready': return renderReady();
      case 'confirm': return renderConfirm();
      case 'running': return renderRunning();
      case 'done': return renderDone();
    }
    return null;
  }

  function renderReady() {
    const total = S.files.length, hidden = Math.max(0, total - S.visible);
    const stats = h('div', { class: 'stats' },
      `${plural(total, 'file')} · ${fmtBytes(sumBytes(S.files))} on Anthropic's servers · checked ${fmtTime(S.loadedAt)}`,
      hidden ? h('div', {}, `${hidden.toLocaleString()} of these don't show on Claude's own Uploaded files page.`) : null);
    if (!total) return [stats, h('div', { class: 'banner ok' }, h('strong', {}, 'No uploaded files'), h('div', {}, 'There is nothing to delete in this account.'))];

    const preset = activePreset();
    const seg = h('div', {},
      h('div', { class: 'label', id: 'seg-label' }, 'What to delete'),
      h('div', { class: 'seg', role: 'group', 'aria-labelledby': 'seg-label' },
        PRESETS.map(p => h('button', { 'data-key': 'preset-' + p.id, 'aria-pressed': String(preset === p.id), title: p.title,
          onclick: () => { S.filters = Object.assign({}, p.filters); S.customOpen = false; render(); announce(`${p.label}: ${plural(selected().length, 'file')} selected`); } },
          p.label, h('span', { class: 'n' }, S.files.filter(f => matches(f, p.filters)).length.toLocaleString()))),
        h('button', { 'data-key': 'preset-custom', 'aria-pressed': String(preset === 'custom'), title: 'Choose by source, chat use and age',
          onclick: () => { S.customOpen = true; render(); } }, 'Custom', h('span', { class: 'n' }, 'filters'))));

    const filters = preset === 'custom' ? h('div', { class: 'filters' }, Object.entries(FILTERS).map(([k, d]) => h('div', { class: 'field' },
      h('label', { for: 'f-' + k }, d.label),
      (() => {
        const s = h('select', { id: 'f-' + k, 'data-key': 'f-' + k, onchange: e => { S.filters[k] = e.target.value; render(); announce(`${plural(selected().length, 'file')} selected`); } },
          d.options.map(([v, text]) => h('option', { value: v }, `${text} (${S.files.filter(f => matches(f, Object.assign({}, S.filters, { [k]: v }))).length})`)));
        s.value = S.filters[k];
        return s;
      })()))) : null;

    const scope = inScope(), sel = selected();
    const kept = scope.length - sel.length, outside = total - scope.length, reasons = notIncludedReasons();
    const card = h('div', { class: 'card' },
      h('div', { class: 'big' }, `${sel.length.toLocaleString()} of ${plural(total, 'file')} selected`, h('span', { class: 'muted' }, ` · ${fmtBytes(sumBytes(sel))}`)),
      h('div', { class: 'small' }, describe(), ' ', consequence()),
      outside ? h('div', { class: 'small' }, h('strong', {}, `Not included: ${plural(outside, 'file')}`), reasons.length ? ` (${reasons.join('; ')}).` : '.',
        preset !== 'everything' ? [' ', h('button', { class: 'linkbtn', 'data-key': 'pick-everything', onclick: () => { S.filters = Object.assign({}, PRESETS[2].filters); S.customOpen = false; render(); } }, 'Select everything instead')] : null) : null,
      kept ? h('div', { class: 'small muted' }, `${plural(kept, 'file')} you unticked will be kept.`) : null,
      scope.length ? h('button', { class: 'linkbtn small', 'data-key': 'toggleList', 'aria-expanded': String(S.listOpen), onclick: () => { S.listOpen = !S.listOpen; render(); } },
        S.listOpen ? 'Hide the file list' : `Review the ${plural(scope.length, 'file')} before deleting`) : null);
    return [stats, seg, filters, card, S.listOpen && scope.length ? renderList(scope) : null];
  }

  function renderList(scope) {
    const shown = scope.slice(0, 1000);
    return h('div', {},
      h('div', { class: 'listhead small' },
        h('span', { class: 'muted' }, 'Untick any file you want to keep.'),
        h('span', {},
          h('button', { class: 'linkbtn', 'data-key': 'tickAll', onclick: () => { scope.forEach(f => S.excluded.delete(f.file_uuid)); render(); } }, 'Tick all'),
          ' · ',
          h('button', { class: 'linkbtn', 'data-key': 'untickAll', onclick: () => { scope.forEach(f => S.excluded.add(f.file_uuid)); render(); } }, 'Untick all'))),
      h('div', { class: 'list' }, shown.map(f => {
        const on = !S.excluded.has(f.file_uuid);
        const cb = h('input', { type: 'checkbox', 'data-key': 'cb-' + f.file_uuid });
        cb.checked = on;
        cb.addEventListener('change', () => { if (cb.checked) S.excluded.delete(f.file_uuid); else S.excluded.add(f.file_uuid); render(); });
        const meta = [fmtDate(f.created_at), surfaceLabel(f.surface), f.size_bytes != null ? fmtBytes(f.size_bytes) : 'size unknown', isLinked(f) ? `in ${plural(f.conversation_uuids.length, 'chat')}` : 'not in any chat'].join(' · ');
        return h('label', { class: 'row' + (on ? '' : ' off') }, cb,
          h('div', { class: 'rowtext' }, h('div', { class: 'name', title: fileName(f) }, fileName(f)), h('div', { class: 'small muted' }, meta)));
      }), scope.length > shown.length ? h('div', { class: 'row small muted' }, `…and ${(scope.length - shown.length).toLocaleString()} more`) : null));
  }

  const needsTyping = sel => sel.some(isLinked) || sel.length === S.files.length;

  function renderConfirm() {
    const sel = selected(), linked = sel.filter(isLinked).length, outside = S.files.length - sel.length;
    const parts = [h('div', { class: 'banner err' },
      h('div', { class: 'big' }, `Delete ${plural(sel.length, 'file')} (${fmtBytes(sumBytes(sel))})?`),
      h('ul', {},
        h('li', {}, "This can't be undone."),
        h('li', {}, `Account: ${S.org ? S.org.name : ''}`),
        linked
          ? h('li', {}, `${plural(linked, 'file')} ${linked === 1 ? 'is' : 'are'} attached to chats. Those chats lose the attachment. Text Claude already read from a file stays in the chat.`)
          : h('li', {}, 'None of these files is attached to a chat.'),
        outside ? h('li', {}, `${plural(outside, 'file')} ${outside === 1 ? 'stays' : 'stay'}, because ${outside === 1 ? 'it is' : 'they are'} not part of this selection.`) : h('li', {}, 'Nothing stays: this is every file in the account.'),
        h('li', {}, 'When it finishes, it scans again and also deletes any further files that match this selection.'),
        h('li', {}, 'Keep this tab open until it finishes. You can stop at any point.')))];
    if (needsTyping(sel)) {
      const inp = h('input', { type: 'text', id: 'confirm-in', 'data-key': 'confirm-in', autocomplete: 'off', spellcheck: 'false' });
      inp.value = S.confirmText;
      inp.addEventListener('input', () => { S.confirmText = inp.value; if (refs.go) refs.go.disabled = inp.value.trim() !== 'DELETE'; });
      inp.addEventListener('keydown', e => { if (e.key === 'Enter' && inp.value.trim() === 'DELETE') startRun(); });
      parts.push(h('div', { class: 'field' }, h('label', { for: 'confirm-in' }, 'Type DELETE to confirm'), inp));
    }
    return parts;
  }

  function renderRunning() {
    return [
      h('div', { class: 'big', ref: 'runTitle' }),
      h('div', { class: 'bar', role: 'progressbar', 'aria-label': 'Delete progress', 'aria-valuemin': '0', ref: 'bar' }, h('div', { class: 'fill', ref: 'fill' })),
      h('div', { class: 'small muted', ref: 'runMeta' }),
      h('div', { class: 'small note', ref: 'runNote', role: 'status' }),
      h('div', { class: 'small muted name note', ref: 'runCurrent' }),
      h('div', { class: 'small muted' }, 'Keep this tab open. Closing or reloading it stops the run.'),
    ];
  }

  function renderDone() {
    const r = S.run;
    const stuck = r.stuck || [];
    const kind = r.fatal ? 'err' : (r.stopped || stuck.length || r.failed) ? 'warn' : 'ok';
    const title = r.fatal ? 'Stopped because of a problem' : r.stopped ? 'Stopped' : stuck.length ? 'Finished, but some files are still there' : 'Done';
    const deleted = r.verifiedDeleted != null ? r.verifiedDeleted : r.done;
    const bytes = r.verifiedDeleted != null ? r.verifiedBytes : r.bytes;
    const leftOther = r.leftOther || 0;
    return [
      h('div', { class: 'banner ' + kind, role: 'status' },
        h('div', { class: 'big' }, title),
        r.fatal ? h('div', {}, r.fatal) : null,
        h('div', {}, `Deleted ${plural(deleted, 'file')} (${fmtBytes(bytes)})${DRY ? ' (test mode: nothing was really deleted)' : r.verifiedDeleted != null ? ', confirmed by a fresh scan' : ''}.`),
        r.extra ? h('div', {}, `That includes ${plural(r.extra, 'file')} that only turned up after the first pass.`) : null,
        r.verifiedDeleted == null ? h('div', { class: 'small' }, "Couldn't scan again afterwards, so this count is based on Claude's replies.") : null,
        h('div', {}, `${plural(S.files.length, 'file')} left in this account.`),
        leftOther ? h('div', { class: 'small' }, `${plural(leftOther, 'file')} ${leftOther === 1 ? 'was' : 'were'} not part of this selection${r.reasons && r.reasons.length ? ` (${r.reasons.join('; ')})` : ''}.`) : null,
        r.keptCount ? h('div', { class: 'small' }, `${plural(r.keptCount, 'file')} you unticked ${r.keptCount === 1 ? 'was' : 'were'} kept.`) : null),
      stuck.length ? h('details', { open: true }, h('summary', { class: 'small' }, `${plural(stuck.length, 'file')} still listed after two tries`),
        h('ul', { class: 'small' }, stuck.slice(0, 100).map(f => h('li', {}, fileName(f))))) : null,
      r.errors.length ? h('details', {}, h('summary', { class: 'small' }, `Show ${plural(r.errors.length, 'error')}`),
        h('ul', { class: 'small' }, r.errors.slice(0, 100).map(e => h('li', {}, `${e.name} (${e.status})`)))) : null,
      h('div', { class: 'small muted' }, "Reload the page to refresh Claude's table. It never shows some Code / Cowork files."),
    ];
  }

  function renderFooter() {
    switch (S.phase) {
      case 'idle':
      case 'loading':
        return null;
      case 'error':
        return h('footer', {}, h('button', { class: 'btn primary', 'data-key': 'retry', onclick: () => refresh() }, 'Try again'));
      case 'ready': {
        const sel = selected();
        if (!S.files.length) return h('footer', {}, h('span', { class: 'hint' }, 'Nothing to delete.'));
        return h('footer', {},
          h('span', { class: 'hint' }, 'Nothing is deleted until you confirm.'),
          h('button', { class: 'btn danger', 'data-key': 'delete', disabled: !sel.length, onclick: () => { S.phase = 'confirm'; S.confirmText = ''; render(); focusConfirm(); } },
            icon('trash'), sel.length ? `Delete ${plural(sel.length, 'file')}…` : 'Nothing selected'));
      }
      case 'confirm': {
        const sel = selected();
        return h('footer', {},
          h('button', { class: 'btn', 'data-key': 'cancel', onclick: cancelConfirm }, 'Cancel'),
          h('button', { class: 'btn danger', 'data-key': 'go', ref: 'go', disabled: needsTyping(sel) && S.confirmText.trim() !== 'DELETE', onclick: startRun }, icon('trash'), `Delete ${plural(sel.length, 'file')}`));
      }
      case 'running':
        return h('footer', {}, h('button', { class: 'btn', 'data-key': 'stop', ref: 'stop', onclick: () => { S.run.stopRequested = true; updateProgress(); } }, 'Stop'));
      case 'done': {
        const r = S.run;
        return h('footer', {},
          r && r.leftOther && activePreset() !== 'everything'
            ? h('button', { class: 'btn', 'data-key': 'rest', onclick: () => { S.filters = Object.assign({}, PRESETS[2].filters); S.customOpen = false; S.phase = 'ready'; S.run = null; render(); } }, 'Select the rest')
            : null,
          h('button', { class: 'btn', 'data-key': 'back', onclick: () => { S.phase = 'ready'; S.run = null; render(); } }, 'Back'),
          h('button', { class: 'btn primary', 'data-key': 'reload', onclick: () => location.reload() }, 'Reload page'));
      }
    }
    return null;
  }

  function focusConfirm() { const el = root.querySelector('[data-key="confirm-in"]') || root.querySelector('[data-key="cancel"]'); if (el) el.focus(); }
  function cancelConfirm() { S.phase = 'ready'; S.confirmText = ''; render(); const b = root.querySelector('[data-key="delete"]'); if (b) b.focus(); }
  root.addEventListener('keydown', e => { if (e.key === 'Escape' && S.phase === 'confirm') { e.stopPropagation(); cancelConfirm(); } });

  let lastAnnounced = -1;
  function updateProgress() {
    if (S.phase !== 'running' || !S.run) return;
    const r = S.run, n = r.done + r.failed, pct = Math.min(100, r.total ? Math.round(n / r.total * 100) : 0);
    if (refs.pillText) refs.pillText.textContent = pillLabel();
    if (!refs.fill) return;
    refs.runTitle.textContent = r.stopRequested ? 'Stopping after the deletes already in progress…'
      : r.checking ? 'Checking the result…'
      : `Deleting ${Math.min(n, r.total).toLocaleString()} of ${plural(r.total, 'file')}${r.pass > 1 ? ` (pass ${r.pass})` : ''}`;
    refs.fill.style.width = pct + '%';
    refs.bar.setAttribute('aria-valuenow', String(pct));
    const elapsed = (Date.now() - r.startedAt) / 1000, rate = n / Math.max(elapsed, 0.001), left = rate > 0 ? (r.total - n) / rate : 0;
    refs.runMeta.textContent = `${pct}% · ${fmtBytes(r.bytes)} removed${r.failed ? ` · ${r.failed} failed` : ''}${n >= 3 && !r.stopRequested && !r.checking && n < r.total ? ` · about ${fmtDur(left)} left` : ''}`;
    const wait = pausedUntil - Date.now();
    refs.runNote.textContent = r.note || (wait > 0 ? `Pausing ${Math.ceil(wait / 1000)} s because Claude asked to slow down. It continues by itself.` : '');
    refs.runCurrent.textContent = r.current && !r.checking ? 'Now: ' + r.current : '';
    if (refs.stop) { refs.stop.disabled = !!r.stopRequested; refs.stop.textContent = r.stopRequested ? 'Stopping…' : 'Stop'; }
    const q = Math.floor(pct / 25); if (q !== lastAnnounced) { lastAnnounced = q; announce(`${pct}% done`); }
  }

  // ---------- actions ----------
  async function refresh() {
    if (S.phase === 'running' || S.phase === 'loading' || S.refreshing) return;
    S.phase = 'loading'; S.progress = { step: 1, found: 0, checked: 0 };
    render();
    try {
      S.org = await getOrg();
      if (S.org.workspace) { S.files = []; S.loadedAt = Date.now(); S.phase = 'unsupported'; render(); return; }
      render();
      const res = await scanAll(S.org.uuid, p => { S.progress = p; updateLoading(); });
      S.files = res.files; S.visible = res.visible; S.loadedAt = Date.now(); S.error = '';
      const ids = new Set(S.files.map(f => f.file_uuid));
      for (const id of [...S.excluded]) if (!ids.has(id)) S.excluded.delete(id);
      S.phase = 'ready';
    } catch (e) {
      S.error = e.message; S.phase = 'error';
    }
    render();
  }

  const guardUnload = e => { e.preventDefault(); e.returnValue = ''; };

  async function startRun() {
    if (S.phase !== 'confirm') return;
    const first = selected();
    if (!first.length || (needsTyping(first) && S.confirmText.trim() !== 'DELETE')) return;
    const org = S.org, filters = Object.assign({}, S.filters), kept = new Set(S.excluded);
    const byId = new Map(S.files.map(f => [f.file_uuid, f]));
    const attempts = new Map();
    let deletesSinceScan = false, lastScan = null;
    S.phase = 'running';
    S.run = { total: first.length, done: 0, failed: 0, bytes: 0, startedAt: Date.now(), current: '', note: '', errors: [], stopRequested: false, stopped: false, fatal: '', consecutiveFail: 0, pass: 1, extra: 0, checking: false, stuck: [], verifiedDeleted: null, verifiedBytes: 0 };
    lastAnnounced = -1;
    render();
    const stopBtn = root.querySelector('[data-key="stop"]'); if (stopBtn) stopBtn.focus();
    window.addEventListener('beforeunload', guardUnload);

    const doOne = async f => {
      const r = S.run;
      attempts.set(f.file_uuid, (attempts.get(f.file_uuid) || 0) + 1); byId.set(f.file_uuid, f); deletesSinceScan = true;
      r.current = fileName(f); updateProgress();
      let res;
      try { res = await deleteFile(org.uuid, f.file_uuid); }
      catch (e) { if (e instanceof AuthError) { r.fatal = e.message; r.stopRequested = true; return false; } res = { ok: false, status: e.message }; }
      if (res.ok) { r.done++; r.bytes += f.size_bytes || 0; r.consecutiveFail = 0; }
      else {
        r.failed++; r.consecutiveFail++; r.errors.push({ name: fileName(f), status: res.status });
        if (r.consecutiveFail >= 5 && !r.fatal) { r.fatal = `Five deletes in a row failed (last: ${res.status}), so the run stopped to be safe.`; r.stopRequested = true; }
      }
      updateProgress();
      return res.ok;
    };
    const runQueue = async list => {
      let next = 0;
      const worker = async () => { while (!S.run.stopRequested) { const i = next++; if (i >= list.length) return; await doOne(list[i]); } };
      await Promise.all(Array.from({ length: Math.min(DELETE_WORKERS, list.length) }, worker));
    };
    const scan = async label => {
      S.run.checking = true; S.run.note = label; updateProgress();
      const res = await scanAll(org.uuid, p => { S.run.note = `${label} ${p.checked ? p.checked.toLocaleString() + ' checked' : p.found.toLocaleString() + ' read'}`; updateProgress(); }, [...byId.values()]);
      S.run.checking = false; S.run.note = ''; deletesSinceScan = false; lastScan = res;
      return res;
    };

    try {
      // First file alone, then confirm it is really gone before touching the rest.
      const firstOk = await doOne(first[0]);
      if (!firstOk && !S.run.fatal) S.run.fatal = 'The first delete failed, so nothing else was touched.';
      if (firstOk && !DRY && !S.verified && !S.run.stopRequested) {
        S.run.note = 'Checking that the first delete worked…'; updateProgress();
        const still = await stillExists(org.uuid, first[0]);
        S.run.note = '';
        if (still) S.run.fatal = "The first delete didn't remove the file, so nothing else was touched.";
        else S.verified = true;
      }
      if (!S.run.fatal && !S.run.stopRequested) await runQueue(first.slice(1));
      // Scan again; delete files that still match (late arrivals, or deletes that didn't take). At most two tries per file.
      for (let pass = 2; !DRY && pass <= MAX_EXTRA_PASSES + 1 && !S.run.fatal && !S.run.stopRequested; pass++) {
        const res = await scan('Scanning again to make sure nothing matching is left…');
        const left = res.files.filter(f => matches(f, filters) && !kept.has(f.file_uuid));
        const retry = left.filter(f => (attempts.get(f.file_uuid) || 0) < 2);
        if (!retry.length) break;
        const fresh = retry.filter(f => !attempts.has(f.file_uuid)).length;
        S.run.extra += fresh; S.run.total += fresh; S.run.pass = pass;
        S.run.note = fresh ? `Found ${plural(fresh, 'more matching file')} that Claude's list had been hiding. Deleting ${fresh === 1 ? 'it' : 'them'} too.` : `Trying again on ${plural(retry.length, 'file')} that ${retry.length === 1 ? 'is' : 'are'} still listed.`;
        updateProgress();
        await runQueue(retry);
        S.run.note = '';
      }
    } catch (e) {
      S.run.fatal = S.run.fatal || e.message;
    }

    // Final numbers come from a fresh scan, not from the server's replies.
    const r = S.run;
    try {
      let present;
      if (DRY) {
        present = new Set(S.files.map(f => f.file_uuid)); for (const id of attempts.keys()) present.delete(id);
        S.files = S.files.filter(f => present.has(f.file_uuid));
      } else {
        const res = (!lastScan || deletesSinceScan) ? await scan('Counting what is left…') : lastScan;
        S.files = res.files; S.visible = res.visible; S.loadedAt = Date.now();
        present = new Set(res.files.map(f => f.file_uuid));
      }
      const ids = [...attempts.keys()];
      const gone = ids.filter(id => !present.has(id));
      r.verifiedDeleted = gone.length;
      r.verifiedBytes = gone.reduce((s, id) => s + ((byId.get(id) || {}).size_bytes || 0), 0);
      r.stuck = ids.filter(id => present.has(id)).map(id => byId.get(id));
    } catch (e) {
      r.verifiedDeleted = null; r.stuck = [];
    }
    r.keptCount = S.files.filter(f => kept.has(f.file_uuid)).length;
    r.leftOther = S.files.filter(f => !matches(f, filters)).length;
    r.reasons = notIncludedReasons();
    window.removeEventListener('beforeunload', guardUnload);
    r.stopped = r.stopRequested && !r.fatal;
    r.current = ''; r.checking = false; r.note = '';
    S.excluded.clear(); S.confirmText = '';
    S.phase = 'done';
    announce(`Finished. Deleted ${plural(r.verifiedDeleted != null ? r.verifiedDeleted : r.done, 'file')}.`);
    render();
    const focusEl = root.querySelector('[data-key="reload"]'); if (focusEl) focusEl.focus();
  }

  // ---------- visibility and housekeeping ----------
  let shown = false;
  function tick() {
    const show = PAGE_RE.test(location.href) || S.phase === 'running';
    host.style.display = show ? '' : 'none';
    if (show) {
      const idle = ['ready', 'error', 'done', 'unsupported'].includes(S.phase);
      const switched = S.org && activeOrgId() && activeOrgId() !== S.org.uuid;
      // Scan again every time the page is opened, so the panel never shows an old result.
      if (S.phase === 'idle' || (!shown && idle) || (switched && idle)) {
        if (S.phase === 'done') { S.phase = 'ready'; S.run = null; }
        refresh();
      }
    }
    if (S.phase === 'running' && pausedUntil > Date.now()) updateProgress();
    shown = show;
  }
  const timer = setInterval(tick, 700);
  window.__ccCleanerTimer = timer;
  window.addEventListener('hashchange', tick);
  window.addEventListener('popstate', tick);
  const onVisible = () => {
    if (document.hidden || !PAGE_RE.test(location.href)) return;
    if (['ready', 'error', 'unsupported'].includes(S.phase) && Date.now() - S.loadedAt > 10000) refresh();
  };
  document.addEventListener('visibilitychange', onVisible);

  function destroy() {
    clearInterval(timer); mo.disconnect();
    window.removeEventListener('hashchange', tick); window.removeEventListener('popstate', tick);
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('beforeunload', guardUnload);
    host.remove();
  }
  window.__ccCleaner = { destroy, version: '2.3', state: () => S, selected, scanAll, stillExists };

  render();
  tick();
})();
