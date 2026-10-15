# Xserver VPS での本番運用

このプロジェクトを Xserver VPS / Ubuntu 上で運用する場合の構成例です。

## 前提

- Node.js / Express バックエンドは `127.0.0.1:3000` で内部起動する
- 外部公開は Nginx のリバースプロキシ経由とし、HTTPS は Nginx / Let’s Encrypt で終端する
- 公開URL は `https://photo.example.com` を想定する
- API は `https://photo.example.com/api/...`
- WebSocket は `wss://photo.example.com/ws/video` と `wss://photo.example.com/ws/session`
- 外部に公開する必要があるポートは `22`, `80`, `443` のみ。`3000` は外部公開しない

## 1. Node.js サーバー起動の設定

`backend/server.js` は以下のように起動します。

```sh
cd 2026Collaboratry_Photographer_Interface/backend
npm install
```

`backend/.env.example` には例を用意しています。

```env
PORT=3000
HOST=127.0.0.1
NODE_ENV=production
# Python interpreter used by guide generation scripts
# PYTHON=.venv/bin/python
```

実際の本番運用ではサーバー上に `.env` を作成してください。秘密情報を含むためGitには追加しないでください。Node.js 22.16以降を使用してください。`server.js` が同じディレクトリの `.env` を自動で読み込みます。

## 2. PM2 で常時起動する手順

```sh
cd 2026Collaboratry_Photographer_Interface/backend
npm install
# 必要なら .env を作成
test -f .env || cp .env.example .env
# pm2 で起動
pm2 start server.js --name photo-backend
pm2 save
```

再起動する場合:

```sh
# If you are using a virtual environment, pass the PYTHON path to PM2
PYTHON=/home/yuri/2026Collaboratry_Photographer_Interface/backend/.venv/bin/python pm2 restart photo-backend
```

## 3. Nginx リバースプロキシ設定例

以下は `photo.example.com` を公開する例です。

```nginx
server {
  listen 80;
  server_name photo.example.com;

  # HTTP から HTTPS にリダイレクト
  return 301 https://$host$request_uri;
}

server {
  listen 443 ssl http2;
  server_name photo.example.com;

  ssl_certificate /etc/letsencrypt/live/photo.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/photo.example.com/privkey.pem;
  ssl_protocols TLSv1.2 TLSv1.3;
  ssl_prefer_server_ciphers on;

  location /api/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }

  location /ws/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 360s;
  }

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

## 4. 本番動作のポイント

- フロントエンドの API 呼び出しは同一ドメインの相対パス `fetch("/api/...")` で行うように修正済み
- WebSocket は `location.protocol === "https:" ? "wss" : "ws"` で接続するようになっている
- したがって、公開 URL は `https://photo.example.com` で十分
- `wss://photo.example.com/ws/video` と `wss://photo.example.com/ws/session` が Nginx 経由で通るように設定する

## 5. ポートの公開方針

- 外部公開するポート: `22`, `80`, `443`
- 内部 Node.js アプリが待ち受けるポート: `3000`
- `3000` は Nginx のプロキシ対象として内部利用し、直接外部には公開しない

## 6. 追加の注意

- Let’s Encrypt を使う場合は `certbot` で証明書を取得し、Nginx の SSL 設定を行ってください
- `backend/.env` はリポジトリに含めず、`.gitignore` に追加済みです
- 本番では `NODE_ENV=production` を設定してください
