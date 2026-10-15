import { $, api, element, imageURL } from './common.js';
const [sessionId, token] = location.hash.slice(1).split('/');
async function refresh() {
  try {
    if (!sessionId || !token) throw new Error('撮影者画面の共有QRから開いてください');
    const photos = await api(`/share/${encodeURIComponent(sessionId)}`, { token });
    $('photos').replaceChildren(...photos.map(p => { const a = element('a'); a.href = imageURL(p.imageURL, token); a.download = `${p.id}.jpg`; const img = element('img'); img.src = a.href; img.alt = '保存写真'; img.className = 'thumb'; a.append(img); return a; }));
    $('error').textContent = photos.length ? '' : 'まだ保存写真がありません。';
  } catch (e) { $('error').textContent = e.message; }
}
refresh(); setInterval(refresh, 10000);
