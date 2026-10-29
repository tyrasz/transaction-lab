import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ProofRpcClient, ProofRpcError, PROOF_RPC_LIMITS } from '../src/proof-rpc.js';

const H = '0x' + 'a'.repeat(64), OTHER = '0x' + 'b'.repeat(64), A = '0x' + '1'.repeat(40), S = '0x' + '0'.repeat(64);
const pinned = { blockHash: H, requireCanonical: true };
const sha = value => createHash('sha256').update(value).digest('hex');
const body = (options, result = '0x1') => JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(options.body).id, result });
const good = async (_url, options) => new Response(body(options));
const make = options => new ProofRpcClient({ fetchImpl: good, ...options });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const responseFor = reader => ({ status: 200, body: { getReader: () => reader, cancel: () => reader.cancel?.() } });
const errorCode = code => error => error instanceof ProofRpcError && error.code === code;

test('fixed defaults, server URL and request transport options have no credential-bearing evidence', async () => {
  const before = process.env.ETHEREUM_RPC_URL;
  try {
    delete process.env.ETHEREUM_RPC_URL; assert.equal(make().url.href, 'https://eth.drpc.org/');
    process.env.ETHEREUM_RPC_URL = 'https://user:secret-pass@rpc.test/private-path?key=private-key';
    const rpc = make({ fetchImpl: async (url, options) => {
      assert.equal(url.href, process.env.ETHEREUM_RPC_URL); assert.equal(options.redirect, 'error'); assert.equal(options.method, 'POST');
      assert.deepEqual(options.headers, { 'content-type': 'application/json' }); assert(options.signal instanceof AbortSignal);
      return new Response(body(options));
    } });
    assert.deepEqual(rpc.limits, PROOF_RPC_LIMITS); assert(Object.isFrozen(rpc.limits));
    const exposed = rpc.url; exposed.pathname = '/changed'; assert.match(rpc.url.pathname, /private-path/);
    assert.equal(await rpc.call('eth_chainId'), '0x1');
    assert.doesNotMatch(JSON.stringify(rpc.snapshotEvidence()), /secret-pass|private-path|private-key|https:/);
    assert.equal((await rpc.drain()).complete, true); assert.equal(rpc.usage().pending, 0);
  } finally { if (before === undefined) delete process.env.ETHEREUM_RPC_URL; else process.env.ETHEREUM_RPC_URL = before; }
});

test('trusted numeric network selects its own endpoint and cannot fall back to the other network', () => {
  const ethereum = process.env.ETHEREUM_RPC_URL, sepolia = process.env.SEPOLIA_RPC_URL;
  try {
    delete process.env.ETHEREUM_RPC_URL; delete process.env.SEPOLIA_RPC_URL;
    assert.equal(make({ chainId: 1 }).url.href, 'https://eth.drpc.org/');
    assert.equal(make({ chainId: 11155111 }).url.href, 'https://rpc.sepolia.ethpandaops.io/');
    process.env.ETHEREUM_RPC_URL = 'https://mainnet.invalid/main';
    assert.equal(make({ chainId: 11155111 }).url.href, 'https://rpc.sepolia.ethpandaops.io/');
    process.env.SEPOLIA_RPC_URL = 'https://sepolia.invalid/test';
    assert.equal(make({ chainId: 1 }).url.href, 'https://mainnet.invalid/main');
    assert.equal(make({ chainId: 11155111 }).url.href, 'https://sepolia.invalid/test');
    assert.equal(make({ chainId: 11155111, url: 'http://127.0.0.1:1234' }).url.href, 'http://127.0.0.1:1234/');
    for (const chainId of ['1', '11155111', 0, 999, 42161, null, {}, NaN]) assert.throws(() => make({ chainId }), ProofRpcError);
  } finally {
    if (ethereum === undefined) delete process.env.ETHEREUM_RPC_URL; else process.env.ETHEREUM_RPC_URL = ethereum;
    if (sepolia === undefined) delete process.env.SEPOLIA_RPC_URL; else process.env.SEPOLIA_RPC_URL = sepolia;
  }
});

test('exact method/parameter allowlist and one-time canonical hash pin reject before dispatch', async () => {
  const methods = [], rpc = make({ fetchImpl: async (_url, options) => { methods.push(JSON.parse(options.body)); return new Response(body(options)); } });
  await rpc.call('eth_chainId', []);
  await rpc.call('eth_getBlockByNumber', ['latest', false]); await rpc.call('eth_getBlockByNumber', ['0xffffffffffffffff', false]);
  await rpc.call('eth_getBlockByHash', [H, false]);
  await assert.rejects(rpc.call('eth_getCode', [A, pinned]), errorCode('RPC_UNPINNED'));
  rpc.pinBlockHash(H.toUpperCase().replace('0X', '0x')); rpc.pinBlockHash(H);
  assert.throws(() => rpc.pinBlockHash(OTHER), errorCode('RPC_PIN_CHANGED'));
  await rpc.call('eth_getCode', [A, pinned]); await rpc.call('eth_getProof', [A, [S], pinned]);
  const accepted = methods.length;
  for (const [method, params] of [
    ['eth_sendRawTransaction', ['0x']], ['eth_call', []], ['debug_traceCall', []], ['eth_chainId', [1]],
    ['eth_getBlockByNumber', ['finalized', false]], ['eth_getBlockByNumber', ['0x00', false]], ['eth_getBlockByNumber', ['0x10000000000000000', false]], ['eth_getBlockByNumber', ['latest', true]],
    ['eth_getBlockByHash', [H, true]], ['eth_getBlockByHash', [H, false, 'extra']],
    ['eth_getCode', [A, 'latest']], ['eth_getCode', [A, { ...pinned, blockHash: OTHER }]], ['eth_getCode', [A, { ...pinned, requireCanonical: false }]],
    ['eth_getCode', [A, { ...pinned, stateOverrides: {} }]], ['eth_getProof', [A, [S, S], pinned]], ['eth_getProof', [A, ['0x0'], pinned]],
    ['eth_getProof', [A, [OTHER.toUpperCase()], pinned]], ['eth_getCode', ['0x' + 'A'.repeat(40), pinned]],
  ]) await assert.rejects(rpc.call(method, params), ProofRpcError);
  assert.equal(methods.length, accepted); assert.equal(rpc.usage().calls, accepted);
  const slots = Array.from({ length: 1024 }, (_, i) => '0x' + i.toString(16).padStart(64, '0'));
  await rpc.call('eth_getProof', [A, slots, pinned]);
  await assert.rejects(rpc.call('eth_getProof', [A, [...slots, OTHER], pinned]), errorCode('RPC_INVALID_INPUT'));
});

test('request objects, getters, proxies, sparse lists and options cannot execute input traps', async () => {
  let touched = 0, dispatched = 0;
  const trap = () => { touched++; throw Error('trap'); };
  const rpc = make({ fetchImpl: async () => { dispatched++; } }); rpc.pinBlockHash(H);
  const proxy = new Proxy([], { getPrototypeOf: trap, get: trap, ownKeys: trap });
  const getter = [A, pinned]; Object.defineProperty(getter, '0', { enumerable: true, get: trap });
  const selector = { ...pinned }; Object.defineProperty(selector, 'blockHash', { enumerable: true, get: trap });
  const slots = [S]; Object.defineProperty(slots, '0', { enumerable: true, get: trap });
  const extra = []; extra.other = 1;
  for (const params of [proxy, getter, Array(2), extra, [A, selector], [A, slots, pinned], new Proxy([A, pinned], { get: trap })]) await assert.rejects(rpc.call('eth_getCode', params), ProofRpcError);
  await assert.rejects(rpc.call('eth_getProof', [A, slots, pinned]), ProofRpcError);
  const opts = {}; Object.defineProperty(opts, 'signal', { enumerable: true, get: trap }); await assert.rejects(rpc.call('eth_chainId', [], opts), ProofRpcError);
  assert.throws(() => new ProofRpcClient(new Proxy({}, { getPrototypeOf: trap })), ProofRpcError);
  const construction = {}; Object.defineProperty(construction, 'url', { enumerable: true, get: trap }); assert.throws(() => new ProofRpcClient(construction), ProofRpcError);
  assert.equal(touched, 0); assert.equal(dispatched, 0); assert.equal(rpc.usage().calls, 0);
});

test('all budgets only tighten; call and constructor-started wall ceilings prevent new reads', async () => {
  for (const [key, maximum] of Object.entries(PROOF_RPC_LIMITS)) {
    assert.equal(make({ limits: { [key]: 1 } }).limits[key], 1);
    for (const value of [0, -1, 1.5, maximum + 1, NaN, '1']) assert.throws(() => make({ limits: { [key]: value } }), errorCode('INVALID_RPC_LIMIT'));
  }
  assert.throws(() => make({ limits: { retries: 1 } }), errorCode('INVALID_RPC_LIMIT'));
  for (const url of ['not a URL', 'file:///secret', {}, ['https://rpc.test']]) assert.throws(() => make({ url }), errorCode('INVALID_RPC_URL'));
  const count = make({ limits: { calls: 1 } }); await count.call('eth_chainId'); await assert.rejects(count.call('eth_chainId'), errorCode('RPC_BUDGET'));
  let clock = 0; const wall = make({ now: () => clock, limits: { wallMs: 10 } }); clock = 10;
  await assert.rejects(wall.call('eth_chainId'), errorCode('RPC_BUDGET')); assert.equal(wall.usage().remainingWallMs, 0); assert.equal(wall.usage().calls, 0);
  assert.throws(() => make({ now: () => NaN }), errorCode('RPC_CLOCK'));
});

test('exact successful UTF8 chunks and request bytes are retained, detached and hashed', async () => {
  let raw;
  const rpc = make({ fetchImpl: async (_url, options) => {
    raw = ' ' + JSON.stringify({ result: { label: '€ / 日本語', value: '9007199254740993' }, jsonrpc: '2.0', id: JSON.parse(options.body).id }) + '\n';
    const bytes = Buffer.from(raw), split = bytes.indexOf(Buffer.from('€')) + 1;
    return new Response(new ReadableStream({ start(c) { c.enqueue(bytes.subarray(0, split)); c.enqueue(bytes.subarray(split)); c.close(); } }));
  } });
  const result = await rpc.call('eth_chainId'); result.label = 'mutated';
  const snapshot = rpc.snapshotEvidence(), e = snapshot[0];
  assert.equal(e.status, 'completed'); assert.equal(e.responseText, raw); assert.equal(e.requestText, JSON.stringify(e.request));
  assert.equal(e.requestSha256, sha(e.requestText)); assert.equal(e.requestBytes, Buffer.byteLength(e.requestText));
  for (const key of ['responseSha256', 'observedPrefixSha256', 'retainedPrefixSha256']) assert.equal(e.transport[key], sha(raw));
  assert.equal(e.transport.bodyRetained, true); assert.equal(e.transport.complete, true); assert.equal(e.transport.observedBytes, Buffer.byteLength(raw));
  assert.equal(rpc.usage().successfulResponseBytes, Buffer.byteLength(raw)); assert.equal(rpc.usage().retainedBytes, Buffer.byteLength(raw));
  snapshot[0].request.params.push('changed'); snapshot[0].responseText = 'changed';
  assert.equal(rpc.snapshotEvidence()[0].responseText, raw); assert.deepEqual(rpc.snapshotEvidence()[0].request.params, []);
});

test('HTTP, RPC, nested errors and thrown adapter secrets retain only safe messages and body hashes', async () => {
  const secret = 'PRIVATE_PROVIDER_CREDENTIAL_123';
  const cases = [
    { status: 503, raw: secret, code: 'RPC_HTTP_ERROR' },
    { status: 200, raw: JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: secret } }), code: 'RPC_EXECUTION_ERROR' },
    { status: 200, raw: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { storageProof: [{ error: { code: -32001, message: secret } }] } }), code: 'RPC_EXECUTION_ERROR' },
    { status: 200, raw: JSON.stringify({ jsonrpc: '2.0', id: 1, error: null }), code: 'RPC_EXECUTION_ERROR' },
  ];
  for (const sample of cases) {
    const rpc = make({ fetchImpl: async () => new Response(sample.raw, { status: sample.status }) });
    await assert.rejects(rpc.call('eth_chainId'), errorCode(sample.code)); const e = rpc.snapshotEvidence()[0];
    assert.equal(e.responseText, undefined); assert.equal(e.transport.responseSha256, sha(sample.raw)); assert.equal(e.transport.observedBytes, Buffer.byteLength(sample.raw));
    assert.equal(e.transport.bodyRetained, false); assert.doesNotMatch(JSON.stringify(e), /PRIVATE_PROVIDER/);
  }
  const rpc = make({ fetchImpl: async () => { throw new Error(secret); } });
  await assert.rejects(rpc.call('eth_chainId'), errorCode('RPC_CONNECTION_ERROR')); assert.doesNotMatch(JSON.stringify(rpc.snapshotEvidence()), /PRIVATE_PROVIDER/);
});

test('provider URL secrets echoed by a successful envelope are withheld', async () => {
  for (const [url, secret] of [['https://rpc.test/private-token', 'private-token'], ['https://user:secret%3Apass@rpc.test', 'secret:pass'], ['https://rpc.test?key=secret-key', 'secret-key'], ['https://user:abc@rpc.test', 'abc'], ['https://x@rpc.test', 'x'], ['https://rpc.test?key=%61', 'a']]) {
    const rpc = make({ url, fetchImpl: async (_url, options) => new Response(body(options, { value: secret })) });
    await assert.rejects(rpc.call('eth_chainId'), errorCode('RPC_INVALID_RESPONSE')); assert.equal(rpc.snapshotEvidence()[0].responseText, undefined);
  }
  assert.equal(await make({ url: 'https://x:a@rpc.test?key=b' }).call('eth_chainId'), '0x1');
});

test('adapter same-class errors cannot inject text, detail, codes or getters into retained evidence', async () => {
  const secret = 'PRIVATE_ERROR_INSTANCE_SECRET'; let touched = 0;
  const poisoned = new ProofRpcError('RPC_EXECUTION_ERROR', { rpcCode: -32000, message: secret, headers: { Authorization: secret } }); poisoned.message = secret;
  const getter = new ProofRpcError('RPC_EXECUTION_ERROR'); Object.defineProperty(getter, 'detail', { get() { touched++; throw Error(secret); } });
  const proxy = new Proxy({}, { getPrototypeOf() { touched++; throw Error(secret); }, get() { touched++; throw Error(secret); } });
  for (const [thrown, expected, detail] of [[poisoned, 'RPC_EXECUTION_ERROR', { rpcCode: -32000 }], [getter, 'RPC_EXECUTION_ERROR', { rpcCode: null }], [new ProofRpcError(secret), 'RPC_CONNECTION_ERROR', null], [proxy, 'RPC_CONNECTION_ERROR', null]]) {
    const rpc = make({ fetchImpl: async () => { throw thrown; } });
    await assert.rejects(rpc.call('eth_chainId'), error => {
      assert.equal(error.code, expected); assert.deepEqual(error.detail, detail);
      if (detail) { error.detail.rpcCode = 123; error.detail.secret = secret; }
      assert(!error.message.includes(secret)); return true;
    });
    assert(!JSON.stringify(rpc.snapshotEvidence()).includes(secret));
    if (detail) assert.deepEqual(rpc.snapshotEvidence()[0].error.detail, detail);
  }
  assert.equal(touched, 0);
});

test('invalid JSON, UTF8, BOM and inconsistent envelopes fail without raw error-body retention', async () => {
  const samples = [null, [], {}, { jsonrpc: '2.0', id: 2, result: '0x1' }, { jsonrpc: '2.0', id: '1', result: '0x1' }, { jsonrpc: '2.0', id: 1 }, { jsonrpc: '2.0', id: 1, result: null, error: null }].map(JSON.stringify);
  samples.push('{malformed', Buffer.from([0xff]), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"jsonrpc":"2.0","id":1,"result":"0x1"}')]));
  for (const raw of samples) {
    const rpc = make({ fetchImpl: async () => new Response(raw) }); await assert.rejects(rpc.call('eth_chainId'), errorCode('RPC_INVALID_RESPONSE'));
    const e = rpc.snapshotEvidence()[0]; assert.equal(e.responseText, undefined); assert.equal(e.transport.responseSha256, sha(raw)); assert.equal(e.transport.complete, true);
  }
});

test('oversized stream chunks are counted in full but only bounded prefix bytes are held', async () => {
  const raw = 'abcdefgh', rpc = make({ limits: { responseBytes: 5 }, fetchImpl: async () => new Response(raw) });
  await assert.rejects(rpc.call('eth_chainId'), errorCode('RPC_RESPONSE_TOO_LARGE'));
  const e = rpc.snapshotEvidence()[0]; assert.equal(e.transport.observedBytes, 8); assert.equal(e.transport.retainedPrefixBytes, 5);
  assert.equal(e.transport.observedPrefixSha256, sha(raw)); assert.equal(e.transport.retainedPrefixSha256, sha('abcde')); assert.equal(e.responseText, undefined);
  assert.equal(e.transport.complete, false); assert.equal(rpc.usage().retainedBytes, 5); assert.equal((await rpc.drain()).complete, true);
});

test('shared byte ceiling spans calls and closes dispatch after an overshooting chunk', async () => {
  const first = JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' });
  const rpc = make({ limits: { totalBytes: Buffer.byteLength(first) + 5 }, fetchImpl: async (_url, options) => new Response(body(options)) });
  await rpc.call('eth_chainId'); await assert.rejects(rpc.call('eth_chainId'), errorCode('RPC_RESPONSE_TOO_LARGE'));
  assert.equal(rpc.usage().calls, 2); assert.equal(rpc.usage().retainedBytes, Buffer.byteLength(first) + 5);
  await assert.rejects(rpc.call('eth_chainId'), errorCode('RPC_BUDGET')); assert.equal(rpc.usage().dispatched, 2);
});

test('pre-abort and shared cancellation dispatch nothing; abort reasons never leak', async () => {
  let dispatched = 0; const rpc = make({ fetchImpl: async () => { dispatched++; } }), controller = new AbortController();
  controller.abort('PRIVATE_ABORT_SECRET');
  await assert.rejects(rpc.call('eth_chainId', [], { signal: controller.signal }), errorCode('RPC_CANCELLED'));
  rpc.cancel(); await assert.rejects(rpc.call('eth_chainId'), errorCode('RPC_CANCELLED'));
  assert.equal(dispatched, 0); assert.equal(rpc.usage().calls, 0); assert.equal((await rpc.drain()).complete, true);
  assert.doesNotMatch(JSON.stringify(rpc.usage()), /PRIVATE_ABORT/);
});

test('external abort terminates ignored-signal fetch, reports pending adapter and seals evidence', async () => {
  const late = deferred(), entered = deferred(), controller = new AbortController(); let cancelledBody = 0;
  const rpc = make({ fetchImpl: async () => { entered.resolve(); return late.promise; } });
  const call = rpc.call('eth_chainId', [], { signal: controller.signal }); await entered.promise; controller.abort('secret');
  await assert.rejects(call, errorCode('RPC_CANCELLED')); const sealed = rpc.snapshotEvidence();
  const drained = await rpc.drain({ timeoutMs: 5 }); assert.equal(drained.complete, false); assert.equal(drained.pending, 0); assert.equal(drained.adapterPending, 1);
  late.resolve({ body: { cancel() { cancelledBody++; } } }); await delay(0);
  assert.deepEqual(rpc.snapshotEvidence(), sealed); assert.equal(cancelledBody, 1); assert.equal((await rpc.drain()).complete, true);
});

test('request deadline terminates stalled stream and ignores all late bytes/results', async () => {
  const late = deferred(); let reads = 0, cancels = 0;
  const reader = { read() { reads++; return late.promise; }, cancel() { cancels++; } };
  const rpc = make({ limits: { requestMs: 10 }, fetchImpl: async () => responseFor(reader) });
  await assert.rejects(rpc.call('eth_chainId'), errorCode('RPC_TIMEOUT')); const sealed = rpc.snapshotEvidence();
  assert.equal(reads, 1); assert.equal(cancels, 1); assert(sealed[0].transport.durationMs >= 5);
  assert.equal((await rpc.drain({ timeoutMs: 5 })).complete, false);
  late.resolve({ done: false, value: Buffer.alloc(100) }); await delay(0);
  assert.deepEqual(rpc.snapshotEvidence(), sealed); assert.equal(rpc.usage().observedBytes, 0); assert.equal((await rpc.drain()).complete, true);
});

test('shared cancel stops concurrent requests and later adapter failure cannot rewrite evidence', async () => {
  const adapters = [deferred(), deferred()], entered = deferred(); let dispatched = 0;
  const rpc = make({ fetchImpl: async () => { const next = adapters[dispatched++]; if (dispatched === 2) entered.resolve(); return next.promise; } });
  const calls = [rpc.call('eth_chainId'), rpc.call('eth_chainId')]; const outcomes = Promise.allSettled(calls); await entered.promise; rpc.cancel();
  for (const result of await outcomes) assert.equal(result.reason.code, 'RPC_CANCELLED');
  const sealed = rpc.snapshotEvidence(); assert.equal(rpc.usage().pending, 0);
  await assert.rejects(rpc.call('eth_chainId'), errorCode('RPC_CANCELLED'));
  adapters[0].reject(Error('private late error')); adapters[1].resolve(new Response('private late body')); await delay(0);
  assert.deepEqual(rpc.snapshotEvidence(), sealed); assert.equal((await rpc.drain()).complete, true);
});

test('drain is explicitly bounded and cannot accept widened or unbounded waits', async () => {
  const rpc = make();
  for (const timeoutMs of [0, -1, 25001, Infinity, NaN, '1']) await assert.rejects(rpc.drain({ timeoutMs }), errorCode('INVALID_RPC_LIMIT'));
  await assert.rejects(rpc.drain({ timeoutMs: 1, retries: 1 }), ProofRpcError);
  const before = rpc.snapshotEvidence(); assert.equal((await rpc.drain({ timeoutMs: 1 })).complete, true); assert.deepEqual(rpc.snapshotEvidence(), before);
});

test('backward or nonfinite clock closes all future dispatch without NaN telemetry', async () => {
  let clock = 10; const rpc = make({ now: () => clock }); clock = 9;
  await assert.rejects(rpc.call('eth_chainId'), errorCode('RPC_CLOCK'));
  clock = NaN; const usage = rpc.usage(); assert.equal(usage.clockValid, false); assert.equal(usage.calls, 0); assert.equal(usage.elapsedMs, 0); assert.equal(usage.cancelled, true);
  clock = 20; await assert.rejects(rpc.call('eth_chainId'), errorCode('RPC_CLOCK'));
});

test('header-aware pin allows only source rechecks and sequential hash-selected parents', async () => {
  const hashAt=n=>'0x'+BigInt(n).toString(16).padStart(64,'0');
  const headerAt=n=>({hash:hashAt(n),number:'0x'+n.toString(16),parentHash:hashAt(n-1)});
  const seen=[],rpc=make({fetchImpl:async(_url,options)=>{const request=JSON.parse(options.body);seen.push(request);return new Response(body(options,headerAt(Number(BigInt(request.params[0])))));}});
  rpc.pinBlockHash(hashAt(300),headerAt(300));
  await assert.rejects(rpc.call('eth_getBlockByNumber',['latest',false]),errorCode('RPC_INVALID_INPUT'));
  await assert.rejects(rpc.call('eth_getBlockByNumber',['0x12b',false]),errorCode('RPC_INVALID_INPUT'));
  await assert.rejects(rpc.call('eth_getBlockByHash',[hashAt(298),false]),errorCode('RPC_INVALID_INPUT'));
  await rpc.call('eth_getBlockByHash',[hashAt(299),false]);
  rpc.pinBlockHash(hashAt(300),headerAt(300)); // Repeating the pin must not reset ancestry.
  await assert.rejects(rpc.call('eth_getBlockByHash',[hashAt(299),false]),errorCode('RPC_INVALID_INPUT'));
  await rpc.call('eth_getBlockByHash',[hashAt(298),false]);
  await rpc.call('eth_getBlockByHash',[hashAt(300),false]);await rpc.call('eth_getBlockByNumber',['0x12c',false]);
  assert.equal(seen.length,4);assert.equal(rpc.snapshotEvidence().length,4);
  assert.throws(()=>rpc.pinBlockHash(hashAt(300),{...headerAt(300),parentHash:H}),errorCode('RPC_PIN_CHANGED'));
});

test('transport ancestry rejects malformed or skipped header numbers without advancing the gate',async()=>{
  const root={hash:H,number:'0x10',parentHash:OTHER},parent={hash:OTHER,number:'0xf',parentHash:S};let value={...parent,number:'0xe'};
  const rpc=make({fetchImpl:async(_url,options)=>new Response(body(options,value))});rpc.pinBlockHash(H,root);
  await assert.rejects(rpc.call('eth_getBlockByHash',[OTHER,false]),errorCode('RPC_INVALID_RESPONSE'));
  assert.equal(rpc.snapshotEvidence()[0].status,'failed');assert.equal(Object.hasOwn(rpc.snapshotEvidence()[0],'responseText'),false);
  await assert.rejects(rpc.call('eth_getBlockByHash',[S,false]),errorCode('RPC_INVALID_INPUT'));
  value=parent;assert.deepEqual(await rpc.call('eth_getBlockByHash',[OTHER,false]),parent);
  assert.equal(rpc.usage().calls,2);
});

test('transport bounds ancestry to255 fetched intermediate headers inside its unchanged shared call cap',async()=>{
  const hashAt=n=>'0x'+BigInt(n).toString(16).padStart(64,'0'),headerAt=n=>({hash:hashAt(n),number:'0x'+n.toString(16),parentHash:hashAt(n-1)});
  const rpc=make({fetchImpl:async(_url,options)=>new Response(body(options,headerAt(Number(BigInt(JSON.parse(options.body).params[0])))))});
  rpc.pinBlockHash(hashAt(300),headerAt(300));
  for(let n=299;n>=45;n--)await rpc.call('eth_getBlockByHash',[hashAt(n),false]);
  assert.equal(rpc.usage().calls,255);await assert.rejects(rpc.call('eth_getBlockByHash',[hashAt(44),false]),errorCode('RPC_INVALID_INPUT'));
  await rpc.call('eth_getCode',[A,{blockHash:hashAt(300),requireCanonical:true}]).catch(()=>{});assert.equal(rpc.usage().calls,256);
});

test('ancestor gate prevents concurrent chain advancement and preserves cancellation evidence',async()=>{
  const waiting=deferred(),rpc=make({fetchImpl:async()=>waiting.promise});rpc.pinBlockHash(H,{hash:H,number:'0x10',parentHash:OTHER});
  const controller=new AbortController(),pending=rpc.call('eth_getBlockByHash',[OTHER,false],{signal:controller.signal});
  await assert.rejects(rpc.call('eth_getBlockByHash',[OTHER,false]),errorCode('RPC_INVALID_INPUT'));
  controller.abort();await assert.rejects(pending,errorCode('RPC_CANCELLED'));
  const saved=JSON.stringify(rpc.snapshotEvidence());waiting.resolve(new Response(JSON.stringify({jsonrpc:'2.0',id:1,result:{hash:OTHER,number:'0xf',parentHash:S}})));
  assert.equal((await rpc.drain({timeoutMs:100})).complete,true);assert.equal(JSON.stringify(rpc.snapshotEvidence()),saved);
  await assert.rejects(rpc.call('eth_getBlockByHash',[S,false]),errorCode('RPC_INVALID_INPUT'));
});
