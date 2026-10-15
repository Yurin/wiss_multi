export const $ = id => document.getElementById(id);
export function element(tag, text, className) { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (className) e.className = className; return e; }
export async function api(path, { token, method = 'GET', body } = {}) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  if (body && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const response = await fetch(`/api/wiss${path}`, { method, headers, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined });
  if (!response.ok) { const result = await response.json().catch(() => ({})); throw new Error(result.error || `通信エラー ${response.status}`); }
  return response.json();
}
export function imageURL(path, token) { return `${path}?token=${encodeURIComponent(token)}`; }
export function socketUrl(session) { return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/wiss?sessionId=${session.sessionId}&token=${encodeURIComponent(session.token)}`; }
// One center-crop equation for live video and capture. No mirroring or overlay
// is baked into the saved photo; guides use the same normalized 4:3 viewport.
export function draw43(video, canvas, width = 1600) {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) throw new Error('カメラの準備を待ってください');
  const sw = Math.min(vw, vh * 4 / 3), sh = sw * 3 / 4;
  canvas.width = width; canvas.height = width * 3 / 4;
  canvas.getContext('2d').drawImage(video, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, canvas.width, canvas.height);
}
export const blobOf = canvas => new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', .92));
export function jobText(jobs) { return jobs.map(j => `${{ shared: '共有Drive', research: '研究Drive', mail: 'メール' }[j.destination]}: ${{ pending: '待機', running: '処理中', succeeded: '完了', failed: '失敗', uncertain: '配送確認が必要' }[j.status]}${j.error ? `（${j.error}）` : ''}`).join('\n'); }
