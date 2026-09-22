/**
 * Policy Gate：Computer Use の確認方針をコードで検査する。
 * 副作用のない純粋関数。cua 実行環境なしで単体テストできる。
 */

export const DEFAULT_ALLOWED_APPS = [
  "Calendar",
  "Calculator",
  "TextEdit",
  "NetEaseMusic",
  "Figma",
  "Google Chrome",
  "Codex In-app Browser",
];

/** 対象の表示文言がこれらのパターンに一致した場合、停止して確認する。照合用の中国語は維持する。 */
export const SENSITIVE_LABEL_PATTERNS = [
  { id: "delete", re: /删除|移除|清空|delete|remove|削除|消去|上書き/i },
  { id: "send", re: /发送|提交|发布|回复|send|submit|post|reply|送信|投稿|返信/i },
  { id: "payment", re: /支付|付款|购买|下单|充值|订阅|开通|pay|purchase|buy|subscribe|checkout/i },
  { id: "auth", re: /授权|权限|登录|密码|验证码|authorize|permission|sign in|login|password|captcha/i },
  { id: "share", re: /上传|分享|导出|upload|share|export/i },
  { id: "install", re: /安装|install/i },
  { id: "settings", re: /系统设置|偏好设置|安全设置|system settings|security settings/i },
];

export const DEFAULT_THRESHOLDS = {
  doneProbability: 0.9, // 完了の推定値がこの値以上なら終了判定
  riskConfirm: 0.2, // リスクの推定値がこの値以上なら停止して確認
  minConfidence: 0.5, // 対象の confidence がこの値未満なら判断を上位へ戻す
  lowRiskMinConfidence: 0.4, // 上流の低リスク分類では 0.4 に緩和する。副作用がないことを保証する分類ではない
  stopConfidence: 0.3, // 対象の confidence がこの値未満なら停止
};

/** 上流で confidence の閾値を緩和するアプリ。安全性や書き込み権限を保証する一覧ではない。 */
export const LOW_RISK_APPS = ["Calculator", "Calendar", "TextEdit", "Figma"];

export function matchSensitive(label = "") {
  const text = String(label);
  return SENSITIVE_LABEL_PATTERNS.find((p) => p.re.test(text)) ?? null;
}

/**
 * @param {object} input
 * @param {object} input.decision  normalizeDecision の出力
 * @param {string} input.app
 * @param {string[]} [input.allowedApps]
 * @param {number} [input.step]
 * @param {number} [input.maxSteps]
 * @param {object} [input.thresholds]
 * @param {boolean} [input.dryRun]
 * @returns {{verdict:"proceed"|"done"|"confirm"|"escalate"|"stop", kind?:string, reasons:string[]}}
 */
export function evaluatePolicy({
  decision,
  app,
  allowedApps = DEFAULT_ALLOWED_APPS,
  step = 1,
  maxSteps = 30,
  thresholds = DEFAULT_THRESHOLDS,
  dryRun = false,
}) {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const fmt = (n) => (typeof n === "number" ? n.toFixed(2) : "n/a");

  if (step > maxSteps) {
    return { verdict: "stop", kind: "budget", reasons: [`step ${step} が上限を超えました： ${maxSteps}`] };
  }
  if (![decision?.confidence, decision?.risk, decision?.done].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1)) {
    return { verdict: "escalate", kind: "invalid_decision", reasons: ["判断の確率値がないか、0～1 の範囲外です"] };
  }
  if (decision.done >= t.doneProbability) {
    return { verdict: "escalate", kind: "done_proposed", reasons: ["完了はモデル推定です。結果の独立確認が必要です"] };
  }

  const reasons = [];
  if (!allowedApps.includes(app)) reasons.push(`アプリ「${app}」は許可リストにありません`);
  const sensitive = matchSensitive(decision?.targetLabel);
  if (sensitive) reasons.push(`対象は「${sensitive.id}」に該当する要確認操作の可能性があります：${decision.targetLabel}`);
  if (typeof decision?.risk === "number" && decision.risk >= t.riskConfirm) {
    reasons.push(`Jev のリスク判定 ${fmt(decision.risk)} ≥ ${t.riskConfirm}`);
  }
  if (decision?.action === "ask_user") reasons.push("Jev がユーザーの対応が必要と判断しました");
  if (reasons.length) return { verdict: "confirm", kind: "sensitive", reasons, dryRun };

  if (typeof decision?.confidence === "number" && decision.confidence < t.stopConfidence) {
    return { verdict: "stop", kind: "low_confidence", reasons: [`対象の confidence ${fmt(decision.confidence)} < ${t.stopConfidence}`] };
  }
  const minConfidence = LOW_RISK_APPS.includes(app) ? t.lowRiskMinConfidence : t.minConfidence;
  if (typeof decision?.confidence === "number" && decision.confidence < minConfidence) {
    return {
      verdict: "escalate",
      kind: "low_confidence",
      reasons: [`対象の confidence ${fmt(decision.confidence)} < ${minConfidence}`],
      minConfidence,
    };
  }
  if (decision?.targetIndex == null && decision?.action !== "wait") {
    return { verdict: "escalate", kind: "no_target", reasons: ["対象要素が選択されていません"] };
  }

  return { verdict: "proceed", reasons: [] };
}
