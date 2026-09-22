// 入力・外部エラー本文をエラーメッセージへ反射しない。
export class BoundaryError extends Error {
  constructor(code) { super(code); this.name = 'BoundaryError'; this.code = code; }
}
export function requireCondition(ok, code) {
  if (!ok) throw new BoundaryError(code);
}
export const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const isProbability = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
export function freezeData(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freezeData);
    Object.freeze(value);
  }
  return value;
}
// timeout後も外部実装が動き続ける場合がある。呼出し側は操作を再送しない。
export async function withinDeadline(fn, milliseconds, onTimeout = () => {}) {
  requireCondition(Number.isFinite(milliseconds) && milliseconds > 0, 'DEADLINE');
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(fn),
      new Promise((_, reject) => {
        timer = setTimeout(() => { onTimeout(); reject(new BoundaryError('DEADLINE')); }, milliseconds);
      }),
    ]);
  } finally { clearTimeout(timer); }
}
