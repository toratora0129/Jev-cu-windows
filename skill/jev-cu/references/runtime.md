# 実行例

この例は、上流が対象にしている `cua_repl` 環境向けです。初回は `await cua.getApp("Calendar")` だけを実行してツールの文書を読み、import とループは次の呼び出しで行います。現在の API と driver が一致しない場合は停止します。Windows でも同じ API があると仮定しないでください。

```js
var jevUrl = await import("node:url");
var repoDir = "{{REPO_DIR}}"; // インストール時にリポジトリの実際のパスへ置換
var jevLoop = await import(jevUrl.pathToFileURL(
  repoDir + "/scripts/loop.mjs"
).href);

// 現在の AX から、ロール・ラベル・ID・選択状態の形式を確認する。
// 以下は week-button / Value: 1 が観測された Calendar 向けの判定。
var weekSelected = ax => ax.split("\n").some(line =>
  /radio button/.test(line) && /ID: week-button\b/.test(line) && /Value: 1\b/.test(line)
);
var jevResult = await jevLoop.runTask({
  driver: jevLoop.createCuaDriver(cua),
  appName: "Calendar",
  goal: "Switch Calendar to Week view.",
  dryRun: true,
  maxSteps: 2,
  verify: weekSelected,
});
nodeRepl.write(jevResult);
```

プレビューを確認し、その環境と操作が許可されている場合にのみ `dryRun: false` へ変更します。最初から週表示なら検証だけで終了し、実演のために不要なクリックをしません。

- `verify(ax)`：読み取り専用の全体目標の判定。各ステップの前と最後の操作後に確認します。ボタンの存在ではなく、選択状態や結果の値を検査します。
- `resources: { text, key, direction }`：Codex が準備する操作引数。動的に作る場合は副作用のないコールバックを使います。1ステップに2回呼ばれる場合があります（判断前は `null`、判断後は decision）。
- 異なる `jevGoal` を混ぜた長い多段階処理にはせず、段階ごとに呼び出して検証します。
- 候補上限の既定値は40です。増やす前にロールの絞り込みやラベルの問題を確認します。
- 上流の例ではツールの既定タイムアウトを30秒としていますが、実際の環境で確認してください。1段階2～3手を目安にし、API と観測の所要時間を含めて上限を設定します。外側のタイムアウトが発生しても「操作は起きなかった」とはみなさず、状態とログを確認します。
- `plan` はモデルへの情報であり、保存された実行進捗ではありません。静的手順や `skipJev` を Jev の判断実績として集計しません。

アプリごとの閾値緩和やキーワードの誤判定は残っています。許可リストはアプリ内の全書き込みへの許可ではありません。複雑な入力、座標クリック、ドラッグ、ブラウザー経路は個別の検証が必要です。

Windows パスを JavaScript の文字列に埋め込む場合、バックスラッシュのエスケープも別途確認が必要です。この上流向け例を、そのまま Windows 対応の証拠にはしません。
