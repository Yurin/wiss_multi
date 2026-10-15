# WISS Challenge 協調フォトブース

撮影者1人・被写体最大6人で、共通の手描きフレームを見ながら横4:3の写真を撮影するデモです。

- 撮影者Web：`/booth/`（`/` からも移動できます）
- 被写体iOS：SwiftUIのWISS専用アプリ
- 研究者Web：`/admin/`（管理者認証が必要）
- 映像・状態同期：`/ws/wiss`、バックエンド：Node.js / Express
- 保存：Google Drive、同意に応じた研究用・共有用の独立保存
- フレーム作成：研究者がibisPaint等で作成した3種類の透過PNGを登録

## 起動

```sh
cd backend
npm ci
# .env.exampleを参考に.envを設定する
node --env-file=.env server.js
```

## 手順と検証

- [WISSの設計と構成](../docs/wiss-design.md)
- [設定・運用・検証・受入試験](../docs/wiss-operations.md)
- [Xserverへの配備](../docs/deploy-xserver.md)

```sh
cd backend
npm run test:wiss
npm run test:wiss-ui
```

旧1対1撮影・ユーザ実験・自動姿勢解析のコードは削除済みです。保存済み写真・ログは削除していません。
