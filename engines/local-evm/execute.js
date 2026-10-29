// Experimental message execution. No provider trace, expected output, outer
// transaction signature or broadcast enters this module. Fee settlement is an
// explicit opt-in; the legacy unsigned/unpriced profile stays unchanged.
// Explicit bounded EIP-7702 authorization signatures are processed separately.
import { performance } from 'node:perf_hooks';
import { createCustomCommon, Hardfork, Mainnet } from '@ethereumjs/common';
import { createEVM, EVMError } from '@ethereumjs/evm';
import { Account, bytesToHex, createAddressFromString, hexToBytes } from '@ethereumjs/util';
import { ethereumCommon, ethereumContextProfile, ethereumCallGas, ethereumUsedGas } from './ethereum-profile.js';
import { normalizeEvmContext } from '../evm-context.js';
import { EMPTY_STORAGE_ROOT } from './verified-state-proof.js';
import { existingDelegationTarget } from './sender-delegation.js';
import { normalizeAuthorizationList, recoverAuthorization, authorizationStateDecision } from './authorization-list.js';
import { normalizeEthereumFees, ethereumFeePlan, settleEthereumFees } from './ethereum-fees.js';
import { verifyKzgProof } from './kzg-point-evaluation.js';
import { guardKzgVerifier } from './kzg-runtime.js';
import { createGuardedBls } from './bls-runtime.js';
import { P256_ADDRESS, createP256Precompile } from './p256-runtime.js';

export const EXECUTION_LIMITS = Object.freeze({ gas: 5000000, steps: 1000000, frames: 1000, depth: 32, logs: 2000, memoryBytes: 1048576, returnBytes: 1048576, calldataBytes: 32768, traceBytes: 8388608, wallMs: 10000 });
export const ETHEREUM_EXECUTION_LIMITS = Object.freeze({ ...EXECUTION_LIMITS, wallMs: 120000 });
const ADDRESS = /^0x[0-9a-f]{40}$/i, WORD = /^0x[0-9a-f]{64}$/i, BYTES = /^0x(?:[0-9a-f]{2})*$/i;
const CORE_WRITER = '0x3333333333333333333333333333333333333333';
const UINT256_MAX = (1n << 256n) - 1n;
const activeManagers = new WeakSet();
const evmErrors = new Set(Object.values(EVMError.errorMessages));
const callOpcodes = new Map([[0xf1, 'CALL'], [0xf2, 'CALLCODE'], [0xf4, 'DELEGATECALL'], [0xfa, 'STATICCALL']]);
const createOpcodes = new Map([[0xf0, 'CREATE'], [0xf5, 'CREATE2']]);
const hex = value => '0x' + BigInt(value).toString(16);
const address = value => typeof value === 'string' && ADDRESS.test(value) ? value.toLowerCase() : null;
const quantity = value => typeof value === 'bigint' && value >= 0n && value <= UINT256_MAX ? value : typeof value === 'string' && value.length <= 80 && /^(?:0x[0-9a-f]+|[0-9]+)$/i.test(value) && BigInt(value) <= UINT256_MAX ? BigInt(value) : Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
class ExecutionError extends Error {
  constructor(code, message, status = 'unavailable') { super(message); this.code = code; this.status = status; }
}
const reject = (code, message, status) => { throw new ExecutionError(code, message, status); };
function supportedAddress(value, chainId) {
  const target = typeof value === 'string' ? address(value) : value?.toString?.();
  if (!target || !ADDRESS.test(target)) return;
  const n = BigInt(target);
  // Official HyperCore reads start at0x0800. Reserve the whole0x08xx band,
  // including unknown future entries, instead of interpreting them as EOAs.
  if (chainId === 999 && n >= 0x800n && n <= 0x8ffn) reject('LOCAL_HYPERCORE_UNSUPPORTED', 'HyperCore read precompile execution is unsupported.', 'unsupported');
  if (chainId === 999 && target.toLowerCase() === CORE_WRITER) reject('LOCAL_COREWRITER_UNSUPPORTED', 'CoreWriter execution and HyperCore effects are unsupported.', 'unsupported');
  if (chainId === 999 && n === 10n) reject('LOCAL_BLOB_UNSUPPORTED', 'The KZG point-evaluation precompile is outside the legacy HyperEVM profile.', 'unsupported');
}
function safeFailure(error) {
  if (error instanceof ExecutionError) return { status: error.status, error: { code: error.code, message: error.message } };
  if (error?.code === 'LOCAL_STATE_MISSING') return { status: 'unavailable', error: { code: 'LOCAL_STATE_MISSING', message: 'Required local input state was not supplied.' } };
  if (error?.code === 'LOCAL_STATE_UNSUPPORTED') return { status: 'unsupported', error: { code: 'LOCAL_STATE_UNSUPPORTED', message: 'The supplied sparse state adapter does not support this state change.' } };
  return { status: 'unavailable', error: { code: 'LOCAL_EXECUTION_FAILED', message: 'Local execution could not complete; arbitrary host error details are omitted.' } };
}

/** Execute real bytecode against the supplied manager. Completed message calls
 * retain their state; infrastructure/unsupported/limit failures roll it back.
 * The supplied manager and blockchain must themselves bound asynchronous I/O.
 * `now` is an internal deterministic test clock, never a public request field. */
export async function executeUnsignedCall({ request, block, stateManager, blockchain, chainId = 999, limits: requestedLimits = {}, now = () => performance.now() }) {
  const ceilings = chainId === 1 ? ETHEREUM_EXECUTION_LIMITS : EXECUTION_LIMITS;
  const limits = { ...ceilings }, startedAt = now();
  const usage = { steps: 0, frames: 0, maxDepth: 0, logOpcodes: 0, retainedTraceBytes: 0 };
  const semantics = {
    kind: 'unsigned_message', signatureVerification: false, transactionNonceValidation: false,
    callerNonce: 'runCall_increments_once_including_EVM_revert', gasBudget: 'message_execution_only_intrinsic_transaction_gas_not_subtracted',
    gasUsed: 'execution_gas_before_transaction_refund_and_intrinsic_gas', gasPrice: '0', feeSettlement: false,
    warmAddresses: 'sender_destination_coinbase_and_Ethereum_precompiles_1_to_10_no_access_list',
    logs: 'committed_root_result_only_no_duplicated_descendant_log_arrays', callTree: 'entered_messages_only',
    chainScope: 'Ethereum_Cancun_rules_with_chainId999_not_full_HyperEVM_equivalence',
    lifecycle: chainId === 1 ? 'no_lifecycle_operation_encountered' : 'CREATE_CREATE2_SELFDESTRUCT_unsupported', deadline: 'cooperative_until_final_atomic_commit_no_forceful_IO_cancellation',
  };
  let root = null, environment = null, evm, checkpointDepth = 0, ownsManager = false;
  let hostFailed = false, hostError;
  let delegatedSenderNonce = null, retainedSenderCreations = 0;
  let authorizationProcessing = null, authorizationSenderIncrements = 0, authorizationBaseline = null;
  let feePlan = null, feeCosts = null, feeAccounting = null;
  const stack = [];
  function latchHostFailure(error) { if (!hostFailed) { hostFailed = true; hostError = error; } }
  const reserved = value => supportedAddress(value, chainId);
  function bound(name, value) { if (value > limits[name]) reject('LOCAL_RESOURCE_LIMIT', `Local execution exceeded its ${name} limit.`); }
  function clockCheck() {
    // Some EVM paths catch balance-write errors as if they were EVM faults.
    // A host/adapter rejection must never become success or a catchable CALL
    // result. Keep the first failure outside the library's exception wrapper.
    if (hostFailed) throw hostError;
    if (now() - startedAt >= limits.wallMs) reject('LOCAL_RESOURCE_LIMIT', 'Local execution exceeded its wallMs limit.');
  }
  function retain(size) { usage.retainedTraceBytes += size; bound('traceBytes', usage.retainedTraceBytes); }
  async function restore() {
    while (checkpointDepth > 0) { await stateManager.revert(); checkpointDepth--; }
  }
  try {
    if (![1, 999].includes(chainId)) reject('LOCAL_INVALID_INPUT', 'Only the explicit Ethereum mainnet and legacy HyperEVM development profiles are supported.');
    for (const [key, value] of Object.entries(requestedLimits)) {
      if (!Object.hasOwn(ceilings, key) || !Number.isSafeInteger(value) || value <= 0 || value > ceilings[key]) reject('LOCAL_INVALID_INPUT', 'Execution limits must be positive integers no greater than the fixed ceilings.');
      limits[key] = value;
    }
    if (!stateManager || typeof stateManager !== 'object' || ['getAccount', 'putAccount', 'getCode', 'getStorage', 'checkpoint', 'commit', 'revert'].some(method => typeof stateManager[method] !== 'function')) reject('LOCAL_INVALID_INPUT', 'A compatible explicit state manager is required.');
    if (activeManagers.has(stateManager)) reject('LOCAL_STATE_BUSY', 'Concurrent execution on the same state manager is not supported.');
    let context, authorizationList, feeContext; try { context = normalizeEvmContext(request); authorizationList = normalizeAuthorizationList(request); feeContext = normalizeEthereumFees(request); } catch { reject('LOCAL_INVALID_INPUT', 'Optional EVM context is malformed.'); }
    if (chainId !== 1 && (Object.keys(context).length || authorizationList !== undefined || feeContext.executionProfile)) reject('LOCAL_INVALID_INPUT', 'Optional execution context requires the Ethereum profile.');
    const topLevelCreation = chainId === 1 && request?.to === null;
    const from = address(request?.from), to = address(request?.to), value = quantity(request?.value), gasLimit = quantity(request?.gasLimit);
    if (!from || (!to && !topLevelCreation) || (topLevelCreation && context.blobVersionedHashes !== undefined) || value === null || gasLimit === null || (chainId === 999 && gasLimit === 0n) || gasLimit > BigInt(limits.gas) || typeof request?.data !== 'string' || !BYTES.test(request.data) || request.data.length > 2 + limits.calldataBytes * 2 || Object.keys(request).some(key => !['from', 'to', 'data', 'value', 'gasLimit', 'accessList', 'blobVersionedHashes', 'authorizationList', 'executionProfile', 'fees'].includes(key))) reject('LOCAL_INVALID_INPUT', 'A bounded unsigned message with explicit from, destination (or Ethereum creation null), data, value and message gasLimit is required.');
    reserved(from); reserved(to);
    if (!block || ['number', 'timestamp', 'gasLimit', 'baseFeePerGas'].some(field => quantity(block[field]) === null) || quantity(block.gasLimit) === 0n || typeof block.mixHash !== 'string' || !WORD.test(block.mixHash) || !address(block.miner) || ['hash', 'parentHash'].some(field => block[field] !== undefined && (typeof block[field] !== 'string' || !WORD.test(block[field])))) reject('LOCAL_INVALID_INPUT', 'Explicit block number, timestamp, gas limit, base fee, prevRandao and coinbase are required.');
    const common = chainId === 1 ? ethereumCommon(block) : createCustomCommon({ chainId: 999, name: 'experimental-hyperevm-message' }, Mainnet, { hardfork: Hardfork.Cancun });
    if (chainId === 1 && common.isActivatedEIP(4844)) {
      common.customCrypto.kzg = guardKzgVerifier(verifyKzgProof, clockCheck, latchHostFailure);
    }
    if (authorizationList !== undefined && (!common.isActivatedEIP(7702) || topLevelCreation || context.blobVersionedHashes !== undefined)) reject('LOCAL_INVALID_INPUT', 'Authorization lists require a Prague-or-later Ethereum call without blob context.', 'invalid');
    if (authorizationList !== undefined && typeof stateManager.applyAuthorization !== 'function') reject('LOCAL_STATE_UNSUPPORTED', 'Authorization lists require an authenticated authorization-capable state manager.', 'unsupported');
    const canCreate = chainId === 1 && typeof stateManager.beginContractCreation === 'function';
    const canFinalizeDeletion = chainId === 1 && typeof stateManager.finalizeCreatedContractDeletion === 'function';
    const canFinalizeShanghai = chainId === 1 && typeof stateManager.finalizeShanghaiContractDeletion === 'function';
    const canCleanupEmpty = chainId === 1 && typeof stateManager.beginEmptyAccountCleanup === 'function' && typeof stateManager.endEmptyAccountCleanup === 'function';
    if (feeContext.executionProfile) {
      if (!canCleanupEmpty) reject('LOCAL_STATE_UNSUPPORTED', 'Fee settlement requires transaction-end empty-account cleanup.', 'unsupported');
      try {
        feeCosts = ethereumCallGas(request.data, common, request);
        const totalGas = gasLimit + feeCosts.intrinsic;
        if (totalGas < feeCosts.minimum) reject('LOCAL_INVALID_INPUT', 'The priced envelope cannot cover the selected fork gas minimum.', 'invalid');
        feePlan = ethereumFeePlan({ ...request, value: value.toString(), gas: totalGas.toString() }, block);
      } catch (error) {
        if (error?.code === 'LOCAL_ETHEREUM_BLOB_PRICE_LIMIT') reject(error.code, 'Blob base fee exceeds the bounded exact calculation profile.', 'unsupported');
        reject('LOCAL_INVALID_INPUT', 'The explicit fee profile does not match the selected header or gas envelope.', 'invalid');
      }
      semantics.gasPrice = feePlan.effectiveGasPrice.toString();
    }
    let observedCreation = false, observedSelfdestruct = false, observedCreatedSelfdestruct = false;
    function describeLifecycle() {
      const unsupported = canFinalizeDeletion ? (canCleanupEmpty ? (canFinalizeShanghai ? 'fork_selected_SELFDESTRUCT_finalization' : 'Shanghai_SELFDESTRUCT_unsupported') : 'Shanghai_SELFDESTRUCT_and_full_EIP161_cleanup_unsupported') : 'same_invocation_creation_and_Shanghai_SELFDESTRUCT_unsupported';
      if (observedSelfdestruct && !common.isActivatedEIP(6780)) semantics.lifecycle = 'Shanghai_SELFDESTRUCT_with_root_commit_gated_whole_account_deletion';
      else if (observedCreatedSelfdestruct) semantics.lifecycle = 'Cancun_created_account_SELFDESTRUCT_with_root_commit_gated_deletion_' + unsupported;
      else if (observedSelfdestruct) semantics.lifecycle = (observedCreation ? (topLevelCreation ? 'top_level_CREATE_and_' : '') + 'internal_CREATE_CREATE2_and_' : '') + 'preexisting_Cancun_SELFDESTRUCT_without_deletion_' + unsupported;
      else if (observedCreation) semantics.lifecycle = (topLevelCreation ? 'top_level_CREATE_and_' : '') + 'internal_CREATE_CREATE2_with_proven_deployable_targets_' + unsupported;
    }
    if (topLevelCreation && !canCreate) reject('LOCAL_LIFECYCLE_UNSUPPORTED', 'Top-level creation requires an authenticated creation-capable state manager.', 'unsupported');
    if (chainId === 1) {
      try { ethereumContextProfile(context, block, common); } catch { reject('LOCAL_INVALID_INPUT', 'Optional execution context does not match the selected fork/header.'); }
      semantics.chainScope = 'Ethereum_mainnet_pinned_timestamp_selected_fork';
      semantics.warmAddresses = topLevelCreation
        ? context.accessList ? 'sender_coinbase_fork_active_precompiles_and_declared_access_list_creation_target_warmed_by_EVM' : 'sender_coinbase_and_fork_active_precompiles_creation_target_warmed_by_EVM_no_access_list'
        : context.accessList ? 'sender_destination_coinbase_fork_active_precompiles_and_declared_access_list' : 'sender_destination_coinbase_and_fork_active_precompiles_no_access_list';
    }
    environment = { chainId, hardfork: common.hardfork(), number: quantity(block.number).toString(), timestamp: quantity(block.timestamp).toString(), gasLimit: quantity(block.gasLimit).toString(), baseFeePerGas: quantity(block.baseFeePerGas).toString(), mixHash: block.mixHash.toLowerCase(), miner: address(block.miner), ...(block.hash ? { sourceBlockHash: block.hash.toLowerCase() } : {}), ...(block.parentHash ? { sourceParentHash: block.parentHash.toLowerCase() } : {}), sourceBlockIdentityVerified: false, ...(feePlan?.blobContext ? { blobBaseFeePerGas: feePlan.blobContext.blobBaseFeePerGas.toString() } : {}) };
    activeManagers.add(stateManager); ownsManager = true;
    const methods = new Map();
    // Bind methods to the real manager; track every nested checkpoint so a host
    // exception in an EVM event cannot leave partially applied state behind.
    const guarded = new Proxy(stateManager, { get(target, property) {
      const member = Reflect.get(target, property, target);
      if (typeof member !== 'function') return member;
      if (!methods.has(property)) methods.set(property, async (...args) => {
        try {
          clockCheck();
          if (['getAccount', 'putAccount', 'deleteAccount', 'modifyAccountFields', 'getCode', 'putCode', 'getCodeSize', 'getStorage', 'putStorage', 'clearStorage', 'beginContractCreation', 'finalizeCreatedContractDeletion', 'finalizeShanghaiContractDeletion', 'applyAuthorization'].includes(property)) reserved(args[0]);
          const result = await member.apply(target, args);
          if (property === 'checkpoint') checkpointDepth++;
          else if (property === 'commit' || property === 'revert') checkpointDepth--;
          clockCheck();
          return result;
        } catch (error) {
          latchHostFailure(error);
          throw error;
        }
      });
      return methods.get(property);
    } });
    const hashes = {
      async getBlock(number) {
        clockCheck();
        if (!blockchain || typeof blockchain.getBlock !== 'function') reject('LOCAL_BLOCKHASH_MISSING', 'An in-range BLOCKHASH requires an explicitly supplied block hash.', 'unsupported');
        const found = await blockchain.getBlock(number); clockCheck();
        const hash = found?.hash?.();
        if (!(hash instanceof Uint8Array) || hash.length !== 32) reject('LOCAL_BLOCKHASH_MISSING', 'An in-range BLOCKHASH requires an explicitly supplied block hash.', 'unsupported');
        return { hash: () => hash.slice() };
      },
      async putBlock() { reject('LOCAL_BLOCKCHAIN_WRITE_UNSUPPORTED', 'Block writes are unsupported.', 'unsupported'); },
      shallowCopy() { return this; },
    };
    evm = await createEVM({ common, stateManager: guarded, blockchain: hashes,
      ...(chainId === 1 && common.isActivatedEIP(2537) ? { bls: createGuardedBls(clockCheck, latchHostFailure) } : {}),
      ...(chainId === 1 && common.isActivatedEIP(7951) ? { customPrecompiles: [{ address: P256_ADDRESS,
        function: createP256Precompile(clockCheck, latchHostFailure) }] } : {}),
    });
    // Each invocation is a fresh message/transaction-context boundary for
    // SSTORE refund accounting, even when the caller retains the same manager.
    stateManager.originalStorageCache?.clear();
    for (const warm of [from, ...(to ? [to] : []), address(block.miner), ...evm.precompiles.keys()]) evm.journal.addAlwaysWarmAddress(warm);
    for (const entry of context.accessList ?? []) {
      evm.journal.addAlwaysWarmAddress(entry.address);
      for (const slot of entry.storageKeys) evm.journal.addAlwaysWarmSlot(entry.address, slot);
    }
    evm.events.on('beforeMessage', message => {
      clockCheck();
      const creation = !message.to;
      if (creation && (!canCreate || (!stack.length && !topLevelCreation))) reject('LOCAL_LIFECYCLE_UNSUPPORTED', 'This profile requires an explicit supported contract creation.', 'unsupported');
      if (!creation) { reserved(message.to); reserved(message.codeAddress); }
      bound('frames', ++usage.frames); bound('depth', message.depth); usage.maxDepth = Math.max(usage.maxDepth, message.depth);
      bound('calldataBytes', message.data.length); retain(512 + message.data.length * 2);
      const parent = stack.at(-1), type = parent ? parent.pendingCall ?? (creation ? 'CREATE' : message.delegatecall ? 'DELEGATECALL' : message.isStatic ? 'STATICCALL' : 'CALL') : creation ? 'CREATE' : 'CALL';
      if (creation) { observedCreation = true; describeLifecycle(); }
      const frame = { type, from: parent?.frame.executionAddress ?? message.caller.toString(), to: creation ? null : message.codeAddress.toString(), executionAddress: creation ? null : message.to.toString(), caller: message.caller.toString(), value: hex(message.value), input: bytesToHex(message.data), gas: hex(message.gasLimit), gasUsed: null, output: null, error: null, depth: message.depth, calls: [] };
      if (parent) parent.frame.calls.push(frame); else root = frame;
      // CREATE increments the creator before the child's checkpoint. A failed
      // constructor or collision keeps that increment if its parent commits.
      // Count entered attempts in the parent, then merge only committed
      // descendants. The supported fork range excludes EIP-7928's alternate
      // collision path, which would need a different observation point.
      if (delegatedSenderNonce !== null && creation && parent && frame.from === from) parent.senderCreations++;
      // This is the EVM's invocation-local creation set. The state manager's
      // creation marker deliberately survives copied after-state query forks.
      stack.push({ frame, pendingCall: null, createdAddresses: message.createdAddresses, senderCreations: 0 });
    });
    evm.events.on('newContract', event => {
      clockCheck(); const active = stack.at(-1), target = event.address.toString();
      if (!canCreate || !active || !['CREATE', 'CREATE2'].includes(active.frame.type) || active.frame.to !== null) reject('LOCAL_TRACE_INVALID', 'Creation event does not match the entered creation frame.');
      // EthereumJS does not await one-argument event listeners. The manager's
      // marker is synchronous over facts already loaded by clearStorage.
      reserved(target); stateManager.beginContractCreation(event.address, active.frame.depth === 0 ? 'top_level_contract_creation' : 'internal_contract_creation');
      active.frame.to = target; active.frame.executionAddress = target;
    });
    evm.events.on('step', step => {
      clockCheck(); bound('steps', ++usage.steps); bound('memoryBytes', step.memory.length);
      const active = stack.at(-1);
      if (createOpcodes.has(step.opcode.code) && !canCreate) reject('LOCAL_LIFECYCLE_UNSUPPORTED', 'This local profile does not support the requested lifecycle operation.', 'unsupported');
      if (step.opcode.code === 0xff) {
        // runCall applies the balance transfer but leaves transaction-end
        // deletion to our bounded finalizer after the committed root result.
        const executionAddress = step.address.toString();
        const cancun = common.isActivatedEIP(6780);
        if (chainId !== 1 || !active || active.frame.executionAddress !== executionAddress ||
            (cancun ? !(active.createdAddresses instanceof Set) || (active.createdAddresses.has(executionAddress) && !canFinalizeDeletion) : !canFinalizeShanghai)) reject('LOCAL_LIFECYCLE_UNSUPPORTED', 'SELFDESTRUCT deletion or unsupported fork context is outside this local profile.', 'unsupported');
        observedCreatedSelfdestruct ||= cancun && active.createdAddresses.has(executionAddress);
        // The step event precedes gas/static/stack checks. Promote this into
        // trace evidence only if this frame actually completes successfully.
        if (step.stack.length) active.pendingSelfdestruct = '0x' + (step.stack.at(-1) & ((1n << 160n) - 1n)).toString(16).padStart(40, '0');
        observedSelfdestruct = true; describeLifecycle();
      }
      // On Ethereum, absent blob hashes are the empty transaction list: BLOBHASH
      // returns zero through the fork-selected EVM opcode. Real BLOBBASEFEE
      // belongs only to explicit priced contexts; unpriced probes stay fresh.
      if (((step.opcode.code === 0x4a && !feePlan?.blobContext) || (step.opcode.code === 0x49 && chainId !== 1)) && !context.blobVersionedHashes) reject('LOCAL_BLOB_UNSUPPORTED', 'Blob transaction context is outside this local engine profile.', 'unsupported');
      if (step.opcode.code >= 0xa0 && step.opcode.code <= 0xa4) bound('logs', ++usage.logOpcodes);
      if (active) active.pendingCall = callOpcodes.get(step.opcode.code) ?? createOpcodes.get(step.opcode.code) ?? null;
      if (callOpcodes.has(step.opcode.code) && step.stack.length >= 2) reserved('0x' + (step.stack.at(-2) & ((1n << 160n) - 1n)).toString(16).padStart(40, '0'));
    });
    evm.events.on('afterMessage', result => {
      clockCheck();
      // A final instruction can expand memory and fall off the bytecode without
      // another pre-op step event; validate its completed frame as well.
      const memoryWords = result.execResult.runState?.memoryWordCount;
      if (memoryWords !== undefined) bound('memoryBytes', memoryWords * 32n);
      const active = stack.pop();
      if (!active) reject('LOCAL_TRACE_INVALID', 'Local call-tree event nesting is inconsistent.');
      if (['CREATE', 'CREATE2'].includes(active.frame.type)) {
        const created = result.createdAddress?.toString() ?? null;
        if (active.frame.to !== null && active.frame.to !== created) reject('LOCAL_TRACE_INVALID', 'Creation result address disagrees with its entered frame.');
        active.frame.to = created; active.frame.executionAddress = created;
      }
      const output = result.execResult.returnValue;
      bound('returnBytes', output.length); retain(output.length * 2 + 128);
      active.frame.gasUsed = hex(result.execResult.executionGasUsed); active.frame.output = bytesToHex(output);
      const error = result.execResult.exceptionError?.error;
      active.frame.error = error === undefined ? null : evmErrors.has(error) ? error : 'unrecognized EVM exception';
      if (error === undefined) {
        const parent = stack.at(-1);
        if (parent) parent.senderCreations += active.senderCreations;
        else retainedSenderCreations = active.senderCreations;
      }
      if (error === undefined && active.pendingSelfdestruct !== undefined) {
        if (result.execResult.selfdestruct?.get(active.frame.executionAddress) !== active.pendingSelfdestruct) reject('LOCAL_TRACE_INVALID', 'Successful SELFDESTRUCT disagrees with its frame result.');
        active.frame.selfdestruct = { beneficiary: active.pendingSelfdestruct }; retain(96);
      }
    });
    if (chainId === 1) {
      const sender = createAddressFromString(from), account = await guarded.getAccount(sender), code = await guarded.getCode(sender);
      if (code.length) {
        const delegation = existingDelegationTarget(bytesToHex(code), common);
        if (delegation === null) reject('LOCAL_SENDER_CODE_UNSUPPORTED', 'The unsigned reference requires an empty-code sender or an exact existing EIP-7702 delegation on Prague or later.', 'unsupported');
        delegatedSenderNonce = account?.nonce ?? 0n;
        semantics.senderDelegation = { address: delegation, authorizationListProcessed: false };
        semantics.callerNonce = 'runCall_increment_and_committed_sender_creation_attempts';
      }
      if ((account?.balance ?? 0n) < (feePlan?.maximumRequiredBalance ?? value)) reject('LOCAL_CALL_INSUFFICIENT_BALANCE', feePlan ? 'The sender cannot cover the native value and maximum declared gas fee.' : 'The sender cannot cover the declared native value.', 'invalid');
      if ((account?.nonce ?? 0n) >= (1n << 64n) - 1n) reject('LOCAL_CALL_NONCE_OVERFLOW', 'The sender nonce cannot be incremented within uint64.', 'invalid');
      if (authorizationList !== undefined) delegatedSenderNonce = account?.nonce ?? 0n;
    }
    if (authorizationList !== undefined) authorizationBaseline = { callerNonce: semantics.callerNonce, warmAddresses: semantics.warmAddresses, senderDelegation: semantics.senderDelegation };
    await guarded.checkpoint();
    if (feePlan) {
      const sender = createAddressFromString(from), account = await guarded.getAccount(sender) ?? new Account();
      account.balance -= feePlan.totalUpfrontDebit ?? feePlan.upfrontGasDebit; await evm.journal.putAccount(sender, account);
    }
    if (authorizationList !== undefined) {
      const sender = createAddressFromString(from), account = await guarded.getAccount(sender) ?? new Account();
      account.nonce++; await evm.journal.putAccount(sender, account);
      const entries = []; let gasRefund = 0n;
      for (let index = 0; index < authorizationList.length; index++) {
        clockCheck(); const tuple = authorizationList[index], recovered = recoverAuthorization(tuple);
        let reason = recovered.reason;
        if (reason === null) {
          const authority = createAddressFromString(recovered.authority);
          // Warming survives a later nonce/code rejection, and message revert.
          evm.journal.addAlwaysWarmAddress(recovered.authority);
          const prior = await guarded.getAccount(authority), code = bytesToHex(await guarded.getCode(authority));
          const decision = authorizationStateDecision(tuple, { exists: prior !== undefined, nonce: prior?.nonce ?? 0n, code });
          reason = decision.reason;
          if (reason === null) {
            await guarded.applyAuthorization(authority, BigInt(tuple.nonce), tuple.address);
            gasRefund += decision.gasRefund;
            if (recovered.authority === from) authorizationSenderIncrements++;
          }
        }
        entries.push({ index, authority: recovered.authority, status: reason === null ? 'applied' : 'skipped', reason }); retain(256);
      }
      authorizationProcessing = { entries, gasRefundCounter: gasRefund.toString() };
      const effective = existingDelegationTarget(bytesToHex(await guarded.getCode(sender)), common);
      delete semantics.senderDelegation;
      if (effective !== null) semantics.senderDelegation = { address: effective, authorizationListProcessed: true };
      semantics.callerNonce = 'outer_increment_authorizations_and_committed_sender_creation_attempts';
      semantics.warmAddresses += '_and_recovered_authorities';
    }
    const result = await evm.runCall({ caller: createAddressFromString(from), origin: createAddressFromString(from), ...(to ? { to: createAddressFromString(to) } : {}), data: hexToBytes(request.data), value, gasLimit, gasPrice: feePlan?.effectiveGasPrice ?? 0n, ...(authorizationList !== undefined ? { skipNonceIncrement: true } : {}), ...(context.blobVersionedHashes ? { blobVersionedHashes: [...context.blobVersionedHashes] } : {}), block: { header: { number: quantity(block.number), timestamp: quantity(block.timestamp), gasLimit: quantity(block.gasLimit), baseFeePerGas: quantity(block.baseFeePerGas), difficulty: 0n, prevRandao: hexToBytes(block.mixHash), coinbase: createAddressFromString(address(block.miner)), getBlobGasPrice() { if (feePlan?.blobContext) return feePlan.blobContext.blobBaseFeePerGas; if (context.blobVersionedHashes) return 0n; reject('LOCAL_BLOB_UNSUPPORTED', 'Blob transaction context is unsupported.', 'unsupported'); } } } });
    clockCheck();
    if (stack.length || checkpointDepth !== 1) reject('LOCAL_TRACE_INVALID', 'Local call-tree or checkpoint completion is inconsistent.');
    if (feePlan) {
      const used = ethereumUsedGas({ messageGasUsed: result.execResult.executionGasUsed, refundCounter: (result.execResult.gasRefund ?? 0n) + BigInt(authorizationProcessing?.gasRefundCounter ?? '0'), intrinsic: feeCosts.intrinsic, floor: feeCosts.floor });
      feeAccounting = settleEthereumFees(feePlan, { gasUsed: used.gasUsed });
      // Read current state separately for each credit: sender and coinbase can
      // coincide. Credit even a zero tip so EIP-161 sees the coinbase touch.
      for (const [target, amount] of [[from, BigInt(feeAccounting.senderRefund)], [feePlan.coinbase, BigInt(feeAccounting.coinbaseTip)]]) {
        const accountAddress = createAddressFromString(target), account = await guarded.getAccount(accountAddress) ?? new Account();
        if (account.balance + amount > UINT256_MAX) reject('LOCAL_STATE_INVALID', 'Fee settlement exceeds the account balance range.');
        account.balance += amount; await evm.journal.putAccount(accountAddress, account);
      }
      // Settlement precedes deletion. A scheduled deletion can burn its tip;
      // refunding or crediting it after finalization would resurrect state.
      semantics.feeSettlement = true;
    }
    const finalizedDeletions = [];
    if (!result.execResult.exceptionError && result.execResult.selfdestruct?.size) {
      const cancun = common.isActivatedEIP(6780);
      if (!(result.execResult.selfdestruct instanceof Map) || (cancun && !(result.execResult.createdAddresses instanceof Set))) reject('LOCAL_TRACE_INVALID', 'Committed lifecycle collections are malformed.');
      const deletions = [...result.execResult.selfdestruct.keys()].filter(key => !cancun || result.execResult.createdAddresses.has(key)).sort();
      bound('frames', deletions.length);
      for (const key of deletions) {
        if (!ADDRESS.test(key) || (cancun ? !canFinalizeDeletion : !canFinalizeShanghai)) reject('LOCAL_LIFECYCLE_UNSUPPORTED', 'Committed deletion requires an authenticated fork-appropriate finalizer.', 'unsupported');
        if (cancun) {
          await guarded.finalizeCreatedContractDeletion(createAddressFromString(key));
          finalizedDeletions.push({ address: key, scope: 'entire_account_including_code_and_storage', initialStorageRoot: EMPTY_STORAGE_ROOT });
        } else finalizedDeletions.push(await guarded.finalizeShanghaiContractDeletion(createAddressFromString(key)));
      }
    }
    let emptyAccountCleanup = null;
    if (canCleanupEmpty) {
      const touchedAccounts = [...evm.journal.touched].map(key => '0x' + key).sort();
      if (touchedAccounts.some(key => !ADDRESS.test(key))) reject('LOCAL_TRACE_INVALID', 'The retained empty-account touch set is malformed.');
      clockCheck(); stateManager.beginEmptyAccountCleanup();
      let deletions;
      try { clockCheck(); await evm.journal.cleanup(); }
      finally { deletions = stateManager.endEmptyAccountCleanup(); }
      clockCheck();
      if (deletions.length) {
        emptyAccountCleanup = { basis: 'eip161_transaction_end', scope: feePlan?.blobGasUsed ? 'unsigned_eip4844_transaction_touches' : feePlan ? 'unsigned_eip1559_transaction_touches' : 'unsigned_message_touches_no_fee_settlement', touchedAccounts, deletions };
        semantics.lifecycle = (semantics.lifecycle === 'no_lifecycle_operation_encountered' ? '' : semantics.lifecycle + '_and_') + 'EIP161_empty_account_cleanup';
      }
    }
    const lifecycle = finalizedDeletions.length || emptyAccountCleanup ? {
      ...(finalizedDeletions.length ? { finalizedDeletions } : {}),
      ...(emptyAccountCleanup ? { emptyAccountCleanup } : {}),
    } : null;
    const logs = (result.execResult.logs ?? []).map(([emitter, topics, data]) => ({ address: bytesToHex(emitter), topics: topics.map(bytesToHex), data: bytesToHex(data) }));
    bound('logs', logs.length); bound('returnBytes', result.execResult.returnValue.length);
    usage.retainedTraceBytes = Buffer.byteLength(JSON.stringify({ trace: root, logs, ...(lifecycle ? { lifecycle } : {}), ...(authorizationProcessing ? { authorizationProcessing } : {}), ...(feeAccounting ? { feeAccounting } : {}) }), 'utf8'); bound('traceBytes', usage.retainedTraceBytes);
    const error = root.error, status = !error ? 'success' : error === 'revert' ? 'reverted' : 'failed';
    const report = { execution: { status, executionGasUsed: result.execResult.executionGasUsed.toString(), gasRefundCounter: (result.execResult.gasRefund ?? 0n).toString(), returnData: bytesToHex(result.execResult.returnValue), error }, trace: root, logs, environment, semantics, limits, usage, ...(lifecycle ? { lifecycle } : {}), ...(authorizationProcessing ? { authorizationProcessing } : {}), ...(feeAccounting ? { feeAccounting } : {}), stateDisposition: 'message_result_retained_in_supplied_manager' };
    // Transient writes in reverted subtrees are gone now. Any remaining whole
    // namespace reset must be representable before the invocation is retained,
    // including when a caller supplied an already-checkpointed manager.
    if (typeof stateManager.assertRepresentableAccountResets === 'function') await guarded.assertRepresentableAccountResets();
    if (delegatedSenderNonce !== null) {
      const senderAfter = await guarded.getAccount(createAddressFromString(from));
      if (senderAfter?.nonce !== delegatedSenderNonce + 1n + BigInt(authorizationSenderIncrements) + BigInt(retainedSenderCreations)) reject('LOCAL_TRACE_INVALID', 'Sender nonce disagrees with its authorization and committed creation attempts.');
    }
    clockCheck();
    // Final atomic commit is the irreversible terminal step: no subsequent
    // deadline/output validation may mislabel retained state as rolled back.
    await stateManager.commit(); checkpointDepth--;
    return report;
  } catch (error) {
    semantics.feeSettlement = false;
    // No completed preparation record is exposed for a rolled-back attempt.
    // Keep incomplete metadata bound to the independently known sender input.
    if (authorizationBaseline) {
      semantics.callerNonce = authorizationBaseline.callerNonce;
      semantics.warmAddresses = authorizationBaseline.warmAddresses;
      delete semantics.senderDelegation;
      if (authorizationBaseline.senderDelegation) semantics.senderDelegation = authorizationBaseline.senderDelegation;
    }
    let stateDisposition = 'unchanged';
    if (checkpointDepth > 0) {
      try { await restore(); stateDisposition = 'rolled_back'; }
      catch { stateDisposition = 'rollback_failed_discard_manager'; }
    }
    const failure = stateDisposition === 'rollback_failed_discard_manager' ? { status: 'unavailable', error: { code: 'LOCAL_ROLLBACK_FAILED', message: 'Local rollback failed; discard the supplied state manager.' } } : safeFailure(error);
    for (const active of stack) active.frame.incomplete = true;
    return { execution: { ...failure, executionGasUsed: null, returnData: null }, trace: root, logs: [], environment, semantics, limits, usage, stateDisposition };
  } finally { evm?.events.removeAllListeners(); if (ownsManager) activeManagers.delete(stateManager); }
}
