# 設計・再利用・調査の指針

更新日：2026-09-23。新しい設計を始めるとき、実装中の不明点や反復失敗を解消するときに読む。日常の小修正で全文を必読にしない。現在の作業範囲は[STATUS](STATUS.md)を参照する。

## 1. Astra向け指示の扱い

ユーザー指定の[Model guidance](https://developers.openai.com/api/docs/guides/latest-model)と[Rethinking skills and prompts for GPT-6 Astra](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra)を確認し、このリポジトリには次のように適用する。

常設のAGENTS.mdは目的・境界・参照先を中心にする。タスク固有の到達点と停止点はSTATUSまたはその依頼に置く。必要な情報だけを読み、通常の可逆な判断で手を止めず、変更に見合う検証まで進める。追加の変更や未解決の根拠がない限り、同じテストや調査を反復しない。スキルは用途を狭く記述し、開発中に実行用スキルが誤って起動しないようにする。

APIの新機能を利用できるという説明は、現在のCodexツールにその機能が公開されている証拠ではない。API設定例を理由に個人のモデル・推論設定、承認設定、プラグインを変更しない。Astra固定の隠れた前提を持たせず、別の担当者も読める契約と資料を残す。

[公式AGENTS.mdガイド](https://developers.openai.com/codex/guides/agents-md/)が説明する探索対象に合わせ、ファイル名は`AGENTS.md`とする。更新の自動再読込は仮定しない。現在のセッションで使う場合は明示的に読み、必要なら更新後のフォルダで新しいセッションを開始する。

## 2. 組み合わせる前に確かめる

まずこのForkの関数とテストから使える部分を探す。次に、関連実装の小さな機能・設計・回帰テストを比較し、不足する接続だけを作る。既存コードに合わせるためにWindowsの観測を偽のAX文字列へ変換しない。再利用より修正負担が大きい部分は、捨てる理由を記録して小さく置き換える。

外部から移すときは、元URL・commit SHA・ライセンス／必要な帰属・変更箇所・検証条件を残す。ライセンスを確認できないコードは転載を保留し、設計上の着想と独立実装を区別する。公開されていること、READMEに動くとあること、PRが存在することだけで採用しない。個人パス、認証・relay、常駐処理、未固定依存をまとめて持ち込まない。

新しい依存や別サービス、汎用provider切替、MCPサーバーを先回りして追加しない。必要なら既存の薄い接続と比較し、現在の要件で採用する理由を示す。選択肢が多い場合でも、短い比較と最小の検証で前に進める。

## 3. 調査するタイミングと終了条件

新しい境界を設計するとき、APIが文書と合わないとき、原因不明の失敗が続くとき、既存実装に似た課題がありそうなときは調査する。最初に下の関連する1～3件から始め、足りない論点だけ検索を広げる。設計時にはコードと関連するPR・Issueの会話まで追い、成功例だけでなく失敗・撤回・未マージ理由を見る。

記録には確認日、対象版、URL、実装箇所、報告者の環境、失敗条件、提案／修正済みの別、こちらで再現したか、採否を含める。本文・レビュー・Issueコメント・行コメントを混同しない。後から追加された修正が、読んだコードの版に入っているか確認する。

必要な契約が分かり、主な失敗条件を説明でき、次の小さい試験が決まったら調査を止める。取得不能な資料や本機にない機能は未確認として残し、別の安全な証拠で進められる部分まで作業する。同じ検索・同じ失敗を根拠なく繰り返さない。

## 4. 論点別の参照先

下表は調査の入口であり、インストールや一括mergeの指示ではない。リンク先のmainとPRは変わるため、利用時に対象SHA・差分・会話を再確認する。広い背景は[2026-09-22報告](RESEARCH_2026-09-22_JA.md)の該当節だけ読む。

| 論点 | 参照先 | 見る点／持ち込まない前提 |
|---|---|---|
| Windowsの接続・観測不足 | [Jev-cu PR #1の実機コメント](https://github.com/Sac-Y/Jev-cu/pull/1#issuecomment-5750600092) | 旧cuaとの不一致、accessibility:null、画像補助、完了後の再操作案。1台の報告を全Windowsへ一般化しない |
| 操作直前の鮮度 | [Jev-cu PR #3](https://github.com/Sac-Y/Jev-cu/pull/3) | NextがDeleteへ変わる模擬再現、実行前の再読込。全AX一致でも原子的な観測＋操作ではない |
| Codexへの引き継ぎ | [Jev-cu PR #9](https://github.com/Sac-Y/Jev-cu/pull/9) | route分離、無進捗、期限、handoff出力を勝手に実行しないこと |
| Astra＋Jevの小さな操作単位 | [rmalde/minecraft-agent](https://github.com/rmalde/minecraft-agent)、[nether-agent.mjs](https://github.com/rmalde/minecraft-agent/blob/main/nether-agent.mjs)、[end-combat.mjs](https://github.com/rmalde/minecraft-agent/blob/main/end-combat.mjs) | Jevが選ぶ単位、前提・中断条件、実行中の監視。ゲームの内部状態・経路探索・既知シードをGUIだけのテストと同一視しない |
| 古い計画の破棄 | [async-planner.mjs](https://github.com/rmalde/minecraft-agent/blob/main/async-planner.mjs) | 応答待ち中にstageが変われば捨てる。GUIでは文書・窓・観測・許可も結び付ける |
| Minecraftの失敗原因 | [optimization/nether/REVIEW.md](https://github.com/rmalde/minecraft-agent/blob/main/optimization/nether/REVIEW.md)、[同repo PR #2](https://github.com/rmalde/minecraft-agent/pull/2) | 観測欠落、経路途中の危険、短すぎる回収期限、未準備のfixture、環境依存・relayの指摘。開発中の修正付き試験と連続成功を分ける |
| 候補の過不足・待機 | [Hermes＋Jev](https://github.com/teknium1/hermes-and-jev-play-minecraft)、[低レベルMinecraft](https://github.com/ellistev/typesafe-minecraft-demo) | 達成済み行動を候補から外す、幾何処理の失敗、検証操作。提示候補の制限だけでなく実行側も検証する |
| Windowsの操作契約・まとめ実行 | [Otto agent bridge](https://github.com/NobleSpartan6/otto/blob/main/docs/agent-bridge.md)、[評価記録](https://github.com/NobleSpartan6/otto/blob/main/docs/evaluation-codex-agent-bridge.md) | 観測参照、アプリ範囲、run_stepsとdelegateの違い。承認・評価器側の失敗をJevの失敗に混ぜない |
| 入力と送信・進捗確認 | [Jev Browser変更履歴](https://github.com/jkudish/jev-browser/blob/main/CHANGELOG.md) | 入力成功なのに無変化扱い、Enterによる途中送信、未取得の入力欄 |
| Jevの質問契約 | [Primitives](https://docs.typesafe.ai/primitives)、[Confidence](https://docs.typesafe.ai/confidence)、[既知の制限](https://docs.typesafe.ai/model-jaggedness/jev-1.13) | 同時質問の回答依存を仮定しない。confidenceを成功率・権限にしない。候補NONEと不明状態を保持する |

### 今回再確認した証拠

2026-09-23のGitHub読み取りで、PR #1の上記コメント、PR #3本文／head `d8e5b70876c4683e79e4bad6a3012135e1e4b51d`、PR #9本文／head `db39d0ebc757a02130ba1131f4bf3cf2e3813a47`を確認。#3と#9はこの時点では未マージだった。PR #1コメントは2026-09-20の投稿であり、新しい本機試験ではない。

Minecraftの`async-planner.mjs`（blob `0b4e72e3419d57f51f961f0309a81d27a2afdaf8`）と`optimization/nether/REVIEW.md`（blob `2fe16376d3053bc07378ffa1ffce4fef1ef770a3`）を再読した。前者のstage変化時の破棄はコードの静的確認、後者の失敗・改善は作者報告。こちらでゲームを実行していない。表の他の参照先は前回調査からの入口であり、今回すべてを再監査したという意味ではない。

## 5. 小さく保つ設計の基準

以下は既存会話で合意した設計目標であり、実装済みAPIではない。D1で全体を実装しない。

Codexは目的・手順・候補の意味付けと難しい判断、Jevは提示された短期候補の選択、adapterはWindowsの観測・操作、Verifierは結果確認を担当する。別プロセスやクラスを役割ごとに必ず作るという意味ではない。少数の関数と明示的なデータで足りるなら、それを優先する。

- 観測には取得元と取得可否を残す。候補なし、構造化情報なし、読込中、認証待ちを区別する。画像を解釈するCodexと、画像を取得するExecutorを同一機能と考えない。追加のOCRや別制御経路は最後の手段とし、ツール制約を迂回しない。
- 操作IDへ対象・操作・用意済み引数・観測・許可・結果条件を結び付ける。モデルの出力から任意コードを実行せず、選択後に座標や引数を差し替えない。候補外、古い観測、引数不足、権限不足では操作しない。
- `EXECUTE / REOBSERVE / REASONING / VISION / ASK_USER`の処理先、単発の操作結果、全体の終了理由を分ける。`NONE`を許し、終わったという提案と実際の検証済み完了を区別する。型名を増やすこと自体を目的にしない。
- 操作直前の基本的な対象・状態確認は全操作へ適用し、重要操作だけ追加確認する。再観測でも原子的な実行保証にはならない。結果不明な送信・保存等は自動再送せず、結果を調べる。
- 待機・再観測・API再試行・Codex引き継ぎは共通予算を持つ。入力は値、選択は選択状態など操作別に進捗を測る。通常の非同期処理の待機を、単に同じ画面という理由だけでLOOPとしない。
- 既知手順のまとめ実行とJevの逐次選択を分ける。Codex呼び出しを省いても各段階の観測・検査・検証は省かない。高速化は同一条件の完了率、介入、総時間、費用で比較する。
- 短い符号はID／enum／表示用の略記に限る。意味を明記し、複雑な一時言語を学習させない。新しい公開入口は必要になった時点で追加する。

挙動を変更したPRには、変更理由、採用／不採用の既存案と根拠、入力・出力・エラー、最小の使用例、該当する回帰テスト、残る制限を短く残す。重要な判断はこの文書または該当モジュールの近くへ集約し、同じ仕様を何箇所にも複製しない。

## 6. 失敗記録の最小形式

```text
日付／対象SHA／環境／観測方法：
根拠の種類とURLまたはローカルの非公開記録参照：
目的と成功条件：
失敗した操作・実際の結果：
原因：確認済み／候補／未確認
対処と再現試験：
結果・残る制限・次の確認：
```

元の失敗を削除して成功率だけを出さない。環境準備・観測・候補生成・モデル選択・実行・Verifierのどこで失敗したか分ける。第三者のテスト数・小数回のライブ例・READMEの速度を本プロジェクトの実績に数えない。秘密や実デスクトップ情報は公開せず、必要なら人工的なfixtureで再現する。根拠が得られない場合も、その限界を記録する。
