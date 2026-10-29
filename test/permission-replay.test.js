import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { replay } from '../src/server.js';
import { RpcError } from '../src/rpc.js';
import { VERSION } from '../src/config.js';

// Complete observed public HTTP/RPC captures. This adapter serves only the saved
// RPC sequence: no provider connection, alternate block, or extra call is allowed.
const bytes = await readFile(new URL('../reports/permission-comparisons/2026-10-25T15-26-52-549Z-http.json', import.meta.url));
const FILE_SHA256 = 'e305f6b98a5c3ef3deee207d5b463c2f1ad8bb0cbc30577d9336084805a7f824';
const CAPTURED_ENGINE_SHA256 = '02f8ab5584ff7ca5fabd18a2a9a969280211b54b4b14382e2091ef353738cc9f';
assert.equal(createHash('sha256').update(bytes).digest('hex'), FILE_SHA256);
const capture = JSON.parse(bytes);
const v7Bytes = await readFile(new URL('../reports/affected-balance-comparisons/capture.json', import.meta.url));
assert.equal(createHash('sha256').update(v7Bytes).digest('hex'),'53eec210304f3f3ff749bc4a4cdbd4fe55f57e87a2cd0b94983574bd0942de34');
const v7Capture=JSON.parse(v7Bytes);
const guardedBytes=await readFile(new URL('../reports/replay-state-comparisons/capture.json',import.meta.url));
assert.equal(createHash('sha256').update(guardedBytes).digest('hex'),'51d7cb6ba049b1cd38da52ba2131b4bc328ac264419c240f132c3b570f8ed610');
const guardedCapture=JSON.parse(guardedBytes);
// Independently hash the current source bytes using the documented fingerprint
// encoding. Source hardening can change this metadata without changing any
// original chain observation or the captured implementation's provenance.
// Declared current additions are independent of the response under test; the
// pinned capture inventory and its historical implementation remain unchanged.
const sourceFiles = guardedCapture.implementation.sourceFiles.flatMap(name => name === 'analyze.js' ? [name, 'arbitrum-loader.js'] : name === 'historical-state.js'
  ? ['current-state.js', name] : name === 'server.js' ? [name, 'standard-loader.js', 'standard-rpc.js'] : name === 'lending-balances.js' ? [name, 'local-loader.js', 'local-simulation.js'] : name === 'permissions.js' ? [name, 'proof-rpc.js'] : [name]);
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
const TRANSFER_WARNINGS = [
  'transferFrom records a requested transfer amount, not a requested allowance. The owner, immediate spender, recipient and transaction submitter are distinct roles; call success does not independently verify intent or authorization.',
  'A transferFrom call does not by itself establish final token balances or numerical allowance consumption. Consult transfer events and separately measured state; an unchanged allowance does not mean no spending occurred.',
];
const TRANSFER_EXPLANATION = ' transferFrom amounts are requested token transfers, not requested allowance values, and are not equated with allowance changes. An unchanged allowance does not establish that no spending occurred.';
const observationKey = o => JSON.stringify([o.kind,o.asset?.address,o.owner,o.spender,o.framePath]);
function assertLegacyMeasurementEvidence(actual, saved, caseId, provider) {
  assert.deepEqual(actual.evidence.balanceMeasurement, saved.evidence.balanceMeasurement, 'The previously empty balance context remains exact');
  const old = saved.evidence.allowanceMeasurement, current = actual.evidence.allowanceMeasurement;
  const unavailable = caseId === 'usdc-approve-hyperlend' && provider === 'drpc';
  const count = unavailable ? 2 : caseId === 'usdc-router-permit-consumed' ? 16 : 11;
  const oldIds = Array.from({ length: count }, (_, index) => index + 1);
  // The sole inserted preparation call is original-position prestateTracer id5.
  // Original token queries retain their exact order and are never replaced with
  // later identical canonical requests or newly added affected-balance reads.
  const currentIds = oldIds.map(id => !unavailable && id >= 5 ? id + 1 : id);
  assert.deepEqual(old.request.map(entry => entry.id), oldIds);
  assert.deepEqual(old.response.map(entry => entry.id), oldIds);
  assert.equal(new Set(current.request.map(entry => entry.id)).size, current.request.length);
  assert.equal(new Set(current.response.map(entry => entry.id)).size, current.response.length);
  const revisions = provider !== 'drpc' ? [] : caseId === 'husdc-relayed-permit' ? [[11, '0x1c3a', '0x1e33']]
    : caseId === 'usdc-router-permit-consumed' ? [[2, '0x90d', '0x4ad'], [16, '0x4ad', '0x90d']] : [];
  const usedIds = new Set(), usedRevisions = new Set();
  for (const [index, oldId] of oldIds.entries()) {
    const id = currentIds[index];
    assert.equal(usedIds.has(id), false, 'A repeated equal request cannot reuse an earlier captured response'); usedIds.add(id);
    const requests = current.request.filter(entry => entry.id === id), responses = current.response.filter(entry => entry.id === id);
    assert.equal(requests.length, 1); assert.equal(responses.length, 1);
    assert.deepEqual({ ...requests[0], id: oldId }, old.request[index], 'Legacy method, complete parameters and original position are unchanged');
    const response = structuredClone(responses[0]); response.id = oldId;
    const revision = revisions.find(entry => entry[0] === oldId);
    if (revision) {
      assert.equal(response.method, 'eth_getBlockByNumber');
      assert.equal(old.response[index].result.size, revision[1]); assert.equal(response.result.size, revision[2]);
      response.result.size = revision[1]; usedRevisions.add(oldId);
    }
    assert.deepEqual(response, old.response[index], 'Every legacy result is preserved except an explicitly asserted size metadata revision');
  }
  assert.deepEqual([...usedIds], currentIds, 'The exact genuine context request IDs are consumed once each');
  assert.deepEqual([...usedRevisions].sort((a,b) => a-b), revisions.map(entry => entry[0]).sort((a,b) => a-b));
}
function assertLegacyResult(actual, saved, caseId, provider) {
  assertLegacyMeasurementEvidence(actual, saved, caseId, provider);
  const result = structuredClone(actual), expected = structuredClone(saved);
  // Generated IDs/time/timing and implementation provenance are validated apart
  // from semantic equality; original observations remain unchanged in v0.7.
  for (const report of [result,expected]) for (const key of ['id','createdAt','timing','implementation']) delete report[key];
  for(const field of ['balanceChanges','allowanceChanges'])if(result[field]?.executionIdentity){
    assert.equal(result[field].executionIdentity.validation.originalReplayState,'complete_pre_post_diff_match');
    expected[field].executionIdentity.validation.originalReplayState='complete_pre_post_diff_match';
  }
  // Declared v0.6 wording revision includes transfer-only permissions accurately.
  expected.coverage.reasons=expected.coverage.reasons.map(reason=>reason==='Configured ERC20 approval requests and events were interpreted separately. Final allowance state and other effects remain unverified.'
    ? 'Configured ERC20 permission and transfer-call observations were interpreted separately. Final allowance state and other effects remain unverified.' : reason);
  delete result.accountEffects; // Asserted independently below with known quantities.
  delete result.affectedBalanceChanges; // New state queries are asserted separately.
  delete result.evidence.affectedBalanceMeasurement;
  // The exact declared legacy subset is checked above. Complete current shared
  // evidence, including added diff/balance queries, is checked against the new
  // frozen API capture separately; local IDs alone are not execution evidence.
  for(const report of [result,expected])for(const field of ['balanceMeasurement','allowanceMeasurement'])delete report.evidence[field];
  const transfers = result.permissions.observations.filter(o=>o.kind==='transfer_from_call');
  const oldObservations = result.permissions.observations.filter(o=>o.kind!=='transfer_from_call');
  assert.equal(oldObservations.length, expected.permissions.observations.length);
  const idMap = new Map();
  for (const old of expected.permissions.observations) {
    const matched = oldObservations.filter(o=>observationKey(o)===observationKey(old));
    assert.equal(matched.length,1,'Every legacy permission observation has one semantic match');
    idMap.set(matched[0].id,old.id);
  }
  const mapId = id => { assert.ok(idMap.has(id),'Legacy correlation references a known legacy observation'); return idMap.get(id); };
  for (const observation of oldObservations) {
    observation.id=mapId(observation.id);
    for (const field of ['matchedEventIds','matchedRequestIds']) if (observation[field]) observation[field]=observation[field].map(mapId);
  }
  result.permissions.observations=oldObservations;
  for (const finding of result.permissions.findings) if (finding.observationIds) finding.observationIds=finding.observationIds.map(mapId);
  assert.deepEqual(result.permissions.warnings,[...expected.permissions.warnings,...(transfers.length?TRANSFER_WARNINGS:[])]);
  result.permissions.warnings=expected.permissions.warnings;
  for (const [index,allowance] of result.allowanceChanges.allowances.entries()) {
    const relevant=transfers.filter(o=>o.asset.address===allowance.asset.address&&o.owner===allowance.owner&&o.spender===allowance.spender);
    const ids=relevant.map(o=>o.id);
    assert.deepEqual(allowance.consistency.transferObservationIds,ids);
    assert.equal(allowance.consistency.transferComparison,ids.length?'not_compared_to_allowance':'no_transfer_from_call');
    assert.deepEqual(allowance.observationIds.filter(id=>ids.includes(id)),ids);
    allowance.observationIds=allowance.observationIds.filter(id=>!ids.includes(id)).map(mapId);
    if (allowance.consistency.lastEventObservationId) allowance.consistency.lastEventObservationId=mapId(allowance.consistency.lastEventObservationId);
    allowance.consistency.falseReturnObservationIds=allowance.consistency.falseReturnObservationIds.map(mapId);
    assert.equal(allowance.consistency.explanation,expected.allowanceChanges.allowances[index].consistency.explanation+(ids.length?TRANSFER_EXPLANATION:''));
    allowance.consistency.explanation=expected.allowanceChanges.allowances[index].consistency.explanation;
    delete allowance.consistency.transferObservationIds;
    delete allowance.consistency.transferComparison;
  }
  assert.deepEqual(result,expected,'Every unchanged v0.5 semantic field and original raw execution/receipt is preserved');
  return transfers;
}
function assertAccountEffects(result,item) {
  const effects=result.accountEffects;
  assert.equal(effects.status,'observed');
  assert.equal(effects.summary.measuredBalancePairs,item.id==='usdc-router-permit-consumed'?5:0,'Only independently queried configured-token balances are measured');
  assert.equal(effects.summary.measuredAllowancePairs,result.allowanceChanges.allowances.length);
  for (const account of effects.accounts) for (const token of account.tokens) {
    if(token.balance.status==='measured'){
      assert.equal(item.id,'usdc-router-permit-consumed');assert.equal(token.asset.address,USDC);
      const measured=result.affectedBalanceChanges.assets[token.balance.affectedBalanceChangeIndex];
      assert.equal(measured.account,account.address);assert.deepEqual([token.balance.beforeRaw,token.balance.afterRaw,token.balance.deltaRaw],[measured.beforeRaw,measured.afterRaw,measured.deltaRaw]);
    }else assert.equal(token.balance.status,'not_measured');
  }
  if (item.id==='usdc-router-permit-consumed') {
    assert.equal(result.affectedBalanceChanges.status,'measured');assert.equal(result.affectedBalanceChanges.assets.length,5);
    assert.deepEqual(result.evidence.allowanceMeasurement,result.evidence.affectedBalanceMeasurement);
    const knownBalances=[['50000000','25000000','-25000000'],['0','0','0'],['4099157892','4123970196','24812304'],['64258987719','64258987915','196'],['11356529011','11356716511','187500']];
    assert.deepEqual(result.affectedBalanceChanges.assets.map(entry=>[entry.beforeRaw,entry.afterRaw,entry.deltaRaw]),knownBalances);
    const expected=new Map([
      ['0x0c71073344e27e33cb57fcb587fc412d689dfd1d',['0','25000000','-25000000']],
      ['0x693f12e9e6b35b34458793546065e8b08e0299d6',['25000000','25000000','0']],
      ['0x04de1ef694923844bae419d4f832196f21767f86',['24812500','196','24812304']],
      ['0x7fe37fc2f987eb981a0fc63cf1eabf04463550d4',['196','0','196']],
      ['0xb4894380282533a86cb241145fac54aaac995f18',['187500','0','187500']],
    ]);
    const cash=effects.accounts.flatMap(account=>account.tokens.filter(token=>token.asset.address===USDC).map(token=>[account.address,token]));
    assert.equal(cash.length,5);
    for (const [address,token] of cash) {assert.equal(token.events.status,'observed');assert.deepEqual([token.events.incomingRaw,token.events.outgoingRaw,token.events.netRaw],expected.get(address));}
    for (const account of effects.accounts) for (const token of account.tokens.filter(token=>token.role==='unverified_token')) {
      assert.equal(token.tokenVerified,false);assert.equal(token.asset.decimals,null);assert.equal(token.asset.symbol,null);
      assert.match(token.events.netRaw,/^-?\d+$/);assert.equal(token.events.net,null);
    }
  } else {
    assert.equal(result.affectedBalanceChanges.status,'not_applicable');assert.deepEqual(result.evidence.affectedBalanceMeasurement,{request:[],response:[]});
    assert.equal(effects.summary.accountCount,item.id==='husdc-relayed-permit'?3:2);
    for (const account of effects.accounts) for (const token of account.tokens) {assert.equal(token.events.status,'not_observed');assert.equal(token.events.net,null);}
  }
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

for (const item of capture.cases) for (const legacyRun of item.runs) {
  test(`recorded full permission replay: ${item.id} through ${legacyRun.provider}`, async () => {
    const currentId={'usdc-approve-hyperlend':'usdc-approval-historical','husdc-relayed-permit':'husdc-relayed-permit-historical','usdc-router-permit-consumed':'usdc-router-permit-consumed'}[item.id];
    const fresh=guardedCapture.cases.find(entry=>entry.id===currentId)?.runs.find(run=>run.provider===legacyRun.provider);
    if(!(item.id==='usdc-approve-hyperlend'&&legacyRun.provider==='drpc'))assert.ok(fresh,'Every changed successful permission request requires genuine new capture evidence');
    const run=fresh??legacyRun;
    const rpc = recordedRpc(run);
    const originalRaw = JSON.stringify(run.rpcCalls);
    const result = await replay(structuredClone(run.request), rpc);
    assert.equal(rpc.consumed, run.rpcCalls.length, 'Exactly the captured RPC sequence is consumed');
    const transfers=assertLegacyResult(result,legacyRun.response,item.id,legacyRun.provider);
    if(fresh){
      const withoutGenerated=report=>{const {id,createdAt,timing,implementation,...rest}=report;return rest;};
      assert.deepEqual(withoutGenerated(result),withoutGenerated(fresh.response),'Every new API field and complete shared evidence matches the observed guarded response');
    }else{
      assert.deepEqual(result.evidence.balanceMeasurement,legacyRun.response.evidence.balanceMeasurement);
      assert.deepEqual(result.evidence.allowanceMeasurement,legacyRun.response.evidence.allowanceMeasurement);
    }
    assertAccountEffects(result,item);
    assert.equal(JSON.stringify(run.rpcCalls), originalRaw, 'Saved provider requests and responses remain immutable');
    assert.equal(result.implementation.sourceSha256, CURRENT_ENGINE_SHA256, 'Current implementation fingerprint matches independently read source files');
    assert.equal(result.implementation.version,VERSION);
    assert.equal(result.implementation.name,run.response.implementation.name);
    assert.deepEqual(result.implementation.sourceFiles,sourceFiles);
    assert.equal(transfers.length,item.id==='usdc-router-permit-consumed'?2:0);
    if (transfers.length) {
      assert.deepEqual(transfers.map(o=>[o.framePath,o.owner,o.spender,o.recipient,o.amountRaw]),[
        ['0.0.4','0x0c71073344e27e33cb57fcb587fc412d689dfd1d','0x693f12e9e6b35b34458793546065e8b08e0299d6','0x693f12e9e6b35b34458793546065e8b08e0299d6','25000000'],
        ['0.0.7.1.23','0x693f12e9e6b35b34458793546065e8b08e0299d6','0x04de1ef694923844bae419d4f832196f21767f86','0x04de1ef694923844bae419d4f832196f21767f86','24812500'],
      ]);
      for (const transfer of transfers) {assert.equal(transfer.amountMeaning,'requested_transfer_amount');assert.equal(transfer.returnStatus,'returned_true');assert.equal(transfer.authorizationVerification,'not_independently_verified');assert.equal(transfer.intentVerification,'not_assessed');}
    }
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
