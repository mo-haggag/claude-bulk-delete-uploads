// Simplified Settings > Privacy > Uploaded files page for the live demo.
// Like claude.ai, its table loads files 50 at a time, so some Code / Cowork files never show up here.
(() => {
  'use strict';
  const ORG = '9f1c2e4a-0d3b-4c56-8e7f-1a2b3c4d5e6f';
  const PRIVACY = '#settings/data-privacy-controls';
  const FILES = PRIVACY + '/uploaded-files';
  const content = document.getElementById('settings-content');
  const overlay = document.getElementById('overlay');

  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of kids.flat()) if (c != null && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return e;
  }
  const fmtBytes = b => b == null ? '' : b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : b >= 1024 ? (b / 1024).toFixed(1) + ' KB' : b + ' B';
  const fmtDate = s => new Date(s).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  const toast = msg => { const t = h('div', { class: 'toast', role: 'status' }, msg); document.body.append(t); setTimeout(() => t.remove(), 2200); };
  const trashIcon = () => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', '18'); s.setAttribute('height', '18'); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '2'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3'); s.append(p); return s; };

  function renderPrivacy() {
    content.replaceChildren(
      h('h2', {}, 'Privacy'),
      h('p', { class: 'lead' }, 'Control how your data is used and stored.'),
      h('div', { class: 'row' }, h('div', {}, h('div', { class: 'title' }, 'Help improve our AI models'), h('div', { class: 'help' }, 'Allow the use of your chats and coding sessions for training.')), h('span', { class: 'toggle', 'aria-label': 'Off' })),
      h('h2', { style: 'margin-top:22px' }, 'Your data'),
      h('div', { class: 'row' }, h('div', { class: 'title' }, 'Export data'), h('button', { class: 'btn', type: 'button', disabled: true }, 'Export data')),
      h('div', { class: 'row' }, h('div', { class: 'title' }, 'Shared chats'), h('button', { class: 'btn', type: 'button', disabled: true }, 'Manage')),
      h('div', { class: 'row' }, h('div', { class: 'title' }, 'Uploaded files'), h('a', { class: 'btn', href: FILES, id: 'manage-files' }, 'Manage')),
      h('div', { class: 'row' }, h('div', { class: 'title' }, 'Your feedback'), h('button', { class: 'btn', type: 'button', disabled: true }, 'Manage')),
    );
  }

  function renderFiles() {
    const tbody = h('tbody');
    const moreBtn = h('button', { class: 'btn', type: 'button', hidden: true }, 'Load more');
    const more = h('div', { class: 'more' }, moreBtn);
    const status = h('div', { class: 'empty' }, 'Loading…');
    content.replaceChildren(
      h('a', { class: 'back', href: PRIVACY }, '← Privacy'),
      h('h2', {}, 'Uploaded files'),
      h('p', { class: 'lead' }, 'Deleting a file removes it from storage. Text already pulled into a chat stays in that chat; delete the chat to remove it.'),
      h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Uploaded'), h('th', {}, 'Surface'), h('th', {}, 'Location'), h('th', {}, 'Delete'))), tbody),
      status, more);
    let cursor = null;
    const addRow = f => {
      const tr = h('tr', {},
        h('td', {}, h('div', { class: 'fname', title: f.file_name }, f.file_name || ''), h('div', { class: 'fsize' }, fmtBytes(f.size_bytes))),
        h('td', {}, fmtDate(f.created_at)),
        h('td', {}, h('span', { class: 'tag' }, f.surface === 'chat' ? 'Chat' : 'Code')),
        h('td', {}, f.conversation_uuids.length ? '1 chat' : 'No chat'),
        h('td', {}, h('button', { class: 'trash', type: 'button', 'aria-label': 'Delete ' + (f.file_name || 'file'), onclick: async () => {
          const r = await fetch(`/api/organizations/${ORG}/account/files/${f.file_uuid}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fileUuid: f.file_uuid }) });
          if (r.ok) { tr.remove(); toast('File deleted'); if (!tbody.children.length && !cursor) status.textContent = 'No uploaded files.', status.hidden = false; }
        } }, trashIcon())));
      tbody.append(tr);
    };
    const loadPage = async () => {
      moreBtn.disabled = true;
      const r = await fetch(`/api/organizations/${ORG}/account/files?limit=50${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`);
      const j = await r.json();
      j.files.forEach(addRow);
      cursor = j.next_cursor;
      moreBtn.hidden = !cursor; moreBtn.disabled = false;
      status.hidden = tbody.children.length > 0;
      if (!tbody.children.length && !cursor) status.textContent = 'No uploaded files.';
    };
    moreBtn.addEventListener('click', loadPage);
    loadPage();
  }

  function route() {
    const hash = location.hash;
    if (!hash.startsWith(PRIVACY)) { overlay.classList.remove('open'); return; }
    overlay.classList.add('open');
    if (hash.startsWith(FILES)) renderFiles(); else renderPrivacy();
  }

  document.getElementById('reset').addEventListener('click', () => {
    if (confirm('Put all the demo files back?')) { window.cfcDemo.reset(); location.reload(); }
  });
  const themeBtn = document.getElementById('theme');
  const setTheme = m => { document.documentElement.setAttribute('data-mode', m); themeBtn.textContent = m === 'dark' ? 'Light mode' : 'Dark mode'; try { localStorage.setItem('cfcDemoTheme', m); } catch (e) {} };
  themeBtn.addEventListener('click', () => setTheme(document.documentElement.getAttribute('data-mode') === 'dark' ? 'light' : 'dark'));
  try { const saved = localStorage.getItem('cfcDemoTheme'); if (saved) setTheme(saved); } catch (e) {}

  window.addEventListener('hashchange', route);
  if (!location.hash) location.hash = PRIVACY; else route();
})();
