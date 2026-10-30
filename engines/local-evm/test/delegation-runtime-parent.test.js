// Parent derivation from verified inputs returned by an actual isolated call.
// Altered metadata below is fabricated test data, not another EVM execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import { executeIsolatedEthereumCall } from '../isolated-call.js';
import { deriveAmsterdamAuthorizationPreparation, validateAmsterdamAuthorizationProcessing } from '../amsterdam-authorization-validation.js';
import { amsterdamAuthorizationExecutionFixture as fixture, authorization, signedAuthorizationTransaction, AUTHORITY, DELEGATE } from './amsterdam-authorization-execution-fixture.js';
import { MALFORMED, EXACT } from './delegation-runtime-fixture.js';

test('independent parent derivation treats malformed recipient code as an entered message with retained preparation', async () => {
  const f = await fixture({ targetCode: MALFORMED[2], authorizationList: [authorization()] });
  f.request.gas = (signedAuthorizationTransaction(f).getIntrinsicGas() + 44190n + 100n).toString();
  const result = await executeIsolatedEthereumCall({ request: f.request, header: f.header, rpc: f.rpc, chainId: 11155111 });
  assert.equal(result.status, 'completed'); assert.equal(result.output.execution.error, 'invalid opcode');
  assert.equal(result.isolation.processClosed, true); assert.equal(result.broker.pendingAtReturn, 0);
  const prepared = deriveAmsterdamAuthorizationPreparation({ request: f.request, header: f.header, inputs: result.inputs, common: f.common });
  assert.equal(prepared.recipient.delegatedTo, null); assert.equal(prepared.recipient.delegationAccessGas, 0n);
  assert.equal(prepared.recipient.outOfGas, false); assert.equal(prepared.recipient.gasLimitAfter, 100n);
  assert.equal(prepared.retained, true); assert.equal(prepared.applied.has(AUTHORITY), true);
  assert.equal(prepared.accounts.get(AUTHORITY).current.code, EXACT);
  assert.equal(prepared.accounts.get(AUTHORITY).current.nonce, 1n);
  validateAmsterdamAuthorizationProcessing(prepared, result.output.authorizationProcessing);
  const changes = [
    processing => { processing.preparation.authorizationGasUsed = '47190'; },
    processing => { Object.assign(processing.preparation, { phase: 'recipient_out_of_gas', retained: false, executionStateGasUsed: '0', stateGasSpilled: '0' }); },
    processing => { processing.entries[0] = { index: 0, authority: AUTHORITY, status: 'skipped', reason: 'code_not_allowed' }; },
    processing => { processing.preparation.delegatedTo = DELEGATE; },
  ];
  for (const change of changes) {
    const claimed = structuredClone(result.output.authorizationProcessing); change(claimed);
    assert.throws(() => validateAmsterdamAuthorizationProcessing(prepared, claimed), /does not match verified starting facts/);
  }
});

test('an exact recipient designation still incurs the real cold access charge and can halt preparation', async () => {
  const f = await fixture({ targetCode: EXACT, authorizationList: [authorization()] });
  f.request.gas = (signedAuthorizationTransaction(f).getIntrinsicGas() + 44190n + 100n).toString();
  const result = await executeIsolatedEthereumCall({ request: f.request, header: f.header, rpc: f.rpc, chainId: 11155111 });
  assert.equal(result.status, 'completed'); assert.equal(result.output.execution.error, 'out of gas');
  const prepared = deriveAmsterdamAuthorizationPreparation({ request: f.request, header: f.header, inputs: result.inputs, common: f.common });
  assert.equal(prepared.recipient.delegatedTo, DELEGATE); assert.equal(prepared.recipient.delegationAccessGas, 3000n);
  assert.equal(prepared.recipient.outOfGasAt, 'delegation'); assert.equal(prepared.retained, false);
  assert.equal(prepared.processing.preparation.phase, 'recipient_out_of_gas');
  assert.equal(result.changes.accounts.some(row => row.address === AUTHORITY), false);
  validateAmsterdamAuthorizationProcessing(prepared, result.output.authorizationProcessing);
});
