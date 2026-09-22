/**
 * jev-use ループ：観測（Computer Use）→ 判断（Jev）→ 検査（Policy）→ 実行（Computer Use）。
 *
 * 設計上の前提：グローバル変数 `cua` を持つ Codex デスクトップの cua_repl JS 環境で実行する。
 * このモジュールでは cua 固有 API を import せず、単体テストができるよう driver から注入する。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decide as jevDecide } from "./jev-decide.mjs";
import { evaluatePolicy, DEFAULT_ALLOWED_APPS } from "./policy.mjs";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/* --------------------------- AX の解析と候補 --------------------------- */

const ROLES = [
  "standard window",
  "split group",
  "scroll area",
  "HTML content",
  "content list",
  "menu bar",
  "menu bar main-menu-bar",
  "toolbar",
  "radio button",
  "close button",
  "minimize button",
  "full screen button",
  "search field",
  "text field",
  "pop up button",
  "toggle button",
  "stepper",
  "combo box",
  "menu item",
  "button",
  "checkbox",
  "heading",
  "image",
  "link",
  "text",
  "grid",
  "list",
  "date time area",
  "row",
  "tab",
  "container",
  "Event",
];

// CUA の中国語版 Calculator 出力で観測されたロール名。
// ロールのみ正規化する。中国語の照合語、ラベル、ID、元の行は翻訳しない。
const ROLE_ALIASES = new Map([
  ["标准窗口", "standard window"],
  ["分离组", "split group"],
  ["滚动区", "scroll area"],
  ["文本", "text"],
  ["按钮", "button"],
]);

const CLICKABLE_ROLES = new Set([
  "button",
  "radio button",
  "close button",
  "minimize button",
  "full screen button",
  "link",
  "menu item",
  "text field",
  "search field",
  "checkbox",
  "pop up button",
  "toggle button",
  "stepper",
  "combo box",
  "tab",
  "list",            // Calendar の月表示の日付セル（role=list、例："list Saturday, September 19"）
  "date time area",  // Calendar の日付／時刻選択（ID: start-datepicker / start-timepicker 等）
]);

/** AX テキストを要素一覧に変換する：{index, role, label, depth, raw} */
export function parseAX(axText) {
  const out = [];
  for (const line of String(axText ?? "").split(/\r?\n/)) {
    const m = line.match(/^(\s*)(\d+)\s+(.*)$/);
    if (!m) continue;
    const depth = m[1].replace(/\t/g, "    ").length;
    const rest = m[3].trim();
    const sourceRole = ROLES.find((r) => rest === r || rest.startsWith(r + " ")) ?? rest.split(" ")[0];
    const role = ROLE_ALIASES.get(sourceRole) ?? sourceRole;
    // AX の末尾メタデータ（例："Secondary Actions: Move next, Remove from toolbar"）を除く。
    // これは要素名ではなく補助操作の一覧であり、残すとラベルや危険語判定に影響する。
    const label = rest
      .slice(sourceRole.length)
      .trim()
      .replace(/,?\s*Secondary Actions:.*$/i, "")
      .trim();
    out.push({ index: Number(m[2]), role, label, depth, raw: line });
  }
  return out;
}

/**
 * 候補の抽出：ロールによる絞り込みと簡易スコアリング。
 * P0 の教訓：単に先頭から切り詰めると、一覧項目に押し出されて目的の要素が候補から落ちる。
 */
export function selectCandidates(elements, goal = "", { max = 40 } = {}) {
  const tokens = String(goal)
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/)
    .filter((t) => t.length >= 2);

  const scored = [];
  for (const el of elements) {
    if (!CLICKABLE_ROLES.has(el.role)) continue;
    let score = 0;
    if (["button", "toggle button", "radio button", "menu item", "pop up button", "combo box"].includes(el.role)) score += 3;
    if (["text field", "search field"].includes(el.role)) score += 2;
    if (el.role === "link") score += 1;
    const label = `${el.label}`.toLowerCase();
    if (label) {
      for (const t of tokens) if (label.includes(t)) score += 4;
    } else {
      score -= 2;
    }
    if (/^javascript:;?$/.test(el.label.trim()) || !el.label.trim()) score -= 2;
    if (/previous month|next month|today|搜索|search/i.test(el.label) && /month|搜索|search/i.test(goal)) score += 6;
    if (el.role === "toggle button" && /toolbar|tool\b|tool\s/i.test(goal)) score += 5;
    scored.push({ ...el, score });
  }

  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  const clipped = scored.length > max;
  const selected = scored.slice(0, max);
  return Object.assign(selected, { clipped, totalClickable: scored.length });
}

/**
 * Jev に渡す少量の情報：ウィンドウタイトル、重要なテキスト行（計算機の表示値など）、フォーカス行。
 * 候補だけでなく現在値も渡し、複数ステップの判断に必要な状態を伝える。
 */
export function buildContext(axText, { maxTextLines = 6 } = {}) {
  const lines = String(axText ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const head = lines.slice(0, 2);
  const texts = parseAX(axText).filter((element) => element.role === "text")
    .slice(0, maxTextLines).map((element) => element.raw.trim());
  const focus = lines.find((l) => /focused UI element/i.test(l));
  return [...head, ...texts, focus].filter(Boolean).join("\n").slice(0, 1_500);
}

/* ------------------------------ cua アダプター ------------------------------ */

export function createCuaDriver(cua) {
  let app = null;
  return {
    async bind(appName) {
      app = await cua.getApp(appName);
      return app;
    },
    async observe({ full = true } = {}) {
      return withRetry(() => app.getAXState({ emit: false, disableDiffing: full }), { attempts: 3, delayMs: 300 });
    },
    async click(index, options) {
      return app.click(index, options);
    },
    async drag(from, to) {
      return app.drag(from, to);
    },
    async setValue(index, value) {
      return app.setValue(index, value);
    },
    async typeText(text) {
      return app.typeText(text);
    },
    async pressKey(key) {
      return app.pressKey(key);
    },
    async scroll(index, direction, pages) {
      return app.scroll(index, direction, pages);
    },
  };
}

/* ------------------------------- メインループ ------------------------------- */

const defaultEmit = (line) =>
  globalThis.nodeRepl?.write ? globalThis.nodeRepl.write(line + "\n") : console.log(line);

export async function runTask({
  driver,
  appName,
  goal,
  dryRun = true,
  maxSteps = 30,
  candidateMax = 40, // 候補数の上限。大きな日付ツリー（42セルとポップアップ内の欄）では調整が必要
  allowedApps = DEFAULT_ALLOWED_APPS,
  thresholds,
  decide = jevDecide,
  emit = defaultEmit,
  traceDir = path.join(PROJECT_DIR, "runs"),
  traceId,
  resources = {}, // { text, key, direction } は Planner が用意する（Jev は文字列を生成しない）
  constraints = "",
  plan = "", // Planner（Codex）が用意した手順。Planner が作業内容、Jev が操作対象を選ぶ
  jevOptions = {},
  verify, // 任意：完全な AX → boolean。指定した場合は全体目標の検証に使う
}) {
  const runId = traceId ?? `${new Date().toISOString().replace(/[:.]/g, "-")}-${appName.replace(/\W+/g, "")}`;
  fs.mkdirSync(traceDir, { recursive: true });
  const tracePath = path.join(traceDir, `${runId}.jsonl`);
  const record = (entry) => fs.appendFileSync(tracePath, JSON.stringify({ ts: new Date().toISOString(), runId, ...entry }) + "\n");

  emit(`[jev-use] run=${runId} app=${appName} dryRun=${dryRun} goal=${goal}`);
  record({ event: "start", appName, goal, dryRun, maxSteps, plan });

  await driver.bind(appName);
  let observation = await driver.observe({ full: true });
  const recentActions = [];
  const startedAt = Date.now();

  for (let step = 1; step <= maxSteps; step++) {
    // Planner が渡す確定的な手順（座標クリック／ドラッグ／入力）は、下で実行可否を制御する。
    // ツールバーやパネルのどの要素を選ぶか、といった判断を Jev に渡す。
    const planned = typeof resources === "function" ? ((await resources(step, null)) ?? {}) : {};
    if (planned.skipJev) {
      // 旧 Planner 経路には検証可能な対象／リスクがないため、Policy を迂回して実行しない。
      return finish(dryRun ? "dry_run" : "escalate", {
        steps: step - 1, tracePath, planned,
        message: "Planner の直接操作はプレビュー専用です。現在の Computer Use 呼び出しで確認・実行し、Jev の判断には数えないでください",
        elapsedMs: Date.now() - startedAt,
      });
    }
    if (verify && await verify(observation)) {
      return finish("done", { steps: step - 1, tracePath, verified: true, elapsedMs: Date.now() - startedAt });
    }
    const stepGoal = planned.jevGoal ?? goal;

    let candidates = selectCandidates(parseAX(observation), stepGoal, { max: candidateMax });
    // 観測が不足する場合（直前の差分に解析できる要素がない場合など）は、完全なツリーで1回再観測する
    if (candidates.length < 2) {
      observation = await driver.observe({ full: true });
      candidates = selectCandidates(parseAX(observation), stepGoal, { max: candidateMax });
      if (candidates.length < 2) {
        record({ event: "no_candidates", step });
        return finish("escalate", {
          steps: step - 1,
          tracePath,
          message: "候補要素が不足しているため判断できません",
          elapsedMs: Date.now() - startedAt,
        });
      }
    }
    if (candidates.clipped) {
      emit(`[step ${step}] 候補を制限：${candidates.totalClickable} → ${candidateMax}（ロールと関連度で並べ替え済み）`);
    }

    let decision;
    try {
      decision = await decide({
        goal: stepGoal,
        app: appName,
        candidates,
        context: buildContext(observation),
        recentActions,
        constraints: [planned.jevPlan ?? "", plan ? `Plan (from planner): ${plan}` : "", constraints].filter(Boolean).join("\n"),
        ...jevOptions,
      });
    } catch (err) {
      record({ event: "decide_error", step, message: err.message });
      return { status: "error", step, message: err.message, tracePath };
    }

    const selected = candidates.find(c => c.index === decision.targetIndex);
    const invalidTarget = decision.targetIndex != null && !selected;
    if (invalidTarget) {
      return finish("escalate", { steps: step - 1, tracePath, message: "対象が現在の候補一覧にありません", elapsedMs: Date.now() - startedAt });
    }
    // モデル用の説明は短縮される。Policy では、カスタムアダプターがラベルを返した場合も、
    // 選択された観測要素の完全なラベルを使う。
    if (selected) decision = { ...decision, targetLabel: selected.label };
    const gate = evaluatePolicy({ decision, app: appName, allowedApps, step, maxSteps, thresholds, dryRun });
    const target = decision.targetIndex != null ? `i${decision.targetIndex} (${decision.targetLabel ?? "?"})` : "—";
    const line =
      `[step ${step}] Jev ${decision.latencyMs}ms · ${decision.action ?? "?"} ${target} · ` +
      `conf=${fmt(decision.confidence)} risk=${fmt(decision.risk)} done=${fmt(decision.done)} → ${gate.verdict}` +
      (gate.reasons.length ? ` · ${gate.reasons.join("；")}` : "");
    emit(line);
    record({ event: "step", step, candidates: candidates.length, decision: stripRaw(decision), gate });

    if (gate.verdict === "done" && (verify || stepGoal !== goal)) {
      return finish("escalate", { steps: step - 1, tracePath, decision, message: "Jev は完了と判断しましたが全体目標は未確認です。現在の段階を確認してください", elapsedMs: Date.now() - startedAt });
    }
    if (gate.verdict === "done") {
      return finish("done", { steps: step - 1, tracePath, decision, gate, elapsedMs: Date.now() - startedAt });
    }
    if (gate.verdict !== "proceed") {
      return finish(gate.verdict, { steps: step - 1, tracePath, decision, gate, elapsedMs: Date.now() - startedAt });
    }
    if (dryRun) {
      return finish("dry_run", {
        steps: 0,
        tracePath,
        planned: { action: decision.action, targetIndex: decision.targetIndex, targetLabel: decision.targetLabel },
        gate,
        elapsedMs: Date.now() - startedAt,
      });
    }

    const tAct = Date.now();
    // 引数には固定設定またはステップごとのコールバックを使える（Planner が作業内容、Jev が操作対象を選ぶ）
    const stepResources = typeof resources === "function" ? ((await resources(step, decision)) ?? {}) : resources;
    try {
      await executeAction(driver, decision, stepResources);
    } catch (err) {
      record({ event: "action_error", step, message: err.message });
      return finish("error", { steps: step, tracePath, message: `操作の実行に失敗しました：${err.message}`, elapsedMs: Date.now() - startedAt });
    }
    const actMs = Date.now() - tAct;

    const previousObservation = observation;
    observation = await driver.observe({ full: true });
    const noChange = observation === previousObservation;
    recentActions.push(`${decision.action} i${decision.targetIndex} → ${noChange ? "no change" : "changed"}`);
    emit(`         └ 操作 ${actMs}ms · ${noChange ? "画面に変化なし" : "画面に変化あり"}`);
    record({ event: "action", step, actMs, noChange, action: decision.action, targetIndex: decision.targetIndex });
  }

  if (verify && await verify(observation)) {
    return finish("done", { steps: maxSteps, tracePath, verified: true, elapsedMs: Date.now() - startedAt });
  }
  return finish("max_steps", { steps: maxSteps, tracePath, elapsedMs: Date.now() - startedAt });

  function finish(status, extra) {
    record({ event: "finish", status, ...extra });
    emit(`[jev-use] 終了：${status} · 所要時間 ${(extra.elapsedMs / 1000).toFixed(1)}s · trace=${tracePath}`);
    return { status, ...extra };
  }
}

async function executeAction(driver, decision, resources) {
  switch (decision.action) {
    case "click_element":
      if (Array.isArray(resources.at)) return driver.click(resources.at);
      return driver.click(decision.targetIndex, resources.mouseButton ? { mouseButton: resources.mouseButton } : undefined);
    case "click_at":
      return driver.click(resources.at);
    case "drag":
      return driver.drag(resources.from, resources.to);
    case "set_value":
      return driver.setValue(decision.targetIndex, String(resources.text ?? ""));
    case "type_text":
      return driver.typeText(String(resources.text ?? ""));
    case "press_key":
      return driver.pressKey(String(resources.key ?? "Return"));
    case "scroll":
      return driver.scroll(decision.targetIndex, String(resources.direction ?? "down"), 1);
    case "wait":
      return sleep(500);
    default:
      throw new Error(`未対応の操作種別：${decision.action}`);
  }
}

const fmt = (n) => (typeof n === "number" ? n.toFixed(2) : "n/a");
const stripRaw = ({ raw, ...rest }) => rest;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 一時的な実行基盤エラー（ScreenCaptureKit／無効な引数）を再試行する */
export async function withRetry(fn, { attempts = 3, delayMs = 350 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const transient = /ScreenCaptureKit|invalid parameter|-10005|timeout/i.test(String(err));
      if (!transient || i === attempts - 1) throw err;
      await sleep(delayMs);
    }
  }
  throw lastErr;
}
