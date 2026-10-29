import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { executeEthereumPreview } from '../ethereum-preview.js';
import { EMPTY_CODE_HASH, verifyStateProof } from '../verified-state-proof.js';
import { assertReadsWithCleanup } from './cleanup-read-regression.js';

// Development regression inputs, not held-out accuracy cases. The RPC adapter
// below serves only independently captured eth_getProof/eth_getCode results.
// It is keyed saved-result playback: getters can request facts in a different
// order from the original capture. No provider trace or diff supplies state.
const PACKET = new URL('../../../reports/ethereum-lending-local-reference/', import.meta.url);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const bytes = name => readFileSync(new URL(name, PACKET));
const manifestBytes = bytes('manifest.json');
assert.equal(sha(manifestBytes), '34b1e325ea08604705e50f06da81e442bb48cea017faf3058671e1e1a4e8f8c5');
const manifest = JSON.parse(manifestBytes);
const entries = new Map(manifest.files.map(row => [row.path, row]));
assert.equal(entries.size, manifest.files.length);
function checked(name, expectedSha) {
  const value = bytes(name), entry = entries.get(name);
  assert.ok(entry, 'Fixture must belong to the original sealed manifest: ' + name);
  assert.equal(value.length, entry.bytes, name + ' byte count');
  assert.equal(sha(value), expectedSha ?? entry.sha256, name + ' pinned hash');
  assert.equal(sha(value), entry.sha256, name + ' manifest hash');
  return value;
}
const plan = JSON.parse(checked('plan.json', 'f9fb0e1b465bcf191185e1790204bf64a324634d98436ebb4a17f4cb6cd83288'));
const captured = new Map([
  ['aave-usdc-supply-with-permit', JSON.parse(checked('aave-usdc-supply-with-permit-local.json', '1cbe7eeca94e528b9d5cda932524e65c0cbf6b08fb08c962aca36841dfaa1763'))],
  ['morpho-kiln-usdc-deposit', JSON.parse(checked('morpho-kiln-usdc-deposit-local.json', '4e85c6c4daa5ebbb0e38536ed8b78ea5ce105adde5c9fc83d663a30de161c940'))],
]);
const AAVE = plan.cases[0], MORPHO = plan.cases[1];
assert.equal(AAVE.id, 'aave-usdc-supply-with-permit');
assert.equal(MORPHO.id, 'morpho-kiln-usdc-deposit');
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const ATOKEN = '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c';
const VAULT = '0xbeef01735c132ada46aa9aa4c54623caa92a64cb';
const BLUE = '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb';
const FEE_ACCOUNT = '0x255c7705e8bb334dfcae438197f7c4297988085a';
const wordAddress = address => address.slice(2).padStart(64, '0');
const balance = (token, account) => ({ to: token, data: '0x70a08231' + wordAddress(account) });
const allowance = (token, owner, spender) => ({ to: token, data: '0xdd62ed3e' + wordAddress(owner) + wordAddress(spender) });
const unit = { kind: 'token_raw_units', scale: null };
const aaveQueries = [balance(USDC, AAVE.request.from), allowance(USDC, AAVE.request.from, AAVE.request.to), balance(USDC, ATOKEN)];
const aTokenQuery = balance(ATOKEN, AAVE.request.from);
const missingATokenProof = { method: 'eth_getProof', params: [ATOKEN, ['0x' + '0'.repeat(62) + '3d'], { blockHash: AAVE.header.hash, requireCanonical: true }] };

async function playback(c, { expectedMissing = [] } = {}) {
  const original = captured.get(c.id), records = new Map(), calls = [], unexpected = [], missed = [];
  const retained = [], ids = new Map(), proofs = new Map(), latestProof = new Map(), derivations = new Map();
  for (const [i, wire] of original.transport.entries()) {
    assert.equal(wire.status, 'completed');
    assert.equal(wire.id, i + 1);
    assert.equal(wire.requestText, JSON.stringify(wire.request));
    assert.equal(sha(wire.requestText), wire.requestSha256);
    assert.equal(sha(wire.responseText), wire.responseSha256);
    assert.deepEqual(JSON.parse(wire.responseText), wire.parsed);
    assert.deepEqual(wire.request.params.at(-1), { blockHash: c.header.hash, requireCanonical: true });
    assert.ok(['eth_getProof', 'eth_getCode'].includes(wire.request.method));
    const request = { method: wire.request.method, params: wire.request.params }, key = JSON.stringify(request);
    const evidence = original.inputEvidence[i];
    assert.deepEqual(evidence.request, request);
    assert.deepEqual(evidence.result, wire.parsed.result);
    assert.equal(evidence.resultSha256, sha(JSON.stringify(wire.parsed.result)));
    if (wire.request.method === 'eth_getProof') latestProof.set(wire.request.params[0], wire);
    else {
      const proof = latestProof.get(wire.request.params[0]); assert(proof, 'Code must follow its saved account proof');
      const verified = await verifyStateProof({ stateRoot: c.header.stateRoot, address: wire.request.params[0],
        storageKeys: proof.request.params[1], proof: proof.parsed.result, code: wire.parsed.result });
      proofs.set(proof.id, verified);
      if (verified.account.codeHash === EMPTY_CODE_HASH) {
        assert.equal(wire.parsed.result, '0x');
        derivations.set(wire.id, { proofId: proof.id, label: verified.account.exists ? 'verified_account_empty_code_hash' : 'verified_account_absence' });
        continue;
      }
    }
    assert.equal(records.has(key), false, 'No ambiguous equal-key source results');
    records.set(key, { sourceId: wire.id, result: wire.parsed.result });
    ids.set(wire.id, retained.length + 1); retained.push(wire);
  }
  assert.deepEqual([...derivations.keys()], c.id === AAVE.id ? [2, 20] : [2], 'Only fixed, independently proven empty-code reads are omitted');
  const remap = id => { assert(ids.has(id), 'Every retained evidence ID must map to a real read'); return ids.get(id); };
  const expectedInputs = structuredClone(original.inputs);
  for (const item of expectedInputs.provenance) {
    const oldProofId = item.proofEvidenceId, derivation = derivations.get(item.codeEvidenceId);
    assert.deepEqual(item.accountProof, proofs.get(oldProofId).account);
    item.proofEvidenceId = remap(oldProofId);
    if (derivation) { assert.equal(derivation.proofId, oldProofId); item.codeEvidenceId = null; item.codeDerivation = derivation.label; }
    else item.codeEvidenceId = remap(item.codeEvidenceId);
    for (const slot of item.storage) slot.evidenceId = remap(slot.evidenceId);
  }
  assert.deepEqual(expectedInputs.accounts, original.inputs.accounts);
  const expectedEvidence = original.inputEvidence.filter(row => ids.has(row.id)).map(row => ({ ...structuredClone(row), id: remap(row.id) }));
  const rpc = { async call(method, params) {
    const request = { method, params }, key = JSON.stringify(request), found = records.get(key);
    if (!found) {
      missed.push(structuredClone(request));
      if (!expectedMissing.some(allowed => JSON.stringify(allowed) === key)) unexpected.push(structuredClone(request));
      throw new Error('Offline fixture has no recorded pinned proof/code response');
    }
    calls.push({ request: structuredClone(request), sourceId: found.sourceId });
    return structuredClone(found.result);
  } };
  return { rpc, original, expectedInputs, expectedEvidence, retained, calls, unexpected, missed, verifyCalls() {
    assert.deepEqual(unexpected, [], 'Unexpected reads cannot be hidden by an unavailable engine result');
    assert.equal(calls.length, retained.length, 'Original execution runs once and getters use only already-proven facts');
    assert.deepEqual(calls.map(row => row.sourceId), retained.map(row => row.id), 'Every retained source record is used exactly once, in original execution order');
  } };
}

function originalUnchanged(result, fixture) {
  // 0.17 describes observed lifecycle activity instead of advertising the old
  // blanket unsupported policy. Preserve every execution/state byte below.
  const output = structuredClone(result.original.output);
  assert.equal(output.semantics.lifecycle, 'no_lifecycle_operation_encountered');
  assert.equal(fixture.original.output.semantics.lifecycle, 'CREATE_CREATE2_SELFDESTRUCT_unsupported');
  output.semantics.lifecycle = fixture.original.output.semantics.lifecycle;
  assert.deepEqual(output, fixture.original.output);
  assert.deepEqual(result.original.changes, fixture.original.changes);
  assert.deepEqual(result.original.inputs, fixture.expectedInputs);
  assertReadsWithCleanup(result.original.stateReads, fixture.original.stateReads, fixture.original.output.trace);
  assert.equal(result.original.inputUsage.status, 'available');
  assert.equal(result.original.inputUsage.calls, fixture.retained.length);
  assert.equal(result.original.inputEvidence.length, fixture.expectedEvidence.length);
  const omitDuration = rows => rows.map(({ durationMs, ...row }) => row);
  assert.deepEqual(omitDuration(result.original.inputEvidence), omitDuration(fixture.expectedEvidence));
  assert.deepEqual(result.headerVerification, fixture.original.headerVerification);
  // These assertions independently bind each successful probe to its root,
  // exact return word and complete overlay. The post-query sender increment
  // must not leak into the original or any other disposable probe.
  const sender = fixture.original.output.trace.from;
  const nonce = BigInt(fixture.original.inputs.accounts[sender].nonce);
  const hex = value => '0x' + value.toString(16);
  for (const measurement of result.measurements.filter(row => row.status === 'measured')) {
    for (const phase of [measurement.before, measurement.after]) {
      assert.equal(phase.status, 'measured');
      assert.equal(phase.output.execution.status, 'success');
      assert.deepEqual(phase.output.logs, []);
      assert.equal(phase.output.trace.from, sender);
      assert.equal(phase.output.trace.to, measurement.query.to);
      assert.equal(phase.output.trace.input, measurement.query.data);
      assert.equal(phase.output.trace.value, '0x0');
      assert.equal(phase.output.profile.declaredGasLimit, '1000000');
      assert.equal(phase.output.execution.returnData, '0x' + BigInt(phase.values[0].raw).toString(16).padStart(64, '0'));
      assert.deepEqual(phase.mutationValidation, { status: 'verified', scope: 'net_changes_except_expected_query_sender_nonce' });
      assert.deepEqual(phase.inputEvidenceIds, []);
    }
    assert.deepEqual(measurement.before.changesBefore.accounts, []);
    assert.deepEqual(measurement.before.changesAfter.accounts, [{ address: sender, nonce: { before: hex(nonce), after: hex(nonce + 1n) } }]);
    assert.deepEqual(measurement.after.changesBefore, fixture.original.changes);
    const after = structuredClone(fixture.original.changes);
    const senderChange = after.accounts.find(row => row.address === sender);
    assert.deepEqual(senderChange.nonce, { before: hex(nonce), after: hex(nonce + 1n) });
    senderChange.nonce.after = hex(nonce + 2n);
    assert.deepEqual(measurement.after.changesAfter, after);
    assert.equal(measurement.values[0].beforeRaw, measurement.before.values[0].raw);
    assert.equal(measurement.values[0].afterRaw, measurement.after.values[0].raw);
  }
}
function measured(row, query, identity, before, after) {
  assert.equal(row.status, 'measured');
  assert.deepEqual(row.query, query);
  assert.deepEqual(row.identity, { ...identity, chainId: '1', contractIdentityVerified: false });
  assert.equal(row.returnBytes, 32);
  assert.deepEqual(row.values, [{ name: identity.kind === 'allowance' ? 'allowance' : 'balance', beforeRaw: before, afterRaw: after, deltaRaw: (BigInt(after) - BigInt(before)).toString(), unit }]);
}
const balanceIdentity = (token, account) => ({ kind: 'balanceOf', token, account });
const allowanceIdentity = (token, owner, spender) => ({ kind: 'allowance', token, owner, spender });

test('recorded proof packets and their archived local source/header inputs retain sealed hashes', () => {
  const localSources = plan.sourceFiles.filter(row => row.path.startsWith('engines/local-evm/') && !row.path.includes('/node_modules/'));
  assert.equal(localSources.length, 9);
  for (const entry of localSources) {
    const value = checked('runtime/' + entry.path, entry.sha256);
    assert.equal(value.length, entry.bytes);
  }
  for (const c of plan.cases) {
    const source = JSON.parse(checked(c.parentInput));
    assert.deepEqual(source.response.result, c.header);
    assert.deepEqual(source.request.body.params, [c.header.hash, false]);
  }
});

test('Aave three scalar queries derive exact before/after values from saved proof/code only', async () => {
  const f = await playback(AAVE);
  const result = await executeEthereumPreview({ request: AAVE.request, header: AAVE.header, rpc: f.rpc, queries: aaveQueries });
  f.verifyCalls(); assert.deepEqual(f.missed, []);
  assert.equal(result.status, 'complete'); originalUnchanged(result, f);
  assert.equal(result.measurements.length, 3);
  measured(result.measurements[0], aaveQueries[0], balanceIdentity(USDC, AAVE.request.from), '3962903485', '0');
  measured(result.measurements[1], aaveQueries[1], allowanceIdentity(USDC, AAVE.request.from, AAVE.request.to), '0', '0');
  measured(result.measurements[2], aaveQueries[2], balanceIdentity(USDC, ATOKEN), '151987610826648', '151991573730133');
  // The pool receives permission and spends it; a final allowance of zero does
  // not mean no approval happened. It also is not a deposited asset balance.
  assert.notEqual(result.measurements[2].identity.account, AAVE.request.from);
});

test('Morpho eight queries retain wrapper/vault/fee identities and exact independent raw values', async () => {
  const wallet = MORPHO.request.from, wrapper = MORPHO.request.to;
  const rows = [
    [balance(wrapper, wallet), balanceIdentity(wrapper, wallet), '1151370388097', '1481867899909'],
    [balance(USDC, wallet), balanceIdentity(USDC, wallet), '704323976173', '354323976173'],
    [allowance(USDC, wallet, wrapper), allowanceIdentity(USDC, wallet, wrapper), '350000000000', '0'],
    [balance(wrapper, wrapper), balanceIdentity(wrapper, wrapper), '18022867783', '18078180423'],
    [balance(USDC, wrapper), balanceIdentity(USDC, wrapper), '20083625', '20083625'],
    [balance(USDC, BLUE), balanceIdentity(USDC, BLUE), '128890534855869', '129240534855869'],
    [balance(USDC, VAULT), balanceIdentity(USDC, VAULT), '6011', '6011'],
    [balance(VAULT, FEE_ACCOUNT), balanceIdentity(VAULT, FEE_ACCOUNT), '34363220714011809188525', '34390568084318171872187'],
  ];
  const f = await playback(MORPHO);
  const result = await executeEthereumPreview({ request: MORPHO.request, header: MORPHO.header, rpc: f.rpc, queries: rows.map(row => row[0]) });
  f.verifyCalls(); assert.deepEqual(f.missed, []);
  assert.equal(result.status, 'complete'); originalUnchanged(result, f);
  assert.equal(result.measurements.length, rows.length);
  rows.forEach((row, i) => measured(result.measurements[i], ...row));
  assert.equal(result.measurements[7].identity.account, FEE_ACCOUNT);
  assert.notEqual(FEE_ACCOUNT, wallet);
  assert.notEqual(result.measurements[3].identity.account, wallet);
});

test('missing aToken proof last retains original and earlier measurements without invented amount', async () => {
  const f = await playback(AAVE, { expectedMissing: [missingATokenProof] });
  const result = await executeEthereumPreview({ request: AAVE.request, header: AAVE.header, rpc: f.rpc, queries: [...aaveQueries, aTokenQuery] });
  f.verifyCalls(); assert.deepEqual(f.missed, [missingATokenProof]);
  assert.equal(result.status, 'partial'); originalUnchanged(result, f);
  measured(result.measurements[0], aaveQueries[0], balanceIdentity(USDC, AAVE.request.from), '3962903485', '0');
  measured(result.measurements[1], aaveQueries[1], allowanceIdentity(USDC, AAVE.request.from, AAVE.request.to), '0', '0');
  measured(result.measurements[2], aaveQueries[2], balanceIdentity(USDC, ATOKEN), '151987610826648', '151991573730133');
  const missing = result.measurements[3];
  assert.equal(missing.status, 'unavailable'); assert.equal(missing.values, null);
  assert.deepEqual(missing.query, aTokenQuery);
  assert.ok(missing.reason);
  assert.equal(result.inputUsage.status, 'unavailable');
});

test('missing proof poisons shared collector and prevents later known query instead of retrying or zero-filling', async () => {
  const f = await playback(AAVE, { expectedMissing: [missingATokenProof] });
  const result = await executeEthereumPreview({ request: AAVE.request, header: AAVE.header, rpc: f.rpc, queries: [aaveQueries[0], aTokenQuery, aaveQueries[1]] });
  f.verifyCalls(); assert.deepEqual(f.missed, [missingATokenProof]);
  assert.equal(result.status, 'partial'); originalUnchanged(result, f);
  measured(result.measurements[0], aaveQueries[0], balanceIdentity(USDC, AAVE.request.from), '3962903485', '0');
  assert.equal(result.measurements[1].status, 'unavailable'); assert.equal(result.measurements[1].values, null);
  assert.equal(result.measurements[2].status, 'not_attempted'); assert.equal(result.measurements[2].values, null);
  assert.deepEqual(result.measurements[2].query, aaveQueries[1]);
  assert.ok(result.measurements[2].reason);
  assert.equal(result.inputUsage.status, 'unavailable');
});
