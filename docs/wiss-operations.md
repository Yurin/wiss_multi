# WISS Challenge 運用と検証

## 起動

Node.js 22以上、単一プロセスで運用する。PM2 cluster・複数コンテナから同じ保存領域へ同時書込みしない。既存Python解析はWISSでは使用しない。

```sh
cd backend
npm ci
# .env.exampleを参考にローカルの.envを準備する（秘密情報はコミットしない）
node --env-file=.env server.js
```

`.env` は `npm start` 単独では読み込まない。PM2では環境を明示して渡す。Xserver/Nginxの既存 `/ws/` 設定は `/ws/wiss` にも利用できる。ブラウザカメラにはHTTPS（またはlocalhost）が必要。

- 撮影者：`https://<host>/booth/`
- 研究者：`https://<host>/admin/`。`WISS_ADMIN_TOKEN` が未設定なら管理APIは使用不可。
- iOS：`API_BASE_URL` / `WEB_APP_BASE_URL` の設定先を同一サーバーへ合わせる。WISSは横向きのみ、管理者画面・自動姿勢推定・フレーム変形を含まない。従来画面は `WISS_MODE=false` のビルドで利用できる。
- QRからiOSの`wissphoto://join?code=...`を開くか、12桁の参加コードを入力する。

## Drive・通知

Google Cloud側でDrive APIを有効化し、サーバー専用OAuthのClient ID / Client Secret / Refresh Tokenを用意する。各保存先フォルダに書込み可能なアカウントを使う。OAuth認可・トークン発行は運営者のGoogleアカウント設定が必要であり、アプリは設定済みRefresh Tokenを更新して使用する。

`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` と `DRIVE_RESEARCH_FOLDER_ID`, `DRIVE_SHARED_FOLDER_ID` を設定する。別アカウントの研究／共有Driveなら `DRIVE_RESEARCH_{CLIENT_ID,CLIENT_SECRET,REFRESH_TOKEN}` と `DRIVE_SHARED_{CLIENT_ID,CLIENT_SECRET,REFRESH_TOKEN}` で上書き可能。

保存先ごとにセッションフォルダを作成する。ファイルIDは作成前に永続化し、応答消失後も同一IDで再試行する。共有・研究・研究メタデータ・参照画像・各PNGは別ジョブ。成功ジョブは再送しない。失敗は最大8回まで指数バックオフし、その後は画面から再試行できる。

共有QRは本システムのセッション限定ギャラリーを開く。Drive親フォルダへの公開権限は追加しない。共有資格を持つ人は当該グループの保存写真を閲覧できるため、参加者間のみでQRを共有する。写真はアップロード待ちでもローカルの保存済みデータから表示でき、Driveへの成功／失敗は撮影者画面に別表示する。

SMTP設定は `.env.example` 参照。`WISS_PUBLIC_URL` が通知の管理画面リンク・QRのベースURLとなる。新着通知は管理画面が15秒ごとに確認する（編集中は入力保護のため停止）。通知は写真IDごとに一意。メールは固定Message-IDで送信し、送信中のプロセス停止／配送結果不確定時は `uncertain` として自動再送せず、研究者が受信状況を確認して配送済み／再送を選ぶ。SMTP自体には厳密なexactly-once配送保証がない。

## 展示の流れ

1. 撮影者がセッションを作成しカメラを開始する。各被写体が参加コードから参加する（最大6人）。最初の参加者が代表者となる。
2. 各被写体が研究利用・公開利用を独立して回答する。不同意でも撮影可能。未回答者がいる間は撮影できない。
3. 被写体が参照写真→フレーム種類を個人選択し、グループに提案する。代表者が確定すると全端末へ反映される。撮影者または現在の代表者が代表者を移譲できる。
4. フレームなしを選ぶと共通Active Frameを解除。映像配信は640×480、撮影は1600×1200。どちらも同じ中央クロップで、ガイドは固定座標。完成写真にガイド線は焼き込まない。
5. 撮影後に保存／削除を選択する。削除はローカル画像も消し、Driveジョブを作らない。未決定下書きは既定1時間後に削除する。ページを再読込みしても未決定写真は一覧から再開できる。
6. 保存操作により共有Driveジョブを作る。研究Driveは撮影時の全員の研究同意がある場合のみ。公開再利用は全員の公開同意がある場合のみ。両者は独立しており、公開のみ同意の写真はフレーム化できるが研究Driveへ送らない。
7. 自由撮影かつ公開同意ありの保存写真は管理画面の通知から開く。作成中へ変更し元写真をダウンロードする。ibisPaintで同寸法の透過PNG3種を作り、別の横4:3参照写真と登録する。プレビュー後に公開すると他セッションから選べる。
8. 初期テンプレートは管理画面の「初期テンプレートの元写真を登録」で、権利・同意を確認した素材を登録する。参加者由来素材とは出典別に集計される。
9. 非公開／削除したフレームはライブラリから除外し、利用中セッションのActive Frameを解除する。フレームの削除は研究記録・Driveの保存写真を削除する操作ではない。

## データ・アクセス

`WISS_DATA_DIR`（既定 `backend/data/wiss`）に原子的JSONスナップショットと画像を保存する。旧uploads/TTLから独立し、起動時は既存状態を復元する。元撮影画像のバイト列を保持し、トリミング後の参照画像を別ファイルにする。破損スナップショットは空で上書きせず起動エラーにする。

バックアップはNode停止中にディレクトリ全体をコピーする。保存済み写真と研究ログは自動削除しない。保持期間・同意撤回後の処理は研究運用として定める。画面の同意変更は今後撮影する写真に適用され、既存写真の同意スナップショットを書き換えない。

撮影者資格はブラウザのlocalStorage、被写体資格はiOS Keychain、管理者資格は画面メモリに保持する。一般参加者の資格で管理APIを実行できない。共有資格とセッション資格は相互利用できない。画像・WebSocket接続時の資格はURLクエリを使うため、Nginxアクセスログにクエリ文字列を保存しない（`$request` / `$request_uri` の代わりに `$uri` を使用）。公開参照画像だけは認証不要となる。

管理トークンは運営者にのみ配布する。複数の研究者アカウント、MFA、共有リンクの有効期限／失効UIは今回の実装に含めていない。1端末につき1つのWebSocket資格を使い、同じ資格の再接続は古い接続を置換する。

## 検証（2026-10-07）

```sh
npm run test:wiss
npm run test:wiss-ui
npm run test:session-flow
npm run test:guidance
npm run test:participant-flow
npm run test:research-operations
npm run test:study-design
```

`test:wiss-ui` は一時プロファイル・偽カメラで実ブラウザを起動する。既定ChromeパスはmacOS。別環境は `CHROME_PATH` にChromium/Chromeの実行パスを指定する。

検証済み：WISS結合テスト6本、既存の全5種のnpmテストスクリプト、偽カメラによるWeb画面操作、1600×1200の保存画像、手描きPNGの登録・公開、共有ギャラリー、CSVダウンロード、Xcode 16.4のiOS Simulator向けビルド。iPhone 16 / iOS 18.5シミュレーターで、参加コード入力・同意回答・横向き左右表示・ライブラリ表示・アプリ再起動後の復元・終了後の参加情報リセットをUIテストで確認した。

npm auditは既知の脆弱性0件（互換範囲で依存更新済み）。Drive・SMTPの成功／失敗はテスト用代替実装で確認したもので、実サービスへの送信は行っていない。

iOS UIテストは一時ディレクトリを使ったバックエンドをポート3099で起動してから実行する。Keychainを使うためシミュレーターもアドホック署名を有効にする（`CODE_SIGNING_ALLOWED=NO` は再起動復元の検証に使わない）。

```sh
# ターミナル1（backendから実行）
WISS_DATA_DIR=/tmp/wiss-ios-test PORT=3099 node server.js
# ターミナル2（リポジトリルートから実行）
xcodebuild -project photo2026/photo2026.xcodeproj -scheme photo2026 \
  -destination 'platform=iOS Simulator,name=iPhone 16,OS=18.5' \
  -only-testing:photo2026UITests/WISSUITests CODE_SIGN_IDENTITY=- test
```

自動テストとiOSビルドが通っても、次の受入確認は別途必要：

- Xserver上のHTTPS/WSS接続、カメラ向き／回転、参加者の物理端末6台で遅延・熱・電池・再接続を確認。
- 実OAuth資格で共有・研究Driveそれぞれのファイルと権限を確認し、片方の失敗からの再試行を確認。
- SMTPメールの実配送・通知リンク・配送結果不確定時の運用を確認。
- iOS実機でランドスケープ画面、ディープリンク参加、Keychain再接続、バックグラウンド復帰を確認。
