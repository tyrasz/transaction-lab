// Observe the pinned Amsterdam interpreter's *actual* creator nonce write.
// A CREATE step alone is insufficient: dynamic gas, static execution, balance,
// depth, nonce overflow and EOF checks can all stop it before that write.
// This is a consistency ledger, not an independently verified execution proof.
import { EVMError } from '@ethereumjs/evm';
import { Account, bigIntToBytes, bytesToHex, createAddressFromString, generateAddress, generateAddress2, KECCAK256_NULL, KECCAK256_RLP } from '@ethereumjs/util';

const MAX_WORD = (1n << 256n) - 1n;
const MAX_NONCE = (1n << 64n) - 1n;
const EMPTY_CODE = bytesToHex(KECCAK256_NULL), EMPTY_STORAGE = bytesToHex(KECCAK256_RLP);
const hex = n => '0x' + n.toString(16);
function invalid(message) {
  const error = new Error('Creation-attempt observation: ' + message);
  error.code = 'LOCAL_TRACE_INVALID';
  throw error;
}
function address(value) {
  const text = typeof value === 'string' ? value : value?.toString();
  if (typeof text !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(text)) invalid('invalid execution address');
  return text.toLowerCase();
}
function word(value) {
  if (typeof value !== 'bigint' || value < 0n || value > MAX_WORD) invalid('invalid stack word');
  return value;
}
function snapshot(account) {
  if (account === undefined) return { exists: false, nonce: 0n, balance: 0n, codeHash: EMPTY_CODE, storageRoot: EMPTY_STORAGE, codeSize: 0, version: 0 };
  if (!(account instanceof Account)) invalid('account read is not a complete Account');
  const result = { exists: true, nonce: word(account.nonce), balance: word(account.balance), codeHash: bytesToHex(account.codeHash), storageRoot: bytesToHex(account.storageRoot), codeSize: account.codeSize, version: account.version };
  if (result.nonce > MAX_NONCE || !/^0x[0-9a-f]{64}$/.test(result.codeHash) || !/^0x[0-9a-f]{64}$/.test(result.storageRoot)) invalid('invalid account facts');
  return result;
}
function collision(facts) { return facts.exists && (facts.nonce !== 0n || facts.codeHash !== EMPTY_CODE); }
function sameStackPrefix(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length + 1 && expected.every((n, i) => actual[i] === n);
}

/** Internal hooks only. The executor owns checkpoints, supplies trusted Common
 * and the real manager read, and latches every hook exception as a host failure.
 * beforePutAccount's token must be acknowledged ONLY after that write succeeds.
 * Retained rows include attempts in reverted frames; parent validation decides
 * which ancestor paths commit. No query/request can inject observer callbacks. */
export function createCreationAttemptObserver({ common, getAccount, check, bound, retain }) {
  if (!common?.isActivatedEIP(7928) || [getAccount, check, bound, retain].some(fn => typeof fn !== 'function')) invalid('trusted Amsterdam hooks are required');
  const contexts = new WeakMap(), frames = [], tokens = new WeakSet();
  let attempts = 0, finished = false;
  function context(frame) {
    const ctx = contexts.get(frame);
    if (!ctx || ctx.closed || frames.at(-1) !== ctx || finished) invalid('frame hook order is inconsistent');
    return ctx;
  }
  function resolve(ctx, values) {
    const candidate = ctx.candidate;
    if (!candidate) return;
    ctx.candidate = null;
    if (!candidate.written) {
      if (candidate.token) invalid('creator write was not acknowledged');
      return; // A zero-write candidate is deliberately absent from the ledger.
    }
    if (!candidate.targetFacts) invalid('creator write has no target observation');
    let result, disposition;
    if (collision(candidate.targetFacts)) {
      if (candidate.child) invalid('colliding target unexpectedly entered a child');
      result = 0n; disposition = 'collision';
    } else {
      if (!candidate.child || !candidate.child.closed || candidate.childResult === undefined) invalid('creator write has no completed child');
      result = candidate.childResult; disposition = 'entered';
    }
    if (!sameStackPrefix(values, candidate.prefix) || word(values.at(-1)) !== result) invalid('returned stack value does not match the observed creation');
    const facts = candidate.targetFacts;
    const row = { position: candidate.position, type: candidate.type, pc: candidate.pc, nonceBefore: hex(candidate.nonceBefore), nonceAfter: hex(candidate.nonceBefore + 1n), value: hex(candidate.value), input: bytesToHex(candidate.input), salt: candidate.salt === null ? null : bytesToHex(candidate.salt), target: candidate.target, targetBefore: { exists: facts.exists, nonce: hex(facts.nonce), codeHash: facts.codeHash, storageRoot: facts.storageRoot }, disposition, result: hex(result) };
    // Reserve the exact final serialized row, including its surrounding comma.
    retain(Buffer.byteLength(JSON.stringify(row)) + 1);
    ctx.frame.creationAttempts.push(row);
  }
  return Object.freeze({
    enterFrame(frame, message, parentFrame = null) {
      check();
      if (finished || contexts.has(frame) || !Array.isArray(frame.calls) || Object.hasOwn(frame, 'creationAttempts')) invalid('duplicate or malformed entered frame');
      const parent = frames.at(-1) ?? null;
      if ((parent?.frame ?? null) !== parentFrame) invalid('entered frame has a different parent');
      const ctx = { frame, parent, candidate: null, closed: false };
      if (parent) {
        const candidate = parent.candidate;
        if (!message.to) {
          if (!candidate?.written || !candidate.targetFacts || collision(candidate.targetFacts) || candidate.child || parentFrame.calls[candidate.position] !== frame || parentFrame.calls.length !== candidate.position + 1) invalid('creation child does not join one observed write');
          if (frame.type !== candidate.type || frame.from !== candidate.creator || address(message.caller) !== candidate.creator || message.value !== candidate.value || frame.value !== hex(candidate.value) || bytesToHex(message.data) !== bytesToHex(candidate.input) || frame.input !== bytesToHex(candidate.input) || message.depth !== parentFrame.depth + 1) invalid('creation child envelope differs from its opcode');
          const salt = message.salt === undefined ? null : bytesToHex(message.salt);
          if (salt !== (candidate.salt === null ? null : bytesToHex(candidate.salt))) invalid('creation child salt differs from its opcode');
          candidate.child = ctx;
        } else if (candidate) invalid('pending creation unexpectedly entered a non-creation child');
      }
      frame.creationAttempts = [];
      retain(22); // The field itself is retained even on frames with no attempts.
      contexts.set(frame, ctx); frames.push(ctx);
    },
    step(frame, step) {
      check(); const ctx = context(frame);
      resolve(ctx, step.stack);
      const type = step.opcode.code === 0xf0 ? 'CREATE' : step.opcode.code === 0xf5 ? 'CREATE2' : null;
      if (!type) return;
      const arity = type === 'CREATE' ? 3 : 4;
      if (!Array.isArray(step.stack)) invalid('step stack is missing');
      if (step.stack.length < arity) return; // Stack-underflow never writes nonce.
      const creator = address(step.address);
      if (creator !== frame.executionAddress || step.depth !== frame.depth || !Number.isSafeInteger(step.pc) || step.pc < 0) invalid('creation opcode is not in the active execution context');
      const stack = step.stack.map(word), nonce = word(step.account.nonce);
      if (!(step.memory instanceof Uint8Array)) invalid('step memory is missing');
      // Materialize initcode only if the nonce write is actually attempted.
      // In particular, an already-faulted dynamic-gas step with enormous memory
      // operands must not allocate memory or acquire an invented attempt row.
      ctx.candidate = { creator, type, pc: step.pc, value: stack.at(-1), offset: stack.at(-2), length: stack.at(-3), saltWord: type === 'CREATE2' ? stack.at(-4) : null, prefix: stack.slice(0, -arity), memory: step.memory, nonceBefore: nonce, position: frame.calls.length, written: false };
    },
    async beforePutAccount(frame, accountAddress, nextAccount) {
      check();
      if (!frame) return null; // Transaction preparation and finalization.
      const ctx = context(frame), candidate = ctx.candidate;
      if (!candidate || address(accountAddress) !== candidate.creator) return null;
      if (candidate.written) invalid('unjoined second creator write before opcode completion');
      if (candidate.token) invalid('overlapping creator writes');
      const current = snapshot(await getAccount(createAddressFromString(candidate.creator)));
      check(); const next = snapshot(nextAccount);
      if (!current.exists || current.nonce !== candidate.nonceBefore || current.nonce >= MAX_NONCE || next.nonce !== current.nonce + 1n || !next.exists || ['balance', 'codeHash', 'storageRoot', 'codeSize', 'version'].some(key => current[key] !== next[key])) invalid('creator write is not exactly one nonce increment');
      bound('calldataBytes', candidate.length);
      if (candidate.length !== 0n) bound('memoryBytes', candidate.offset + candidate.length);
      // Even a supplied budget hook cannot make Number conversion unsafe.
      if (candidate.length > BigInt(Number.MAX_SAFE_INTEGER) || (candidate.length !== 0n && candidate.offset + candidate.length > BigInt(Number.MAX_SAFE_INTEGER))) invalid('creation memory range is not representable');
      const input = new Uint8Array(Number(candidate.length));
      if (candidate.length !== 0n) input.set(candidate.memory.subarray(Number(candidate.offset), Number(candidate.offset + candidate.length)));
      const salt = candidate.saltWord === null ? null : Uint8Array.from(Buffer.from(candidate.saltWord.toString(16).padStart(64, '0'), 'hex'));
      const from = createAddressFromString(candidate.creator).bytes;
      candidate.input = input; candidate.salt = salt;
      candidate.target = bytesToHex(salt === null ? generateAddress(from, bigIntToBytes(current.nonce)) : generateAddress2(from, salt, input));
      // Drop the large detached step memory once the bounded initcode is copied.
      candidate.memory = null;
      const token = { ctx, candidate }; tokens.add(token); candidate.token = token;
      return token;
    },
    afterPutAccount(token) {
      check();
      if (!tokens.has(token) || token.ctx.candidate !== token.candidate || token.candidate.written || frames.at(-1) !== token.ctx) invalid('unknown or repeated creator write acknowledgement');
      tokens.delete(token); token.candidate.token = null;
      token.candidate.written = true;
      bound('frames', ++attempts);
      // Bound pending initcode before a child/collision result is available.
      retain(token.candidate.input.length * 2);
    },
    afterGetAccount(frame, accountAddress, account) {
      check();
      if (!frame) return;
      const candidate = context(frame).candidate;
      if (!candidate?.written || candidate.targetFacts) return;
      if (address(accountAddress) !== candidate.target) invalid('creator write was not followed by its target read');
      candidate.targetFacts = snapshot(account);
    },
    exitFrame(frame, result) {
      check(); const ctx = context(frame);
      resolve(ctx, result.execResult.runState?.stack?.getStack());
      ctx.closed = true; frames.pop();
      const candidate = ctx.parent?.candidate;
      if (candidate?.child === ctx) {
        const created = result.createdAddress === undefined ? null : address(result.createdAddress);
        if (created !== null && created !== candidate.target) invalid('creation child returned a different address');
        if (frame.to !== created || frame.executionAddress !== created) invalid('creation frame address differs from its result');
        const error = result.execResult.exceptionError?.error;
        const success = error === undefined || error === EVMError.errorMessages.CODESTORE_OUT_OF_GAS;
        if (success && created === null) invalid('successful creation returned no address');
        candidate.childResult = success ? BigInt(candidate.target) : 0n;
      }
    },
    finish() {
      check();
      if (finished || frames.length !== 0) invalid('execution ended with unresolved creation frames');
      finished = true;
    },
  });
}
