import assert from 'node:assert/strict';

const object = v => { assert(v && typeof v === 'object' && !Array.isArray(v)); return v; };
const keys = (v, required, optional = []) => { object(v); assert(required.every(k => Object.hasOwn(v, k))); assert(Object.keys(v).every(k => required.includes(k) || optional.includes(k))); };
export const quantity = v => { assert.equal(typeof v, 'string'); assert.match(v, /^0x[0-9a-f]+$/i); const n = BigInt(v); assert(n < 2n ** 64n); return n; };
const hex = (v, n) => { assert.equal(typeof v, 'string'); assert.match(v, n === undefined ? /^0x(?:[0-9a-f]{2})*$/i : new RegExp(`^0x[0-9a-f]{${n * 2}}$`, 'i')); return v.toLowerCase(); };
const uint = n => { assert(Number.isSafeInteger(n) && n >= 0); return n; };
export function parseRootTrace(bytes, request) {
  assert(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 4194304);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  assert(text.endsWith('\n'), 'A complete JSONL file must end in a newline');
  const lines = text.slice(0, -1).split('\n'); assert(lines.length <= 100000);
  const stack = []; let root = null, rootEnter = null, opcodeCount = 0, frameCount = 0;
  for (let i = 0; i < lines.length; i++) {
    assert(lines[i].length > 0); const event = object(JSON.parse(lines[i]));
    assert(root === null, 'No event may follow the root exit');
    if (Object.hasOwn(event, 'type')) {
      keys(event, ['type', 'from', 'to', 'gas', 'value'], ['input']);
      assert(['CALL', 'STATICCALL', 'CALLCODE', 'DELEGATECALL', 'CREATE', 'CREATE2', 'SELFDESTRUCT'].includes(event.type));
      hex(event.from, 20); hex(event.to, 20); hex(event.input ?? '0x'); quantity(event.gas);
      assert(event.value === null || typeof event.value === 'string' && /^0x[0-9a-f]+$/i.test(event.value));
      if (event.value !== null) assert(BigInt(event.value) < 2n ** 256n);
      if (stack.length === 0) {
        assert.equal(i, 0); assert.equal(event.type, 'CALL');
        assert.equal(hex(event.from, 20), request.from); assert.equal(hex(event.to, 20), request.to);
        assert.equal(hex(event.input ?? '0x'), request.data); assert.equal(BigInt(event.value), BigInt(request.value));
        rootEnter = event;
      }
      stack.push(event); frameCount++; assert(stack.length <= 1025);
    } else if (Object.hasOwn(event, 'output')) {
      keys(event, ['output', 'gasUsed'], ['error']);
      assert(stack.length > 0); assert.equal(typeof event.output, 'string'); assert.match(event.output, /^(?:[0-9a-f]{2})*$/i);
      const used = quantity(event.gasUsed), frame = stack.pop(); assert(used <= quantity(frame.gas));
      if (event.error !== undefined) assert(typeof event.error === 'string' && event.error.length > 0 && event.error.length <= 4096);
      if (stack.length === 0) {
        assert.equal(i, lines.length - 1);
        root = { output: '0x' + event.output.toLowerCase(), gasUsed: used.toString(), error: event.error ?? null };
      }
    } else {
      keys(event, ['pc', 'op', 'gas', 'gasCost', 'memSize', 'stack', 'depth', 'refund', 'opName'], ['memory', 'error']);
      assert(stack.length > 0); uint(event.pc); assert(uint(event.op) <= 255); quantity(event.gas); quantity(event.gasCost);
      uint(event.memSize); assert.equal(event.stack, null); assert.equal(event.depth, stack.length); uint(event.refund);
      assert.equal(typeof event.opName, 'string'); if (event.memory !== undefined) assert.equal((hex(event.memory).length - 2) / 2, event.memSize);
      if (event.error !== undefined) assert.equal(typeof event.error, 'string'); opcodeCount++;
    }
  }
  assert(root !== null && rootEnter !== null && stack.length === 0, 'Missing complete root exit');
  const calldata = Buffer.from(request.data.slice(2), 'hex'), intrinsic = 21000n + [...calldata].reduce((n, b) => n + (b === 0 ? 4n : 16n), 0n);
  assert.equal(quantity(rootEnter.gas), BigInt(request.gas) - intrinsic, 'Root message gas must match exact Shanghai signed input');
  return { ...root, opcodeCount, frameCount, records: lines.length };
}
export function comparePrefix(input, count, expected, result, body, roots) {
  assert(Number.isSafeInteger(count) && count > 0 && count <= input.requests.length);
  assert.equal(body, input.prefixBodies[count - 1]); assert.equal(result.receipts.length, count); assert.equal(roots.length, count);
  assert(result.rejected === undefined || Array.isArray(result.rejected) && result.rejected.length === 0);
  assert(expected?.steps.slice(0, count).every(e => e.status === 'derived'));
  const end = expected.steps[count - 1], channels = { stateRoot: hex(result.stateRoot, 32) === end.stateRoot, logsHash: hex(result.logsHash, 32) === end.logsHash, gas: quantity(result.gasUsed) === BigInt(end.cumulativeGasUsed), execution: true, returnData: true };
  for (let i = 0; i < count; i++) {
    const receipt = result.receipts[i], e = expected.steps[i], trace = roots[i];
    assert.equal(hex(receipt.transactionHash, 32), input.signed[i].hash); assert.equal(quantity(receipt.transactionIndex), BigInt(i)); assert.equal(quantity(receipt.type), 2n);
    const status = quantity(receipt.status); assert(status === 0n || status === 1n); assert(Array.isArray(receipt.logs));
    channels.gas &&= quantity(receipt.gasUsed) === BigInt(e.gasUsed) && quantity(receipt.cumulativeGasUsed) === BigInt(e.cumulativeGasUsed) && BigInt(trace.gasUsed) === BigInt(e.execution.executionGasUsed);
    channels.execution &&= (status === 1n) === (e.execution.status === 'success') && (trace.error === null) === (e.execution.status === 'success');
    channels.returnData &&= trace.output === e.execution.returnData;
  }
  return { status: Object.values(channels).every(Boolean) ? 'matched' : 'mismatched', channels, reason: null };
}
