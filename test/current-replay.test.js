import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { simulate } from '../src/server.js';
import { RpcClient } from '../src/rpc.js';
import { InputError } from '../src/validate.js';
import { VERSION } from '../src/config.js';

const sha = value => createHash('sha256').update(value).digest('hex');
async function pinnedJson(path, expected) {
  const bytes = await readFile(new URL('../' + path, import.meta.url));
  assert.equal(sha(bytes), expected, 'Immutable recorded evidence hash');
  return JSON.parse(bytes);
}
const capture = await pinnedJson('reports/current-validated-decimal/capture.json', 'bcb186b6a3a44d94be91ad74aa9b61b83a116ea06d0ada6834d2b19da028770b');
const failedInputCapture = await pinnedJson('reports/current-validated-comparisons/capture.json', '391522d206dfa8add52c3b8a275729fd286e94a35c3b12cb863010a2e9fe8884');
const capability = await pinnedJson('reports/current-query-capability/capture.json', '3c11faec39109a330d91428d9ad359ee1601fc3820f5ae17b9971c61e7ddfae2');
const CORE_SHA = '2205334781a09baf98c3f5cb05a546bcca7d4946aea33b510d1963c8eb561a0f';
const sourceFiles = ['account-effects.js','affected-balances.js','allowances.js','analyze.js','balances.js','config.js','current-state.js','historical-state.js','lending.js','lending-balances.js','permissions.js','query-validation.js','revert.js','rpc.js','server.js','state-diff.js','state.js','validate.js'];
const currentSourceFiles = sourceFiles.flatMap(name => name === 'analyze.js' ? [name, 'arbitrum-loader.js'] : name === 'server.js' ? [name, 'standard-loader.js', 'standard-rpc.js'] : name === 'lending-balances.js' ? [name, 'local-loader.js', 'local-sequence.js', 'local-simulation.js'] : name === 'permissions.js' ? [name, 'proof-rpc.js'] : [name]);
const engineHash = createHash('sha256');
for (const name of currentSourceFiles) engineHash.update(name + '\0').update(await readFile(new URL('../src/' + name, import.meta.url))).update('\0');
const actualSourceHash = engineHash.digest('hex');
const baselineHash = createHash('sha256');
for (const name of sourceFiles) baselineHash.update(name + '\0').update(await readFile(new URL('../reports/coverage-evaluation-v2-baseline-source/repository/src/' + name, import.meta.url))).update('\0');
assert.equal(baselineHash.digest('hex'), CORE_SHA, 'The original 0.8 source remains byte-identical in its archive');
const endpoints = { drpc: 'https://hyperliquid.drpc.org', 'hyperlend-archive': 'https://rpc.hyperlend.finance/archive' };
const USDC = '0xb88339cb7199b77e23db6e890353e22632ba630f', HUSDC = '0x744e4f26ee30213989216e1632d9be3547c4885b', DEBT = '0xd612513cb3b2c52abcd6d4b338374c09ada4657d';
const SENDER = '0x9a1dbc6a6e7e59f6beb23db0d00b603fc90e94d0', POOL = '0x00a89d7a5a02160f20150ebea7a2b5e4879a1a8b';
// Frozen quantities independently observed in the earlier capability packet,
// not derived from the current API response or the implementation under test.
const priorAmounts = {
  supply: [
    ['usdc', USDC, '344156193', '329090078'],
    ['husdc', HUSDC, '3179075937', '3194142051'],
    ['usdc-allowance', USDC, '115792089237316195423570985008687907853269984665640564039457584003202135963444', '115792089237316195423570985008687907853269984665640564039457584003202120897329'],
  ],
  borrow: [
    ['usdc', USDC, '569439069', '1404913479'],
    ['husdc', HUSDC, '5677678780', '5677678780'],
    ['debt', DEBT, '2', '835474412'],
  ],
};
function withoutGenerated({ id, createdAt, timing, implementation, ...semantic }) { return semantic; }
function assertImplementation(report, recorded = false) {
  assert.deepEqual(report.implementation, recorded
    ? { name: 'Transaction Lab', version: '0.8.0', sourceSha256: CORE_SHA, sourceFiles }
    : { name: 'Transaction Lab', version: VERSION, sourceSha256: actualSourceHash, sourceFiles: currentSourceFiles });
}
function sharedEvidence(run) {
  const snapshots = ['balanceMeasurement', 'allowanceMeasurement', 'affectedBalanceMeasurement'].map(key => run.response.evidence[key]).filter(item => item.request.length);
  for (const item of snapshots.slice(1)) assert.deepEqual(item, snapshots[0]);
  return snapshots[0] ?? { request: [], response: [] };
}

// Actual RpcClient parses every original response byte string. The injected
// transport never opens a connection and provides no generated RPC response.
// Resolve in recorded context-completion order, which differs from request
// order for both supply runs, preserving the full shared-evidence interleaving.
function recordedTransport(run) {
  const records = run.rpcCalls, context = sharedEvidence(run);
  const offset = records.length - context.request.length;
  assert.equal(offset, 3, 'Chain, block selection and original trace precede the shared lazy context');
  const completion = [...Array(offset).keys(), ...context.response.map(entry => offset + entry.id - 1)];
  assert.deepEqual([...completion].sort((a,b) => a-b), records.map((_, i) => i));
  for (let i = 0; i < context.request.length; i++) {
    const recorded = records[offset + i], query = context.request[i];
    assert.deepEqual({ method: query.method, params: query.params }, { method: recorded.request.method, params: recorded.request.params });
    assert.deepEqual(context.response.find(entry => entry.id === query.id).result, recorded.response.result);
  }
  let nextRequest = 0, nextCompletion = 0, scheduled = false;
  const pending = new Map(), completed = [], assertions = [];
  function pump() {
    if (scheduled) return;
    scheduled = true;
    setImmediate(() => {
      scheduled = false;
      const index = completion[nextCompletion], entry = pending.get(index);
      if (!entry) return;
      pending.delete(index); nextCompletion++; completed.push(index);
      entry.resolve(new Response(records[index].responseText, { status: records[index].httpStatus, headers: records[index].responseHeaders }));
      pump();
    });
  }
  const rpc = new RpcClient({ url: endpoints[run.provider], fetchImpl: async (url, options) => {
    const index = nextRequest++, record = records[index];
    try {
      assert.ok(record, 'No extra calls, retries, or replacement responses are allowed');
      assert.equal(String(url), new URL(endpoints[run.provider]).href);
      assert.equal(options.method, 'POST');
      assert.equal(options.body, record.requestText, 'Exact JSON-RPC envelope and serialized request bytes');
      assert.deepEqual(JSON.parse(options.body), record.request);
    } catch (error) { assertions.push(error); throw error; }
    return new Promise(resolve => { pending.set(index, { resolve }); pump(); });
  } });
  return { rpc, finish() {
    assert.deepEqual(assertions, []);
    assert.equal(nextRequest, records.length); assert.equal(nextCompletion, records.length);
    assert.equal(pending.size, 0); assert.deepEqual(completed, completion);
  } };
}

function assertPriorAmounts(report, run, operation) {
  const records = capability.records.filter(record => record.provider === (run.provider === 'drpc' ? 'A' : 'B') && record.caseId === operation);
  assert.deepEqual(records.find(record => record.label === 'original-trace').request.params, report.evidence.traceRequest.params, 'Same unsigned envelope and canonical hash as the prior independent capture');
  for (const [id, token, before, after] of priorAmounts[operation]) {
    for (const [stage, value] of [['before', before], ['after', after]]) {
      const raw = records.find(record => record.label === `${id}-${stage}-trace`);
      assert.equal(sha(raw.responseRaw), raw.responseSha256);
      assert.equal(BigInt(raw.response.result.output).toString(), value);
    }
    const observed = id.includes('allowance')
      ? report.allowanceChanges.allowances.find(item => item.asset.address === token && item.owner === SENDER && item.spender === POOL)
      : report.balanceChanges.assets.find(item => item.asset.address === token && item.account === SENDER);
    assert.ok(observed);
    assert.deepEqual([observed.beforeRaw, observed.afterRaw, observed.deltaRaw], [before, after, (BigInt(after) - BigInt(before)).toString()]);
  }
}

test('eight current API outcomes preserve frozen source, complete raw HTTP/RPC bytes and all196 calls', () => {
  assert.equal(capture.status, 'complete'); assert.deepEqual(capture.skipped, []);
  assert.deepEqual(capture.summary, { planned: 8, attempted: 8, http200: 8, failedHttp: 0, rpcCalls: 196, rpcResponseBytes: 305383, httpResponseBytes: 1019762, responseBytes: 1325145 });
  assert.deepEqual(capture.implementation, { version: '0.8.0', sourceSha256: CORE_SHA, sourceFiles });
  let count = 0;
  for (const item of capture.cases) for (const run of item.runs) {
    assert.equal(run.http.response.status, 200); assert.equal(run.request.value, '0');
    assert.deepEqual(JSON.parse(run.http.request.bodyText), run.request);
    assert.deepEqual(run.http.request.body, run.request);
    assert.equal(sha(run.http.response.bodyText), run.http.response.bodySha256);
    assert.equal(Buffer.byteLength(run.http.response.bodyText), run.http.response.responseBytes);
    assert.deepEqual(JSON.parse(run.http.response.bodyText), run.response); assertImplementation(run.response, true);
    for (const raw of run.rpcCalls) {
      count++; assert.deepEqual(JSON.parse(raw.requestText), raw.request);
      assert.equal(raw.httpStatus, 200); assert.equal(raw.bodyComplete, true); assert.equal(raw.error, undefined);
      assert.equal(sha(raw.responseText), raw.responseSha256); assert.equal(Buffer.byteLength(raw.responseText), raw.responseBytes);
      assert.deepEqual(JSON.parse(raw.responseText), raw.response); assert.equal(raw.request.id, raw.response.id);
    }
  }
  assert.equal(count, 196);
});

for (const item of capture.cases) for (const run of item.runs) test(`genuine full current transport replay: ${item.id} on ${run.provider}`, { timeout: 5000 }, async () => {
  const transport = recordedTransport(run), report = await simulate(run.request, transport.rpc);
  transport.finish(); assertImplementation(report);
  assert.deepEqual(withoutGenerated(report), withoutGenerated(run.response), 'Every semantic field, original trace, complete shared request/response and proof marker is preserved');
  assert.equal(report.source.mode, 'simulation'); assert.equal(report.security.status, 'not_assessed');
  if (item.id === 'current-supply') {
    assertPriorAmounts(report, run, 'supply');
    assert.deepEqual([report.balanceChanges.status, report.allowanceChanges.status, report.affectedBalanceChanges.status], ['measured', 'measured', 'measured']);
    assert.equal(report.balanceChanges.assets[1].deltaRaw, '15066114');
    assert.notEqual(report.balanceChanges.assets[1].deltaRaw, '15066115', 'Actual receipt balance rounding is preserved');
    assert.deepEqual(report.affectedBalanceChanges.assets.map(asset => [asset.asset.address, asset.account, asset.beforeRaw, asset.afterRaw, asset.deltaRaw]), [[USDC, HUSDC, '4384331852804', '4384346918919', '15066115']]);
    assert.equal(report.affectedBalanceChanges.reusedPairs.length, 2);
    assert.equal(report.accountEffects.summary.measuredBalancePairs, 3);
  } else if (item.id === 'current-borrow') {
    assertPriorAmounts(report, run, 'borrow');
    assert.deepEqual([report.balanceChanges.status, report.allowanceChanges.status, report.affectedBalanceChanges.status], ['measured', 'not_applicable', 'measured']);
    const debt = report.balanceChanges.assets.find(asset => asset.asset.address === DEBT && asset.account === SENDER);
    assert.equal(debt.asset.role, 'liability');
    assert.ok([...report.inAssets, ...report.outAssets].every(asset => asset.asset?.address !== DEBT && asset.address !== DEBT));
    assert.deepEqual(report.affectedBalanceChanges.assets, []); assert.equal(report.affectedBalanceChanges.reusedPairs.length, 3);
    assert.equal(report.accountEffects.summary.measuredBalancePairs, 6);
    assert.deepEqual(report.evidence.allowanceMeasurement, { request: [], response: [] });
  } else if (item.id === 'current-direct-transferfrom-a') {
    const owner = '0xfc1bdd1ff58200761d56ccbce73f6f42ebe56379', spender = report.request.from;
    assert.deepEqual([report.balanceChanges.status, report.allowanceChanges.status, report.affectedBalanceChanges.status], ['not_applicable', 'measured', 'measured']);
    assert.notEqual(owner, spender);
    assert.deepEqual(report.affectedBalanceChanges.assets.map(asset => [asset.account, asset.beforeRaw, asset.afterRaw, asset.deltaRaw]), [[owner, '1541542', '264475', '-1277067'], [spender, '4647557042700', '4647558319767', '1277067']]);
    const permission = report.permissions.observations[0];
    assert.deepEqual([permission.owner, permission.spender, permission.submitter, permission.recipient], [owner, spender, spender, spender]);
    assert.equal(report.allowanceChanges.allowances[0].deltaRaw, '-1277067');
    assert.equal(report.accountEffects.summary.measuredBalancePairs, 2);
  } else {
    assert.equal(item.id, 'current-usdc-router-permit-consumed');
    assert.equal(report.execution.status, 'reverted'); assert.equal(report.execution.returnData, '0x062879da');
    assert.equal(report.execution.revert.kind, 'custom_error');
    assert.match(report.execution.revert.message, /no verified ABI/);
    const router = report.evidence.traceResponse, permit = router.calls[0].calls[0];
    assert.equal(permit.to, USDC); assert.equal(permit.input.slice(0, 10), '0xd505accf'); assert.equal(permit.error, undefined);
    const failedRead = router.calls[0].calls[7].calls[1].calls[6].calls[0];
    assert.equal(failedRead.type, 'STATICCALL'); assert.equal(failedRead.to, '0x0000000000000000000000000000000000000801');
    assert.equal(failedRead.error, 'out of gas'); assert.equal(failedRead.gas, failedRead.gasUsed);
    for (const key of ['balanceChanges', 'allowanceChanges', 'affectedBalanceChanges']) assert.equal(report[key].status, 'not_applicable');
    for (const key of ['balanceMeasurement', 'allowanceMeasurement', 'affectedBalanceMeasurement']) assert.deepEqual(report.evidence[key], { request: [], response: [] });
    assert.deepEqual(report.inAssets, []); assert.deepEqual(report.outAssets, []); assert.deepEqual(report.permissions.observations, []);
    assert.equal(run.rpcCalls.length, 3, 'Failed execution never prepares a state measurement context');
  }
});

test('the original eight hexadecimal-value HTTP400 failures remain intact and still reject before any RPC', async () => {
  assert.equal(failedInputCapture.status, 'complete'); assert.deepEqual(failedInputCapture.skipped, []);
  assert.deepEqual(failedInputCapture.summary, { planned: 8, attempted: 8, http200: 0, failedHttp: 8, rpcCalls: 0, rpcResponseBytes: 0, httpResponseBytes: 856, responseBytes: 856 });
  let attempts = 0, rpcCalls = 0;
  const forbiddenRpc = { async verifyChain() { rpcCalls++; assert.fail('Input must be rejected before chain verification'); }, async call() { rpcCalls++; assert.fail('No RPC is allowed for rejected input'); } };
  for (const item of failedInputCapture.cases) for (const run of item.runs) {
    attempts++; assert.equal(run.http.response.status, 400); assert.deepEqual(run.rpcCalls, []); assert.equal(run.request.value, '0x0');
    assert.equal(sha(run.http.response.bodyText), run.http.response.bodySha256);
    assert.deepEqual(JSON.parse(run.http.response.bodyText), run.http.response.body);
    assert.deepEqual(JSON.parse(run.http.request.bodyText), run.request);
    await assert.rejects(simulate(run.request, forbiddenRpc), error => {
      assert.ok(error instanceof InputError);
      assert.deepEqual({ error: { code: error.code, message: error.message } }, run.http.response.body);
      return true;
    });
    const corrected = capture.cases.find(candidate => candidate.id === item.id).runs.find(candidate => candidate.provider === run.provider);
    assert.deepEqual(corrected.request, { ...run.request, value: '0' }, 'Corrected packet changes only the API value representation');
  }
  assert.equal(attempts, 8); assert.equal(rpcCalls, 0);
});
