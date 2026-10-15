import { $, api, element, imageURL, socketUrl, draw43, blobOf, jobText } from './common.js';
let credentials = JSON.parse(localStorage.getItem('wiss-photographer') || 'null');
let state, ws, stream, draft, uploading = false, previewURL, stopped = false;
const guard = fn => async () => { $('error').textContent = ''; try { await fn(); } catch (e) { $('error').textContent = e.message; } };
const request = (path = '', opts = {}) => api(`/sessions/${credentials.sessionId}${path}`, { token: credentials.token, ...opts });
function render(s) {
  state = s;
  $('start').hidden = true; $('session').hidden = false;
  $('joinCode').textContent = s.joinCode;
  $('mode').textContent = s.mode === 'free' ? '自由撮影 / フレームなし' : s.reference?.name || 'フレーム撮影';
  const variant = s.reference?.variants.find(v => v.id === s.activeFrameId);
  $('overlay').hidden = !variant;
  if (variant) $('overlay').src = variant.imageURL;
  $('subjects').textContent = s.subjects.map((p, i) => `${i + 1}人目 ${p.connected ? '● 接続中' : '○ 未接続'}${p.id === s.representativeId ? ' / 代表者' : ''}\n研究: ${p.consent.research ? '同意' : '不同意'} / 公開: ${p.consent.publication ? '同意' : '不同意'}${p.consent.answered ? '' : ' / 未回答'}`).join('\n\n') || '参加を待っています';
  const previous = $('representative').value;
  $('representative').replaceChildren(...s.subjects.map((p, i) => { const o = element('option', `${i + 1}人目`); o.value = p.id; return o; }));
  $('representative').value = s.subjects.some(p => p.id === previous) ? previous : s.representativeId || '';
  $('proposals').textContent = s.proposals.map(p => `${s.subjects.findIndex(x => x.id === p.subjectId) + 1}人目：${p.name} / ${p.kind}`).join('\n') || '被写体からの提案を待っています';
  $('capture').disabled = !stream || uploading || !!draft || s.closed || !s.subjects.length || !s.subjects.every(p => p.consent.answered);
  $('photos').replaceChildren(...s.photos.filter(p => p.decision === 'saved' || p.decision === 'draft').map(p => {
    const card = element('div'), img = element('img'); img.className = 'thumb'; img.alt = '撮影写真'; img.src = imageURL(p.imageURL, credentials.token); card.append(img);
    card.append(element('p', p.decision === 'draft' ? '保存・削除の選択待ち' : jobText(p.jobs), 'status'));
    if (p.decision === 'draft') { const b = element('button', '保存・削除を選ぶ'); b.onclick = () => review(p); card.append(b); }
    return card;
  }));
}
function connect() {
  if (stopped) return;
  ws = new WebSocket(socketUrl(credentials));
  ws.onopen = () => { $('connection').textContent = '接続中'; };
  ws.onmessage = e => { if (typeof e.data === 'string') { const p = JSON.parse(e.data); if (p.type === 'state') render(p.session); } };
  ws.onclose = e => { $('connection').textContent = '未接続'; if (e.code === 4000) { stopped = true; $('error').textContent = '別の画面で接続されました。この画面を閉じてください。'; return; } if (!stopped) setTimeout(connect, 2000); };
}
async function initialize() {
  render(await request());
  const links = await request('/links'); $('joinQR').src = links.joinQR; $('shareQR').src = links.shareQR; $('shareLink').href = links.shareURL;
  connect();
}
$('create').onclick = guard(async () => { credentials = await api('/sessions', { method: 'POST' }); localStorage.setItem('wiss-photographer', JSON.stringify(credentials)); await initialize(); });
$('camera').onclick = guard(async () => {
  stream?.getTracks().forEach(t => t.stop());
  stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1600 }, height: { ideal: 1200 } }, audio: false });
  $('video').srcObject = stream; await $('video').play(); render(state);
});
const liveCanvas = document.createElement('canvas'); let sending = false;
setInterval(async () => {
  if (!stream || sending || ws?.readyState !== WebSocket.OPEN || ws.bufferedAmount > 512 * 1024 || !$('video').videoWidth) return;
  sending = true;
  try { draw43($('video'), liveCanvas, 640); const blob = await blobOf(liveCanvas); if (blob && ws.readyState === WebSocket.OPEN) ws.send(blob); } finally { sending = false; }
}, 150);
function review(p) {
  draft = p; $('reviewImage').src = imageURL(p.imageURL, credentials.token);
  $('consentSummary').textContent = `共有Drive：保存します。研究Drive：${p.research ? '全員同意のため保存します' : '保存しません'}。ライブラリ再利用：${p.publication ? '全員同意あり' : '許可なし'}。`;
  $('reviewError').textContent = ''; $('review').showModal(); render(state);
}
$('capture').onclick = guard(async () => {
  uploading = true; render(state);
  try {
    const c = document.createElement('canvas'); draw43($('video'), c);
    const form = new FormData(); form.append('captureId', crypto.randomUUID()); form.append('expectedVersion', state.version); form.append('photo', await blobOf(c), 'capture.jpg');
    const p = await request('/photos', { method: 'POST', body: form }); review(p);
  } finally { uploading = false; render(state); }
});
async function decide(decision) {
  $('save').disabled = $('delete').disabled = true;
  try { await request(`/photos/${draft.id}/decision`, { method: 'POST', body: { decision } }); draft = null; $('review').close(); render(await request()); }
  catch (e) { $('reviewError').textContent = e.message; }
  finally { $('save').disabled = $('delete').disabled = false; }
}
$('save').onclick = () => decide('saved'); $('delete').onclick = () => decide('deleted');
$('review').addEventListener('cancel', e => e.preventDefault());
$('free').onclick = guard(async () => render(await request('/active-frame', { method: 'PUT', body: { frameId: null, expectedVersion: state.version } })));
$('transfer').onclick = guard(async () => render(await request('/representative', { method: 'POST', body: { subjectId: $('representative').value, expectedVersion: state.version } })));
$('retry').onclick = guard(async () => { await request('/retry', { method: 'POST' }); render(await request()); });
$('end').onclick = guard(async () => { if (!confirm('撮影を終了しますか？保存写真の共有リンクは引き続き使えます。')) return; await request('/close', { method: 'POST' }); stopped = true; ws?.close(); stream?.getTracks().forEach(t => t.stop()); localStorage.removeItem('wiss-photographer'); location.reload(); });
setInterval(() => { if (credentials && !stopped && !$('review').open) request().then(render).catch(e => { $('error').textContent = e.message; }); }, 5000);
if (credentials) guard(initialize)();
