import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createCohortWireBudget, createCohortTransport, COHORT_PROVIDERS } from './cohort-wire.mjs';
import { StandardRpcClient } from '../../src/standard-rpc.js';

const blockHash = '0x' + 'a'.repeat(64), account = '0x' + '1'.repeat(40);
const pinned = { blockHash, requireCanonical: true };
const ok = (result = '0x1') => async (_url, options) => new Response(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(options.body).id, result }));
const make = (extra = {}) => createCohortTransport({ budget: createCohortWireBudget(), provider: 'drpc', profile: 'census', fetchImpl: ok(), ...extra });
const code = expected => error => error.code === expected;

test('complete exact wire is saved before return, and snapshots cannot mutate it', async () => {
  const saved = [], transport = make({ save: row => { saved.push(row); } });
  assert.equal(await transport.call('eth_chainId'), '0x1');
  assert.equal(saved.length, 1);
  const row = transport.records()[0];
  assert.equal(row.requestText, JSON.stringify(row.request));
  assert.equal(Buffer.from(row.rawBase64, 'base64').toString(), row.responseText);
  assert.equal(createHash('sha256').update(row.responseText).digest('hex'), row.transport.retainedSha256);
  assert.equal(row.dispatched, true); assert.equal(row.globalId, 1);
  saved[0].status = 'changed'; row.request.id = 99;
  assert.equal(transport.records()[0].status, 'completed');
  assert.equal(transport.records()[0].request.id, 1);
});

test('RPC and HTTP error bodies are retained without retry or fallback', async () => {
  for (const status of [200, 429]) {
    let calls = 0;
    const transport = make({ fetchImpl: async () => {
      calls++; return new Response('{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"unavailable"}}', { status });
    } });
    await assert.rejects(transport.call('eth_chainId'), code(status === 200 ? 'rpc_error' : 'http_error'));
    await transport.drain(); assert.equal(calls, 1);
    const row = transport.records()[0]; assert.equal(row.httpStatus, status);
    assert.equal(row.transport.complete, true); assert.match(Buffer.from(row.rawBase64, 'base64').toString(), /unavailable/);
  }
});

test('malformed and mismatched JSON-RPC envelopes remain failures', async () => {
  for (const payload of [[], { jsonrpc: '2.0', id: 2, result: '0x1' }, { jsonrpc: '2.0', id: 1, result: '0x1', error: {} }]) {
    const transport = make({ fetchImpl: async () => new Response(JSON.stringify(payload)) });
    await assert.rejects(transport.call('eth_chainId'), code('jsonrpc_envelope'));
    assert.equal(transport.records().length, 1);
  }
});

test('method and state policies reject signing, moving state and foreign hashes before public dispatch', async () => {
  let calls = 0; const transport = make({ profile: 'local', blockHash, fetchImpl: async () => { calls++; } });
  for (const [method, params] of [
    ['eth_sendRawTransaction', ['0x']], ['eth_chainId', []],
    ['eth_getCode', [account, 'latest']], ['eth_getCode', [account, { ...pinned, requireCanonical: false }]],
    ['eth_getCode', [account, { ...pinned, blockHash: '0x' + 'b'.repeat(64) }]],
    ['eth_getProof', [account, ['0x1'], pinned]],
  ]) await assert.rejects(transport.call(method, params), code('request_not_allowed'));
  assert.equal(calls, 0); assert.equal(transport.usage().attempts, 0); assert.equal(transport.denied().length, 6);
});

test('local proof/code requests bind canonical hash and cannot request provider traces', async () => {
  const transport = make({ profile: 'local', blockHash, fetchImpl: ok({ proof: 'fixture' }) });
  assert.deepEqual(await transport.call('eth_getProof', [account, ['0x' + '0'.repeat(64)], pinned]), { proof: 'fixture' });
  await transport.call('eth_getCode', [account, pinned]);
  await assert.rejects(transport.call('debug_traceCall', [{}, pinned, { tracer: 'callTracer' }]), code('request_not_allowed'));
  assert.equal(transport.usage().dispatches, 2);
});

test('array coercions and accessor parameters are rejected before dispatch or getter execution', async () => {
  const local = make({ profile: 'local', blockHash }), census = make();
  await assert.rejects(local.call('eth_getCode', [[account], pinned]), code('request_not_allowed'));
  await assert.rejects(local.call('eth_getProof', [[account], [], pinned]), code('request_not_allowed'));
  await assert.rejects(census.call('eth_getBlockByHash', [[blockHash], false]), code('request_not_allowed'));
  let getter = 0; const params = [account, pinned];
  Object.defineProperty(params, '0', { enumerable: true, get() { getter++; return account; } });
  await assert.rejects(local.call('eth_getCode', params), code('request_not_allowed'));
  assert.equal(getter, 0); assert.equal(local.usage().dispatches, 0); assert.equal(census.usage().dispatches, 0);
});

test('shared call budget spans distinct providers and independent scopes', async () => {
  const budget = createCohortWireBudget({ limits: { calls: 2 } });
  const a = make({ budget }), b = make({ budget, provider: 'publicnode' });
  await a.call('eth_chainId'); await b.call('eth_chainId');
  await assert.rejects(a.call('eth_chainId'), code('attempt_budget'));
  assert.equal(budget.snapshot().calls, 2); assert.equal(budget.snapshot().dispatches, 2);
  assert.deepEqual([a.records()[0].globalId, b.records()[0].globalId], [1, 2]);
});

test('scope call limit is enforced independently of larger shared budget', async () => {
  const transport = make({ limits: { calls: 1 } });
  await transport.call('eth_chainId');
  await assert.rejects(transport.call('eth_chainId'), code('attempt_budget'));
  assert.equal(transport.records().length, 1);
});

test('oversized chunks count in full; only bounded prefixes survive; shared exhaustion stops other scopes', async () => {
  const budget = createCohortWireBudget({ limits: { totalBytes: 20 } });
  const transport = make({ budget, fetchImpl: async () => new Response('x'.repeat(100)) });
  await assert.rejects(transport.call('eth_chainId'), code('response_byte_budget'));
  const row = transport.records()[0];
  assert.equal(row.transport.observedBytes, 100); assert.equal(row.transport.retainedBytes, 20);
  assert.equal(row.transport.complete, false); assert.equal(budget.snapshot().observedBytes, 100);
  await assert.rejects(make({ budget }).call('eth_chainId'), code('attempt_budget'));
});

test('per-body bound retains exact prefix without changing larger total-byte limit', async () => {
  const transport = make({ limits: { responseBytes: 5 }, fetchImpl: async () => new Response('abcdefgh') });
  await assert.rejects(transport.call('eth_chainId'), code('response_byte_budget'));
  assert.equal(Buffer.from(transport.records()[0].rawBase64, 'base64').toString(), 'abcde');
  assert.equal(transport.usage().observedBytes, 8);
});

test('deadline cancels ignored-signal fetch; late completion cannot change returned evidence', async () => {
  let resolve; const transport = make({ limits: { requestMs: 10 }, fetchImpl: () => new Promise(r => { resolve = r; }) });
  await assert.rejects(transport.call('eth_chainId'), code('deadline'));
  await transport.drain(); const before = transport.records();
  resolve(new Response('{"jsonrpc":"2.0","id":1,"result":"late"}'));
  await new Promise(r => setTimeout(r, 15));
  assert.deepEqual(transport.records(), before); assert.equal(transport.usage().dispatches, 1);
});

test('pre-abort and concurrent calls dispatch no extra requests', async () => {
  let resolve;
  const transport = make({ fetchImpl: () => new Promise(r => { resolve = r; }) });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(transport.call('eth_chainId', [], { signal: controller.signal }), code('cancelled_before_dispatch'));
  const active = transport.call('eth_chainId');
  await assert.rejects(transport.call('eth_chainId'), code('concurrent_dispatch'));
  resolve(new Response('{"jsonrpc":"2.0","id":2,"result":"0x1"}'));
  assert.equal(await active, '0x1'); assert.equal(transport.usage().dispatches, 1);
});

test('save failure prevents success and latches across the whole run', async () => {
  const budget = createCohortWireBudget(), transport = make({ budget, save: () => { throw new Error('disk'); } });
  await assert.rejects(transport.call('eth_chainId'), code('wire_save_failed'));
  await assert.rejects(transport.drain(), code('wire_save_failed'));
  await assert.rejects(make({ budget }).call('eth_chainId'), code('wire_save_failed'));
  assert.equal(transport.records().length, 1); assert.equal(budget.snapshot().dispatches, 1);
});

test('in-flight independent scopes retain their wire but cannot succeed after another scope cannot save', async () => {
  const budget = createCohortWireBudget(); let release; const saved = [];
  const a = make({ budget, save: () => { throw new Error('disk'); } });
  const b = make({ budget, save: row => { saved.push(row); }, fetchImpl: () => new Promise(resolve => { release = resolve; }) });
  const pending = b.call('eth_chainId');
  await assert.rejects(a.call('eth_chainId'), code('wire_save_failed'));
  release(new Response('{"jsonrpc":"2.0","id":1,"result":"0x1"}'));
  await assert.rejects(pending, code('wire_save_failed'));
  assert.equal(saved.length, 1); assert.equal(b.records().length, 1); assert.equal(budget.snapshot().dispatches, 2);
});

test('product fetch adapter preserves successful exact request and response bytes', async () => {
  let requestText;
  const transport = make({ profile: 'product', blockHash, fetchImpl: async (_url, options) => {
    requestText = options.body; return new Response('{ "jsonrpc": "2.0", "id": 1, "result": "0x1" }');
  } });
  const rpc = new StandardRpcClient({ url: transport.url, fetchImpl: transport.fetch });
  assert.equal(await rpc.call('eth_chainId'), '0x1');
  assert.equal(transport.records()[0].requestText, requestText);
  assert.equal(rpc.snapshotEvidence()[0].requestText, requestText);
  assert.equal(rpc.snapshotEvidence()[0].responseText, transport.records()[0].responseText);
});

test('product still sees RPC/HTTP/JSON failures while external capture retains the actual bodies', async () => {
  for (const [text, status, expected] of [
    ['{"jsonrpc":"2.0","id":1,"error":{"code":-32001,"message":"missing"}}', 200, 'RPC_EXECUTION_ERROR'],
    ['provider unavailable', 503, 'RPC_HTTP_ERROR'], ['broken json', 200, 'RPC_INVALID_RESPONSE'],
  ]) {
    const transport = make({ profile: 'product', blockHash, fetchImpl: async () => new Response(text, { status }) });
    const rpc = new StandardRpcClient({ url: transport.url, fetchImpl: transport.fetch });
    await assert.rejects(rpc.call('eth_chainId'), code(expected));
    assert.equal(Buffer.from(transport.records()[0].rawBase64, 'base64').toString(), text);
    assert.equal(rpc.snapshotEvidence()[0].responseText, undefined);
  }
});

test('fetch adapter rejects endpoint drift, duplicate IDs and custom JavaScript tracers', async () => {
  const transport = make({ profile: 'product', blockHash });
  const body = { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] };
  const options = { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
  await assert.rejects(transport.fetch(COHORT_PROVIDERS.publicnode, options), code('fetch_not_allowed'));
  await transport.fetch(transport.url, options);
  await assert.rejects(transport.fetch(transport.url, options), code('duplicate_request_id'));
  const altered = { ...body, id: 2, method: 'debug_traceCall', params: [{}, pinned, { tracer: '{result:function(){}}' }] };
  await assert.rejects(transport.fetch(transport.url, { ...options, body: JSON.stringify(altered) }), code('request_not_allowed'));
  assert.equal(transport.usage().dispatches, 1);
});

test('limits can only tighten and endpoint selection cannot be caller URLs', () => {
  for (const limits of [{ calls: 6145 }, { wallMs: 0 }, { unknown: 1 }]) assert.throws(() => createCohortWireBudget({ limits }), code('invalid_limits'));
  assert.throws(() => make({ provider: 'https://example.com' }), code('invalid_transport'));
  assert.throws(() => make({ profile: 'local' }), code('invalid_state_binding'));
  assert.throws(() => make({ profile: 'local', blockHash, limits: { calls: 257 } }), code('invalid_limits'));
});

test('optional verified local header admits only successive committed ancestor hashes',async()=>{
 const {chain}=await import('../../engines/local-evm/test/ancestry-fixture.js');const c=chain(3),saved=[];
 const rpc=make({profile:'local',blockHash:c.header.hash,header:c.header,save:wire=>{saved.push(wire);},fetchImpl:async(_url,options)=>{const r=JSON.parse(options.body);return new Response(JSON.stringify({jsonrpc:'2.0',id:r.id,result:c.byHash.get(r.params[0])}));}});
 for(const [method,params]of [['eth_getBlockByNumber',[c.blocks[0].number,false]],['eth_getBlockByHash',[c.blocks[0].hash,false]],['eth_getBlockByHash',[c.header.parentHash,true]]])await assert.rejects(rpc.call(method,params),code('request_not_allowed'));
 const first=await rpc.call('eth_getBlockByHash',[c.header.parentHash,false]);assert.equal(first.hash,c.header.parentHash);assert.equal(saved[0].ancestorVerification,'verified');
 await rpc.call('eth_getBlockByHash',[first.parentHash,false]);assert.equal(rpc.records().length,2);
 await assert.rejects(rpc.call('eth_getBlockByHash',[c.header.parentHash,false]),code('request_not_allowed'));
 const legacy=make({profile:'local',blockHash:c.header.hash});await assert.rejects(legacy.call('eth_getBlockByHash',[c.header.parentHash,false]),code('request_not_allowed'));
 assert.throws(()=>make({profile:'local',blockHash,header:c.header}),code('invalid_state_binding'));
 let touched=0;const getter={...c.header};Object.defineProperty(getter,'hash',{enumerable:true,get(){touched++;return c.header.hash;}});
 assert.throws(()=>make({profile:'local',blockHash:c.header.hash,header:getter}),code('invalid_state_binding'));
 const proxy=new Proxy(c.header,{get(){touched++;throw Error('trap');},ownKeys(){touched++;throw Error('trap');}});
 assert.throws(()=>make({profile:'local',blockHash:c.header.hash,header:proxy}),code('invalid_state_binding'));assert.equal(touched,0);
});

test('invalid ancestor bytes remain losslessly saved failures and poison further local reads',async()=>{
 const {chain}=await import('../../engines/local-evm/test/ancestry-fixture.js');const c=chain(2),bad={...c.blocks.at(-2),gasUsed:'0x0'};
 const rpc=make({profile:'local',blockHash:c.header.hash,header:c.header,fetchImpl:ok(bad)});
 await assert.rejects(rpc.call('eth_getBlockByHash',[c.header.parentHash,false]),code('ancestor_header_invalid'));
 const wire=rpc.records()[0];assert.deepEqual(wire.parsed.result,bad);assert.equal(wire.ancestorVerification,'rejected');assert.equal(wire.status,'failed');assert.equal(wire.transport.complete,true);
 assert.equal(JSON.parse(Buffer.from(wire.rawBase64,'base64')).result.gasUsed,'0x0');
 await assert.rejects(rpc.call('eth_getCode',[account,{blockHash:c.header.hash,requireCanonical:true}]),code('ancestor_header_invalid'));assert.equal(rpc.records().length,1);
 const viaFetch=make({profile:'local',blockHash:c.header.hash,header:c.header,fetchImpl:ok(bad)});
 await assert.rejects(viaFetch.fetch(viaFetch.url,{method:'POST',redirect:'error',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_getBlockByHash',params:[c.header.parentHash,false]})}),code('ancestor_header_invalid'));
 assert.equal(viaFetch.records().length,1);
});

test('ancestor traversal has255 intermediate-header ceiling and shares existing local call limits',async()=>{
 const {chain}=await import('../../engines/local-evm/test/ancestry-fixture.js');const c=chain();
 const options={profile:'local',blockHash:c.header.hash,header:c.header,fetchImpl:async(_url,options)=>{const r=JSON.parse(options.body);return new Response(JSON.stringify({jsonrpc:'2.0',id:r.id,result:c.byHash.get(r.params[0])}));}};
 const rpc=make(options);let hash=c.header.parentHash;
 for(let i=0;i<255;i++)hash=(await rpc.call('eth_getBlockByHash',[hash,false])).parentHash;
 await assert.rejects(rpc.call('eth_getBlockByHash',[hash,false]),code('request_not_allowed'));assert.equal(rpc.usage().attempts,255);
 const capped=make({...options,limits:{calls:1}}),parent=await capped.call('eth_getBlockByHash',[c.header.parentHash,false]);
 await assert.rejects(capped.call('eth_getBlockByHash',[parent.parentHash,false]),code('attempt_budget'));assert.equal(capped.records().length,1);
});
