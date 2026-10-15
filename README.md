# WISS Multi

WISS Challenge向けの協調写真撮影システムです。撮影者1人と被写体最大6人が、共通のフレームを見ながら写真を撮影します。

- 撮影者Web：`/booth/`
- 被写体iOS：**WISS Multi**（`photo2026/photo2026.xcodeproj`）
- 研究者Web：`/admin/`
- バックエンド：Node.js / Express、WebSocketによる映像・状態同期

## 起動と参加

[バックエンドの起動手順](backend/README.md)に従ってサーバーを起動してください。
撮影者Webで「セッションを開始」を押すと参加コードが発行されます。
被写体はそれぞれのiOSアプリに同じ参加コードを入力して参加します。

iOSはXcodeでプロジェクトを開き、Signing & Capabilitiesで使用する開発チームを選択してビルドします。
Bundle IDは `com.yurinisocha.wissmulti.a81c4f2b` です。
サーバー接続先の既定値は `https://photo-interface.com` です。

## ドキュメント

- [設計とPhase計画](docs/wiss-design.md)
- [設定・運用・検証と受入試験](docs/wiss-operations.md)
- [Xserverへの配備](docs/deploy-xserver.md)

## 開発

```sh
npm --prefix backend ci
npm --prefix backend run test:wiss
npm --prefix backend run test:wiss-ui
```

秘密情報は `backend/.env` に設定し、Gitには含めません。写真、セッションデータ、研究用エクスポート、ビルド生成物も管理対象外です。
旧1人用アプリから引き継いだ履歴を保持し、WISS Multiは https://github.com/Yurin/wiss_multi で管理します。
