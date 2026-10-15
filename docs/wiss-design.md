# WISS Challenge 差分設計（2026-10-07）

## Phase 1：調査結果

|領域|既存実装|WISSでの差分|
|---|---|---|
|バックエンド|`backend/server.js`、Express / multer / ws。実験APIと通常撮影APIが同居|`/api/wiss` に独立したルーターを追加|
|セッション|iOS生成ID、メモリ上のsender/receiver/watchers、実験状態のJSON保存|撮影者発行、匿名被写体最大6人、代表者、端末別認証、参加コード、バージョン管理|
|映像|`/ws/video` のJPEG中継。LiveKit依存・設定・実装は存在しない|既存方式を認証付きWISSチャンネルに再利用。ユーザー確認済み：LiveKitは削除済み、WebSocketを正式採用|
|Web|`photographer/index.html`, `script.js`, `style.css`。撮影・共有・実験フロー|`/booth/` に独立した撮影者画面、`/admin/` に管理画面|
|iOS|`ContentView`, `TakePhoto`, `SessionAPI`。ガイド作成・研究設定・写真確認|WISS専用SwiftUI画面を追加、既存画面は別モードとして維持。WISS参加者画面に管理操作を置かない|
|画像|プレビュー映像320×約427、撮影900×1200の縦3:4、ガイド変形操作あり|中央クロップを横4:3で統一、1600×1200撮影、フレーム固定重畳|
|フレーム生成|Pythonによる人物・姿勢・シルエット解析、iOSでガイド作成|WISSでは呼び出さない。研究者の手描き3種PNGを登録|
|保存|`backend/uploads` に画像、JSON、JSONL。通常セッションはTTL削除|`backend/data/wiss` に専用永続領域。旧TTL・旧公開uploadsから分離|
|外部連携|Drive・メール・LiveKitなし。Xserver/Nginx手順あり|Drive独立ジョブ、SMTP通知、同一Nodeサーバーで配信|
|認証|既存研究APIは`X-Research-Token`、iOSの研究設定はPIN|WISS管理APIは専用サーバー秘密鍵、参加者資格ではアクセス不可|

## データと権限

- Session: id, joinCode, photographerTokenHash, subjects[{id, tokenHash, joinedAt, consent}], representativeId, activeFrameId, mode, version, proposals, shareToken（撮影者のQR再表示用。サーバー内に保持）。
- Consent: `research` と `publication` を別の真偽値で各被写体が回答。写真ごとに撮影時スナップショットを固定し、全員の同意で研究保存／公開可否を決める。写真を保存する操作とは独立。
- Photo: id, sessionId, capturedAt, subjectCount, consent snapshot, activeFrameId, mode, decision(draft/saved/deleted), status(pending/processing/ready/published/rejected), original path, referenceId。
- Reference: id, sourcePhotoId, name, subjectCount, origin(initial/participant), status, original asset, reference_4x3, variants(box/silhouette/box_face)。公開には全画像の寸法一致・横4:3・PNGの実際の透明画素・3種が必須。
- Event: eventId, timestamp, eventType, sessionId, subjectId, referenceId, frameVariantId, subjectCount, origin。閲覧・提案・確定・撮影を別々に記録。
- Job: destination(shared/research/mail), entityId, status, attempts, nextAttemptAt, remoteId, error。成功済み保存先を再送しない。

既存に合わせて単一Nodeプロセスで原子的JSON置換によりメタデータとログ・ジョブを一括永続化する。撮影画像は別ファイル。マルチプロセス／PM2 clusterは使用しない。大規模化時はSQLite等へ移行する。書込み失敗時は変更を反映しない。画像の下書きにはTTLを設け、削除決定で画像を物理削除する。

セッション参加・撮影者・管理者・共有用資格を分ける。公開ライブラリ以外の画像に静的公開パスを与えない。共有QRは推測困難なセッション限定資格を含むアプリ内ギャラリーへ誘導し、Driveフォルダ自体を全体公開しない。

## API

`/api/wiss` 配下で、`POST /sessions`、`POST /join`、`GET /sessions/:id`、`POST /sessions/:id/consent`、`POST /sessions/:id/representative`、`POST /sessions/:id/proposals`、`PUT /sessions/:id/active-frame`、`POST /sessions/:id/photos`、`POST /sessions/:id/photos/:photoId/decision`、`POST /sessions/:id/retry` を追加。

フレーム確定・モード変更は`expectedVersion`を必須にして不一致を409で拒否する。撮影はサーバー上の同一バージョンを確認し、撮影時の参加者・同意・フレームを固定する。資格はAuthorization Bearer、画像／WSでは専用のアクセス資格を検証する。

`GET /library`、フレーム閲覧イベント、認証付き画像配信、セッション限定共有ギャラリー、QR生成を追加。管理APIは`/admin/*`に限定し、ダッシュボード・写真・参照画像と3種フレーム登録・公開・非公開・削除・集計・CSVを提供する。

`/ws/wiss` は認証後にセッション状態を配信し、撮影者のJPEGを被写体へ中継。再接続時に最新状態を送る。HTTPポーリングも再同期に利用する。

## 変更／追加ファイル

変更：`backend/server.js`（ルーターとupgrade振分け）、`backend/package.json` / lock（画像検証・QR・Drive・メール）、`.env.example`, `.gitignore`, `README.md`, `photo2026App.swift`, `Info.plist`。

追加：`backend/wiss/{store,router,integrations}.js`、`backend/test/wiss.test.js`、`photographer/{booth,admin}/` のHTML/JS/CSS、`photo2026/photo2026/WISS*.swift`、本設計書と運用検証手順。

## 環境変数

`WISS_DATA_DIR`, `WISS_PUBLIC_URL`, `WISS_DRAFT_TTL_MS`。

Drive：`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `DRIVE_RESEARCH_FOLDER_ID`, `DRIVE_SHARED_FOLDER_ID`。2フォルダに書込可能なサーバー専用OAuth資格を使用。異なるGoogleアカウントを利用する場合は保存先別OAuth資格を追加設定する。

メール：`SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `WISS_NOTIFY_TO`。未設定・失敗を成功扱いにせず管理画面で表示する。

## 実装順序と完了判定

1. Phase 1：本書で現状／差分／API／環境変数を提示。
2. Phase 2：6人参加・7人目拒否・代表移譲・提案・確定競合・再接続同期・4:3映像と保存画像・iOS左右表示を検証。
3. Phase 3：削除画像不保持、保存の冪等性、全員の独立同意、保存先別再試行と再起動復旧、共有資格による他セッション分離を検証。
4. Phase 4：未認証管理操作の拒否、手動PNG3種と寸法／透明性検証、状態遷移、公開後の別セッション選択、通知重複防止を検証。
5. Phase 5：閲覧・提案・確定・撮影の集計とCSV、既存回帰テスト。実機6台、実Drive、実SMTP、Xserver配備は資格・端末が揃った環境で別途受入試験。

SMTPは送信直後のプロセス停止時に配送完了を厳密判定できないため、不確定ジョブは自動再送せず管理者の確認対象とする。画面内通知はphotoIdで一意にする。

外部API仕様： [Google Drive files.create](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/create)、[独自プロパティ](https://developers.google.com/workspace/drive/api/guides/properties)、[Nodemailer SMTP](https://nodemailer.com/smtp)。
