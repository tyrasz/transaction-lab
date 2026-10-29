// Hook-contract controls. Actual bytecode, signed-VM and isolated-parent cases
// live separately in amsterdam-creation-attempts.test.js; these synthetic hook
// sequences deliberately exercise inconsistencies a correct EVM cannot emit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Account, bigIntToBytes, bytesToHex, createAddressFromString, generateAddress, generateAddress2, KECCAK256_NULL, KECCAK256_RLP } from '@ethereumjs/util';
import { createCreationAttemptObserver } from '../creation-attempt-observer.js';

const CREATOR = '0x1111111111111111111111111111111111111111', OTHER = '0x2222222222222222222222222222222222222222';
const addr = createAddressFromString, hex = n => '0x' + n.toString(16), bytes = h => Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'));
const copy = a => a === undefined ? undefined : new Account(a.nonce, a.balance, new Uint8Array(a.storageRoot), new Uint8Array(a.codeHash), a.codeSize, a.version);
const common = { isActivatedEIP: n => n === 7928 };
const final = (values = [], error) => ({ execResult: { ...(error === undefined ? {} : { exceptionError: { error } }), runState: { stack: { getStack: () => values } } } });
function fixture({ account = new Account(7n, 1000n), limits = {}, check = () => {}, getAccount } = {}) {
  let reads = 0, retained = 0;
  const f = { account, reads: () => reads, retained: () => retained, limits: { frames: 1000, calldataBytes: 32768, memoryBytes: 1048576, traceBytes: 8388608, ...limits } };
  f.observer = createCreationAttemptObserver({ common, check, getAccount: async address => { reads++; assert.equal(address.toString(), CREATOR); return getAccount ? getAccount() : copy(f.account); }, bound: (name, n) => { if (n > f.limits[name]) throw Error('limit:' + name); }, retain: n => { retained += n; if (retained > f.limits.traceBytes) throw Error('limit:traceBytes'); } });
  f.frame = { type: 'CALL', from: OTHER, to: CREATOR, executionAddress: CREATOR, caller: OTHER, input: '0x', value: '0x0', depth: 0, calls: [] };
  f.observer.enterFrame(f.frame, { to: addr(CREATOR) });
  return f;
}
function arm(f, { type = 'CREATE2', length = 2n, offset = 1n, value = 3n, salt = 9n, memory = bytes('006000'), prefix = [42n], pc = 19, stack } = {}) {
  const arity = type === 'CREATE2' ? 4 : 3;
  const values = stack ?? [...prefix, ...(arity === 4 ? [salt] : []), length, offset, value];
  f.observer.step(f.frame, { opcode: { code: type === 'CREATE2' ? 0xf5 : 0xf0 }, stack: values, address: addr(CREATOR), account: copy(f.account), depth: 0, pc, memory });
  const init = new Uint8Array(Number(length <= 32768n ? length : 0n));
  if (init.length) init.set(memory.subarray(Number(offset), Number(offset + length)));
  const saltBytes = type === 'CREATE2' ? bytes(salt.toString(16).padStart(64, '0')) : null;
  const target = bytesToHex(saltBytes ? generateAddress2(addr(CREATOR).bytes, saltBytes, init) : generateAddress(addr(CREATOR).bytes, bigIntToBytes(f.account?.nonce ?? 7n)));
  return { type, target, init, saltBytes, value, prefix, position: f.frame.calls.length };
}
async function write(f, next = (() => { const a = copy(f.account); a.nonce++; return a; })()) {
  const token = await f.observer.beforePutAccount(f.frame, addr(CREATOR), next);
  f.account = copy(next); f.observer.afterPutAccount(token); return token;
}
function targetRead(f, attempt, account) { f.observer.afterGetAccount(f.frame, addr(attempt.target), account); }
function child(f, a, { error, created = a.target, mutate = () => {} } = {}) {
  const frame = { type: a.type, from: CREATOR, caller: CREATOR, to: null, executionAddress: null, value: hex(a.value), input: bytesToHex(a.init), depth: 1, calls: [] };
  const message = { caller: addr(CREATOR), value: a.value, data: a.init, depth: 1, ...(a.saltBytes ? { salt: a.saltBytes } : {}) };
  mutate(frame, message); f.frame.calls.push(frame); f.observer.enterFrame(frame, message, f.frame);
  frame.to = created; frame.executionAddress = created; frame.error = error ?? null;
  const result = final([], error); if (created !== null) result.createdAddress = addr(created);
  f.observer.exitFrame(frame, result); return frame;
}
function finish(f, values) { f.observer.exitFrame(f.frame, final(values)); f.observer.finish(); }

test('observer binds successful CREATE/CREATE2 writes, detached target facts and terminal result stacks', async () => {
  for (const type of ['CREATE', 'CREATE2']) {
    const f = fixture(), a = arm(f, { type }); await write(f); const target = new Account(0n, 55n);
    targetRead(f, a, target); target.nonce = 99n; // Snapshot must not retain a mutable Account.
    child(f, a); finish(f, [...a.prefix, BigInt(a.target)]);
    assert.deepEqual(f.frame.creationAttempts, [{ position: 0, type, pc: 19, nonceBefore: '0x7', nonceAfter: '0x8', value: '0x3', input: '0x6000', salt: a.saltBytes ? bytesToHex(a.saltBytes) : null, target: a.target, targetBefore: { exists: true, nonce: '0x0', codeHash: bytesToHex(KECCAK256_NULL), storageRoot: bytesToHex(KECCAK256_RLP) }, disposition: 'entered', result: hex(BigInt(a.target)) }]);
    assert.equal(f.reads(), 1); assert.deepEqual(f.frame.calls[0].creationAttempts, []);
  }
});

test('only acknowledged nonce writes produce attempts; zero-write huge-memory and underflow candidates disappear', async () => {
  const f = fixture(); arm(f, { length: (1n << 256n) - 1n, offset: (1n << 256n) - 1n });
  f.observer.step(f.frame, { opcode: { code: 0x00 }, stack: [] });
  arm(f, { stack: [0n] }); finish(f, []);
  assert.equal(f.reads(), 0); assert.deepEqual(f.frame.creationAttempts, []);
  const g = fixture(); arm(g); const next = copy(g.account); next.nonce++;
  await g.observer.beforePutAccount(g.frame, addr(CREATOR), next);
  assert.throws(() => finish(g, [42n, 0n]), /not acknowledged/);
});

test('collision facts cover nonce, code and storage; repeated collisions share the unconsumed child position', async () => {
  const f = fixture();
  for (const target of [new Account(1n), new Account(0n, 0n, KECCAK256_RLP, new Uint8Array(32).fill(1)), new Account(0n, 0n, new Uint8Array(32).fill(2))]) {
    const a = arm(f); await write(f); targetRead(f, a, target);
    // Subsequent reads must never replace the actual first collision snapshot.
    targetRead(f, a, undefined);
    f.observer.step(f.frame, { opcode: { code: 0x00 }, stack: [42n, 0n] });
  }
  finish(f, []); assert.equal(f.frame.calls.length, 0); assert.equal(f.frame.creationAttempts.length, 3);
  assert.deepEqual(f.frame.creationAttempts.map(r => [r.position, r.nonceBefore, r.result, r.disposition]), [[0, '0x7', '0x0', 'collision'], [0, '0x8', '0x0', 'collision'], [0, '0x9', '0x0', 'collision']]);
});

test('constructor faults retain the own-parent attempt and bind zero; pinned code-store exception binds address', async () => {
  for (const error of ['revert', 'out of gas', 'code store out of gas']) {
    const f = fixture(), a = arm(f); await write(f); targetRead(f, a, undefined); child(f, a, { error });
    finish(f, [42n, error === 'code store out of gas' ? BigInt(a.target) : 0n]);
    assert.equal(f.frame.creationAttempts[0].result, error === 'code store out of gas' ? hex(BigInt(a.target)) : '0x0');
  }
});

test('creator reads are limited to armed matching writes, and every unchanged account field is bound', async () => {
  const f = fixture(); assert.equal(await f.observer.beforePutAccount(undefined, addr(CREATOR), new Account()), null);
  assert.equal(await f.observer.beforePutAccount(f.frame, addr(CREATOR), new Account()), null);
  arm(f); assert.equal(await f.observer.beforePutAccount(f.frame, addr(OTHER), new Account()), null); assert.equal(f.reads(), 0);
  for (const alter of [a => a.nonce += 2n, a => { a.nonce++; a.balance++; }, a => { a.nonce++; a.codeHash = new Uint8Array(32); }, a => { a.nonce++; a.storageRoot = new Uint8Array(32); }, a => { a.nonce++; a.version++; }, a => { a.nonce++; a.codeSize++; }]) {
    const g = fixture(); arm(g); const next = copy(g.account); alter(next);
    await assert.rejects(g.observer.beforePutAccount(g.frame, addr(CREATOR), next), /exactly one nonce increment/);
  }
  const absent = fixture({ getAccount: () => undefined }); arm(absent);
  await assert.rejects(absent.observer.beforePutAccount(absent.frame, addr(CREATOR), new Account(8n, 1000n)), /exactly one nonce increment/);
  const repeated = fixture(); arm(repeated); const token = await write(repeated);
  assert.throws(() => repeated.observer.afterPutAccount(token), /unknown or repeated/);
  await assert.rejects(repeated.observer.beforePutAccount(repeated.frame, addr(CREATOR), copy(repeated.account)), /unjoined second creator write/);
});

test('zero-length initcode ignores huge offset, and short pre-op memory supplies zero-padded initcode', async () => {
  for (const opts of [{ length: 0n, offset: (1n << 256n) - 1n }, { length: 4n, offset: 2n, memory: bytes('006000') }]) {
    const f = fixture(), a = arm(f, opts); await write(f); targetRead(f, a, undefined); child(f, a); finish(f, [42n, BigInt(a.target)]);
    assert.equal(f.frame.creationAttempts[0].input, opts.length === 0n ? '0x' : '0x00000000');
  }
});

test('wrong target, missing target, orphan creation and colliding child are rejected', async () => {
  for (const mode of ['wrong', 'missing', 'collision']) {
    const f = fixture(), a = arm(f); await write(f);
    if (mode === 'wrong') assert.throws(() => f.observer.afterGetAccount(f.frame, addr(OTHER), undefined), /target read/);
    if (mode === 'missing') assert.throws(() => finish(f, [42n, 0n]), /no target observation/);
    if (mode === 'collision') { targetRead(f, a, new Account(1n)); assert.throws(() => child(f, a), /does not join/); }
  }
  const f = fixture(), a = arm(f); assert.throws(() => child(f, a), /does not join/);
});

test('child joins reject altered type, input, value, sender, depth, salt and returned address', async () => {
  for (const mutate of [(f, m) => { f.type = 'CREATE'; }, (f, m) => { m.data = bytes('00'); }, (f, m) => { m.value++; }, (f, m) => { m.caller = addr(OTHER); }, (f, m) => { m.depth++; }, (f, m) => { m.salt = new Uint8Array(32); }]) {
    const f = fixture(), a = arm(f); await write(f); targetRead(f, a, undefined); assert.throws(() => child(f, a, { mutate }), /differs|envelope/);
  }
  const f = fixture(), a = arm(f); await write(f); targetRead(f, a, undefined); assert.throws(() => child(f, a, { created: OTHER }), /different address/);
});

test('resolution rejects wrong result, changed stack prefix, missing terminal stack and unfinished child', async () => {
  for (const values of [[42n, 0n], [43n], undefined]) {
    const f = fixture(), a = arm(f); await write(f); targetRead(f, a, undefined); child(f, a);
    assert.throws(() => f.observer.exitFrame(f.frame, values === undefined ? { execResult: {} } : final(values)), /returned stack value/);
  }
  const f = fixture(), a = arm(f); await write(f); targetRead(f, a, undefined);
  assert.throws(() => finish(f, [42n, BigInt(a.target)]), /no completed child/);
  const g = fixture(); assert.throws(() => g.observer.finish(), /unresolved creation frames/);
});

test('attempt count, pending bytes, final trace bytes, memory and calldata obey supplied ceilings', async () => {
  for (const [limits, expected, opts] of [[{ calldataBytes: 1 }, 'calldataBytes', {}], [{ memoryBytes: 2 }, 'memoryBytes', {}], [{ frames: 0 }, 'frames', {}], [{ traceBytes: 23 }, 'traceBytes', {}]]) {
    const f = fixture({ limits }); arm(f, opts); await assert.rejects(write(f), new RegExp('limit:' + expected));
  }
  const f = fixture({ limits: { traceBytes: 100 } }), a = arm(f); await write(f); targetRead(f, a, new Account(1n));
  assert.throws(() => finish(f, [42n, 0n]), /limit:traceBytes/);
});

test('host errors and nullish throws propagate unchanged through reads and budget hooks', async () => {
  for (const error of [new Error('host'), null, undefined]) {
    const f = fixture({ getAccount() { throw error; } }); arm(f);
    let caught = false; try { await write(f); } catch (actual) { caught = true; assert.equal(actual, error); } assert(caught);
    let active = false; const g = fixture({ check() { if (active) throw error; } }); active = true;
    caught = false; try { g.observer.finish(); } catch (actual) { caught = true; assert.equal(actual, error); } assert(caught);
  }
  assert.throws(() => createCreationAttemptObserver({ common: { isActivatedEIP: () => false } }), /trusted Amsterdam/);
});
