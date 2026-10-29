import fs from 'node:fs';
import assert from 'node:assert/strict';
import { encodeDeployData, encodeFunctionData, decodeFunctionData } from 'viem';
import { deploylessCallViaBytecodeBytecode } from './node_modules/viem/_esm/constants/contracts.js';

export const ENDPOINT = 'https://arb1.arbitrum.io/rpc';
export const LIMITS = Object.freeze({ calls: 20, responseBytes: 4 * 1024 * 1024, totalBytes: 16 * 1024 * 1024, requestBytes: 128 * 1024, requestMs: 25000, overallMs: 120000,
  viemDispatchMs: 110000, finalReserveCalls: 1, finalReserveMs: 10000, retainedOutputBytes: 24 * 1024 * 1024 });
export const USDC = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
export const ZERO = '0x' + '00'.repeat(20);
export const METHODS = ['eth_chainId', 'eth_getBlockByNumber', 'eth_call', 'eth_getBalance', 'eth_getCode', 'eth_simulateV1'];
const source = fs.readFileSync(new URL('./node_modules/viem/_esm/actions/public/simulateCalls.js', import.meta.url), 'utf8');
function literal(name) { const matches = [...source.matchAll(new RegExp(`const ${name} = '(0x[0-9a-f]+)'`, 'g'))]; assert.equal(matches.length, 1); return matches[0][1]; }
export const STATIC_CODE = literal('staticCallCode'), BALANCE_CODE = literal('getBalanceCode');
const STATIC_ABI = [{ type: 'function', name: 'query', stateMutability: 'view', inputs: [{ type: 'address', name: 'target' }, { type: 'bytes', name: 'data' }], outputs: [] }];
const GET_BALANCE_ABI = [{ type: 'function', name: 'getBalance', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }];
export function nativeProbe(sender) { return encodeDeployData({ abi: [{ type: 'constructor', inputs: [{ type: 'bytes' }, { type: 'bytes' }] }], bytecode: deploylessCallViaBytecodeBytecode,
  args: [BALANCE_CODE, encodeFunctionData({ abi: GET_BALANCE_ABI, functionName: 'getBalance', args: [sender] })] }); }
export const balanceData = sender => '0x70a08231' + sender.slice(2).padStart(64, '0');
export const allowanceData = (sender, spender) => '0xdd62ed3e' + sender.slice(2).padStart(64, '0') + spender.slice(2).padStart(64, '0');
export const originalCall = s => ({ from: s.from, to: s.to, data: s.data, value: '0x0', gas: '0x1e8480', gasPrice: '0x0' });
const keys = (o, allowed) => { assert.ok(o && typeof o === 'object' && !Array.isArray(o)); assert.ok(Object.keys(o).every(k => allowed.includes(k)), 'Unexpected request field.'); };
export function validateRequest({ method, params, phase, selected, scenario }) {
  assert.ok(METHODS.includes(method), 'Method outside read-only allowlist.'); assert.ok(Array.isArray(params));
  if (phase === 'selection') {
    assert.ok(method === 'eth_chainId' || method === 'eth_getBlockByNumber');
    assert.deepEqual(params, method === 'eth_chainId' ? [] : ['latest', false]); return [];
  }
  assert.ok(selected && /^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(selected.number));
  if (phase === 'final') { assert.equal(method, 'eth_getBlockByNumber'); assert.deepEqual(params, [selected.number, false]); return []; }
  assert.equal(params[1], selected.number, 'All state/simulation reads must remain pinned to the selected number.');
  if (phase === 'prechecks') {
    if (method === 'eth_getBalance' || method === 'eth_getCode') { assert.deepEqual(params, [scenario.from, selected.number]); return []; }
    assert.equal(method, 'eth_call'); assert.equal(params.length, 2);
    assert.ok([balanceData(scenario.from), allowanceData(scenario.from, scenario.to)].includes(params[0]?.data));
    assert.deepEqual(params[0], { to: USDC, data: params[0].data }); return [];
  }
  assert.equal(phase, 'viem'); assert.ok(method === 'eth_call' || method === 'eth_simulateV1');
  const overrides = [];
  function codeOverride(value) {
    if (value === undefined) return;
    const entries = Object.entries(value); assert.equal(entries.length, 1);
    for (const [address, state] of entries) {
      assert.match(address, /^0x[0-9a-f]{40}$/); const n = BigInt(address);
      assert.ok(n >= 0xdeadbeefn && n <= 0xdeadbeefn + 32n, 'Unexpected helper scratch address.');
      assert.ok(![scenario.from, scenario.to, USDC].includes(address));
      assert.deepEqual(state, { code: STATIC_CODE }, 'Only the pinned code-only measurement helper is permitted.');
      overrides.push({ address, code: state.code });
    }
  }
  function helper(call, native = false) {
    if (native) { keys(call, ['from', 'data']); assert.equal(call.data, nativeProbe(scenario.from)); if (call.from !== undefined) assert.equal(call.from, scenario.from); return; }
    keys(call, ['from', 'to', 'data', 'gas']); if (call.from !== undefined) assert.equal(call.from, ZERO);
    assert.match(call.to, /^0x[0-9a-f]{40}$/); assert.ok(BigInt(call.to) >= 0xdeadbeefn && BigInt(call.to) <= 0xdeadbeefn + 32n); assert.equal(call.gas, '0xf4240');
    const decoded = decodeFunctionData({ abi: STATIC_ABI, data: call.data }); assert.equal(decoded.functionName, 'query');
    assert.ok([balanceData(scenario.from), '0x313ce567', '0x95d89b41', '0xc87b56dd' + '0'.repeat(64)].includes(decoded.args[1]));
  }
  if (method === 'eth_call') {
    assert.ok(params.length === 2 || params.length === 3); codeOverride(params[2]);
    helper(params[0], params[0].to === undefined); if (params[0].to !== undefined) assert.ok(overrides.some(row => row.address === params[0].to));
  } else {
    assert.equal(params.length, 2); const options = params[0]; keys(options, ['blockStateCalls', 'traceTransfers', 'validation']);
    assert.equal(options.validation, false); assert.equal(options.traceTransfers, true);
    const blocks = options.blockStateCalls; assert.ok(Array.isArray(blocks) && [1, 6].includes(blocks.length));
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i]; keys(block, ['calls', 'stateOverrides']); assert.ok(Array.isArray(block.calls) && block.calls.length <= 12); codeOverride(block.stateOverrides);
      if (i === 0) {
        assert.equal(block.stateOverrides, undefined); assert.equal(block.calls.length, blocks.length === 1 ? 1 : 2);
        assert.deepEqual(block.calls[0], originalCall(scenario));
        if (block.calls.length === 2) assert.deepEqual(block.calls[1], { from: scenario.from, to: ZERO });
      } else if (i === 1) { assert.equal(block.stateOverrides, undefined); assert.equal(block.calls.length, 1); helper(block.calls[0], true); }
      else {
        assert.ok(block.stateOverrides); for (const call of block.calls) { helper(call); assert.ok(Object.hasOwn(block.stateOverrides, call.to)); }
      }
    }
  }
  return overrides;
}
