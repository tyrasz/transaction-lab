import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createAppServer } from '../src/server.js';
import { loadLocalApi } from '../src/local-loader.js';
import { ProofRpcClient } from '../src/proof-rpc.js';
import { LOCAL_SEQUENCE_CAPABILITIES, validateLocalSequence } from '../src/local-sequence.js';
import { sequenceFixture } from '../engines/local-evm/test/sequence-fixture.js';

const callFields = ({ from, ...call }) => call;
const inputFor = f => ({ chainId: f.chainId, from: f.addresses.sender, block: f.header.hash,
  calls: [f.requests.approve, f.requests.deposit].map(callFields), queries: f.queries.slice(0, 4) });

// Real handler, adapter, proof transport and isolated child. Fetch serves only
// synthetic initial-state proofs/code, never reference execution or poststate.
function transport(f, { changedFinal = false } = {}) {
  const wires = [], errors = []; let confirmations = 0;
  const rpc = new ProofRpcClient({ chainId: f.chainId, url: 'https://fixture.invalid', fetchImpl: async (_url, options) => {
    try {
      const request = JSON.parse(options.body); wires.push(request);
      assert.equal(request.id, wires.length); assert.equal(request.jsonrpc, '2.0');
      let result;
      if (request.method === 'eth_chainId') { assert.equal(wires.length, 1); result = '0x' + f.chainId.toString(16); }
      else if (request.method === 'eth_getBlockByHash') {
        assert.equal(wires.length, 2); assert.deepEqual(request.params, [f.header.hash, false]); result = f.header;
      } else if (request.method === 'eth_getBlockByNumber') {
        confirmations++; assert.equal(confirmations, 1); assert.deepEqual(request.params, [f.header.number, false]);
        result = changedFinal ? { ...f.header, unboundChangedMetadata: true } : f.header;
      } else {
        assert(['eth_getProof', 'eth_getCode'].includes(request.method));
        assert.deepEqual(request.params.at(-1), { blockHash: f.header.hash, requireCanonical: true });
        result = await f.rpc.call(request.method, request.params);
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), { headers: { 'content-type': 'application/json' } });
    } catch (error) { errors.push(error.message); throw error; }
  } });
  return { rpc, check(report) {
    assert.deepEqual(errors, []); assert.equal(confirmations, 1);
    assert.equal(report.transportEvidence.length, wires.length);
    report.transportEvidence.forEach((row, i) => assert.deepEqual(JSON.parse(row.requestText), wires[i]));
    assert.equal(report.drain.complete, true);
  } };
}

async function dispatch(server, value, { path = '/api/evm/local-sequence', method = 'POST', origin, body } = {}) {
  const req = Readable.from(method === 'GET' ? [] : [Buffer.from(body ?? JSON.stringify(value))]);
  Object.assign(req, { method, url: path, headers: { host: '127.0.0.1', 'content-type': 'application/json', ...(origin ? { origin } : {}) }, aborted: false });
  let status, result;
  const res = new EventEmitter(); Object.assign(res, { writableEnded: false, destroyed: false,
    writeHead(code) { status = code; return this; },
    end(bytes) { result = JSON.parse(String(bytes)); this.writableEnded = true; return this; } });
  try { await server.listeners('request')[0](req, res); } finally { req.destroy(); }
  return { status, result };
}

for (const fork of ['osaka', 'amsterdam']) test(`HTTP ${fork} sequence returns measured per-step state and bound implementation`, async () => {
  const f = await sequenceFixture({ fork, priced: true }), wire = transport(f), api = await loadLocalApi();
  assert(api); let factories = 0;
  const server = createAppServer({ persist: false, standardLoader: async () => null, arbitrumLoader: async () => null,
    localLoader: async () => api, proofRpcFactory({ chainId }) { factories++; assert.equal(chainId, f.chainId); return wire.rpc; } });
  try {
    const response = await dispatch(server, inputFor(f)); assert.equal(response.status, 200);
    const report = response.result; wire.check(report); assert.equal(factories, 1);
    assert.equal(report.kind, 'local_proof_sequence'); assert.equal(report.status, 'complete', JSON.stringify(report.error));
    assert.deepEqual(report.steps.map(step => step.execution.status), ['success', 'success']);
    assert.deepEqual(report.steps[0].measurements[1].values.map(value => [value.beforeRaw, value.afterRaw]), [['0', '100']]);
    assert.deepEqual(report.steps[1].measurements[0].values.map(value => [value.beforeRaw, value.afterRaw]), [['1000', '900']]);
    assert.deepEqual(report.steps[1].measurements[3].values.map(value => [value.beforeRaw, value.afterRaw]), [['0', '100']]);
    assert.equal(report.source.canonicalStatus, 'verified'); assert.deepEqual(report.implementation, api.implementation);
    for (const name of ['src/local-sequence.js', 'engines/local-evm/ethereum-sequence.js', 'engines/local-evm/execution-state.js']) assert(report.implementation.sourceFiles.includes(name));
    assert.equal(report.attempt.isolation.processClosed, true); assert.equal(report.attempt.broker.pendingAtReturn, 0);
  } finally { server.close(); }
});

test('sequence admission and origin rejection happen before proof transport construction', async () => {
  const f = await sequenceFixture(); let factories = 0, executions = 0;
  const api = { validateLocalSequence, LOCAL_SEQUENCE_CAPABILITIES,
    simulateLocalSequence() { executions++; assert.fail('Invalid input executed'); } };
  const server = createAppServer({ persist: false, localLoader: async () => api,
    proofRpcFactory() { factories++; assert.fail('Invalid input constructed transport'); } });
  try {
    const input = inputFor(f);
    for (const bad of [{ ...input, chainId: 999 }, { ...input, queries: [] }, { ...input, calls: input.calls.slice(0, 1) },
      { ...input, calls: [{ ...input.calls[0], from: f.addresses.sender }, input.calls[1]] },
      { ...input, calls: [{ ...input.calls[0], stateOverrides: {} }, input.calls[1]] }]) assert.equal((await dispatch(server, bad)).status, 400);
    assert.equal((await dispatch(server, input, { origin: 'https://other.invalid' })).status, 403);
    const huge = await dispatch(server, input, { body: JSON.stringify({ padding: 'x'.repeat(768 * 1024) }) });
    assert.equal(huge.status, 400); assert.equal(huge.result.error.code, 'REQUEST_TOO_LARGE');
    assert.equal(factories, 0); assert.equal(executions, 0);
  } finally { server.close(); }
});

test('missing local engine disables sequence route and capability without constructing transport', async () => {
  const f = await sequenceFixture();
  const server = createAppServer({ persist: false, standardLoader: async () => null, arbitrumLoader: async () => null,
    localLoader: async () => null, proofRpcFactory() { assert.fail('Disabled engine constructed transport'); } });
  try {
    const response = await dispatch(server, inputFor(f)); assert.equal(response.status, 503); assert.equal(response.result.error.code, 'LOCAL_EVM_UNAVAILABLE');
    const config = await dispatch(server, null, { path: '/api/config', method: 'GET' });
    assert.equal(config.result.localEvm.available, false); assert.equal(config.result.localEvm.sequenceCapabilities, null);
  } finally { server.close(); }
});

test('final header disagreement strips every actionable sequence amount at the HTTP boundary', async () => {
  const f = await sequenceFixture(), wire = transport(f, { changedFinal: true }), api = await loadLocalApi();
  const server = createAppServer({ persist: false, localLoader: async () => api, proofRpcFactory: () => wire.rpc });
  try {
    const { status, result } = await dispatch(server, inputFor(f)); assert.equal(status, 200); wire.check(result);
    assert.equal(result.status, 'unavailable'); assert.equal(result.error.code, 'LOCAL_PREVIEW_CANONICAL');
    assert.equal(result.attempt.sequence, null); assert.equal(result.audit.status, 'unverified_not_a_measurement');
    assert(result.steps.every(step => step.execution.status === 'unavailable' && step.measurements.length === 0));
    assert(!JSON.stringify(result.audit).includes('beforeRaw'));
  } finally { server.close(); }
});
