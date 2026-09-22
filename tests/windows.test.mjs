import test from 'node:test';
import assert from 'node:assert/strict';
import {createWindowsSkyAdapter} from '../scripts/windows-sky-adapter.mjs';
import {createCalculatorKeySession} from '../scripts/guarded-key-session.mjs';

const app = 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App';
const window = {app, id: 1, title: 'Synthetic Calculator'};
function fixture(options = {}) {
  let time = 1000;
  const calls = [];
  const sky = {
    target: 'windows',
    list_windows: async () => [window],
    get_window_state: async ({window: target}) => ({window: target, accessibility: null, screenshots: [{id:'synthetic', zIndex:0, width:400,height:600,url:'synthetic-private-pixels'}]}),
    press_key: async value => calls.push(value),
    ...options,
  };
  const adapter = createWindowsSkyAdapter(sky, {now: () => time});
  return {sky, adapter, calls, now: () => time, advance: n => {time += n;}};
}
async function prepared(options = {}) {
  const f = fixture(options);
  const selection = await f.adapter.selectWindow({app});
  const observation = await f.adapter.observe(selection);
  const session = createCalculatorKeySession({sky:f.sky, adapter:f.adapter, selection, allowedKeys:['KP_2', 'Numpad_Add', 'Return'], maxActions:2, now:f.now});
  const input = [{id:'A1', key:'KP_2', description:'Enter digit 2 into the synthetic test calculator'}];
  const batch = session.prepare(observation, input);
  return {...f, selection, observation, session, input, batch};
}
const execute = batch => ({route:'EXECUTE', operationId:'A1', batchId:batch.id, observationId:batch.operations[0].observationId});

test('adapter: construction does not invoke any sky method', () => {
  let calls = 0;
  createWindowsSkyAdapter({target:'windows', list_windows:() => {calls++;}, get_window_state:() => {calls++;}});
  assert.equal(calls,0);
});
test('adapter: null means unavailable; screenshots are references, not fabricated AX or saved pixels', async () => {
  const f = await prepared();
  assert.equal(f.observation.accessibility.status,'unavailable');
  assert.equal(f.observation.candidates.status,'unavailable');
  assert.deepEqual(f.observation.candidates.items,[]);
  assert.equal(f.observation.source,'sky');
  assert.equal(JSON.stringify(f.observation).includes('synthetic-private-pixels'),false);
  assert.ok(Object.isFrozen(f.observation.screenshots[0]));
});
test('adapter: absent and ambiguous windows are distinct failures; no launch fallback', async () => {
  for (const [windows,code] of [[[],'WINDOW_NOT_FOUND'],[[window,{...window,id:2}],'AMBIGUOUS_WINDOW']]) {
    const f = fixture({list_windows:async () => windows});
    await assert.rejects(f.adapter.selectWindow({app}),{code});
  }
});
test('adapter: window disappearance or title replacement invalidates selection', async () => {
  const f = await prepared();
  f.sky.list_windows = async () => [{...window,title:'Other document'}];
  await assert.rejects(f.adapter.observe(f.selection),{code:'STALE_WINDOW'});
  assert.throws(() => f.adapter.assertCurrent(f.observation),{code:'STALE_OBSERVATION'});
});
test('adapter: returned wrong window, raw errors, and invented handles fail closed', async () => {
  const f = await prepared();
  await assert.rejects(f.adapter.observe({window}),{code:'UNKNOWN_SELECTION'});
  f.sky.get_window_state = async () => ({window:{...window,id:9},screenshots:[],accessibility:null});
  await assert.rejects(f.adapter.observe(f.selection),{code:'WINDOW_MISMATCH'});
  f.sky.get_window_state = async () => {throw new Error('PRIVATE_SCREEN_AND_KEY');};
  await assert.rejects(f.adapter.observe(f.selection),e => e.message === 'OBSERVATION_FAILED');
});
test('adapter: text shape is retained without inventing an element parser; empty and unsupported differ', async () => {
  for (const [accessibility,status,candidates] of [[{tree:'arbitrary native text'},'available','unsupported_format'],[{tree:''},'available','empty_tree'],[{nodes:[]},'unsupported_format','unavailable']]) {
    const f = fixture({get_window_state:async () => ({window,accessibility,screenshots:[]})});
    const s = await f.adapter.selectWindow({app});
    const o = await f.adapter.observe(s);
    assert.equal(o.accessibility.status,status);
    assert.equal(o.candidates.status,candidates);
    assert.deepEqual(o.candidates.items,[]);
  }
});
test('adapter: expiry and newer observation reject old references', async () => {
  const f = await prepared();
  f.advance(30_000);
  assert.throws(() => f.adapter.assertCurrent(f.observation),{code:'STALE_OBSERVATION'});
  const newer = await f.adapter.observe(f.selection);
  assert.equal(f.adapter.assertCurrent(newer),true);
  assert.throws(() => f.adapter.assertCurrent(f.observation),{code:'STALE_OBSERVATION'});
});
test('keys: input mutation cannot replace a prepared key; explicit preflight and result verification required', async () => {
  const f = await prepared();
  f.input[0].key = 'Return';
  await assert.rejects(f.session.dispatch(f.batch,execute(f.batch)),{code:'INVALID_CHOICE'});
  const fresh = await f.session.refresh(f.batch);
  await assert.rejects(f.session.dispatch(f.batch,execute(f.batch),{confirmed:true,observationId:f.observation.id}),{code:'PREFLIGHT_REQUIRED'});
  const result = await f.session.dispatch(f.batch,execute(f.batch),{confirmed:true,observationId:fresh.id});
  assert.equal(f.calls.length,1);
  assert.equal(f.calls[0].key,'KP_2');
  assert.equal(result.status,'pending_verification');
  assert.throws(() => f.session.prepare(result.observation,f.input),{code:'RESULT_PENDING'});
  assert.throws(() => f.session.verify(result,{passed:true,observationId:'invented'}),{code:'INVALID_VERIFICATION'});
  assert.equal(f.session.verify(result,{passed:true,observationId:result.observation.id}).status,'verified');
  await assert.rejects(f.session.dispatch(f.batch,execute(f.batch)),{code:'INVALID_BATCH'});
});
test('keys: unknown operation, unsafe key, foreign window and stale preflight cannot dispatch', async () => {
  const f = await prepared();
  assert.throws(() => f.session.prepare(f.observation,[{id:'A2',key:'Meta+r',description:'bad'}]),{code:'INVALID_OPERATION'});
  assert.throws(() => createCalculatorKeySession({sky:f.sky,adapter:f.adapter,selection:{window:{...window,app:'Other'}},allowedKeys:['KP_2']}),{code:'INVALID_SCOPE'});
  const fresh = await f.session.refresh(f.batch);
  await assert.rejects(f.session.dispatch(f.batch,{...execute(f.batch),operationId:'UNKNOWN'},{confirmed:true,observationId:fresh.id}),{code:'INVALID_CHOICE'});
  await f.adapter.observe(f.selection);
  await assert.rejects(f.session.dispatch(f.batch,execute(f.batch),{confirmed:true,observationId:fresh.id}),{code:'STALE_OBSERVATION'});
  assert.equal(f.calls.length,0);
});
test('keys: changed text before dispatch blocks even an affirmative visual confirmation', async () => {
  let tree = 'initial';
  const f = await prepared({get_window_state: async () => ({window,screenshots:[],accessibility:{tree}})});
  tree = 'replacement';
  const fresh = await f.session.refresh(f.batch);
  await assert.rejects(f.session.dispatch(f.batch,execute(f.batch),{confirmed:true,observationId:fresh.id}),{code:'OBSERVATION_CHANGED'});
  assert.equal(f.calls.length,0);
});
test('keys: all handoffs are non-executing and cannot replay old operations', async () => {
  for (const route of ['NONE','REOBSERVE','REASONING','VISION','ASK_USER']) {
    const f = await prepared();
    assert.equal((await f.session.dispatch(f.batch,{route,operationId:'A1'})).status,'handoff');
    await assert.rejects(f.session.dispatch(f.batch,execute(f.batch)),{code:'INVALID_BATCH'});
    assert.equal(f.calls.length,0);
  }
});
test('keys: uncertain dispatch and post-observation errors stop permanently without retry', async () => {
  for (const where of ['input','capture']) {
    const f = await prepared();
    const fresh = await f.session.refresh(f.batch);
    f.sky.press_key = async value => {f.calls.push(value); if (where === 'input') throw new Error('PRIVATE'); f.sky.get_window_state = async () => {throw new Error('PRIVATE');};};
    const result = await f.session.dispatch(f.batch,execute(f.batch),{confirmed:true,observationId:fresh.id});
    assert.equal(result.status,'unknown');
    assert.equal(result.uncertainAction,true);
    await assert.rejects(f.session.dispatch(f.batch,execute(f.batch)),{code:'SESSION_STOPPED'});
    assert.equal(f.calls.length,1);
    assert.equal(JSON.stringify(result).includes('PRIVATE'),false);
  }
});
test('keys: failed verification, deadline and action budget prevent further actions', async () => {
  const f = await prepared();
  for (let n=0;n<2;n++) {
    const batch = n === 0 ? f.batch : f.session.prepare(await f.adapter.observe(f.selection), f.input);
    const fresh = await f.session.refresh(batch);
    const result = await f.session.dispatch(batch,execute(batch),{confirmed:true,observationId:fresh.id});
    f.session.verify(result,{passed:true,observationId:result.observation.id});
  }
  const current = await f.adapter.observe(f.selection);
  assert.throws(() => f.session.prepare(current,f.input),{code:'ACTION_BUDGET'});
  assert.equal(f.calls.length,2);
  const g = await prepared();
  g.advance(120_000);
  await assert.rejects(g.session.refresh(g.batch),{code:'DEADLINE'});
  assert.equal(g.calls.length,0);
  const h = await prepared();
  const fresh = await h.session.refresh(h.batch);
  const result = await h.session.dispatch(h.batch,execute(h.batch),{confirmed:true,observationId:fresh.id});
  assert.equal(h.session.verify(result,{passed:false,observationId:result.observation.id}).status,'failed');
  assert.throws(() => h.session.prepare(result.observation,h.input),{code:'SESSION_STOPPED'});
});

test('keys: a delayed choice cannot execute another batch reusing the same operation ID', async () => {
  const f = await prepared();
  const oldChoice = execute(f.batch);
  const replacement = f.session.prepare(f.observation,[{id:'A1',key:'Return',description:'different operation'}]);
  const fresh = await f.session.refresh(replacement);
  await assert.rejects(f.session.dispatch(replacement,oldChoice,{confirmed:true,observationId:fresh.id}),{code:'CHOICE_BINDING_MISMATCH'});
  assert.equal(f.calls.length,0);
});
test('keys: same client sessions cannot run in parallel or discard an uncertain action', async () => {
  const f = await prepared();
  const create = () => createCalculatorKeySession({sky:f.sky,adapter:f.adapter,selection:f.selection,allowedKeys:['KP_2']});
  assert.throws(create,{code:'CLIENT_SESSION_ACTIVE'});
  const fresh = await f.session.refresh(f.batch);
  f.sky.press_key = async () => {throw new Error('unknown');};
  await f.session.dispatch(f.batch,execute(f.batch),{confirmed:true,observationId:fresh.id});
  assert.throws(()=>f.session.close(),{code:'UNRESOLVED_ACTION'});
  assert.throws(create,{code:'CLIENT_SESSION_ACTIVE'});
});
test('adapter: input receives the exact Window object returned by sky', async () => {
  const f = await prepared();
  let actual;
  f.sky.get_window_state = async ({window: target}) => {actual=target; return {window:target,accessibility:null,screenshots:[]};};
  const fresh = await f.session.refresh(f.batch);
  f.sky.press_key = async ({window:target}) => {assert.equal(target,actual);};
  const result = await f.session.dispatch(f.batch,execute(f.batch),{confirmed:true,observationId:fresh.id});
  f.session.verify(result,{passed:true,observationId:result.observation.id});
  f.session.close();
  assert.equal(f.session.status().stopped,true);
});
test('keys: explicitly prepared number-row key works without rewriting it as numpad input', async () => {
  const f = fixture();
  const selection = await f.adapter.selectWindow({app});
  const s = createCalculatorKeySession({sky:f.sky,adapter:f.adapter,selection,allowedKeys:['2']});
  const batch = s.prepare(await f.adapter.observe(selection),[{id:'A1',key:'2',description:'type digit 2'}]);
  const fresh = await s.refresh(batch);
  await s.dispatch(batch,execute(batch),{confirmed:true,observationId:fresh.id});
  assert.equal(f.calls.length,1);
  assert.equal(f.calls[0].key,'2');
});
test('keys: expired result evidence can be refreshed within budget without resending input', async () => {
  const f = await prepared();
  const fresh = await f.session.refresh(f.batch);
  const original = await f.session.dispatch(f.batch,execute(f.batch),{confirmed:true,observationId:fresh.id});
  f.advance(30_001);
  assert.throws(()=>f.session.verify(original,{passed:true,observationId:original.observation.id}),{code:'STALE_OBSERVATION'});
  const refreshed = await f.session.refreshResult(original);
  assert.equal(f.session.verify(refreshed,{passed:true,observationId:refreshed.observation.id}).status,'verified');
  assert.equal(f.calls.length,1);
  f.session.close();
});
test('keys: closing an old session twice cannot unlock a newer session', async () => {
  const f = await prepared();
  const create = () => createCalculatorKeySession({sky:f.sky,adapter:f.adapter,selection:f.selection,allowedKeys:['2']});
  f.session.close();
  const next = create();
  f.session.close();
  assert.throws(create,{code:'CLIENT_SESSION_ACTIVE'});
  next.close();
});
