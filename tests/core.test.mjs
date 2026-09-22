import test from "node:test";
import assert from "node:assert/strict";
import { parseAX, selectCandidates, buildContext } from "../scripts/loop.mjs";
import { evaluatePolicy, matchSensitive } from "../scripts/policy.mjs";
import { buildQuestions, normalizeDecision, sanitizeLabel } from "../scripts/jev-decide.mjs";

const CALENDAR_AX = [
  'Window: "Calendar", App: Calendar.',
  '0 standard window Calendar, ID: CALMainWindow, Secondary Actions: Raise',
  "\t1 split group",
  "\t\t2 container Description: Month Calendar Area, Value: 9/18/26, ID: active-view",
  "\t\t\t4 list Sunday, August 30",
  "\t\t\t5 list Monday, August 31",
  "\t\t\t6 list Tuesday, September 1",
  "\t\t\t7 list Wednesday, September 2",
  "\t\t\t8 list Thursday, September 3",
  "\t\t\t9 list Friday, September 4",
  "\t\t\t10 list Saturday, September 5",
  "\t\t\t11 list Sunday, September 6",
  "\t\t\t12 list Monday, September 7",
  "\t\t\t13 Event Description: Labor Day. September 7, 2026, All-Day",
  "\t17 list Tuesday, September 8",
  "\t24 list Sunday, September 13",
  "\t31 list Today, Friday, September 18",
  "\t\t\t56 button previous month",
  "\t\t\t57 button Today, ID: today-button",
  "\t\t\t58 button next month",
  "\t\t59 text Value: September 2026, ID: view-date-title",
  "\t60 toolbar",
  "\t\t64 button Description: Add Event",
  "\t\t71 button Search",
  "\t72 close button",
  "The focused UI element is 2 container Description: Month Calendar Area",
].join("\n");

test("parseAX：インデックス・ロール・ラベルの解析", () => {
  const els = parseAX(CALENDAR_AX);
  const prev = els.find((e) => e.index === 56);
  assert.equal(prev.role, "button");
  assert.equal(prev.label, "previous month");
  const field = els.find((e) => e.index === 57);
  assert.equal(field.role, "button");
});

test("parseAX：CRLF 改行に対応（Windows チェックアウトの回帰確認）", () => {
  // A Windows checkout (core.autocrlf) turns the LF fixtures into CRLF. Splitting
  // on "\n" alone leaves a trailing "\r" on every line, and because "." does not
  // match "\r" the `(.*)$` group never closes: parseAX then returns 0 elements and
  // every Choice question is sent with an empty criteria map (HTTP 400).
  const crlf = CALENDAR_AX.replace(/\n/g, "\r\n");
  const els = parseAX(crlf);
  assert.equal(els.length, parseAX(CALENDAR_AX).length, "CRLF と LF で解析される要素数が一致すること");
  assert.ok(els.length > 0, "CRLF のテキストでも要素が解析されること");
  const prev = els.find((e) => e.index === 56);
  assert.equal(prev?.role, "button");
  assert.equal(prev?.label, "previous month");
  assert.ok(buildContext(crlf).includes("September"), "buildContext が CRLF の状態行を取得できること");
});

test("selectCandidates：目的のボタンを候補から落とさない（P0 の回帰確認）", () => {
  const els = parseAX(CALENDAR_AX);
  const candidates = selectCandidates(els, "switch the calendar to the previous month", { max: 40 });
  const indices = candidates.map((c) => c.index);
  assert.ok(indices.includes(56), "previous month ボタンが候補に含まれること");
  assert.ok(indices.includes(58), "next month ボタンが候補に含まれること");
  // 日付セルも選べるが、月移動ボタンは無関係な日付より先に並ぶこと。
  assert.ok(indices.indexOf(56) < indices.indexOf(4));
});

test("selectCandidates：max が小さくてもボタンを優先して残す", () => {
  const els = parseAX(CALENDAR_AX);
  const candidates = selectCandidates(els, "previous month", { max: 3 });
  assert.ok(candidates.map((c) => c.index).includes(56));
});

test("buildContext：少量の画面情報だけを取得する", () => {
  const ctx = buildContext(CALENDAR_AX);
  assert.ok(ctx.includes("Calendar"));
  assert.ok(ctx.includes("September 2026"), "重要な表示状態（現在の月）が含まれること");
  assert.ok(ctx.split("\n").length <= 9);
});

test("buildContext：計算機の表示値を含める", () => {
  const calcAx = ['Window: "Calculator", App: Calculator.', '0 standard window Calculator', '\t4 text ‎42', '\t24 button Equals'].join("\n");
  const ctx = buildContext(calcAx);
  assert.ok(ctx.includes("42"), "Jev に現在の表示値が渡ること");
});

test("policy：完了推定は成功認定せず独立確認へ返す", () => {
  const gate = evaluatePolicy({ decision: { done: 0.95, risk: 0, confidence: 1, targetIndex: 56 }, app: "Calendar" });
  assert.equal(gate.verdict, "escalate");
});

test("policy：要確認の対象なら confirm", () => {
  const gate = evaluatePolicy({
    decision: { done: 0.01, risk: 0.01, confidence: 0.99, targetIndex: 12, targetLabel: "button 删除歌曲" },
    app: "NetEaseMusic",
  });
  assert.equal(gate.verdict, "confirm");
});

test("policy：高リスクの判定なら confirm", () => {
  const gate = evaluatePolicy({
    decision: { done: 0.01, risk: 0.8, confidence: 0.99, targetIndex: 12, targetLabel: "button download" },
    app: "NetEaseMusic",
  });
  assert.equal(gate.verdict, "confirm");
});

test("policy：低 confidence を stop / escalate に振り分ける", () => {
  const stop = evaluatePolicy({ decision: { done: 0.1, risk: 0.01, confidence: 0.2, targetIndex: 1 }, app: "Calendar" });
  assert.equal(stop.verdict, "stop");
  // Calendar は既存の緩和対象（下限 0.4）だが、0.35 では上位へ戻す
  const esc = evaluatePolicy({ decision: { done: 0.1, risk: 0.01, confidence: 0.35, targetIndex: 1 }, app: "Calendar" });
  assert.equal(esc.verdict, "escalate");
  // 緩和対象外のアプリ（下限 0.5）は、0.45 では上位へ戻す
  const esc2 = evaluatePolicy({ decision: { done: 0.1, risk: 0.01, confidence: 0.45, targetIndex: 1 }, app: "NetEaseMusic" });
  assert.equal(esc2.verdict, "escalate");
});

test("policy：緩和対象は confidence 0.46 で進み、対象外は上位へ戻す", () => {
  const calc = evaluatePolicy({ decision: { done: 0.1, risk: 0.03, confidence: 0.46, targetIndex: 24, targetLabel: "button: Equals" }, app: "Calculator" });
  assert.equal(calc.verdict, "proceed");
  const netease = evaluatePolicy({ decision: { done: 0.1, risk: 0.03, confidence: 0.46, targetIndex: 24, targetLabel: "link: 播放" }, app: "NetEaseMusic" });
  assert.equal(netease.verdict, "escalate");
});

test("policy：許可リスト外のアプリは confirm", () => {
  const gate = evaluatePolicy({ decision: { done: 0.1, risk: 0, confidence: 1, targetIndex: 1 }, app: "UnknownApp" });
  assert.equal(gate.verdict, "confirm");
});

test("matchSensitive：支払いと送信の照合", () => {
  assert.equal(matchSensitive("button 立即支付").id, "payment");
  assert.equal(matchSensitive("button Send message").id, "send");
  assert.equal(matchSensitive("button Search"), null);
});

test("buildQuestions/normalizeDecision：往復で判断情報が一致する", () => {
  const candidates = [
    { index: 56, role: "button", label: "previous month" },
    { index: 58, role: "button", label: "next month" },
  ];
  const { questions, criteria } = buildQuestions("go to the previous month", candidates);
  assert.ok(questions.target.criteria.i56.includes("previous month"));
  assert.ok(questions.action.criteria.drag, "操作種別に drag が含まれること");
  const decision = normalizeDecision(
    {
      target: { choice: "i56", confidence: 1, probabilities: { i56: 1, i58: 0 } },
      action: { choice: "click_element" },
      done: { noul: 0.04 },
      risk: { noul: 0.01 },
    },
    criteria,
  );
  assert.equal(decision.targetIndex, 56);
  assert.equal(decision.action, "click_element");
  assert.equal(decision.done, 0.04);
});

test("sanitizeLabel：長い URL を除き、文字数を制限する", () => {
  const raw = "link: 下载管理, Value: orpheus://orpheus/pub/app.html?resizable=true&x=0&y=0&width=1470#/m/offline/complete/";
  const clean = sanitizeLabel(raw);
  assert.ok(!clean.includes("orpheus://"));
  assert.ok(clean.includes("下载管理"));
  assert.ok(clean.length <= 120);
});

test("不明な対象や確率の欠落を許可しない", () => {
  const decision = normalizeDecision({ target: { choice: "i999" }, action: { choice: "click_element" } }, { i1: "button A" });
  assert.equal(decision.targetIndex, null);
  assert.equal(evaluatePolicy({ decision, app: "Calendar" }).verdict, "escalate");
});

const CHINESE_CALCULATOR_AX = [
  'Window: "计算器", App: 计算器.',
  '0 标准窗口 计算器, ID: main',
  '\t1 分离组 main',
  '\t\t3 滚动区 Description: 编辑字段',
  '\t\t\t4 文本 0',
  '\t\t\t15 按钮 Description: 6, ID: Six',
  '\t\t\t24 按钮 Description: 等于, ID: Equals',
].join('\n');

test('中国語 AX と英語ロールで候補・表示値が一致し、元のインデックスとラベルを保持する', () => {
  const en = CHINESE_CALCULATOR_AX.replace('标准窗口', 'standard window')
    .replace('分离组', 'split group').replace('滚动区', 'scroll area')
    .replace('文本', 'text').replaceAll('按钮', 'button');
  for (const separator of ['\n', '\r\n']) {
    const zh = CHINESE_CALCULATOR_AX.replaceAll('\n', separator);
    const elements = parseAX(zh);
    assert.deepEqual(elements.map(({raw, ...element}) => element),
      parseAX(en).map(({raw, ...element}) => element));
    assert.deepEqual(selectCandidates(elements).map(e => e.index), [15, 24]);
    assert.ok(buildContext(zh).includes('4 文本 0'));
    assert.ok(buildContext(en).includes('4 text 0'));
    assert.equal(elements.find(e => e.index === 15).raw.trim(), '15 按钮 Description: 6, ID: Six');
  }
  assert.equal(selectCandidates(parseAX('1 未知控件 Button')).length, 0);
});
