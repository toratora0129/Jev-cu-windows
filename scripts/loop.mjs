/**
 * jev-use ループ：観測（Computer Use）→ 判断（Jev）→ 検査（Policy）→ 実行（Computer Use）。
 *
 * 設計上の前提：グローバル変数 `cua` を持つ Codex デスクトップの cua_repl JS 環境で実行する。
 * このモジュールでは cua 固有 API を import せず、単体テストができるよう driver から注入する。
 */



import { decide as jevDecide } from "./jev-decide.mjs";
import { evaluatePolicy, DEFAULT_ALLOWED_APPS } from "./policy.mjs";



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

/** 旧cuaの1回プレビュー。実操作は観測・許可を固定する新しい入口へ移行した。 */
export async function runTask({driver, appName, goal, dryRun = true, candidateMax = 40,
  allowedApps = DEFAULT_ALLOWED_APPS, thresholds, decide = jevDecide, verify,
} = {}) {
  if (dryRun !== true) return {status: 'escalate', reason: 'legacy_execution_disabled', steps: 0};
  try {
    await driver.bind(appName);
    const observation = await driver.observe({full: true});
    if (typeof observation !== 'string' || !observation.trim()) return {status: 'escalate', reason: 'observation_unavailable', steps: 0};
    if (verify && await verify(observation) === true) return {status: 'done', verified: true, steps: 0};
    const candidates = selectCandidates(parseAX(observation), goal, {max: candidateMax});
    if (candidates.length < 2) return {status: 'escalate', reason: 'missing_candidates', steps: 0};
    const response = await decide({goal, app: appName, candidates, context: buildContext(observation)});
    const selected = candidates.find(c => c.index === response?.targetIndex);
    if (response?.targetIndex != null && !selected) return {status: 'escalate', reason: 'invalid_target', steps: 0};
    const decision = {...response, targetLabel: selected?.label};
    const gate = evaluatePolicy({decision, app: appName, allowedApps, thresholds, dryRun: true});
    // 生応答・ラベル・エラー文字列・goalをログにも戻り値にも反射しない。
    return {status: gate.verdict === 'proceed' ? 'dry_run' : gate.verdict, reason: gate.kind ?? 'preview', steps: 0};
  } catch { return {status: 'error', reason: 'preview_failed', steps: 0}; }
}

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
