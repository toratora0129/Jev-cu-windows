import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {ask,DEFAULT_ENDPOINT,DEFAULT_MODEL} from '../scripts/jev-decide.mjs';

// 実Jev宛に送らない。短命な127.0.0.1だけにlistenし、偽キーのみを使う。
test('loopback: native fetch sends bounded JSON once, rejects redirects and aborts a delayed body', async () => {
  let redirectedRequests = 0, received = 0;
  const server = createServer((req,res) => {
    if(req.url === '/target') redirectedRequests++;
    received++;
    assert.equal(req.headers.authorization,'Bearer FAKE_M1_LOOPBACK');
    if(req.url === '/redirect') {res.writeHead(302,{location:'/target'});res.end();return;}
    if(req.url === '/slow') {res.writeHead(200,{'content-type':'application/json'});res.flushHeaders();return;}
    let body='';
    req.on('data',chunk => {body += chunk;});
    req.on('end',()=>{
      assert.equal(JSON.parse(body).model,DEFAULT_MODEL);
      res.writeHead(200,{'content-type':'application/json'});
      res.end(JSON.stringify({model:DEFAULT_MODEL,answers:{done:{type:'noul',noul:0}},usage:{input_tokens:10}}));
    });
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = route => ask({state:'synthetic only',questions:{done:{type:'noul',instructions:'Is the synthetic task done?'}},apiKey:'FAKE_M1_LOOPBACK',timeoutMs:route === '/slow'?100:1000,
    fetchImpl:async(url,options)=>{
      assert.equal(url,DEFAULT_ENDPOINT);
      const local = await fetch(origin+route,options);
      // テスト用の宛先置換。production transportではこのラッパーを使わない。
      return new Response(local.body,{status:local.status,headers:local.headers});
    },
  });
  try {
    assert.equal((await call('/ok')).answers.done.noul,0);
    await assert.rejects(call('/redirect'),{code:'TRANSPORT_FAILED'});
    assert.equal(redirectedRequests,0);
    await assert.rejects(call('/slow'),{code:'DEADLINE'});
    assert.equal(received,3);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
  }
});
