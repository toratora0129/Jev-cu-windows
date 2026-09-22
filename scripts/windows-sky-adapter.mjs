import { randomUUID } from 'node:crypto';
import { BoundaryError, requireCondition, freezeData, withinDeadline, isRecord } from './safety.mjs';

const validWindow = w => isRecord(w) && typeof w.app === 'string' && w.app.length > 0 && Number.isSafeInteger(w.id);
const metadata = w => ({ app: w.app, id: w.id, ...(typeof w.title === 'string' ? {title: w.title} : {}) });
const sameWindow = (a, b) => a.app === b.app && a.id === b.id && a.title === b.title;

/** 読み取り専用。skyは呼出し側が公式node_replから注入する。自動起動・保存なし。 */
export function createWindowsSkyAdapter(sky, {now = Date.now, maxAgeMs = 30_000, timeoutMs = 10_000} = {}) {
  requireCondition(sky?.target === 'windows' && typeof sky.list_windows === 'function' && typeof sky.get_window_state === 'function', 'UNSUPPORTED_CLIENT');
  requireCondition(Number.isSafeInteger(maxAgeMs) && maxAgeMs > 0 && maxAgeMs <= 60_000, 'INVALID_AGE');
  requireCondition(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30_000, 'INVALID_TIMEOUT');
  const selections = new WeakMap();
  let latest = null;
  let latestWindow = null;
  let pending = false;
  async function listRaw() {
    try {
      const windows = await withinDeadline(() => sky.list_windows(), timeoutMs);
      requireCondition(Array.isArray(windows) && windows.every(validWindow), 'INVALID_WINDOWS');
      return windows;
    } catch (error) { throw error instanceof BoundaryError ? error : new BoundaryError('WINDOW_LIST_FAILED'); }
  }
  return Object.freeze({
    async listWindows() { return freezeData((await listRaw()).map(metadata)); },
    async selectWindow({app, id, title} = {}) {
      requireCondition(typeof app === 'string' && app.length > 0 && (id === undefined || Number.isSafeInteger(id)) && (title === undefined || typeof title === 'string'), 'INVALID_SELECTOR');
      const found = (await listRaw()).filter(w => w.app === app && (id === undefined || w.id === id) && (title === undefined || w.title === title));
      requireCondition(found.length > 0, 'WINDOW_NOT_FOUND');
      requireCondition(found.length === 1, 'AMBIGUOUS_WINDOW');
      const handle = freezeData({window: metadata(found[0])});
      selections.set(handle, handle.window);
      return handle;
    },
    async observe(selection, {includeScreenshot = true, includeText = true} = {}) {
      requireCondition(selections.has(selection), 'UNKNOWN_SELECTION');
      requireCondition(typeof includeScreenshot === 'boolean' && typeof includeText === 'boolean', 'INVALID_CAPTURE');
      requireCondition(!pending, 'OBSERVATION_BUSY');
      pending = true;
      latest = null;
      latestWindow = null;
      try {
        const target = selections.get(selection);
        const windows = (await listRaw()).filter(w => sameWindow(metadata(w), target));
        requireCondition(windows.length === 1, 'STALE_WINDOW');
        const state = await withinDeadline(() => sky.get_window_state({window: windows[0], include_screenshot: includeScreenshot, include_text: includeText}), timeoutMs);
        requireCondition(validWindow(state?.window) && sameWindow(metadata(state.window), target), 'WINDOW_MISMATCH');
        requireCondition(Array.isArray(state.screenshots), 'INVALID_SCREENSHOTS');
        const screenshots = state.screenshots.map(s => {
          requireCondition(typeof s.id === 'string' && Number.isFinite(s.zIndex), 'INVALID_SCREENSHOT');
          const ref = {id: s.id, zIndex: s.zIndex};
          for (const k of ['width', 'height', 'originX', 'originY']) {
            if (s[k] !== undefined) { requireCondition(Number.isFinite(s[k]), 'INVALID_SCREENSHOT'); ref[k] = s[k]; }
          }
          return ref; // data URLは保持・保存・送信しない。公式ツールが画像を表示する。
        });
        let accessibility = {status: includeText ? 'unavailable' : 'not_requested', value: null};
        if (includeText && state.accessibility != null) {
          if (isRecord(state.accessibility) && typeof state.accessibility.tree === 'string') {
            const value = {tree: state.accessibility.tree};
            for (const k of ['document_text', 'focused_element', 'selected_text']) if (typeof state.accessibility[k] === 'string') value[k] = state.accessibility[k];
            if (Array.isArray(state.accessibility.selected_elements) && state.accessibility.selected_elements.every(x => typeof x === 'string')) value.selected_elements = [...state.accessibility.selected_elements];
            accessibility = {status: 'available', value};
          } else accessibility = {status: 'unsupported_format', value: null};
        }
        const capturedAt = now();
        latestWindow = state.window;
        latest = freezeData({
          id: randomUUID(), source: 'sky', capturedAt, expiresAt: capturedAt + maxAgeMs,
          window: metadata(state.window), screenshots, accessibility,
          candidates: {status: accessibility.status === 'available' ? (accessibility.value.tree.trim() ? 'unsupported_format' : 'empty_tree') : 'unavailable', items: []},
        });
        return latest;
      } catch (error) { throw error instanceof BoundaryError ? error : new BoundaryError('OBSERVATION_FAILED'); }
      finally { pending = false; }
    },
    assertCurrent(observation) {
      requireCondition(latest === observation && latest !== null && now() >= latest.capturedAt && now() < latest.expiresAt, 'STALE_OBSERVATION');
      requireCondition(sameWindow(metadata(latestWindow), latest.window), 'WINDOW_MISMATCH');
      return true;
    },
    windowReference(observation) {
      this.assertCurrent(observation);
      return latestWindow; // APIが返した実物を渡す。操作用Windowを再構成しない。
    },
  });
}
