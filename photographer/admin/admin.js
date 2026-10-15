import { $, api, element, jobText } from '../booth/common.js';
let selectedPhoto, refreshing = false, URLs = [], lastNotificationCount = 0;
const request = (path, opts = {}) => api(`/admin${path}`, opts);
const guard = fn => async e => { e?.preventDefault(); $('error').textContent = ''; try { await fn(); } catch (e) { $('error').textContent = e.message; } };
function button(text, action, cls) { const b = element('button', text, cls); b.onclick = guard(action); return b; }
async function privateImage(path) {
  const r = await fetch(`/api/wiss/admin${path}`);
  if (!r.ok) throw new Error('画像を取得できません');
  const url = URL.createObjectURL(await r.blob()); URLs.push(url); return url;
}
function dispose() { URLs.forEach(URL.revokeObjectURL); URLs = []; }
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const [data, stats] = await Promise.all([request('/dashboard'), request('/analytics')]);
    dispose(); $('dashboard').hidden = false;
    $('counts').textContent = `作成待ち ${data.counts.pending} / 作成中 ${data.counts.processing} / 公開 ${data.counts.published}`;
    $('notifications').replaceChildren(...data.notifications.slice(-10).reverse().map(n => {
      const b = button(`${new Date(n.capturedAt).toLocaleString()} / ${n.subjectCount}人 / ${n.sessionId}`, () => selectPhoto(data.photos.find(p => p.id === n.photoId)), 'secondary'); return b;
    }));
    if (data.notifications.length > lastNotificationCount && lastNotificationCount > 0) $('error').textContent = '新しいフレーム化待ち写真が保存されました。';
    lastNotificationCount = data.notifications.length;
    $('photos').replaceChildren();
    for (const p of data.photos.slice().reverse()) {
      const c = element('div', undefined, 'card');
      if (p.research || p.publication) { const img = element('img'); img.className = 'thumb'; img.alt = '元写真'; img.src = await privateImage(`/photos/${p.id}/image`); c.append(img); }
      c.append(element('p', `${new Date(p.capturedAt).toLocaleString()}\n${p.sessionId}\n${p.subjectCount}人 / ${p.status}\n研究：${p.research ? '同意' : '不同意'} / 公開：${p.publication ? '同意' : '不同意'}`, 'status'));
      if (p.research || p.publication) c.append(button('元写真をダウンロード', async () => download(await privateImage(`/photos/${p.id}/image`), `${p.id}-original.jpg`), 'secondary'));
      if (p.publication && p.status !== 'published') {
        c.append(button('フレームを登録', () => selectPhoto(p)));
        for (const [status, title] of [['processing', '作成中'], ['rejected', '対象外'], ['pending', '作成待ち']]) c.append(button(title, async () => { await request(`/photos/${p.id}`, { method: 'PATCH', body: { status } }); await refresh(); }, 'secondary'));
      }
      $('photos').append(c);
    }
    $('references').replaceChildren();
    for (const r of data.references) {
      const c = element('div', undefined, 'card'), frame = element('div', undefined, 'frame');
      const img = element('img'); img.src = await privateImage(`/references/${r.id}/reference`); img.alt = r.name;
      const overlay = element('img'); overlay.className = 'overlay'; overlay.alt = 'フレーム'; overlay.src = await privateImage(`/references/${r.id}/box`); frame.append(img, overlay);
      const kind = element('select');
      for (const v of r.variants) { const o = element('option', v.kind); o.value = v.kind; kind.append(o); }
      kind.onchange = guard(async () => { overlay.src = await privateImage(`/references/${r.id}/${kind.value}`); });
      c.append(frame, element('h3', r.name), element('p', `${r.subjectCount}人 / ${r.status}`), kind);
      const usage = stats.frames.filter(v => v.referenceId === r.id).reduce((n, v) => n + v.captured, 0); c.append(element('p', `撮影利用：${usage}回`));
      c.append(button(r.status === 'published' ? '非公開にする' : 'ライブラリに公開', async () => { await request(`/references/${r.id}`, { method: 'PATCH', body: { status: r.status === 'published' ? 'ready' : 'published' } }); await refresh(); }));
      c.append(button('削除', async () => { if (confirm('このフレームをライブラリから削除しますか？')) { await request(`/references/${r.id}`, { method: 'PATCH', body: { status: 'deleted' } }); await refresh(); } }, 'danger'));
      $('references').append(c);
    }
    const table = element('table'), head = element('tr'); ['フレーム', '種類', '出典', '閲覧', '提案', '確定', '撮影'].forEach(t => head.append(element('th', t))); table.append(head);
    for (const r of stats.frames) { const tr = element('tr'); [r.name, r.kind, r.origin, r.viewed, r.proposed, r.activated, r.captured].forEach(v => tr.append(element('td', v))); table.append(tr); }
    $('analytics').replaceChildren(table);
    for (const [title, rows, key] of [['種類別', stats.byKind, 'kind'], ['出典別', stats.byOrigin, 'origin']]) {
      $('analytics').append(element('h3', title));
      for (const r of rows) $('analytics').append(element('p', `${r[key]}：閲覧 ${r.viewed} / 提案 ${r.proposed} / 確定 ${r.activated} / 撮影 ${r.captured}`));
    }
    $('analytics').append(element('h3', 'セッション別人数'));
    for (const s of stats.sessions) $('analytics').append(element('p', `${s.sessionId}：${s.subjectCount}人`));
    $('recent').textContent = stats.recent.slice(0, 12).map(e => `${new Date(e.timestamp).toLocaleString()} ${e.eventType} ${e.subjectCount ? `${e.subjectCount}人` : ''}`).join('\n');
    $('jobs').replaceChildren();
    for (const j of data.jobs) {
      const row = element('p', `${j.id}\n${jobText([j])}`);
      if (j.status === 'uncertain') for (const [resolution, title] of [['delivered', '配送済みを確認'], ['retry', '未配送を確認して再送']]) row.append(button(title, async () => { await request(`/jobs/${encodeURIComponent(j.id)}/resolve`, { method: 'POST', body: { resolution } }); await refresh(); }));
      $('jobs').append(row);
    }
    const fromLink = location.hash.slice(1);
    if (fromLink && !selectedPhoto) { const p = data.photos.find(p => p.id === fromLink); if (p?.publication) selectPhoto(p); }
  } finally { refreshing = false; }
}
function selectPhoto(p) { if (!p) return; selectedPhoto = p; $('editor').hidden = false; $('editing').textContent = `元写真：${p.id}`; $('register').elements.subjectCount.value = p.subjectCount; $('editor').scrollIntoView({ behavior: 'smooth' }); }
$('initial').onsubmit = guard(async () => { const p = await request('/initial-photos', { method: 'POST', body: new FormData($('initial')) }); $('initial').reset(); await refresh(); selectPhoto(p); });
let previewURLs = [];
function preview() {
  previewURLs.forEach(URL.revokeObjectURL); previewURLs = [];
  for (const [field, target] of [['reference', 'referencePreview'], [$('previewKind').value, 'framePreview']]) {
    const file = $('register').elements[field].files[0];
    $(target).hidden = !file;
    if (file) { const url = URL.createObjectURL(file); previewURLs.push(url); $(target).src = url; }
  }
}
$('register').onchange = preview;
$('register').onsubmit = guard(async () => { if (!selectedPhoto) throw new Error('写真を選択してください'); await request(`/photos/${selectedPhoto.id}/reference`, { method: 'POST', body: new FormData($('register')) }); $('editor').hidden = true; selectedPhoto = null; $('register').reset(); preview(); await refresh(); });
function download(url, name) { const a = element('a'); a.href = url; a.download = name; a.click(); }
async function csv(type) { const r = await fetch(`/api/wiss/admin/export.csv?type=${type}`); if (!r.ok) throw new Error('CSV取得に失敗しました'); const url = URL.createObjectURL(await r.blob()); download(url, `wiss-${type}.csv`); setTimeout(() => URL.revokeObjectURL(url), 10000); }
for (const [id, type] of [['csvFrames', 'frames'], ['csvSessions', 'sessions'], ['csvEvents', 'events']]) $(id).onclick = guard(() => csv(type));
$('retry').onclick = guard(async () => { await request('/retry', { method: 'POST' }); await refresh(); });
// Poll only outside the editor to avoid disturbing manual preview work.
setInterval(() => { if ($('editor').hidden) refresh().catch(e => { $('error').textContent = e.message; }); }, 15000);

refresh().catch(e => { $('error').textContent = e.message; });
