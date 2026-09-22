import test from 'node:test';
import assert from 'node:assert/strict';
import {ask, loadApiKey, DEFAULT_ENDPOINT, DEFAULT_MODEL} from '../scripts/jev-decide.mjs';
import {buildOperationQuestion, interpretOperationChoice, chooseOperation} from '../scripts/operation-choice.mjs';

const operations = [{id:'A1',batchId:'synthetic-batch',observationId:'synthetic-observation',kind:'press_key',args:{key:'KP_2'},description:'Enter 2 in synthetic test calculator'}];
const questions = buildOperationQuestion(operations);
const valid = () => ({model:DEFAULT_MODEL, answers:{operation:{type:'choice',choice:'A1',confidence:0.9,probabilities:Object.fromEntries(Object.keys(questions.operation.criteria).map(k=>[k,k==='A1'?1:0]))}},usage:{input_tokens:50}});
const response = body => new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});
const request = extra => ask({state:{goal:'synthetic digit 2'},questions,apiKey:'FAKE_M1_ONLY',fetchImpl:async()=>response(valid()),...extra});

test('HTTP: fixed endpoint, pinned model, redirect rejection, no cookies; sanitized result', async () => {
  let calls=0;
  const result = await request({fetchImpl:async(url,options)=>{
    calls++;
    assert.equal(url,DEFAULT_ENDPOINT);
    assert.equal(options.redirect,'error');
    assert.equal(options.credentials,'omit');
    assert.equal(options.headers.Authorization,'Bearer FAKE_M1_ONLY');
    assert.equal(JSON.parse(options.body).model,DEFAULT_MODEL);
    return response({...valid(),secret:'PRIVATE_EXTRA'});
  }});
  assert.equal(calls,1);
  assert.equal(result.answers.operation.choice,'A1');
  assert.equal(JSON.stringify(result).includes('PRIVATE_EXTRA'),false);
  assert.equal('raw' in result,false);
});
test('HTTP: no implicit network or key read; arbitrary destinations rejected before transport', async () => {
  assert.throws(()=>loadApiKey(),{code:'SECRET_READ_DISABLED'});
  await assert.rejects(ask({state:'synthetic',questions}),{code:'NETWORK_DISABLED'});
  let calls=0;
  for (const endpoint of ['https://example.invalid/',DEFAULT_ENDPOINT+'?x=1','http://api.typesafe.ai/v1/systemone','https://api.typesafe.ai.evil.invalid/v1/systemone']) {
    await assert.rejects(request({endpoint,fetchImpl:async()=>{calls++;}}),{code:'ENDPOINT_DENIED'});
  }
  await assert.rejects(request({apiKey:undefined}),{code:'API_KEY_REQUIRED'});
  await assert.rejects(request({fetchImpl:null}),{code:'INVALID_TRANSPORT'});
  await assert.rejects(request({fetchImpl:globalThis.fetch}),{code:'NETWORK_DISABLED'});
  await assert.rejects(request({maxRetries:1}),{code:'RETRIES_DISABLED'});
  await assert.rejects(request({model:'jev-latest'}),{code:'MODEL_NOT_PINNED'});
  assert.equal(calls,0);
});
test('HTTP: redirects, HTTP errors, invalid JSON and raw transport errors never reflect body/key', async () => {
  const fixtures = [
    [() => new Response('PRIVATE',{status:302,headers:{location:'https://example.invalid/'}}),'HTTP_ERROR'],
    [() => new Response('PRIVATE',{status:500}),'HTTP_ERROR'],
    [() => new Response('PRIVATE',{headers:{'content-type':'text/plain'}}),'INVALID_CONTENT_TYPE'],
    [() => new Response('PRIVATE',{headers:{'content-type':'application/json'}}),'INVALID_JSON'],
    [() => {throw new Error('FAKE_M1_ONLY PRIVATE');},'TRANSPORT_FAILED'],
  ];
  for (const [fetchImpl,code] of fixtures) await assert.rejects(request({fetchImpl}),e => e.code===code && !e.message.includes('PRIVATE') && !e.message.includes('FAKE_M1_ONLY'));
  const redirected = response(valid());
  Object.defineProperty(redirected,'redirected',{value:true});
  await assert.rejects(request({fetchImpl:async()=>redirected}),{code:'REDIRECT_DENIED'});
});
test('HTTP: total deadline covers body, including a stream that never finishes', async () => {
  let signal, cancelled=false;
  const start=Date.now();
  await assert.rejects(request({timeoutMs:20,fetchImpl:async(_url,options)=>{
    signal=options.signal;
    return new Response(new ReadableStream({pull:()=>new Promise(()=>{}),cancel:()=>{cancelled=true;}}),{headers:{'content-type':'application/json'}});
  }}),{code:'DEADLINE'});
  assert.ok(Date.now()-start<1000);
  assert.equal(signal.aborted,true);
  assert.equal(cancelled,true);
});
test('HTTP: request and streamed response have byte limits, independent of content-length', async () => {
  await assert.rejects(request({state:'x'.repeat(17_000)}),{code:'REQUEST_TOO_LARGE'});
  await assert.rejects(request({maxResponseBytes:20}),{code:'RESPONSE_TOO_LARGE'});
  await assert.rejects(request({fetchImpl:async()=>new Response('{}',{headers:{'content-type':'application/json','content-length':'999999'}})}),{code:'RESPONSE_TOO_LARGE'});
});
test('HTTP: malformed choices, distributions, range, usage, model and missing answers fail closed', async () => {
  const mutations = [
    b=>{b.answers.operation.choice='unknown';}, b=>{b.answers.operation.confidence='0.9';},
    b=>{b.answers.operation.confidence=2;}, b=>{b.answers.operation.probabilities.A1=-1;},
    b=>{delete b.answers.operation.probabilities.NONE;}, b=>{b.answers.operation.probabilities.A1=0.3;},
    b=>{b.usage.input_tokens=-1;}, b=>{b.usage.input_tokens='50';},
    b=>{b.model='unrequested';}, b=>{b.answers={};}, b=>{b.answers.unrequested={};},
    b=>{b.answers.operation.type='noul';}, b=>{b.answers.operation.choice='NONE';},
  ];
  for (const mutate of mutations) {const b=valid();mutate(b);await assert.rejects(request({fetchImpl:async()=>response(b)}));}
  const q={done:{type:'noul',instructions:'Is the synthetic result present?'}};
  for(const noul of [2,-0.1,'0.5',null]) await assert.rejects(request({questions:q,fetchImpl:async()=>response({model:DEFAULT_MODEL,usage:{input_tokens:1},answers:{done:{type:'noul',noul}}})}),{code:'INVALID_PROBABILITY'});
});
test('choice: one operation ID fixes the prepared action; NONE and handoffs never execute', async () => {
  for(const choice of ['NONE','REOBSERVE','REASONING','VISION','ASK_USER']) assert.deepEqual(interpretOperationChoice({choice,confidence:1},operations),{route:choice,operationId:null});
  assert.deepEqual(interpretOperationChoice({choice:'A1',confidence:0.1},operations),{route:'REASONING',operationId:null});
  assert.throws(()=>interpretOperationChoice({choice:'unknown',confidence:1},operations));
  const result=await chooseOperation({operations,state:{task:'synthetic'},apiKey:'FAKE_M1_ONLY',fetchImpl:async()=>response(valid())});
  assert.equal(result.operationId,'A1');
  assert.equal(result.route,'EXECUTE');
});
