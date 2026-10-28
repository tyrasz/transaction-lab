import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectCurrentCases, bindCurrentSelection, verifySelectedProductHeader, CURRENT_CONTEXT_POLICY } from './recheck-current-context.mjs';
import { verifyEthereumHeader } from '../../engines/local-evm/ethereum-header.js';

// The sealed old header is used only as a deterministic synthetic selection
// fixture in these offline controls; this does not represent a fresh selection.
const plans = inspectCurrentCases();
function selected(plan = plans[0]) {
  const header = structuredClone(plan.originalParentHeader);
  return { status: 'selected', selector: 'latest', chainId: '0x1', header,
    headerVerification: verifyEthereumHeader({ header, expectedHash: header.hash }) };
}

test('fixed known inputs retain exact access-list and blob context; no saved-input phase', () => {
  assert.deepEqual(plans.map(p => p.id), ['002', '007']);
  assert.equal(plans[0].localRequest.accessList.length, 25);
  assert.equal(plans[0].localRequest.accessList.reduce((n, e) => n + e.storageKeys.length, 0), 116);
  assert.equal(plans[1].localRequest.blobVersionedHashes.length, 1);
  assert.ok(plans.every(p => p.apiRequest.block === 'latest' && !Object.hasOwn(p, 'header')));
  assert.equal(CURRENT_CONTEXT_POLICY.calls, 2 * (2 + 256 + 65));
  assert.equal(CURRENT_CONTEXT_POLICY.savedInputSupplements, false);
  assert.equal(CURRENT_CONTEXT_POLICY.retries, 0);
});

test('selection binds a complete verified header without changing the fixed call/context', () => {
  for (const plan of plans) {
    const original = structuredClone(plan), selection = selected(plan), actual = bindCurrentSelection(plan, selection);
    assert.deepEqual(plan, original);
    assert.deepEqual(actual.localRequest, plan.localRequest);
    assert.deepEqual(actual.apiRequest, { ...plan.apiRequest, block: selection.header.hash });
    assert.deepEqual(actual.header, selection.header);
    actual.header.transactions.push('modified only the returned snapshot');
    assert.deepEqual(plan, original);
    assert.notDeepEqual(actual.header, selection.header);
  }
});

test('failed, wrong-chain, nonlatest and forged header verification cannot bind execution', () => {
  for (const change of [s => s.status = 'unavailable', s => s.chainId = '0xa', s => s.selector = 'finalized',
    s => s.headerVerification.stateRoot = '0x' + '00'.repeat(32), s => s.header.timestamp = '0x1']) {
    const selection = structuredClone(selected()); change(selection);
    assert.throws(() => bindCurrentSelection(plans[0], selection));
  }
  assert.throws(() => bindCurrentSelection({ ...plans[0], header: plans[0].originalParentHeader }, selected()));
});

test('complete product header equality includes hash-uncommitted body metadata and every repeated observation', () => {
  const c = bindCurrentSelection(plans[0], selected());
  const product = { report: { evidence: [
    { method: 'eth_getBlockByHash', result: structuredClone(c.header) },
    { method: 'eth_getBlockByNumber', result: structuredClone(c.header) },
  ] } };
  assert.equal(verifySelectedProductHeader(c, product).status, 'verified');
  for (const change of [h => h.timestamp = '0x1', h => h.stateRoot = '0x' + '00'.repeat(32),
    h => h.transactions.push('0x' + '00'.repeat(32)), h => h.unrecognizedExtension = true]) {
    const changed = structuredClone(product); change(changed.report.evidence[1].result);
    assert.equal(verifySelectedProductHeader(c, changed).status, 'mismatch');
  }
  assert.equal(verifySelectedProductHeader(c, {}).status, 'unavailable');
  assert.equal(verifySelectedProductHeader(c, { report: { evidence: [{ method: 'eth_getBlockByHash', error: 'unavailable' }] } }).status, 'unavailable');
});
