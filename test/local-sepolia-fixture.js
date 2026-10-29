// Initial-only synthetic proof provider for real API/isolated execution controls.
// This file does not register tests, call a public endpoint or execute a VM.
import assert from 'node:assert/strict';
import { ProofRpcClient } from '../src/proof-rpc.js';
import { amsterdamExecutionFixture, TX_SENDER, TARGET } from '../engines/local-evm/test/amsterdam-execution-fixture.js';
export { TX_SENDER, TARGET, COINBASE } from '../engines/local-evm/test/amsterdam-execution-fixture.js';

export const CHAIN = 11155111, native = account => ({ kind: 'native_balance', account });
export const sepoliaApiInput = (f, options = {}) => ({ chainId: CHAIN, ...f.request, block: 'latest', queries: [native(TX_SENDER), native(TARGET)], ...options });
export async function sepoliaApiFixture(options = {}) {
  return amsterdamExecutionFixture({ priced: false, value: '17', gas: '21000', target: { nonce: 1n, balance: 9n, code: '0x' }, ...options });
}
export function sepoliaApiTransport(f, { rpcChain = '0xaa36a7', initialHeader, finalHeader, failProof = false } = {}) {
  const wires = [], failures = []; let headers = 0;
  const fetchImpl = async (_url, options) => {
    try {
      const q = JSON.parse(options.body); wires.push(q);
      assert.equal(q.id, wires.length); assert.equal(q.jsonrpc, '2.0');
      assert.equal(options.redirect, 'error'); let result, error;
      if (q.method === 'eth_chainId') { assert.equal(wires.length, 1); assert.deepEqual(q.params, []); result = rpcChain; }
      else if (['eth_getBlockByNumber', 'eth_getBlockByHash'].includes(q.method)) {
        headers++;
        if (headers === 1) { assert.equal(wires.length, 2); result = initialHeader ? initialHeader(f.header) : f.header; }
        else { assert.equal(headers, 2); assert.equal(q.method, 'eth_getBlockByNumber'); assert.deepEqual(q.params, [f.header.number, false]); result = finalHeader ? finalHeader(f.header) : f.header; }
      } else {
        assert(['eth_getProof', 'eth_getCode'].includes(q.method));
        assert.deepEqual(q.params.at(-1), { blockHash: f.header.hash, requireCanonical: true });
        if (failProof) error = { code: -32000, message: 'synthetic proof failure' };
        else result = await f.rpc.call(q.method, q.params);
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: q.id, ...(error ? { error } : { result }) }));
    } catch (error) { failures.push(error.message); throw error; }
  };
  const rpc = new ProofRpcClient({ chainId: CHAIN, url: 'https://synthetic.invalid', fetchImpl });
  return { rpc, fetchImpl, wires, failures, check(report) {
    assert.deepEqual(failures, [], 'Fixture assertion failures must not be swallowed by the API');
    assert.equal(report.transportEvidence.length, wires.length); assert.equal(report.drain.complete, true);
    report.transportEvidence.forEach((row, i) => assert.deepEqual(JSON.parse(row.requestText), wires[i]));
  } };
}
