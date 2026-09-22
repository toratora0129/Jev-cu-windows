# Jev-cu-windows

Jev（TypeSafe System One）による候補選択と、Codex Computer UseによるWindows観測・限定実行を検証する実験用Forkです。上流は[Sac-Y/Jev-cu](https://github.com/Sac-Y/Jev-cu)です。用途はComputer Useに限定します。

**M1では、Windows読み取りadapter、実Jev接続前の通信保護、試験用電卓の固定キー実行を実装しました。実Jevの接続・選択精度はまだ未検証です。** 任意のWindowsアプリを自律操作できる完成版ではありません。

## 入口

- [AGENTS.md](AGENTS.md)：作業指示。
- [STATUS](docs/STATUS.md)：到達点・許可・実API接続前の停止境界。
- [M1記録](docs/M1_2026-09-23_JA.md)：設計、実測、失敗条件、最小使用例、実API接続案。
- [DEVELOPMENT](docs/DEVELOPMENT.md)：設計・再利用の指針。

## APIキーなしの検証

Node.js v24.14.1 / npm 11.11.0のWindowsで検証しています。新しいnpm依存はありません。

```powershell
npm test
node examples/m1-offline.mjs
```

テストは人工データと偽キーのみを使用します。大部分は模擬driver／模擬fetchです。1件のHTTP統合試験だけが短命な127.0.0.1サーバーを使用し、正常要求・redirect拒否・本文期限切れを検査して終了します。実アプリ・実Jev・秘密情報は使いません。例の出力がEXECUTEでも、実際のGUI操作は行いません。

## 実装の範囲

| モジュール | 役割 |
|---|---|
| `windows-sky-adapter.mjs` | 注入skyによる一覧・一意選択・読み取り、窓と画像参照、取得可否、観測IDと期限 |
| `operation-choice.mjs` | 準備済み対象・引数を持つ操作IDを選択。NONEと非実行の引き継ぎを保持 |
| `guarded-key-session.mjs` | 試験用電卓への明示した固定キーだけ。直前確認、回数・期限、実行後確認、結果不明時の再送禁止 |
| `jev-decide.mjs` | 送信先／モデル固定、redirect拒否、本文までの期限とサイズ制限、応答検証、秘密読込と標準通信のopt-in |
| `loop.mjs` / `policy.mjs` | 旧AX解析と読み取りプレビュー。旧実行ループは無効化 |

Windowsの`accessibility:null`は候補未取得として返します。画像から架空のAX indexを作りません。実測では試験用電卓の画像を確認でき、固定4手で2+3=5を確認しました。先行するKP_2の1手は無変化で失敗として残しています。詳細と制限はM1記録を参照してください。

M1の結果確認はCodexによる画像の目視です。UIAから計算結果を取得したものではなく、JevによるGUI成功でもありません。座標クリック・汎用入力・他アプリの新実行経路は未対応です。

## 実API・キーの境界

M1ではキーの存在確認も行いません。実APIを使う前に、送信予定データ、回数・期限・費用枠を示してユーザーの確認を待ちます。未認証プローブも行いません。

承認後、ユーザーがローカルで`.env.local`の`TYPESAFE_API_KEY`またはプロセス環境変数を設定します。キーを会話・PR・コマンド履歴に貼らないでください。標準通信は`allowNetwork:true`、キー自動読込は別に`allowSecretRead:true`が必要です。フラグ設定は権限を増やしません。

既定送信先は`https://api.typesafe.ai/v1/systemone`だけ、モデルは`jev-1.13.0`固定です。入力に使えるのは承認済みテキストだけで、画像や実画面情報を暗黙に送信しません。完全な観測・キー・応答本文を自動保存するログはありません。

## 旧経路との互換性

`runTask({dryRun:false})`は、driverを呼ぶ前に`legacy_execution_disabled`を返します。旧target/actionと後付けresourcesの組合せを、新しい実操作へ転用しません。`dryRun:true`は一回の読み取りプレビューで、判断を注入できます。既定判断の標準通信は無効で、旧トレース保存も廃止しました。

`npm run p0`と旧CLIは歴史的な評価入口です。通信opt-inを渡さないため現行版では実APIへ接続しません。実APIの次の入口はM1記録の人工データ試験です。旧スキルのインストールはM1に不要で、実施していません。

日本語化以前の経緯は[LOCALIZATION_JA](docs/LOCALIZATION_JA.md)、過去の安全不備は[2026-09-22調査](docs/RESEARCH_2026-09-22_JA.md)に保持しています。
