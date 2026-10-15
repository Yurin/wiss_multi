const fs = require('node:fs');
const { Readable } = require('node:stream');
const { google } = require('googleapis');
const nodemailer = require('nodemailer');
const { check } = require('./store');
const driveRequestOptions = { timeout: 60000, retry: false };

function driveClient(destination, env) {
  const prefix = destination === 'research' ? 'DRIVE_RESEARCH_' : 'DRIVE_SHARED_';
  const clientId = env[`${prefix}CLIENT_ID`] || env.GOOGLE_CLIENT_ID;
  const secret = env[`${prefix}CLIENT_SECRET`] || env.GOOGLE_CLIENT_SECRET;
  const refresh = env[`${prefix}REFRESH_TOKEN`] || env.GOOGLE_REFRESH_TOKEN;
  check(clientId && secret && refresh, 'Google Drive OAuth未設定', 503);
  const auth = new google.auth.OAuth2(clientId, secret);
  auth.setCredentials({ refresh_token: refresh });
  return google.drive({ version: 'v3', auth });
}

class Integrations {
  constructor(store, env = process.env, adapters = {}) {
    this.store = store;
    this.env = env;
    this.adapters = adapters;
    this.running = false;
    // SMTP has no transactional acknowledgment. Do not auto-send ambiguous mail.
    store.transaction(d => {
      for (const job of Object.values(d.jobs)) if (job.status === 'running') {
        job.status = job.destination === 'mail' ? 'uncertain' : 'failed';
        job.error = '前回処理中にサーバー停止。配送状況を確認してください';
      }
    });
  }
  update(jobId, values) { this.store.transaction(d => Object.assign(d.jobs[jobId], values)); }
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const jobs = Object.values(this.store.data.jobs).filter(j => ['pending', 'failed'].includes(j.status) && j.nextAttemptAt <= Date.now() && j.attempts < 8);
      for (const original of jobs) {
        const j = this.store.data.jobs[original.id];
        this.update(j.id, { status: 'running', attempts: j.attempts + 1 });
        try {
          const result = j.destination === 'mail'
            ? await (this.adapters.mail ? this.adapters.mail(j) : this.mail(j))
            : await (this.adapters.drive ? this.adapters.drive(j) : this.upload(j));
          this.update(j.id, { status: 'succeeded', error: null, remoteId: result?.id || null, completedAt: new Date().toISOString() });
        } catch (error) {
          // A failure after handing mail to SMTP can be ambiguous; never loop it.
          const uncertain = j.destination === 'mail' && error.deliveryUncertain;
          this.update(j.id, { status: uncertain ? 'uncertain' : 'failed', error: error.message,
            nextAttemptAt: Date.now() + Math.min(3600000, 5000 * 2 ** this.store.data.jobs[j.id].attempts) });
        }
      }
    } finally { this.running = false; }
  }
  async upload(job) {
    const drive = driveClient(job.destination, this.env);
    const parent = this.env[job.destination === 'research' ? 'DRIVE_RESEARCH_FOLDER_ID' : 'DRIVE_SHARED_FOLDER_ID'];
    check(parent && /^[\w-]+$/.test(parent), 'Drive保存フォルダ未設定', 503);
    // Remote object IDs are persisted before create. Retrying after an uncertain
    // response uses the same ID, including after a process restart.
    const s = this.store.data.sessions[job.sessionId];
    const folderKey = `${job.destination}FolderId`;
    let folderId = s[folderKey];
    if (!folderId) {
      folderId = (await drive.files.generateIds({ count: 1 }, driveRequestOptions)).data.ids[0];
      this.store.transaction(d => { d.sessions[job.sessionId][folderKey] = folderId; });
    }
    await this.ensureFile(drive, folderId, { id: folderId, name: `WISS-${s.id}`, mimeType: 'application/vnd.google-apps.folder', parents: [parent] });
    let remoteId = this.store.data.jobs[job.id].uploadId;
    if (!remoteId) {
      remoteId = (await drive.files.generateIds({ count: 1 }, driveRequestOptions)).data.ids[0];
      this.update(job.id, { uploadId: remoteId });
    }
    const mimeType = job.asset.endsWith('.png') ? 'image/png' : job.asset.endsWith('.json') ? 'application/json' : 'image/jpeg';
    const bytes = job.metadata ? Buffer.from(JSON.stringify(job.metadata, null, 2)) : fs.readFileSync(this.store.assetPath(job.asset));
    await this.ensureFile(drive, remoteId, { id: remoteId, name: job.asset, parents: [folderId], appProperties: { wissJobId: job.id } }, { mimeType, body: Readable.from(bytes) });
    if (job.destination === 'research' && job.photoId && !job.metadata) {
      const p = this.store.data.photos[job.photoId];
      this.store.transaction(d => this.store.job(d, `research-metadata:${p.id}`, {
        destination: 'research', sessionId: p.sessionId, photoId: p.id, asset: `${p.id}.json`,
        metadata: { photoId: p.id, sessionId: p.sessionId, capturedAt: p.capturedAt, subjectCount: p.subjectCount,
          consents: p.consents, mode: p.mode, frameVariantId: p.frameVariantId, originalAsset: p.asset }
      }));
    }
    return { id: remoteId };
  }
  async ensureFile(drive, fileId, requestBody, media) {
    try { await drive.files.get({ fileId, fields: 'id', supportsAllDrives: true }, driveRequestOptions); return; }
    catch (e) { if (Number(e.code) !== 404) throw e; }
    try { await drive.files.create({ requestBody, media, fields: 'id', supportsAllDrives: true }, driveRequestOptions); }
    catch (e) { if (Number(e.code) !== 409) throw e; }
  }
  async mail(job) {
    const e = this.env, p = this.store.data.photos[job.photoId];
    check(e.SMTP_HOST && e.SMTP_FROM && e.WISS_NOTIFY_TO && e.WISS_PUBLIC_URL, 'メール通知設定が未完了です', 503);
    const transport = nodemailer.createTransport({ host: e.SMTP_HOST, port: Number(e.SMTP_PORT || 587), secure: e.SMTP_SECURE === 'true',
      auth: e.SMTP_USER ? { user: e.SMTP_USER, pass: e.SMTP_PASS } : undefined,
      connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000 });
    try {
      await transport.sendMail({ from: e.SMTP_FROM, to: e.WISS_NOTIFY_TO,
        messageId: `<wiss-${p.id}@${new URL(e.WISS_PUBLIC_URL).hostname}>`,
        subject: 'WISS：フレーム化待ち写真',
        text: `Session ID: ${p.sessionId}\n撮影日時: ${p.capturedAt}\n被写体人数: ${p.subjectCount}\n${e.WISS_PUBLIC_URL.replace(/\/$/, '')}/admin/#${p.id}` });
    } catch (error) {
      error.deliveryUncertain = !['EAUTH', 'ECONNECTION', 'EDNS'].includes(error.code);
      throw error;
    } finally { transport.close(); }
    return { id: `mail:${p.id}` };
  }
}
module.exports = { Integrations };
