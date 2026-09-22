import test from 'node:test';
import assert from 'node:assert/strict';
import {runTask} from '../scripts/loop.mjs';
import {evaluatePolicy,matchSensitive} from '../scripts/policy.mjs';
import {normalizeDecision} from '../scripts/jev-decide.mjs';

test('legacy execution is disabled before driver, callbacks, defaults, logs or secret reads', async()=>{
  let called=0;
  const bomb=()=>{called++;throw new Error('PRIVATE');};
  const result=await runTask({dryRun:false,driver:{bind:bomb,observe:bomb},decide:bomb,resources:bomb,verify:bomb,emit:bomb});
  assert.deepEqual(result,{status:'escalate',reason:'legacy_execution_disabled',steps:0});
  assert.equal(called,0);
});
test('policy validates probabilities before any completion proposal and covers Japanese danger labels',()=>{
  for(const done of [2,'0.99',NaN,-1]) assert.equal(evaluatePolicy({decision:{done,risk:0,confidence:1},app:'Calculator'}).kind,'invalid_decision');
  const d=normalizeDecision({done:{noul:2},risk:{noul:0},target:{confidence:1}});
  assert.equal(d.done,null);
  for(const label of ['削除','送信','上書き','投稿']) assert.ok(matchSensitive(label));
});
test('legacy preview uses full observed danger label, never raw response or misleading short label',async()=>{
  const label='Ordinary '.repeat(30)+'Delete event PRIVATE_LABEL';
  const result=await runTask({appName:'Calendar',goal:'PRIVATE_GOAL',
    driver:{bind:async()=>{},observe:async()=>`1 button ${label}\n2 button Next`},
    decide:async()=>({done:0,risk:0,confidence:1,action:'click_element',targetIndex:1,targetLabel:'Next',raw:{secret:'PRIVATE_RAW'}}),
  });
  assert.equal(result.status,'confirm');
  assert.equal(JSON.stringify(result).includes('PRIVATE'),false);
});
test('legacy preview cannot turn model completion into verified completion or echo exceptions',async()=>{
  const driver={bind:async()=>{},observe:async()=> '1 button Next\n2 button Back'};
  const result=await runTask({driver,appName:'Calculator',goal:'test',decide:async()=>({done:0.99,risk:0,confidence:1})});
  assert.equal(result.status,'escalate');
  assert.equal(result.reason,'done_proposed');
  const error=await runTask({driver,decide:async()=>{throw new Error('PRIVATE_KEY');}});
  assert.equal(JSON.stringify(error).includes('PRIVATE'),false);
});
