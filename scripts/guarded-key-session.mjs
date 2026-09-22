import { BoundaryError, requireCondition, freezeData, withinDeadline } from './safety.mjs';
import { HANDOFF_CHOICES } from './operation-choice.mjs';
import { randomUUID } from 'node:crypto';

const CALCULATOR = 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App';
const KEYS = new Set(['0','1','2','3','4','5','6','7','8','9','KP_0','KP_1','KP_2','KP_3','KP_4','KP_5','KP_6','KP_7','KP_8','KP_9','Numpad_Add','Numpad_Subtract','Numpad_Multiply','Numpad_Divide','Numpad_Decimal','Return']);
const activeClients = new WeakSet();

/** M1の試験用電卓だけ。座標・AX・任意文字・ショートカット・他アプリは未対応。 */
export function createCalculatorKeySession({sky, adapter, selection, allowedKeys, maxActions = 4, deadlineMs = 120_000, now = Date.now}) {
  requireCondition(sky?.target === 'windows' && typeof sky.press_key === 'function' && selection?.window?.app === CALCULATOR, 'INVALID_SCOPE');
  requireCondition(Array.isArray(allowedKeys) && allowedKeys.length > 0 && allowedKeys.every(k => KEYS.has(k)), 'INVALID_KEYS');
  requireCondition(Number.isSafeInteger(maxActions) && maxActions >= 1 && maxActions <= 16 && Number.isSafeInteger(deadlineMs) && deadlineMs > 0 && deadlineMs <= 300_000, 'INVALID_BUDGET');
  requireCondition(!activeClients.has(sky), 'CLIENT_SESSION_ACTIVE');
  activeClients.add(sky);
  const scope = freezeData({...selection.window});
  const keys = new Set(allowedKeys);
  const deadline = now() + deadlineMs;
  const batches = new WeakMap();
  let actions = 0, observations = 0, stopped = false, closed = false, busy = false, uncertain = false, pendingResult = null, activeBatch = null;
  function check() { requireCondition(!stopped, 'SESSION_STOPPED'); requireCondition(now() < deadline, 'DEADLINE'); }
  function assertObservation(observation) {
    adapter.assertCurrent(observation);
    requireCondition(observation.window.app === scope.app && observation.window.id === scope.id && observation.window.title === scope.title, 'WINDOW_MISMATCH');
    requireCondition(Array.isArray(observation.screenshots) && observation.screenshots.length > 0, 'VISUAL_EVIDENCE_REQUIRED');
  }
  async function observe() {
    check();
    requireCondition(++observations <= maxActions * 3, 'OBSERVATION_BUDGET');
    return withinDeadline(() => adapter.observe(selection), deadline - now());
  }
  return Object.freeze({
    prepare(observation, operations) {
      check(); assertObservation(observation);
      requireCondition(!busy && !pendingResult, 'RESULT_PENDING');
      requireCondition(actions < maxActions && Array.isArray(operations) && operations.length > 0 && operations.length <= 16, 'ACTION_BUDGET');
      const ids = new Set();
      const batchId = randomUUID();
      const records = operations.map(op => {
        requireCondition(/^A[0-9]+$/.test(op.id) && !ids.has(op.id) && keys.has(op.key) && typeof op.description === 'string' && op.description.length > 0 && op.description.length <= 500, 'INVALID_OPERATION');
        ids.add(op.id);
        return {id: op.id, batchId, kind: 'press_key', args: {key: op.key}, description: op.description, window: {...scope}, observationId: observation.id};
      });
      const batch = freezeData({id: batchId, operations: records});
      batches.set(batch, {original: observation, fresh: null, consumed: false});
      activeBatch = batch;
      return batch;
    },
    async refresh(batch) {
      check();
      const record = batches.get(batch);
      requireCondition(activeBatch === batch && record && !record.consumed && !busy && !pendingResult, 'INVALID_BATCH');
      assertObservation(record.original);
      busy = true;
      try { record.fresh = await observe(); assertObservation(record.fresh); return record.fresh; }
      catch (error) { record.consumed = true; throw error instanceof BoundaryError ? error : new BoundaryError('PREFLIGHT_FAILED'); }
      finally { busy = false; }
    },
    // 必ずrefreshの画像を別セルで確認してから呼ぶ。Jev自身にconfirmedを決めさせない。
    async dispatch(batch, choice, {observationId, confirmed} = {}) {
      check();
      const record = batches.get(batch);
      requireCondition(activeBatch === batch && record && !record.consumed && !busy && !pendingResult, 'INVALID_BATCH');
      if (choice && Object.hasOwn(HANDOFF_CHOICES, choice.route)) {
        record.consumed = true;
        return freezeData({status: 'handoff', route: choice.route, actions});
      }
      requireCondition(choice?.route === 'EXECUTE', 'INVALID_CHOICE');
      requireCondition(choice.batchId === batch.id && choice.observationId === record.original.id, 'CHOICE_BINDING_MISMATCH');
      const operation = batch.operations.find(op => op.id === choice.operationId);
      requireCondition(operation && actions < maxActions && record.fresh, 'INVALID_CHOICE');
      assertObservation(record.fresh);
      requireCondition(confirmed === true && observationId === record.fresh.id, 'PREFLIGHT_REQUIRED');
      // 取得できたテキストにも変化があれば、目視承認だけで旧操作を再利用しない。
      requireCondition(JSON.stringify(record.original.accessibility) === JSON.stringify(record.fresh.accessibility), 'OBSERVATION_CHANGED');
      record.consumed = true;
      busy = true;
      actions++; // 送出結果が不明でも消費し、再送しない。
      try {
        const target = adapter.windowReference(record.fresh);
        await withinDeadline(() => sky.press_key({window: target, key: operation.args.key}), deadline - now());
        const after = await observe();
        assertObservation(after);
        pendingResult = freezeData({status: 'pending_verification', operationId: operation.id, observation: after, actions});
        return pendingResult;
      } catch {
        stopped = true;
        uncertain = true;
        return freezeData({status: 'unknown', reason: 'ACTION_OR_REFRESH_FAILED', actions, uncertainAction: true});
      } finally { busy = false; }
    },
    async refreshResult(result) {
      check();
      requireCondition(result === pendingResult && result !== null && !busy, 'INVALID_VERIFICATION');
      busy = true;
      try {
        const after = await observe();
        assertObservation(after);
        pendingResult = freezeData({...result, observation: after});
        return pendingResult;
      } catch {
        stopped = true;
        uncertain = true;
        return freezeData({status:'unknown',reason:'VERIFICATION_REFRESH_FAILED',actions,uncertainAction:true});
      } finally { busy = false; }
    },
    verify(result, {observationId, passed} = {}) {
      check();
      requireCondition(result === pendingResult && result !== null && typeof passed === 'boolean', 'INVALID_VERIFICATION');
      assertObservation(result.observation);
      requireCondition(observationId === result.observation.id, 'INVALID_VERIFICATION');
      pendingResult = null;
      if (!passed) stopped = true;
      return freezeData({status: passed ? 'verified' : 'failed', verificationSource: 'caller_visual', actions});
    },
    status() { return freezeData({actions, observations, stopped, deadline, pendingVerification: pendingResult !== null}); },
    close() {
      if (closed) return; // 旧sessionの二重closeで後続sessionのロックを解除しない。
      requireCondition(!busy && !pendingResult && !uncertain, 'UNRESOLVED_ACTION');
      stopped = true;
      closed = true;
      activeClients.delete(sky);
    },
  });
}
