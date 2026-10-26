import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { simulateUnsignedCall, normalizeQuery, validateQueryTrace, validateQueryDiff } from '../unsigned-call.js';

const address = n => '0x' + BigInt(n).toString(16).padStart(40, '0');
const word = n => '0x' + BigInt(n).toString(16).padStart(64, '0');
const hex = n => '0x' + BigInt(n).toString(16);
const S = address(11), TARGET = address(12), USDC = address(21), ATOKEN = address(22), VAULT = address(23), IMPL = address(31), POOL = address(32), POOL_IMPL = address(33), PROBE = address(0xba1a);
const BLOCK = word(90), PARENT = word(89), MIX = word(91), MINER = address(92), NATIVE = 10n ** 18n, MAX = (1n << 256n) - 1n;
const balanceOf = owner => '0x70a08231' + owner.slice(2).padStart(64, '0');
const allowance = (owner, spender) => '0xdd62ed3e' + owner.slice(2).padStart(64, '0') + spender.slice(2).padStart(64, '0');
const CALL = { from: S, to: TARGET, data: '0x11111111', value: '0x0', gas: '0x30d40' };
const HEADER = { hash: BLOCK, parentHash: PARENT, mixHash: MIX, miner: MINER, number: hex(9000001), timestamp: hex(1700000000), gasLimit: hex(30000000), baseFeePerGas: hex(17000000000) };
const QUERIES = [{ to: USDC, data: balanceOf(S) }, { to: ATOKEN, data: balanceOf(S) }, { to: VAULT, data: balanceOf(S) }, { to: USDC, data: allowance(S, TARGET) }];
// This complete RPC fixture is explicitly synthetic. Raw integer values differ
// across receipt shares, vault shares and cash; tests must not invent equivalence.
const VALUES = [['100000000000000000019', '100000000000000000001'], ['17', '36'], ['3', '4'], [MAX.toString(), (MAX - 18n).toString()]];
const ORIGINAL_DIFF = { pre: { [S]: { nonce: 7, balance: hex(NATIVE) }, [USDC]: { storage: { [word(1)]: word(100000000000000000019n), [word(2)]: word(42) } }, [ATOKEN]: { storage: { [word(3)]: word(17) } }, [VAULT]: { storage: { [word(4)]: word(3) } } },
  post: { [S]: { nonce: 8 }, [USDC]: { storage: { [word(1)]: word(100000000000000000001n) } }, [ATOKEN]: { storage: { [word(3)]: word(36) } }, [VAULT]: { storage: { [word(4)]: word(4) } } } };
const EXPECTED_OVERRIDES = { [S]: { nonce: '0x8' }, [USDC]: { stateDiff: { [word(1)]: word(100000000000000000001n), [word(2)]: word(0) } }, [ATOKEN]: { stateDiff: { [word(3)]: word(36) } }, [VAULT]: { stateDiff: { [word(4)]: word(4) } } };
function frame({ from = S, to = TARGET, input = CALL.data, output = '0x', type = 'CALL', gas = CALL.gas, gasUsed = '0x9000', ...extra } = {}) {
  return { type, from, to, input, output, value: '0x0', gas, gasUsed, ...extra };
}
function queryTrace(query, output, gas = '0x493e0') {
  const root = frame({ to: query.to, input: query.data, output: word(output), gas, gasUsed: '0x1800' });
  if (query.to === VAULT) return root;
  const delegate = frame({ type: 'DELEGATECALL', from: query.to, to: IMPL, input: query.data, output: root.output, gas: '0x40000', gasUsed: '0x1000' }); root.calls = [delegate];
  if (query.to === ATOKEN) {
    const input = '0xd15e0053' + USDC.slice(2).padStart(64, '0'), output = word(10n ** 27n + 123n);
    const pool = frame({ type: 'STATICCALL', from: ATOKEN, to: POOL, input, output, gas: '0x30000', gasUsed: '0x800' });
    pool.calls = [frame({ type: 'DELEGATECALL', from: POOL, to: POOL_IMPL, input, output, gas: '0x20000', gasUsed: '0x400' })]; delegate.calls = [pool];
  }
  return root;
}
const queryCall = q => ({ from: S, ...q, value: '0x0', gas: '0x493e0' });
const queryDiff = after => ({ pre: { [S]: { nonce: after ? 8 : 7, balance: hex(NATIVE) } }, post: { [S]: { nonce: after ? 9 : 8 } } });
function harness({ mutate, chainId = 1, originalFailed = false } = {}) {
  const records = [];
  const rpc = { async call(method, params) {
    const record = { method, params: structuredClone(params) }; records.push(record); let result, stage = method;
    if (method === 'eth_chainId') result = hex(chainId);
    else if (method === 'eth_getBlockByHash' || method === 'eth_getBlockByNumber') result = structuredClone(HEADER);
    else if (method === 'eth_getTransactionCount') result = '0x7';
    else if (method === 'eth_getBalance') result = hex(NATIVE);
    else if (method === 'eth_getCode') result = [S, PROBE].includes(params[0]) ? '0x' : '0x60006000f3';
    else if (method === 'debug_traceCall') {
      const [call, , options] = params, diff = options.tracer === 'prestateTracer', after = Boolean(options.stateOverrides), q = QUERIES.findIndex(q => q.to === call.to && q.data === call.data);
      if (call.to === PROBE) {
        stage = after && Object.hasOwn(options.stateOverrides, S) ? 'header_after' : 'header_before';
        result = frame({ ...call, input: call.data, gasUsed: '0x6000', output: '0x' + [9000001,1700000000,30000000,0,MIX,MINER,chainId,PARENT].map(n => word(n).slice(2)).join('') }); delete result.data;
      } else if (call.to === TARGET && call.data === CALL.data) {
        stage = diff ? 'original_diff' : 'original_trace';
        result = diff ? structuredClone(ORIGINAL_DIFF) : frame({ ...(originalFailed ? { error: 'execution reverted', output: '0xdeadbeef' } : {}) });
      } else {
        assert.notEqual(q, -1, 'No undeclared query or fallback'); stage = `query_${q}_${after ? 'after' : 'before'}_${diff ? 'diff' : 'trace'}`;
        result = diff ? queryDiff(after) : queryTrace(QUERIES[q], VALUES[q][after ? 1 : 0]);
      }
    } else assert.fail('Unexpected method ' + method);
    const changed = mutate?.({ method, params, stage, result, record, records }); if (changed !== undefined) result = changed;
    record.result = structuredClone(result); return result;
  } };
  return { rpc, records, chainId, blockHash: BLOCK, request: structuredClone(CALL), queries: structuredClone(QUERIES) };
}
function noAmounts(result) { for (const row of result.measurements) for (const key of ['beforeRaw','afterRaw','deltaRaw','basis']) assert.equal(row[key], undefined); }
const run = h => simulateUnsignedCall(h);

// Positive public traces are pinned separately from the synthetic full pipeline.
const realBytes = await readFile(new URL('../../../reports/standard-evm-capabilities/capture.json', import.meta.url));
assert.equal(createHash('sha256').update(realBytes).digest('hex'), 'ada8360af17b2ebce8caa301ddea304814e730f2e1d492517ae5669081601d80');
const real = JSON.parse(realBytes).records.find(r => r.provider === 'ethereum-drpc' && r.request.method === 'debug_traceCall' && r.request.params[2].tracer === 'callTracer' && r.request.params[0].to === '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
assert.ok(real);
const receiptBytes = await readFile(new URL('../../../reports/affected-balance-comparisons/capture.json', import.meta.url));
assert.equal(createHash('sha256').update(receiptBytes).digest('hex'), '53eec210304f3f3ff749bc4a4cdbd4fe55f57e87a2cd0b94983574bd0942de34');
const receiptQuery = JSON.parse(receiptBytes).cases.flatMap(c => c.runs).flatMap(r => r.rpcCalls).find(r => r.request.method === 'debug_traceCallMany' && r.request.params[2].tracer === 'callTracer' && r.request.params[0][0].transactions[0].to === '0x744e4f26ee30213989216e1632d9be3547c4885b' && r.request.params[0][0].transactions[0].data.startsWith('0x70a08231'));
assert.ok(receiptQuery);

test('saved Ethereum USDC proxy and receipt-token nested STATICCALL traces preserve exact observed output', () => {
  const positives = [[real.response.result, real.request.params[0]], [receiptQuery.response.result[0][0], receiptQuery.request.params[0][0].transactions[0]]];
  for (const [trace, call] of positives) { const snapshot = structuredClone(trace); assert.deepEqual(validateQueryTrace(trace, call), { amountRaw: BigInt(trace.output).toString(), gasUsed: BigInt(trace.gasUsed).toString() }); assert.deepEqual(trace, snapshot); }
  assert.equal(positives[0][0].calls[0].type, 'DELEGATECALL'); assert.equal(positives[1][0].calls[0].calls[0].type, 'STATICCALL');
});

test('synthetic direct vault, proxy and nested index-query shapes are admitted without claiming deployed source verification', () => {
  for (const [i, q] of QUERIES.entries()) assert.deepEqual(validateQueryTrace(queryTrace(q, VALUES[i][0]), queryCall(q)), { amountRaw: VALUES[i][0], gasUsed: '6144' });
  assert.equal(queryTrace(QUERIES[2], 3).calls, undefined);
});

test('canonical query input rejects writes, noncanonical words, coercible addresses and extra fields', () => {
  for (const q of QUERIES) assert.deepEqual(normalizeQuery(q), q);
  for (const query of [null, [], { ...QUERIES[0], to: [USDC] }, { ...QUERIES[0], data: [QUERIES[0].data] }, { ...QUERIES[0], from: S }, { to: USDC, data: '0x095ea7b3' + allowance(S,TARGET).slice(10) }, { ...QUERIES[0], data: QUERIES[0].data + '00' }, { ...QUERIES[0], data: '0x70a08231' + '1' + QUERIES[0].data.slice(11) }]) assert.throws(() => normalizeQuery(query));
});

test('query trace rejects any failed, state-changing, misbound or malformed execution path', () => {
  for (const change of [
    t => { t.error = 'execution reverted'; }, t => { t.calls[0].error = 'execution reverted'; }, t => { t.from = TARGET; }, t => { t.to = TARGET; }, t => { t.input = '0x'; }, t => { t.gas = '0x1'; }, t => { t.gasUsed = '0x0'; }, t => { t.gasUsed = '0x493e1'; }, t => { t.output = '0x01'; }, t => { t.value = '0x1'; },
    t => { t.calls[0].type = 'CALL'; }, t => { t.calls[0].from = S; }, t => { t.calls[0].input = '0x'; }, t => { t.calls[0].output = word(999); }, t => { t.calls[0].logs = [{ address: ATOKEN, topics: [], data: '0x' }]; }, t => { t.calls[0].calls[0].from = IMPL; }, t => { t.calls[0].calls[0].type = 'CALL'; }, t => { t.calls[0].calls[0].revertReason = 'caught revert'; }, t => { t.calls[0].calls[0].calls[0].type = 'CREATE2'; }, t => { t.calls[0].calls[0].calls[0].value = '0x1'; }, t => { t.error = { message: 'malformed' }; }, t => { t.calls = {}; }, t => { t.extra = true; },
  ]) { const trace = queryTrace(QUERIES[1], 17); change(trace); assert.throws(() => validateQueryTrace(trace, queryCall(QUERIES[1]))); }
});

test('query diff requires an anchored nonce increment and unchanged native funds, never empty evidence', () => {
  validateQueryDiff(queryDiff(false), { sender:S, nonce:7n, balance:NATIVE });
  for (const change of [
    d => { d.pre = {}; d.post = {}; }, d => { delete d.pre[S].nonce; }, d => { delete d.pre[S].balance; }, d => { d.post[S].nonce = 9; }, d => { d.post[S].balance = hex(NATIVE-1n); }, d => { d.pre[USDC] = {}; d.post[USDC] = {}; }, d => { d.post[S].storage = { [word(1)]:word(1) }; }, d => { d.post[S].code = '0x00'; },
  ]) { const diff = queryDiff(false); change(diff); assert.throws(() => validateQueryDiff(diff, { sender:S, nonce:7n, balance:NATIVE })); }
  assert.doesNotThrow(() => validateQueryDiff({pre:{[S]:{balance:hex(NATIVE)}},post:{[S]:{nonce:1}}},{sender:S,nonce:0n,balance:NATIVE}));
});

test('full synthetic before/after flow uses complete original overrides, clears omitted slots and retains exact independent integers', async () => {
  for (const chainId of [1,8453]) {
    const h = harness({chainId}), requestSnapshot = structuredClone(h.request), queriesSnapshot = structuredClone(h.queries), result = await run(h);
    assert.equal(result.execution.status, 'success'); assert.equal(result.canonicalStatus, 'verified'); assert.equal(result.accounting.rpcCalls, 31); assert.equal(result.evidence.length, h.records.length);
    assert.deepEqual(result.measurements.map(m => [m.status,m.beforeRaw,m.afterRaw,m.deltaRaw]), VALUES.map(([a,b]) => ['measured',a,b,(BigInt(b)-BigInt(a)).toString()]));
    assert.deepEqual(h.request, requestSnapshot); assert.deepEqual(h.queries, queriesSnapshot);
    assert.equal(result.executionIdentity.chainId, String(chainId)); assert.equal(result.executionIdentity.executionBaseFee, '0'); assert.equal(result.scope.runtimeCodeAttestation, false); assert.equal(result.scope.allEffectsCoverage, 'inconclusive');
    const queryRecords = h.records.filter(r => r.method === 'debug_traceCall' && QUERIES.some(q => q.to === r.params[0].to && q.data === r.params[0].data)); assert.equal(queryRecords.length, 16);
    for (const r of queryRecords) { assert.deepEqual(r.params[1], {blockHash:BLOCK,requireCanonical:true}); assert.equal(Object.hasOwn(r.params[0],'nonce'),false); assert.equal(Object.hasOwn(r.params[0],'gasPrice'),false); if (r.params[2].stateOverrides) assert.deepEqual(r.params[2].stateOverrides,EXPECTED_OVERRIDES); }
    const witnessAfter = h.records.find(r => r.method === 'debug_traceCall' && r.params[0].to === PROBE && Object.hasOwn(r.params[2].stateOverrides,S)); const { [PROBE]:witness, ...complete } = witnessAfter.params[2].stateOverrides; assert.deepEqual(complete,EXPECTED_OVERRIDES); assert.ok(witness.code.startsWith('0x43'));
    assert.equal(EXPECTED_OVERRIDES[USDC].stateDiff[word(2)],word(0)); assert.equal(Object.hasOwn(EXPECTED_OVERRIDES[USDC],'state'),false);
    h.records[0].result = '0xdead'; assert.equal(result.evidence[0].result,hex(chainId),'Parsed evidence is detached from RPC fixture mutation');
  }
});

test('a synthetic original EVM failure is retained distinctly from unavailable transport and never gets poststate measurements', async () => {
  const reverted = harness({originalFailed:true}), result = await run(reverted); assert.equal(result.execution.status,'reverted_or_failed'); assert.equal(result.execution.returnData,'0xdeadbeef'); assert.equal(result.canonicalStatus,'verified'); assert.ok(result.measurements.every(m=>m.status==='not_applicable')); noAmounts(result);
  assert.equal(reverted.records.some(r=>r.method==='debug_traceCall'&&r.params[2].tracer==='prestateTracer'),false);
  const marker='SECRET_PROVIDER_CREDENTIAL'; const failed = await run(harness({mutate:({stage})=>{if(stage==='original_trace')throw new Error(marker);}}));
  assert.equal(failed.execution.status,'unavailable'); assert.ok(failed.measurements.every(m=>m.status==='unavailable')); noAmounts(failed); assert.equal(JSON.stringify(failed).includes(marker),false);
});

test('source-chain/header/basic-state/original trace mismatches fail closed before useful query amounts', async () => {
  const mutations = [
    x=>x.method==='eth_chainId'?'0x2':undefined,
    x=>{if(x.method==='eth_getBlockByHash')x.result.hash=word(999);},
    x=>{if(x.method==='eth_getBlockByHash')delete x.result.parentHash;},
    x=>x.method==='eth_getTransactionCount'?'0x6':undefined,
    x=>x.method==='eth_getBalance'?hex(NATIVE+1n):undefined,
    x=>x.method==='eth_getCode'&&x.params[0]===S?'0x00':undefined,
    x=>x.method==='eth_getCode'&&x.params[0]===VAULT?'0x':undefined,
    x=>x.method==='eth_getCode'&&x.params[0]===PROBE?'0x00':undefined,
    x=>{if(x.stage==='original_trace')x.result.input='0x1234';},
    x=>{if(x.stage==='original_trace')x.result.gas='0x1234';},
    x=>{if(x.stage==='original_diff')x.result.post[S].balance=hex(NATIVE-1n);},
    x=>{if(x.stage==='original_diff')delete x.result.pre[S].nonce;},
    x=>{if(x.stage==='original_diff')delete x.result.pre[S].balance;},
    x=>{if(x.stage==='original_diff')x.result.post[S].nonce=9;},
    x=>{if(x.stage==='header_before')x.result.output=word(0).repeat(8);},
    x=>{if(x.stage==='header_after')x.result.output='0x'+x.result.output.slice(2,194)+word(1).slice(2)+x.result.output.slice(258);},
  ];
  for(const mutate of mutations){const result=await run(harness({mutate}));assert.equal(result.canonicalStatus,'unverified');assert.ok(result.measurementFailure);noAmounts(result);}
});

test('both eight-word header witnesses bind every execution field and forbid witness descendants/events', async () => {
  for(const stage of ['header_before','header_after']) for(let index=0;index<8;index++){
    const h=harness({mutate:x=>{if(x.stage===stage){const words=x.result.output.slice(2).match(/.{64}/g);words[index]=word(BigInt('0x'+words[index])+1n).slice(2);x.result.output='0x'+words.join('');}}});
    const result=await run(h);assert.equal(result.canonicalStatus,'unverified');assert.match(result.measurementFailure,/Execution header/);noAmounts(result);
    assert.equal(h.records.some(r=>r.method==='debug_traceCall'&&QUERIES.some(q=>q.to===r.params[0].to&&q.data===r.params[0].data)),false);
  }
  for(const mutate of [
    x=>{if(x.stage==='header_before')x.result.output+='00';},
    x=>{if(x.stage==='header_after')x.result.calls=[frame({type:'STATICCALL',from:PROBE,to:USDC})];},
    x=>{if(x.stage==='header_before')x.result.logs=[{address:PROBE,topics:[],data:'0x'}];},
  ]){const result=await run(harness({mutate}));assert.equal(result.canonicalStatus,'unverified');noAmounts(result);}
});

test('coercible or incomplete source-header fields and oversized quantities never become state anchors', async () => {
  for(const field of ['hash','parentHash','mixHash','miner']){
    const h=harness({mutate:x=>{if(x.method==='eth_getBlockByHash')x.result[field]=[x.result[field]];}});const result=await run(h);assert.equal(result.canonicalStatus,'unverified');noAmounts(result);assert.equal(h.records.length,2);
  }
  for(const value of ['9'.repeat(1000),'-1','0xnope',Number.MAX_SAFE_INTEGER+1]){
    const h=harness({mutate:x=>x.method==='eth_getTransactionCount'?value:undefined}), result=await run(h);assert.equal(result.canonicalStatus,'unverified');noAmounts(result);
  }
});

test('original lifecycle, account creation and changed code cannot produce a measured after-state', async () => {
  for(const mutate of [
    x=>{if(x.stage==='original_trace')x.result.calls=[frame({type:'CREATE2',from:TARGET,to:address(700),error:'reverted'})];},
    x=>{if(x.stage==='original_diff')x.result.post[address(700)]={nonce:1};},
    x=>{if(x.stage==='original_diff'){x.result.pre[USDC].code='0x00';x.result.post[USDC].code='0x01';}},
    x=>{if(x.stage==='original_diff'){x.result.pre[PROBE]={nonce:0};x.result.post[PROBE]={nonce:1};}},
  ]){const result=await run(harness({mutate}));assert.equal(result.canonicalStatus,'unverified');noAmounts(result);}
});

test('one invalid post-query remains unavailable without fabricated zero while other isolated measurements survive', async () => {
  for(const mutate of [
    x=>{if(x.stage==='query_0_after_trace')x.result.output='0x';},
    x=>{if(x.stage==='query_0_after_diff')x.result.post[USDC]={storage:{[word(1)]:word(1)}};},
    x=>{if(x.stage==='query_0_after_diff')x.result.post[S].balance=hex(NATIVE-1n);},
  ]){const result=await run(harness({mutate}));assert.equal(result.canonicalStatus,'verified');assert.equal(result.measurements[0].status,'unavailable');noAmounts({measurements:[result.measurements[0]]});assert.ok(result.measurements.slice(1).every(m=>m.status==='measured'));}
});

test('late canonical mismatch or scheduling deadline invalidates every previously measured value', async () => {
  const h=harness({mutate:x=>{if(x.method==='eth_getBlockByNumber')x.result.hash=word(999);}}), result=await run(h);
  assert.equal(result.execution.status,'success');assert.equal(result.canonicalStatus,'unverified');assert.ok(result.measurements.every(m=>m.status==='unavailable'));noAmounts(result);
  let clock=0;const timed=harness({mutate:x=>{if(x.stage==='query_2_after_diff')clock=120000;}});const timeout=await simulateUnsignedCall({...timed,now:()=>clock});
  assert.equal(timeout.canonicalStatus,'unverified');noAmounts(timeout);assert.ok(timeout.measurementFailure.includes('deadline'));
});

test('malformed inputs, too many/duplicate queries and reserved addresses are rejected before RPC', async () => {
  for(const change of [
    h=>{h.chainId=0;}, h=>{h.blockHash=[BLOCK];}, h=>{h.request.from=[S];}, h=>{h.request.to=[TARGET];}, h=>{h.request.data=[CALL.data];}, h=>{h.request.value='1';}, h=>{h.request.gas='0x5208';}, h=>{h.request.gas=5000001;}, h=>{h.request.nonce=7;}, h=>{h.queries=[];}, h=>{h.queries.push(h.queries[0]);}, h=>{h.queries=Array.from({length:9},(_,i)=>({to:address(100+i),data:balanceOf(S)}));}, h=>{h.request.to=PROBE;}, h=>{h.queries[0].to=PROBE;},
  ]){const h=harness();change(h);const result=await run(h);assert.equal(h.records.length,0);assert.equal(result.execution.status,'unavailable');noAmounts(result);}
});

test('provider error objects and oversized parsed responses are unavailable and do not leak arbitrary text', async () => {
  const marker='SYNTHETIC_CREDENTIAL_IN_PROVIDER_RESULT';
  const errorResult=await run(harness({mutate:x=>x.stage==='original_trace'?{error:{code:-32603,message:marker}}:undefined}));
  assert.equal(errorResult.execution.status,'unavailable');assert.equal(JSON.stringify(errorResult).includes(marker),false);noAmounts(errorResult);
  const huge=await run(harness({mutate:x=>x.method==='eth_getCode'&&x.params[0]===TARGET?'0x'+'00'.repeat(4*1024*1024):undefined}));
  assert.equal(huge.canonicalStatus,'unverified');assert.match(huge.measurementFailure,/byte budget/);assert.ok(huge.evidence.at(-1).error);assert.equal(huge.evidence.at(-1).result,undefined);noAmounts(huge);
});


test('real saved zero-sender diff accepts omitted zero nonce only with explicit trusted anchor inputs', () => {
  const observed = JSON.parse(realBytes).records.find(r => r.provider === 'ethereum-drpc' && r.request.id === 20);
  assert.equal(observed.request.method,'debug_traceCall');assert.equal(observed.request.params[2].tracer,'prestateTracer');assert.equal(observed.request.params[2].tracerConfig.diffMode,true);
  const sender=address(0), raw=observed.response.result, snapshot=structuredClone(raw), balance=BigInt(raw.pre[sender].balance);
  assert.deepEqual(raw.pre[sender],{balance:'0x2ff6e919d61a45a7101'});assert.deepEqual(raw.post[sender],{nonce:1});
  // These are explicit validator inputs. This saved capability survey did not
  // independently read sender basic state; no new observation is invented here.
  assert.doesNotThrow(()=>validateQueryDiff(raw,{sender,nonce:0n,balance}));
  for(const anchors of [{sender,nonce:1n,balance},{sender,nonce:0n,balance:balance+1n},{sender,nonce:0n},{sender,balance}])assert.throws(()=>validateQueryDiff(raw,anchors));
  assert.deepEqual(raw,snapshot,'Normalization must leave captured omitted fields intact');
});

test('omitted zero basic fields require exact bigint anchors and still require a present post nonce', () => {
  const raw={pre:{[S]:{}},post:{[S]:{nonce:1}}};
  assert.doesNotThrow(()=>validateQueryDiff(raw,{sender:S,nonce:0n,balance:0n}));
  for(const anchors of [
    {sender:S,nonce:1n,balance:0n},{sender:S,nonce:0n,balance:1n},
    {sender:S,nonce:0,balance:0n},{sender:S,nonce:'0',balance:0n},{sender:S,nonce:undefined,balance:0n},{sender:S,nonce:null,balance:0n},
    {sender:S,nonce:-1n,balance:0n},{sender:S,nonce:(1n<<64n)-1n,balance:0n},
    {sender:S,nonce:0n,balance:0},{sender:S,nonce:0n,balance:'0'},{sender:S,nonce:0n,balance:undefined},{sender:S,nonce:0n,balance:null},
    {sender:S,nonce:0n,balance:-1n},{sender:S,nonce:0n,balance:MAX+1n},{sender:[S],nonce:0n,balance:0n},
  ])assert.throws(()=>validateQueryDiff(raw,anchors));
  for(const change of [
    d=>{delete d.pre[S];},d=>{delete d.post[S].nonce;},d=>{d.post[S].nonce=0;},d=>{d.post[S].nonce=2;},d=>{d.post[S].balance='0x1';},
    d=>{d.pre[S].nonce=null;},d=>{d.pre[S].balance=null;},d=>{d.pre[S].nonce=1;},d=>{d.pre[S].balance='0x1';},
  ]){const changed=structuredClone(raw);change(changed);assert.throws(()=>validateQueryDiff(changed,{sender:S,nonce:0n,balance:0n}));}
  // A nonzero post-state query nonce can never be inferred from an omission.
  assert.throws(()=>validateQueryDiff({pre:{[S]:{}},post:{[S]:{nonce:2}}},{sender:S,nonce:1n,balance:0n}));
});

test('fresh synthetic sender is pinned at nonce zero, then original/query transitions use zero→one and one→two', async () => {
  for(const native of [NATIVE,0n]){
    const h=harness({mutate:x=>{
      if(x.method==='eth_getTransactionCount')return '0x0';
      if(x.method==='eth_getBalance')return hex(native);
      if(x.stage==='original_diff'){x.result.pre[S]=native===0n?{}:{balance:hex(native)};x.result.post[S]={nonce:1};}
      if(/^query_\d+_(before|after)_diff$/.test(x.stage)){
        const after=x.stage.includes('_after_');x.result={pre:{[S]:{...(after?{nonce:1}:{}),...(native===0n?{}:{balance:hex(native)})}},post:{[S]:{nonce:after?2:1}}};return x.result;
      }
    }});
    const result=await run(h);assert.equal(result.execution.status,'success');assert.equal(result.canonicalStatus,'verified');assert.equal(result.accounting.rpcCalls,31);
    assert.deepEqual(result.measurements.map(m=>[m.status,m.beforeRaw,m.afterRaw,m.deltaRaw]),VALUES.map(([a,b])=>['measured',a,b,(BigInt(b)-BigInt(a)).toString()]));
    for(const method of ['eth_getTransactionCount','eth_getBalance']){const basic=h.records.find(r=>r.method===method);assert.deepEqual(basic.params,[S,{blockHash:BLOCK,requireCanonical:true}]);assert.equal(basic.result,method==='eth_getTransactionCount'?'0x0':hex(native));}
    const queryDiffs=h.records.filter(r=>r.method==='debug_traceCall'&&r.params[2].tracer==='prestateTracer'&&r.params[0].to!==TARGET);
    assert.equal(queryDiffs.length,8);for(const r of queryDiffs){const after=Boolean(r.params[2].stateOverrides);assert.deepEqual(r.result.post[S],{nonce:after?2:1});assert.equal(r.result.pre[S].nonce,after?1:undefined);if(after)assert.deepEqual(r.params[2].stateOverrides[S],{nonce:'0x1'});}
    assert.equal(result.stateDiff.pre[S].nonce,undefined,'Normalized result retains the source omission, not fabricated raw state');
  }
});


test('fresh-sender original success does not let a missing nonzero after-query nonce be inferred', async () => {
  const h=harness({mutate:x=>{
    if(x.method==='eth_getTransactionCount')return '0x0';
    if(x.stage==='original_diff'){delete x.result.pre[S].nonce;x.result.post[S].nonce=1;}
    if(/^query_\d+_(before|after)_diff$/.test(x.stage))return {pre:{[S]:{balance:hex(NATIVE)}},post:{[S]:{nonce:x.stage.includes('_after_')?2:1}}};
  }});
  const result=await run(h);assert.equal(result.execution.status,'success');assert.equal(result.canonicalStatus,'verified');assert.ok(result.measurements.every(row=>row.status==='unavailable'));noAmounts(result);
  assert.ok(result.measurements.every(row=>/nonce transition/.test(row.reason)));
});


test('same-hash final state-root, transaction-list or unfamiliar-header changes invalidate all measured values', async () => {
  for(const changedField of [null,'stateRoot','transactions','syntheticUnfamiliarHeaderField']){
    const h=harness({mutate:x=>{
      if(!['eth_getBlockByHash','eth_getBlockByNumber'].includes(x.method))return;
      // Both observations begin with the same explicit metadata; no missing
      // header content is fabricated by the module under test.
      Object.assign(x.result,{stateRoot:word(101),transactions:[word(102)],syntheticUnfamiliarHeaderField:{version:'observed-v1'}});
      if(x.method==='eth_getBlockByNumber'){
        if(changedField==='stateRoot')x.result.stateRoot=word(103);
        if(changedField==='transactions')x.result.transactions=[word(104)];
        if(changedField==='syntheticUnfamiliarHeaderField')x.result.syntheticUnfamiliarHeaderField.version='observed-v2';
      }
    }});
    const result=await run(h);assert.equal(result.execution.status,'success');assert.equal(result.accounting.rpcCalls,31);
    assert.equal(h.records.find(r=>r.method==='eth_getBlockByHash').result.hash,h.records.find(r=>r.method==='eth_getBlockByNumber').result.hash);
    if(changedField===null){assert.equal(result.canonicalStatus,'verified');assert.ok(result.measurements.every(row=>row.status==='measured'));}
    else {assert.equal(result.canonicalStatus,'unverified');assert.match(result.measurementFailure,/Canonical header or block contents changed/);assert.ok(result.measurements.every(row=>row.status==='unavailable'));noAmounts(result);}
  }
});

test('saved USDC proxy rejects mutated descendant gas, missing raw input and explicit empty failure fields', () => {
  for(const change of [
    child=>{child.gas=hex(BigInt(real.request.params[0].gas)+1n);},
    child=>{child.gasUsed=hex(BigInt(child.gas)+1n);},
    child=>{delete child.gas;},child=>{delete child.gasUsed;},child=>{delete child.input;},
    child=>{child.error='';},child=>{child.revertReason='';},child=>{child.error=null;},
  ]){const trace=structuredClone(real.response.result);change(trace.calls[0]);assert.throws(()=>validateQueryTrace(trace,real.request.params[0]));}
  const zeroGas=structuredClone(real.response.result);zeroGas.calls[0].gas='0x0';zeroGas.calls[0].gasUsed='0x0';
  // Explicitly synthetic mutation: the validator permits a complete zero-gas
  // child shape; this is not a claim that the observed implementation ran free.
  assert.deepEqual(validateQueryTrace(zeroGas,real.request.params[0]),{amountRaw:BigInt(zeroGas.output).toString(),gasUsed:BigInt(zeroGas.gasUsed).toString()});
});

test('the original call and header witnesses reuse strict raw-frame guards before any measurement', async () => {
  for(const change of [
    frame=>{frame.gas=hex(BigInt(CALL.gas)+1n);},frame=>{delete frame.gas;},frame=>{delete frame.input;},frame=>{frame.error='';},frame=>{frame.revertReason='';},
  ]){
    const h=harness({mutate:x=>{if(x.stage==='original_trace'){const child=frame({from:TARGET,to:USDC,input:'0x',gas:CALL.gas,gasUsed:'0x1'});change(child);x.result.calls=[child];}}});
    const result=await run(h);assert.equal(result.execution.status,'unavailable');assert.equal(result.canonicalStatus,'unverified');noAmounts(result);
    assert.equal(h.records.some(r=>r.method==='debug_traceCall'&&r.params[2].tracer==='prestateTracer'),false);
  }
  for(const stage of ['header_before','header_after']) for(const change of [
    frame=>{delete frame.input;},frame=>{delete frame.gas;},frame=>{frame.gasUsed=hex(BigInt(frame.gas)+1n);},frame=>{frame.error='';},frame=>{frame.revertReason='';},
  ]){
    const h=harness({mutate:x=>{if(x.stage===stage)change(x.result);}}),result=await run(h);
    assert.equal(result.execution.status,'success');assert.equal(result.canonicalStatus,'unverified');noAmounts(result);
    assert.equal(h.records.some(r=>r.method==='debug_traceCall'&&QUERIES.some(q=>q.to===r.params[0].to&&q.data===r.params[0].data)),false);
  }
});
