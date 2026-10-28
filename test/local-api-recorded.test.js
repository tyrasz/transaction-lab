import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { createAppServer } from '../src/server.js';
import { ProofRpcClient } from '../src/proof-rpc.js';
import { loadLocalApi } from '../src/local-loader.js';

// Composite saved-input development regression, not a new observation or an
// exact original wire replay. Metadata envelopes are constructed around the
// sealed parent header. Proof/code response bytes change only their top-level
// JSON-RPC IDs to account for the two preceding metadata requests. No provider
// trace, diff, expected amount, or poststate is passed to the actual child.
const PACKET = new URL('../reports/ethereum-lending-local-reference/', import.meta.url);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const bytes = name => readFileSync(new URL(name, PACKET));
const manifestBytes = bytes('manifest.json');
assert.equal(sha(manifestBytes), '34b1e325ea08604705e50f06da81e442bb48cea017faf3058671e1e1a4e8f8c5');
const manifest = JSON.parse(manifestBytes);
const entries = new Map(manifest.files.map(row => [row.path, row]));
assert.equal(entries.size, manifest.files.length);
function checked(name, hash) {
  const value = bytes(name), entry = entries.get(name);
  assert.ok(entry, name + ' belongs to the sealed packet');
  assert.equal(value.length, entry.bytes); assert.equal(sha(value), hash ?? entry.sha256);
  assert.equal(sha(value), entry.sha256);
  return JSON.parse(value);
}
const plan = checked('plan.json', 'f9fb0e1b465bcf191185e1790204bf64a324634d98436ebb4a17f4cb6cd83288');
const AAVE = plan.cases[0], MORPHO = plan.cases[1];
const fixtures = new Map([
  [AAVE.id, checked('aave-usdc-supply-with-permit-local.json', '1cbe7eeca94e528b9d5cda932524e65c0cbf6b08fb08c962aca36841dfaa1763')],
  [MORPHO.id, checked('morpho-kiln-usdc-deposit-local.json', '4e85c6c4daa5ebbb0e38536ed8b78ea5ce105adde5c9fc83d663a30de161c940')],
]);
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const ATOKEN = '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c';
const VAULT = '0xbeef01735c132ada46aa9aa4c54623caa92a64cb';
const BLUE = '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb';
const FEES = '0x255c7705e8bb334dfcae438197f7c4297988085a';
const addressWord = value => value.slice(2).padStart(64, '0');
const word = value => '0x' + BigInt(value).toString(16).padStart(64, '0');
const balance = (token, account) => [{ to: token, data: '0x70a08231' + addressWord(account) }, { kind: 'balanceOf', token, account }];
const allowance = (token, owner, spender) => [{ to: token, data: '0xdd62ed3e' + addressWord(owner) + addressWord(spender) }, { kind: 'allowance', token, owner, spender }];
const aaveRows = [
  [...balance(USDC, AAVE.request.from), '3962903485', '0'],
  [...allowance(USDC, AAVE.request.from, AAVE.request.to), '0', '0'],
  [...balance(USDC, ATOKEN), '151987610826648', '151991573730133'],
];
const morphoRows = [
  [...balance(MORPHO.request.to, MORPHO.request.from), '1151370388097', '1481867899909'],
  [...balance(USDC, MORPHO.request.from), '704323976173', '354323976173'],
  [...allowance(USDC, MORPHO.request.from, MORPHO.request.to), '350000000000', '0'],
  [...balance(MORPHO.request.to, MORPHO.request.to), '18022867783', '18078180423'],
  [...balance(USDC, MORPHO.request.to), '20083625', '20083625'],
  [...balance(USDC, BLUE), '128890534855869', '129240534855869'],
  [...balance(USDC, VAULT), '6011', '6011'],
  [...balance(VAULT, FEES), '34363220714011809188525', '34390568084318171872187'],
];
const apiInput = (c, rows) => ({ chainId: 1, from: c.request.from, to: c.request.to, data: c.request.data,
  value: BigInt(c.request.value).toString(), block: c.header.hash, queries: rows.map(row => row[0]) });
const missingQuery = balance(ATOKEN, AAVE.request.from);

function playback(c, { missingProof = false, changedFinalHeader = false } = {}) {
  const saved = fixtures.get(c.id), expected = [
    { method: 'eth_chainId', params: [], result: '0x1', origin: 'constructed_metadata_envelope' },
    { method: 'eth_getBlockByHash', params: [c.header.hash, false], result: c.header, origin: 'sealed_parent_header' },
  ];
  for (const [index, row] of saved.transport.entries()) {
    assert.equal(row.id, index + 1); assert.equal(row.status, 'completed');
    assert.equal(sha(row.requestText), row.requestSha256);
    assert.equal(sha(row.responseText), row.responseSha256);
    assert.deepEqual(JSON.parse(row.requestText), row.request);
    assert.deepEqual(JSON.parse(row.responseText), row.parsed);
    assert.ok(['eth_getProof', 'eth_getCode'].includes(row.request.method));
    assert.deepEqual(row.request.params.at(-1), { blockHash: c.header.hash, requireCanonical: true });
    assert.deepEqual(saved.inputEvidence[index].result, row.parsed.result);
    expected.push({ method: row.request.method, params: row.request.params, source: row, origin: 'saved_proof_code_id_adapted' });
  }
  if (missingProof) expected.push({ method: 'eth_getProof',
    params: [ATOKEN, [word(61)], { blockHash: c.header.hash, requireCanonical: true }],
    error: { code: -32000, message: 'Synthetic missing-proof control; no response exists in saved input facts.' }, origin: 'synthetic_missing_proof' });
  expected.push({ method: 'eth_getBlockByNumber', params: [c.header.number, false],
    result: changedFinalHeader ? { ...c.header, syntheticUnboundHeaderField: true } : c.header, origin: 'sealed_parent_header' });
  let at = 0; const mismatches = [], wires = [], usedSourceIds = [];
  const rpc = new ProofRpcClient({ url: 'https://eth.drpc.org', fetchImpl: async (url, options) => {
    const wanted = expected[at++];
    try {
      assert.ok(wanted, 'No unrecorded dispatch may be hidden by engine error handling');
      assert.equal(String(url), 'https://eth.drpc.org/'); assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
      const request = JSON.parse(options.body);
      assert.deepEqual(request, { jsonrpc: '2.0', id: at, method: wanted.method, params: wanted.params });
      let responseText;
      if (wanted.source) {
        const prefix = `{"id":${wanted.source.id},`;
        assert.ok(wanted.source.responseText.startsWith(prefix));
        responseText = `{"id":${at},` + wanted.source.responseText.slice(prefix.length);
        assert.deepEqual(JSON.parse(responseText), { ...wanted.source.parsed, id: at });
        usedSourceIds.push(wanted.source.id);
      } else responseText = JSON.stringify({ jsonrpc: '2.0', id: at, ...(wanted.error ? { error: wanted.error } : { result: wanted.result }) });
      wires.push({ requestText: options.body, responseText, origin: wanted.origin, error: wanted.error });
      return new Response(responseText, { status: 200, headers: { 'content-type': 'application/json' } });
    } catch (error) { mismatches.push({ index: at, message: error.message }); throw error; }
  } });
  return { rpc, saved, wires, assertComplete() {
    assert.deepEqual(mismatches, [], 'Transport assertion failures must survive engine catches');
    assert.equal(at, expected.length); assert.equal(wires.length, expected.length);
    assert.deepEqual(usedSourceIds, saved.transport.map(row => row.id), 'Every proof/code source is consumed once in exact original order');
  } };
}

// Invoke the real HTTP handler without a listening socket. This verifies route
// serialization and persistence; it does not claim network HTTP transport QA.
async function invoke(t, input, rpc) {
  const api = await loadLocalApi(); assert.ok(api, 'Optional owned-executor dependencies are installed');
  const reportDir = await mkdtemp(path.join(os.tmpdir(), 'local-api-recorded-'));
  t.after(() => rm(reportDir, { recursive: true, force: true }));
  let factories = 0, responseBody, status;
  const server = createAppServer({ persist: true, reportDir, localLoader: async () => api,
    proofRpcFactory() { factories++; return rpc; },
    standardRpcFactory() { throw Error('Provider execution is not allowed'); }, rpcFactory() { throw Error('Legacy execution is not allowed'); } });
  const req = Readable.from([Buffer.from(JSON.stringify(input))]);
  Object.assign(req, { method: 'POST', url: '/api/evm/local-preview', headers: { host: '127.0.0.1', 'content-type': 'application/json' }, aborted: false });
  const res = new EventEmitter();
  Object.assign(res, { statusCode: 200, writableEnded: false, destroyed: false,
    writeHead(code) { this.statusCode = code; return this; },
    end(body) { status = this.statusCode; responseBody = String(body); this.writableEnded = true; return this; },
  });
  try { await server.listeners('request')[0](req, res); }
  finally { req.destroy(); server.close(); }
  assert.equal(factories, 1); assert.equal(status, 200); assert.equal(typeof responseBody, 'string');
  const report = JSON.parse(responseBody);
  assert.deepEqual(report.apiRequest, input, 'The returned request must preserve the exact submitted canonical inputs');
  assert.deepEqual(report.implementation, api.implementation);
  assert.deepEqual(JSON.parse(await readFile(path.join(reportDir, 'simulations', report.id + '.json'), 'utf8')), report,
    'Saved JSON retains complete raw API output, not just projected amounts');
  return report;
}

function assertTransport(report, f) {
  f.assertComplete(); assert.equal(report.transportEvidence.length, f.wires.length);
  for (const [index, row] of report.transportEvidence.entries()) {
    const wire = f.wires[index];
    assert.equal(row.id, index + 1); assert.equal(row.requestText, wire.requestText);
    assert.equal(row.requestSha256, sha(wire.requestText));
    assert.equal(row.transport.complete, true);
    assert.equal(row.transport.observedBytes, Buffer.byteLength(wire.responseText));
    assert.equal(row.transport.responseSha256, sha(wire.responseText));
    if (!wire.error) { assert.equal(row.responseText, wire.responseText); assert.equal(row.error, undefined); }
    else { assert.equal(row.responseText, undefined); assert.equal(row.error.code, 'RPC_EXECUTION_ERROR'); }
  }
  assert.equal(report.drain.complete, true);
}
function assertOriginal(report, c, saved) {
  assert.equal(report.kind, 'local_proof_preview');
  assert.equal(report.source.canonicalStatus, 'verified'); assert.equal(report.source.originalTransactionReplay, false);
  assert.equal(report.source.consensusVerified, false); assert.deepEqual(report.source.blockSelection.header, c.header);
  assert.equal(report.execution.status, 'success'); assert.equal(report.attempt.status, 'completed');
  assert.equal(report.attempt.isolation.processSeparated, true); assert.notEqual(report.attempt.isolation.childPid, process.pid);
  assert.equal(report.attempt.isolation.processClosed, true); assert.equal(report.attempt.broker.pendingAtReturn, 0);
  const original = report.attempt.preview.original, normalized = structuredClone(original.output);
  assert.deepEqual(report.execution, original.output.execution);
  // The generated remaining deadline varies with preparation. 0.17 also
  // replaces the old blanket lifecycle policy with observed-operation metadata.
  assert.ok(Number.isSafeInteger(normalized.limits.wallMs) && normalized.limits.wallMs > 0 && normalized.limits.wallMs <= 120000);
  normalized.limits.wallMs = saved.output.limits.wallMs;
  assert.equal(normalized.semantics.lifecycle, 'no_lifecycle_operation_encountered');
  assert.equal(saved.output.semantics.lifecycle, 'CREATE_CREATE2_SELFDESTRUCT_unsupported');
  normalized.semantics.lifecycle = saved.output.semantics.lifecycle;
  assert.deepEqual(normalized, saved.output); assert.deepEqual(original.changes, saved.changes);
  assert.deepEqual(original.inputs, saved.inputs); assert.deepEqual(original.stateReads, saved.stateReads);
  const omitDuration = rows => rows.map(({ durationMs, ...row }) => row);
  assert.deepEqual(omitDuration(original.inputEvidence), omitDuration(saved.inputEvidence));
  assert.deepEqual(report.attempt.headerVerification, saved.headerVerification);
  assert.equal(report.attempt.preview.scope.feesSettled, false);
  assert.equal(report.attempt.preview.scope.allEffectsCoverage, 'not_established');
}
function assertRows(report, c, rows) {
  assert.equal(report.measurements.length, rows.length);
  for (const [index, [query, identity, before, after]] of rows.entries()) {
    const row = report.measurements[index], raw = report.attempt.preview.measurements[index];
    assert.equal(row.index, index); assert.equal(row.status, 'measured'); assert.deepEqual(row.query, query);
    assert.deepEqual(row.identity, { ...identity, chainId: '1', contractIdentityVerified: false });
    assert.deepEqual(row.values, [{ name: identity.kind === 'allowance' ? 'allowance' : 'balance', beforeRaw: before,
      afterRaw: after, deltaRaw: (BigInt(after) - BigInt(before)).toString(), unit: { kind: 'token_raw_units', scale: null } }]);
    assert.deepEqual(row.values, raw.values);
    for (const [phase, value] of [[raw.before, before], [raw.after, after]]) {
      assert.equal(phase.output.execution.returnData, word(value)); assert.equal(phase.output.trace.from, c.request.from);
      assert.equal(phase.output.trace.to, query.to); assert.equal(phase.output.trace.input, query.data);
      assert.equal(phase.output.profile.declaredGasLimit, '1000000'); assert.deepEqual(phase.output.logs, []);
      assert.equal(phase.mutationValidation.status, 'verified'); assert.deepEqual(phase.inputEvidenceIds, []);
    }
    assert.deepEqual(raw.after.changesBefore, fixtures.get(c.id).changes);
  }
}

test('saved local API fixtures bind the original parent headers and runtime source bytes', () => {
  for (const c of plan.cases) {
    const source = checked(c.parentInput); assert.deepEqual(source.response.result, c.header);
    assert.deepEqual(source.request.body.params, [c.header.hash, false]);
  }
  const sources = plan.sourceFiles.filter(row => row.path.startsWith('engines/local-evm/') && !row.path.includes('/node_modules/'));
  assert.equal(sources.length, 9);
  for (const row of sources) {
    const source = bytes('runtime/' + row.path), entry = entries.get('runtime/' + row.path);
    assert.equal(source.length, row.bytes); assert.equal(sha(source), row.sha256); assert.equal(entry.sha256, row.sha256);
  }
});

for (const [c, rows, reads] of [[AAVE, aaveRows, 58], [MORPHO, morphoRows, 230]]) {
  test(`owned API executes ${c.id} in a real child using ${reads} exact saved proof/code inputs`, async t => {
    const f = playback(c), report = await invoke(t, apiInput(c, rows), f.rpc);
    assertTransport(report, f); assert.equal(report.status, 'complete'); assert.equal(report.error, null);
    assertOriginal(report, c, f.saved); assertRows(report, c, rows);
    assert.equal(report.attempt.broker.calls, reads); assert.equal(report.transportEvidence.length, reads + 3);
    if (c === MORPHO) {
      assert.equal(report.measurements[7].identity.account, FEES); assert.notEqual(FEES, c.request.from);
      assert.equal(report.measurements[3].identity.account, c.request.to);
    }
  });
}

test('owned API retains partial original and earlier values when one absent fixture proof poisons later queries', async t => {
  const rows = [aaveRows[0], missingQuery, aaveRows[1]], f = playback(AAVE, { missingProof: true });
  const report = await invoke(t, apiInput(AAVE, rows), f.rpc);
  assertTransport(report, f); assertOriginal(report, AAVE, f.saved); assert.equal(report.status, 'partial');
  assert.deepEqual(report.measurements.map(row => row.status), ['measured', 'unavailable', 'not_attempted']);
  assert.deepEqual(report.measurements[0].values, [{ name: 'balance', beforeRaw: '3962903485', afterRaw: '0', deltaRaw: '-3962903485', unit: { kind: 'token_raw_units', scale: null } }]);
  for (const index of [1, 2]) {
    assert.equal(report.measurements[index].values, null); assert.equal(report.attempt.preview.measurements[index].values, null);
    assert.deepEqual(report.measurements[index].query, rows[index][0]);
  }
  assert.equal(report.attempt.broker.calls, 59); assert.equal(report.attempt.preview.inputUsage.status, 'unavailable');
});

test('a final complete-header mismatch withholds every nested measurement despite successful local execution', async t => {
  const f = playback(AAVE, { changedFinalHeader: true }), report = await invoke(t, apiInput(AAVE, aaveRows), f.rpc);
  assertTransport(report, f); assert.equal(report.status, 'unavailable'); assert.equal(report.error.code, 'LOCAL_PREVIEW_CANONICAL');
  assert.equal(report.source.canonicalStatus, 'unverified'); assert.equal(report.execution.status, 'unavailable');
  assert.deepEqual(report.measurements, []); assert.equal(report.attempt.preview, null); assert.equal(report.attempt.status, 'unavailable');
  assert.equal(report.audit.status, 'unverified_not_a_measurement'); assert.equal(report.audit.original.output.execution.status, 'success');
  assert.deepEqual(report.audit.original.changes, f.saved.changes);
});
