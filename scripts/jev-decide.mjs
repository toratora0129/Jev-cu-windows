#!/usr/bin/env node
/**
 * Jev の判断処理を包むモジュール（TypeSafe API に直接接続）。
 *
 * - キー読込・標準fetchによる通信は別々の明示opt-inが必要。既定では両方しない。
 * - ask()   ：systemone を1回呼び出す（複数の質問を同時に指定可能）
 * - decide()：Computer Use ループ用の標準4問（target/action/done/risk）
 *
 * 旧CLI（通信opt-inを渡さないためNETWORK_DISABLEDで停止）：
 *   node scripts/jev-decide.mjs payload.json
 *   cat payload.json | node scripts/jev-decide.mjs
 */
import fs from "node:fs";
import { Buffer } from 'node:buffer';
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BoundaryError, requireCondition, isRecord, isProbability, withinDeadline } from './safety.mjs';

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const DEFAULT_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const DEFAULT_MODEL = "jev-1.13.0";
/** 上流実装の料金計算用定数：入力 $42/Btok = $0.042/Mtok、出力無料。最新料金は別途確認する。 */
export const PRICE_PER_INPUT_TOKEN_USD = 0.042 / 1e6;

export function loadApiKey({
  allowSecretRead = false,
  envVar = "TYPESAFE_API_KEY",
  envFile = path.join(PROJECT_DIR, ".env.local"),
} = {}) {
  requireCondition(allowSecretRead === true, 'SECRET_READ_DISABLED');
  const env = globalThis.process?.env ?? {};
  if (env[envVar]) return String(env[envVar]).trim();
  try {
    const text = fs.readFileSync(envFile, "utf8");
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && m[1] === envVar) return m[2].replace(/^['"]|['"]$/g, "").trim();
    }
  } catch {
    /* ファイルが存在しない場合は、下の共通エラーに進む */
  }
  throw new BoundaryError('API_KEY_MISSING');
}

export function estimateCostUsd(usage = {}) {
  const tokens = usage.input_tokens ?? usage.inputTokens ?? 0;
  return tokens * PRICE_PER_INPUT_TOKEN_USD;
}

function toNumber(value) {
  return isProbability(value) ? value : null;
}

/** 候補の説明を整形し、URL 等のノイズと長さを抑える（単体テスト用に公開） */
export function sanitizeLabel(text, max = 120) {
  return String(text ?? "")
    .replace(/\b(?:https?|orpheus|file|javascript|data):\S*/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** ループ用の標準4問を組み立てる（単体テスト用に公開） */
export function buildQuestions(goal, candidates = []) {
  const criteria = {};
  for (const c of candidates) criteria[`i${c.index}`] = sanitizeLabel(`${c.role}: ${c.label}`);

  return {
    criteria,
    questions: {
      target: {
        type: "choice",
        instructions: `Which single element should be acted on next to accomplish the goal? Goal: ${goal}`,
        criteria,
      },
      action: {
        type: "choice",
        instructions: "What is the next action type?",
        criteria: {
          click_element: "Click the chosen element",
          click_at: "Click a canvas position (coordinates come from the planner)",
          drag: "Drag on the canvas (coordinates come from the planner)",
          set_value: "Replace the value of a text input",
          type_text: "Type the provided text",
          press_key: "Press a keyboard key",
          scroll: "Scroll the current view",
          wait: "Wait for the UI to update",
          ask_user: "Stop and ask the user",
        },
      },
      done: {
        type: "noul",
        instructions: "Is the goal already visibly achieved in the current UI state?",
      },
      risk: {
        type: "noul",
        instructions:
          "Does the next action require explicit user confirmation (delete data, send/submit, pay/subscribe, change permissions, upload/share, solve CAPTCHA, install software, change system settings, enter credentials)?",
        criteria: {
          true: "delete / send / pay / permission / upload / captcha / install / system settings / credentials",
          false: "safe reversible navigation such as opening, searching, scrolling, selecting, reading",
        },
      },
    },
  };
}

/** API の answers をループで利用できる形式に正規化する（単体テスト用に公開） */
export function normalizeDecision(answers = {}, criteria = {}) {
  const targetKey = answers.target?.choice ?? null;
  const valid = typeof targetKey === "string" && /^i\d+$/.test(targetKey) && Object.hasOwn(criteria, targetKey);
  return {
    action: answers.action?.choice ?? null,
    targetKey: valid ? targetKey : null,
    targetIndex: valid ? Number(targetKey.slice(1)) : null,
    targetLabel: valid ? (criteria[targetKey] ?? null) : null,
    done: toNumber(answers.done?.noul ?? answers.done?.probability),
    risk: toNumber(answers.risk?.noul ?? answers.risk?.probability),
    confidence: toNumber(answers.target?.confidence),
    probabilities: answers.target?.probabilities ?? {},
  };
}

export async function ask({
  state,
  questions,
  model = DEFAULT_MODEL,
  apiKey,
  endpoint = DEFAULT_ENDPOINT,
  maxRetries = 0,
  timeoutMs = 10_000,
  maxResponseBytes = 65_536,
  allowNetwork = false,
  allowSecretRead = false,
  fetchImpl,
}) {
  // キーを読むより先に宛先・明示許可・予算を検査する。自動再送なし。
  requireCondition(endpoint === DEFAULT_ENDPOINT, 'ENDPOINT_DENIED');
  requireCondition(fetchImpl === undefined || typeof fetchImpl === 'function', 'INVALID_TRANSPORT');
  requireCondition((typeof fetchImpl === 'function' && fetchImpl !== globalThis.fetch) || allowNetwork === true, 'NETWORK_DISABLED');
  requireCondition(maxRetries === 0, 'RETRIES_DISABLED');
  requireCondition(model === DEFAULT_MODEL, 'MODEL_NOT_PINNED');
  requireCondition(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 60_000, 'INVALID_TIMEOUT');
  requireCondition(Number.isSafeInteger(maxResponseBytes) && maxResponseBytes > 0 && maxResponseBytes <= 65_536, 'INVALID_SIZE_LIMIT');
  validateQuestions(questions);
  requireCondition(typeof state === 'string' || isRecord(state) || Array.isArray(state), 'INVALID_STATE');
  let requestBody;
  try { requestBody = JSON.stringify({state, model, questions}); }
  catch { throw new BoundaryError('INVALID_REQUEST'); }
  requireCondition(state !== undefined && Buffer.byteLength(requestBody, 'utf8') <= 16_384, 'REQUEST_TOO_LARGE');
  const sentQuestions = JSON.parse(requestBody).questions;
  validateQuestions(sentQuestions); // 応答待ち中の呼出し側の変更を反映しない。
  // 模擬transportは明示された偽キーだけを使う。暗黙の秘密読込をしない。
  const key = apiKey ?? (fetchImpl === undefined ? loadApiKey({allowSecretRead}) : null);
  requireCondition(typeof key === 'string' && key.trim().length > 0 && !/[\r\n]/.test(key), 'API_KEY_REQUIRED');
  const transport = fetchImpl ?? globalThis.fetch;
  requireCondition(typeof transport === 'function', 'INVALID_TRANSPORT');
  const controller = new AbortController();
  const startedAt = Date.now();
  let reader;
  try {
    return await withinDeadline(async () => {
      const res = await transport(DEFAULT_ENDPOINT, {
        method: 'POST', redirect: 'error', credentials: 'omit',
        headers: {Authorization: `Bearer ${key}`, 'Content-Type': 'application/json'},
        body: requestBody, signal: controller.signal,
      });
      requireCondition(!controller.signal.aborted, 'DEADLINE');
      requireCondition(!res.redirected && (!res.url || res.url === DEFAULT_ENDPOINT), 'REDIRECT_DENIED');
      requireCondition(Number.isInteger(res.status) && res.status >= 200 && res.status < 300, 'HTTP_ERROR');
      requireCondition(/^application\/json(?:\s*;|$)/i.test(res.headers?.get('content-type') ?? ''), 'INVALID_CONTENT_TYPE');
      const length = res.headers.get('content-length');
      requireCondition(length === null || (/^\d+$/.test(length) && Number(length) <= maxResponseBytes), 'RESPONSE_TOO_LARGE');
      requireCondition(typeof res.body?.getReader === 'function', 'INVALID_BODY');
      reader = res.body.getReader();
      const chunks = [];
      let bytes = 0;
      while (true) {
        const {done, value} = await reader.read();
        requireCondition(!controller.signal.aborted, 'DEADLINE');
        if (done) break;
        requireCondition(value instanceof Uint8Array, 'INVALID_BODY');
        bytes += value.byteLength;
        requireCondition(bytes <= maxResponseBytes, 'RESPONSE_TOO_LARGE');
        chunks.push(value);
      }
      let body;
      try { body = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(Buffer.concat(chunks))); }
      catch { throw new BoundaryError('INVALID_JSON'); }
      const clean = validateResponse(body, sentQuestions, model);
      return {...clean, latencyMs: Date.now() - startedAt, costUsd: estimateCostUsd(clean.usage)};
    }, timeoutMs, () => controller.abort());
  } catch (error) {
    controller.abort();
    throw error instanceof BoundaryError ? error : new BoundaryError('TRANSPORT_FAILED');
  } finally {
    // cancelが停止しない模擬streamでも、終了期限を延ばさない。
    try { Promise.resolve(reader?.cancel()).catch(() => {}); } catch { /* no raw error */ }
  }
}

function validateQuestions(questions) {
  requireCondition(isRecord(questions) && Object.keys(questions).length > 0 && Object.keys(questions).length <= 16, 'INVALID_QUESTIONS');
  for (const question of Object.values(questions)) {
    requireCondition(isRecord(question) && ['choice', 'noul'].includes(question.type) && typeof question.instructions === 'string' && question.instructions.length > 0, 'INVALID_QUESTION');
    if (question.type === 'choice') requireCondition(isRecord(question.criteria) && Object.keys(question.criteria).length >= 2 && Object.values(question.criteria).every(v => typeof v === 'string' && v.length > 0), 'INVALID_CRITERIA');
  }
}

function validateResponse(body, questions, model) {
  requireCondition(isRecord(body) && isRecord(body.answers) && body.model === model, 'INVALID_RESPONSE');
  requireCondition(Object.keys(body.answers).length === Object.keys(questions).length, 'INVALID_ANSWERS');
  const answers = {};
  for (const [id, question] of Object.entries(questions)) {
    const answer = body.answers[id];
    requireCondition(isRecord(answer) && answer.type === question.type, 'INVALID_ANSWER');
    if (question.type === 'noul') {
      requireCondition(isProbability(answer.noul), 'INVALID_PROBABILITY');
      answers[id] = {type: 'noul', noul: answer.noul};
    } else {
      requireCondition(typeof answer.choice === 'string' && Object.hasOwn(question.criteria, answer.choice) && isProbability(answer.confidence), 'INVALID_CHOICE');
      const probabilities = answer.probabilities;
      const ids = Object.keys(question.criteria);
      requireCondition(isRecord(probabilities) && Object.keys(probabilities).length === ids.length && ids.every(k => Object.hasOwn(probabilities, k) && isProbability(probabilities[k])), 'INVALID_DISTRIBUTION');
      requireCondition(Math.abs(ids.reduce((sum,k) => sum + probabilities[k], 0) - 1) < 0.01, 'INVALID_DISTRIBUTION');
      requireCondition(probabilities[answer.choice] >= Math.max(...Object.values(probabilities)), 'INCONSISTENT_CHOICE');
      answers[id] = {type: 'choice', choice: answer.choice, confidence: answer.confidence, probabilities: Object.fromEntries(ids.map(k => [k, probabilities[k]]))};
    }
  }
  requireCondition(isRecord(body.usage) && Number.isSafeInteger(body.usage.input_tokens) && body.usage.input_tokens >= 0, 'INVALID_USAGE');
  requireCondition(body.usage.output_tokens === undefined || (Number.isSafeInteger(body.usage.output_tokens) && body.usage.output_tokens >= 0), 'INVALID_USAGE');
  return {answers, model, usage: {input_tokens: body.usage.input_tokens}};
}

/**
 * Computer Use ループの標準的な判断の入口。
 * @param {object} input
 * @param {string} input.goal 英語の目標（上流の例に合わせて維持。言語別精度の保証ではない）
 * @param {string} input.app
 * @param {Array<{index:number, role:string, label:string}>} input.candidates
 * @param {string} [input.context] 少量の画面情報（ウィンドウタイトル／フォーカス行）
 * @param {string[]} [input.recentActions]
 * @param {string} [input.constraints]
 */
export async function decide({
  goal,
  app,
  candidates = [],
  context = "",
  recentActions = [],
  constraints = "",
  ...askOptions
}) {
  const { criteria, questions } = buildQuestions(goal, candidates);
  const state = {
    goal,
    app,
    context: String(context).slice(0, 1_500),
    candidates: Object.entries(criteria).map(([id, desc]) => ({ id, desc })),
    recent_actions: recentActions.slice(-6),
    constraints,
  };
  const r = await ask({ state, questions, ...askOptions });
  return {
    ...normalizeDecision(r.answers, criteria),
    usage: r.usage,
    latencyMs: r.latencyMs,
    costUsd: r.costUsd,
    model: r.model,
  };
}

/* ------------------------------- CLI ------------------------------- */

async function main() {
  const file = process.argv[2];
  const raw = file
    ? await fs.promises.readFile(file, "utf8")
    : await new Promise((resolve, reject) => {
        let data = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (c) => (data += c));
        process.stdin.on("end", () => resolve(data));
        process.stdin.on("error", reject);
      });
  const payload = JSON.parse(raw);
  const result = await ask({
    state: payload.state,
    questions: payload.questions,
    model: payload.model ?? DEFAULT_MODEL,
  });
  console.log(JSON.stringify(result, null, 2));
}

const isMain =
  typeof process !== "undefined" && process.argv?.[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error('[jev-decide] CLI_DISABLED_OR_INVALID_INPUT');
    process.exit(1);
  });
}
