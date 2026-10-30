import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { ethereumStateGasBudget, settleEthereumStateGas } from '../ethereum-state-gas.js';
import { executeIsolatedEthereumCall } from '../isolated-call.js';
import { commonForStateGas } from './state-gas-fixture.js';
import { feeFixture } from './fee-fixture.js';

const sha = b => createHash('sha256').update(b).digest('hex');
const capture = new URL('../../../research/amsterdam-authorization-geth-v032/capture/', import.meta.url);
const MANIFEST = '3837d41a5055fd9edb13f2412f96a33660aa2fbad4beb9d3cd1eeb9e3e672f5a';
const max = (a,b) => a > b ? a : b;
function retainedEmptyAuthority() {
  const bytes = readFileSync(new URL('manifest.json', capture)); assert.equal(sha(bytes), MANIFEST);
  const manifest = JSON.parse(bytes);
  const read = path => {
    const entry = manifest.files.find(f => f.path === path), b = readFileSync(new URL(path,capture));
    assert(entry && entry.kind === 'file'); assert.equal(b.length,entry.bytes); assert.equal(sha(b),entry.sha256); return JSON.parse(b);
  };
  const raw = read('product/001.json'), seal = read('product/001.json.seal.json');
  const saved = readFileSync(new URL('product/001.json',capture)); assert.equal(sha(saved),seal.sha256);
  const out = Buffer.from(raw.stdout.base64,'base64'); assert.equal(out.toString('base64'),raw.stdout.base64);
  assert.equal(out.length,raw.stdout.bytes); assert.equal(sha(out),raw.stdout.sha256);
  const product = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(out));
  assert.equal(product.id,'existing_empty_install'); assert.equal(product.attempt.status,'completed');
  const original = product.attempt.output.stateGasAccounting;
  const bigints = value => Object.fromEntries(Object.entries(value).map(([k,v]) => [k,typeof v === 'boolean' ? v : BigInt(v)]));
  return { original, current: settleEthereumStateGas(bigints(original.budget),bigints(original.counters)), geth:read('geth/001/result.json') };
}

test('retained independent Geth evidence separates 250606 receipt/scalar gas from 218790 single-transaction block gas', () => {
  // Artifact-only use of the already executed, sealed independent-client
  // comparison. No product, full VM or Geth execution occurs in this control.
  const {original,current,geth} = retainedEmptyAuthority();
  assert.equal(original.settled.blockGasUsed,'250606','Historical capture remains unchanged');
  assert.equal(current.gasUsed,250606n); assert.equal(current.preRefundGasWithFloor,250606n);
  assert.equal(current.regularGasUsed,31816n); assert.equal(current.stateGasUsed,218790n);
  assert.equal(current.singleTransactionBlockGasUsed,218790n); assert.equal(Object.hasOwn(current,'blockGasUsed'),false);
  assert.equal(BigInt(geth.receipts[0].gasUsed),current.gasUsed);
  assert.equal(BigInt(geth.gasUsed),current.singleTransactionBlockGasUsed);
  for (const [key,value] of Object.entries(original.settled)) if (key !== 'blockGasUsed') assert.equal(current[key],BigInt(value));
});

test('multi-transaction arithmetic accumulates regular/state dimensions before taking a block maximum', () => {
  // Arithmetic examples only. The retained row and synthetic counters below
  // are NOT a claim that these transactions executed together in one block.
  const stateHeavy = retainedEmptyAuthority().current;
  const budget = ethereumStateGasBudget({gasLimit:5000000n,intrinsicRegular:15000n,floor:15000n},commonForStateGas());
  const counters = {messageGasUsed:235000n,authorizationGasUsed:0n,stateGasReservoir:0n,executionStateGasUsed:0n,
    messageRefundCounter:0n,authorizationRefundCounter:0n,postTargetOutOfGas:false};
  const regularHeavy = settleEthereumStateGas(budget,counters);
  const accumulate = rows => {
    const sum = rows.reduce((s,r) => ({regular:s.regular+r.regularGasUsed,state:s.state+r.stateGasUsed}),{regular:0n,state:0n});
    return {...sum,blockGas:max(sum.regular,sum.state)};
  };
  const both = accumulate([stateHeavy,regularHeavy]);
  assert.deepEqual(both,{regular:281816n,state:218790n,blockGas:281816n});
  assert.equal(stateHeavy.singleTransactionBlockGasUsed+regularHeavy.singleTransactionBlockGasUsed,468790n);
  assert.equal(stateHeavy.preRefundGasWithFloor+regularHeavy.preRefundGasWithFloor,500606n);
  assert.notEqual(both.blockGas,468790n); assert.notEqual(both.blockGas,500606n);
  assert.deepEqual(accumulate([regularHeavy,stateHeavy]),both);
  const stateDominant = accumulate([stateHeavy,stateHeavy,regularHeavy]);
  assert.deepEqual(stateDominant,{regular:313632n,state:437580n,blockGas:437580n});
  const floored = settleEthereumStateGas({...budget,floor:50000n},
    {...counters,messageGasUsed:100000n,executionStateGasUsed:80000n,messageRefundCounter:30000n});
  assert.equal(floored.regularGasUsed,50000n); assert.equal(floored.stateGasUsed,80000n);
  assert.equal(floored.preRefundGasWithFloor,115000n); assert.equal(floored.singleTransactionBlockGasUsed,80000n);
  assert.equal(floored.gasUsed,92000n,'Receipt refund must not reduce either block dimension');
  assert.deepEqual(accumulate([floored,regularHeavy]),{regular:300000n,state:80000n,blockGas:300000n});
});

test('actual historical mainnet child keeps its existing scalar gas accounting shape', async () => {
  const f = await feeFixture(), result = await executeIsolatedEthereumCall({request:f.request,header:f.header,rpc:f.rpc});
  assert.equal(result.status,'completed',JSON.stringify(result.error)); assert.equal(result.output.execution.status,'success');
  assert.equal(result.output.stateGasAccounting,undefined);
  assert.deepEqual(Object.keys(result.output.gasAccounting).sort(),['appliedRefund','beforeRefund','floorAdjustment','gasUsed'].sort());
  assert.equal(result.output.gasAccounting.gasUsed,'21000');
});
