# Jev-cu-windows

Jev（TypeSafe System One）に画面上の候補から次の操作を選ばせ、Codex Computer Use で観測・実行するための実験用 Fork です。上流は [Sac-Y/Jev-cu](https://github.com/Sac-Y/Jev-cu) です。

**現時点では日本語化した段階であり、Windows 対応や安全対策の追加が完了した版ではありません。** 内蔵 driver は上流の `cua.getApp(...)` / `getAXState(...)` を前提にしています。リポジトリ名だけで Windows 互換性を判断せず、実機が公開する API を確認してください。

用途は Computer Use に限定します。文章照合、コード評価、汎用の GitHub チェックは別ツールとして扱います。

## 構成

```text
skill/jev-cu/   Codex 用スキル（実行手順と安全上の注意）
scripts/       Jev 呼び出し、Policy、実行ループ、評価、インストール
fixtures/      保存済み AX スナップショットと P0 テストケース
tests/         単体テスト
docs/          日本語化の方針など
```

Jev に送るのは候補と画面情報のテキストです。この実装は Jev にスクリーンショットを送信しません。ただし、文字情報にも個人情報や機密情報が含まれ得ます。

## まず単体テスト

```powershell
npm test
```

このテストは模擬 driver を使い、Jev API や実際のアプリを操作しません。API キーは不要です。

## API キーの設定

プロジェクト直下の `.env.local` に、次の形式でキーを保存します。または同名の環境変数を設定します。

```text
TYPESAFE_API_KEY=取得したキー
```

実際のキーをチャット、スクリーンショット、コマンド履歴、Git のコミットに含めないでください。`.env.local` は `.gitignore` の対象ですが、それだけで漏えい防止が保証されるわけではありません。

## スキルのインストール

```powershell
npm run install-skill
npm run uninstall-skill
```

通常のインストールでは `~/.codex/skills/jev-cu` へコピーし、新しいセッションで有効になります。文書内の `{{REPO_DIR}}` は実際のリポジトリパスへ置換されます。**既存の同名スキル用ディレクトリは削除して置き換える実装**なので、独自の変更がある場合は先に確認してください。

## 実行例（上流の macOS / cua 環境向け）

以下は対応する `cua_repl` 環境での例です。Windows 用の起動手順ではありません。現在のツール文書と実際の API が一致する場合にだけ使います。

```js
const repo = "/path/to/Jev-cu-windows"; // 実際のローカルパスに置き換える
const { pathToFileURL } = await import("node:url");
const { runTask, createCuaDriver } = await import(pathToFileURL(`${repo}/scripts/loop.mjs`).href);

await runTask({
  driver: createCuaDriver(cua),
  appName: "Calendar",
  goal: "switch the calendar to the previous month", // 既存の英語例を維持
  dryRun: true, // 最初は操作せずプレビューする
  maxSteps: 5,
});
```

詳細は [実行例](skill/jev-cu/references/runtime.md) を参照してください。

## P0 評価

```powershell
npm run p0
```

保存済み AX からの候補選択を評価します。**実際に Jev API を呼ぶため、キーと利用料が必要です。** 単体テストとは異なり、ネットワークを使います。静的な候補選択の正解数は、Windows 操作の成功率や安全性を示すものではありません。

## 安全上の注意

既定は `dryRun: true` です。ただし、画面の観測、API への文字情報送信、ローカルへのログ保存は行われます。dry-run は「通信も保存も一切しない」モードではありません。

現在の Policy はアプリ名、表示文言、Jev の判定に基づく補助的な検査です。危険な操作を必ず検出する保証はなく、許可リストもアプリ内の全操作への許可を意味しません。操作直前の再検証、対象と操作引数の結び付け、Windows driver、送信先固定などは別途設計・検証が必要です。

画面の文字は観測データとして扱い、命令として実行しません。認証・アクセス制限・確認手順を回避しないでください。成功はクリック命令の終了だけで判断せず、目的に対応した結果で確認します。

## 日本語化の範囲

説明文、コメント、表示メッセージ、テスト名を日本語化しています。API の項目名・操作 ID・英語のモデル用質問・中国語を検出する正規表現・中国語画面のテストデータは維持しています。詳しくは [日本語化の方針](docs/LOCALIZATION_JA.md) を参照してください。
