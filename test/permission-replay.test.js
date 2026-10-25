import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { replay } from '../src/server.js';
import { RpcError } from '../src/rpc.js';

// Complete observed public HTTP/RPC captures. This adapter serves only the saved
// RPC sequence: no provider connection, alternate block, or extra call is allowed.
const bytes = await readFile(new URL('../reports/permission-comparisons/2026-10-25T15-26-52-549Z-http.json', import.meta.url));
const FILE_SHA256 = 'e305f6b98a5c3ef3deee207d5b463c2f1ad8bb0cbc30577d9336084805a7f824';
const CAPTURED_ENGINE_SHA256 = '02f8ab5584ff7ca5fabd18a2a9a969280211b54b4b14382e2091ef353738cc9f';
assert.equal(createHash('sha256').update(bytes).digest('hex'), FILE_SHA256);
const capture = JSON.parse(bytes);
// Independently hash the current source bytes using the documented fingerprint
// encoding. Source hardening can change this metadata without changing any
// original chain observation or the captured implementation's provenance.
const sourceFiles = capture.cases[0].runs[0].response.implementation.sourceFiles;
const currentSourceHash = createHash('sha256');
for (const name of sourceFiles) {
  assert.match(name, /^[a-z-]+\.js$/);
  currentSourceHash.update(name + '\0');
  currentSourceHash.update(await readFile(new URL('../src/' + name, import.meta.url)));
  currentSourceHash.update('\0');
}
const CURRENT_ENGINE_SHA256 = currentSourceHash.digest('hex');
const USDC = '0xb88339cb7199b77e23db6e890353e22632ba630f';
const HUSDC = '0x744e4f26ee30213989216e1632d9be3547c4885b';
const MAX = '115792089237316195423570985008687907853269984665640564039457584007913129639935';
const MAX_MINUS_SPENT = '115792089237316195423570985008687907853269984665640564039457584007913104639935';
// Independent expected values transcribed from the discovery evidence and public
// historical queries, not computed from the replay implementation under test.
const KNOWN = {
  'usdc-approve-hyperlend': {
    index: '1', postIndex: '2', events: ['1660000000'],
    pairs: [[USDC,'0xc6bf059aabef5668c32ebeef3dae82e59d4ebc4a','0x00a89d7a5a02160f20150ebea7a2b5e4879a1a8b','0','1660000000']],
  },
  'husdc-relayed-permit': {
    index: '6', postIndex: '7', events: [MAX],
    pairs: [[HUSDC,'0x3e248867a2a2ddd1d901f7d595c4d02c6519b32a','0x8a0f75a499c17632e5ee6cc4156099292f3e68f9','0',MAX]],
  },
  'usdc-router-permit-consumed': {
    index: '0', postIndex: '1', events: [MAX,'24812500'],
    pairs: [[USDC,'0x0c71073344e27e33cb57fcb587fc412d689dfd1d','0x693f12e9e6b35b34458793546065e8b08e0299d6','0',MAX_MINUS_SPENT],
      [USDC,'0x693f12e9e6b35b34458793546065e8b08e0299d6','0x04de1ef694923844bae419d4f832196f21767f86','0','0']],
  },
};
function comparable(report) {
  // Exclude generated IDs, creation time, timing and the source fingerprint from
  // historical semantic equality. Validate the current fingerprint independently
  // below and the recorded fingerprint against its pinned value above. Preserve
  // implementation name/version/sourceFiles and every semantic/raw evidence field.
  const { id, createdAt, timing, implementation, ...rest } = report;
  const { sourceSha256, ...implementationMetadata } = implementation;
  return { ...rest, implementation: implementationMetadata };
}
function recordedRpc(run) {
  const records = structuredClone(run.rpcCalls);
  let position = 0;
  return {
    provider: run.response.source.provider, rpcMs: 0,
    async verifyChain() { assert.equal(await this.call('eth_chainId', []), '0x3e7'); },
    async call(method, params = []) {
      const record = records[position++];
      assert.ok(record, 'No additional or live RPC calls are permitted');
      assert.deepEqual({ method, params }, { method: record.request.method, params: record.request.params }, 'Replay must use the original exact RPC method, parameters, block and transaction position');
      if (record.error) throw new RpcError('Recorded public provider failure.', record.error.code);
      assert.ok(record.response && Object.hasOwn(record.response, 'result'));
      return structuredClone(record.response.result);
    },
    get consumed() { return position; },
  };
}

test('permission capture contains exactly six observed HTTP200 responses with the frozen engine', () => {
  assert.equal(capture.executionTransport.kind, 'ephemeral_local_http');
  assert.equal(capture.executionTransport.route, 'POST /api/replay');
  assert.deepEqual(capture.summary.runs, { planned:6, attempted:6, completed:6, measured:5, unavailable:1, failed:0 });
  assert.equal(capture.cases.length, 3);
  assert.equal(capture.executionTransport.httpRuns.length, 6);
  for (const item of capture.cases) {
    assert.ok(KNOWN[item.id]);
    assert.deepEqual(item.runs.map(run => run.provider), ['drpc','hyperlend-archive']);
    for (const run of item.runs) {
      const http = capture.executionTransport.httpRuns.filter(entry => entry.transactionHash === run.request.transactionHash && entry.provider === run.response.source.provider);
      assert.equal(http.length, 1);
      assert.equal(http[0].response.status, 200);
      assert.equal(http[0].request.method, 'POST');
      assert.deepEqual(http[0].request.body, run.request);
      assert.deepEqual(http[0].response.body, run.response, 'Retained API body matches the recorded runner response');
      assert.equal(run.response.implementation.sourceSha256, CAPTURED_ENGINE_SHA256);
      assert.equal(run.rpcCalls.filter(record => record.error).length, 0);
    }
  }
});

for (const item of capture.cases) for (const run of item.runs) {
  test(`recorded full permission replay: ${item.id} through ${run.provider}`, async () => {
    const rpc = recordedRpc(run);
    const originalRaw = JSON.stringify(run.rpcCalls);
    const result = await replay(structuredClone(run.request), rpc);
    assert.equal(rpc.consumed, run.rpcCalls.length, 'Exactly the captured RPC sequence is consumed');
    assert.deepEqual(comparable(result), comparable(run.response), 'Full API result and raw evidence are preserved');
    assert.equal(JSON.stringify(run.rpcCalls), originalRaw, 'Saved provider requests and responses remain immutable');
    assert.equal(result.implementation.sourceSha256, CURRENT_ENGINE_SHA256, 'Current implementation fingerprint matches independently read source files');
    assert.equal(result.execution.status, 'success');
    assert.equal(result.coverage.status, 'partial');
    assert.equal(result.permissions.coverage.status, 'limited');
    assert.deepEqual(result.security, { status:'not_assessed', findings:[] });
    const expected = KNOWN[item.id];
    const events = result.permissions.observations.filter(observation => observation.kind === 'approval_event');
    assert.deepEqual(events.map(event => event.amountRaw), expected.events, 'Original Approval evidence is retained separately from final allowance');
    assert.equal(result.source.transactionIndex, expected.index);

    if (item.id === 'usdc-approve-hyperlend' && run.provider === 'drpc') {
      assert.equal(result.allowanceChanges.status, 'unavailable');
      assert.deepEqual(result.allowanceChanges.allowances, []);
      assert.equal(result.allowanceChanges.executionIdentity, undefined);
      assert.equal(result.permissions.coverage.allowanceStateVerified, false);
      assert.match(result.allowanceChanges.warnings.at(-1), /original transaction position/i);
      assert.equal(result.permissions.observations.filter(observation => observation.kind === 'approval_request').length, 1);
      assert.equal(events.length, 1);
      assert.deepEqual(result.evidence.traceResponse, run.response.evidence.traceResponse);
      assert.deepEqual(result.evidence.receipt, run.response.evidence.receipt);
      return;
    }

    assert.equal(result.allowanceChanges.status, 'measured');
    assert.equal(result.allowanceChanges.basis, 'historical_transaction_position_allowance');
    assert.equal(result.permissions.coverage.allowanceStateVerified, true);
    const actualPairs = result.allowanceChanges.allowances.map(allowance => [allowance.asset.address, allowance.owner, allowance.spender, allowance.beforeRaw, allowance.afterRaw]);
    assert.deepEqual(actualPairs, expected.pairs);
    for (const allowance of result.allowanceChanges.allowances) {
      assert.equal(allowance.deltaRaw, (BigInt(allowance.afterRaw)-BigInt(allowance.beforeRaw)).toString());
    }
    const identity = result.allowanceChanges.executionIdentity;
    assert.equal(identity.transactionHash, run.request.transactionHash);
    assert.equal(identity.transactionIndex, expected.index);
    assert.equal(identity.postTransactionIndex, expected.postIndex);
    assert.equal(identity.stateBlockHash, result.source.blockHash);
    assert.equal(identity.blockNumber, result.source.blockNumber);
    assert.equal(identity.timestamp, result.source.timestamp);
    assert.equal(identity.stateBinding, 'block_hash_and_transaction_index');
    assert.equal(identity.headerContext, 'original_block');
    assert.equal(identity.method, 'debug_traceCallMany');

    if (item.id === 'husdc-relayed-permit') {
      const permit = result.permissions.observations.find(observation => observation.kind === 'permit_request');
      assert.equal(permit.owner, expected.pairs[0][1]);
      assert.equal(permit.submitter, '0xe9755d57f1b933b152b5b1ef43af64a657b58ddd');
      assert.equal(permit.permitCaller, permit.submitter);
      assert.equal(permit.relayed, true);
      assert.notEqual(permit.owner, permit.submitter);
      assert.equal(permit.signatureVerification, 'not_independently_verified');
    }
    if (item.id === 'usdc-router-permit-consumed') {
      const permit = result.permissions.observations.find(observation => observation.kind === 'permit_request');
      assert.equal(permit.owner, expected.pairs[0][1]);
      assert.equal(permit.submitter, permit.owner);
      assert.equal(permit.permitCaller, expected.pairs[0][2]);
      assert.equal(permit.relayed, false);
      assert.notEqual(permit.permitCaller, permit.submitter);
      for (const allowance of result.allowanceChanges.allowances) {
        assert.equal(allowance.consistency.eventComparison, 'differs_from_last_observed_event');
        assert.equal(allowance.consistency.requestComparison, 'differs_from_requested_amount');
        assert.notEqual(allowance.consistency.lastEventAmountRaw, allowance.afterRaw);
      }
    }
  });
}
