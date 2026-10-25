// ERC-20 approve/Approval semantics: https://eips.ethereum.org/EIPS/eip-20
// This module observes permission requests and events. It does not query allowance
// state, classify spenders, or provide a transaction-wide security verdict.
import { CHAIN_ID, USDC, HUSDC } from './config.js';

const APPROVE = '0x095ea7b3';
const PERMIT = '0xd505accf'; // ERC-2612 permit(address,address,uint256,uint256,uint8,bytes32,bytes32)
const APPROVAL = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';
const MAX_UINT256 = (1n << 256n) - 1n;
const VERIFIED_TOKENS = new Set([USDC, HUSDC]);
const PERMIT_IMPLEMENTATIONS = {
  [USDC]: '0x003f73f58ca78880da3642c5cb71d7459b3fe4f8',
  [HUSDC]: '0x410aa1ab680b886c875e99a7a4bfaf188508a7a3',
};
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const WORD = /^0x[0-9a-f]{64}$/i;
const HEX = /^0x(?:[0-9a-f]{2})*$/i;

const address = value => typeof value === 'string' && ADDRESS.test(value) ? value.toLowerCase() : null;
const canonicalWordAddress = value => typeof value === 'string' && /^0x0{24}[0-9a-f]{40}$/i.test(value) ? address(`0x${value.slice(-40)}`) : null;
const failed = frame => Boolean(frame?.error || frame?.revertReason);
const quantity = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : typeof value === 'string' && /^(?:0x[0-9a-f]+|[0-9]+)$/i.test(value) ? BigInt(value) : null;

function assetFor(token, metadata) {
  const data = metadata?.[token];
  return {
    address: token, type: 'ERC20',
    decimals: Number.isInteger(data?.decimals) && data.decimals >= 0 && data.decimals <= 255 ? data.decimals : null,
    symbol: typeof data?.symbol === 'string' ? data.symbol : null,
    name: typeof data?.name === 'string' ? data.name : null,
  };
}

function units(amount, decimals) {
  if (decimals === null) return null;
  const digits = amount.toString().padStart(decimals + 1, '0');
  if (!decimals) return digits;
  const fraction = digits.slice(-decimals).replace(/0+$/, '');
  return `${digits.slice(0, -decimals)}${fraction ? `.${fraction}` : ''}`;
}

function amountFields(amount, asset) {
  return {
    amountRaw: amount.toString(), amount: units(amount, asset.decimals),
    allowanceKind: amount === 0n ? 'revoke' : amount === MAX_UINT256 ? 'uint256_max' : 'bounded',
  };
}

function returnStatus(output) {
  if (output === undefined || output === null) return 'unavailable';
  if (output === '0x') return 'empty';
  if (typeof output !== 'string' || !WORD.test(output)) return 'malformed';
  const value = BigInt(output);
  return value === 1n ? 'returned_true' : value === 0n ? 'returned_false' : 'malformed';
}

function signatureMatches(a, b) {
  return a.asset.address === b.asset.address && a.owner === b.owner && a.spender === b.spender && a.amountRaw === b.amountRaw;
}

function sameCallBranch(call, event) {
  return event.framePath === call.framePath || event.framePath.startsWith(`${call.framePath}.`);
}

function permitImplementation(frame, token) {
  // Known proxy execution is required to interpret this selector as ERC-2612.
  // This is implementation provenance, not independent signature verification.
  if (!Array.isArray(frame.calls) || frame.calls.length !== 1) return null;
  const delegated = frame.calls[0];
  return delegated?.type === 'DELEGATECALL' && !failed(delegated)
    && address(delegated.from) === token && address(delegated.to) === PERMIT_IMPLEMENTATIONS[token]
    && typeof delegated.input === 'string' && delegated.input.toLowerCase() === frame.input.toLowerCase()
    && quantity(delegated.value ?? '0x0') === 0n
    ? PERMIT_IMPLEMENTATIONS[token] : null;
}

/** Analyze permission evidence from a completed callTracer result, without RPC IO. */
export function analyzePermissions({ request, trace, block, metadata = {} } = {}) {
  const observations = [];
  const findings = [];
  const reasons = new Set();
  const warnings = new Set([
    'Approval calldata describes a request; Approval events describe emitted evidence. Neither independently verifies the final on-chain allowance.',
    'Maximum uint256 approval observations describe spender exposure, not maliciousness. No general security verdict or spender reputation assessment is provided.',
  ]);
  const chainSupported = quantity(request?.chainId) === BigInt(CHAIN_ID);
  const verified = token => chainSupported && VERIFIED_TOKENS.has(token);
  let discardedSubtrees = 0;
  const result = () => ({
    scope: { chainId: CHAIN_ID, verifiedTokenAddresses: [...VERIFIED_TOKENS], standard: 'ERC20', standardSource: 'https://eips.ethereum.org/EIPS/eip-20' },
    coverage: { status: 'limited', reasons: [...reasons], allowanceStateVerified: false },
    observations, findings, warnings: [...warnings],
  });
  if (!trace || typeof trace !== 'object' || Array.isArray(trace) || typeof trace.type !== 'string') {
    reasons.add('A valid callTracer result is required; permission effects were not inferred.');
    return result();
  }
  if (!chainSupported) reasons.add('Configured ERC20 identities are verified only on HyperEVM chain 999.');
  if (failed(trace)) {
    warnings.add('The top-level call failed. All permission calls and events were discarded; no effective permission change is inferred.');
    return result();
  }
  for (const [traceKey, requestKey] of [['from', 'from'], ['to', 'to'], ['input', 'data']]) {
    if (typeof request?.[requestKey] === 'string' && typeof trace[traceKey] === 'string' && request[requestKey].toLowerCase() !== trace[traceKey].toLowerCase()) {
      reasons.add(`Trace ${traceKey} differs from requested ${requestKey}; permission observations were withheld.`);
    }
  }
  if ([...reasons].some(reason => reason.includes('were withheld'))) return result();

  const framesSeen = new WeakSet();
  const logsSeen = new WeakSet();
  const globalLogs = new Map();
  const add = observation => { observation.id = `permission-${observations.length + 1}`; observations.push(observation); return observation; };

  function walk(frame, path = '0') {
    if (!frame || typeof frame !== 'object' || framesSeen.has(frame)) return;
    framesSeen.add(frame);
    if (failed(frame)) { discardedSubtrees++; return; }
    // A STATICCALL cannot commit permission changes or LOG instructions.
    if (frame.type === 'STATICCALL') return;
    const token = address(frame.to);
    const selector = typeof frame.input === 'string' ? frame.input.slice(0, 10).toLowerCase() : null;
    if (frame.type === 'CALL' && selector === APPROVE) {
      if (!verified(token)) {
        reasons.add('A matching approve selector occurred at an unverified token address; no ERC20 arguments were inferred.');
        add({ kind: 'unverified_permission_call', contract: token, selector, framePath: path, basis: 'selector_only', tokenVerified: false });
      } else if (!HEX.test(frame.input) || frame.input.length !== 138 || !address(frame.from)) {
        reasons.add('A malformed approve call was omitted.');
      } else {
        const spender = canonicalWordAddress(`0x${frame.input.slice(10, 74)}`);
        if (!spender) reasons.add('An approve call with noncanonical spender encoding was omitted.');
        else {
          const asset = assetFor(token, metadata);
          add({
            kind: 'approval_request', asset, tokenVerified: true, owner: address(frame.from), spender,
            ...amountFields(BigInt(`0x${frame.input.slice(74)}`), asset),
            basis: 'approve_calldata', origin: path === '0' ? 'top_level_request' : 'nested_call', framePath: path,
            returnStatus: returnStatus(frame.output), matchedEventIds: [], eventCorrelation: 'not_observed',
          });
        }
      }
    }

    if (frame.type === 'CALL' && selector === PERMIT) {
      const implementation = verified(token) ? permitImplementation(frame, token) : null;
      if (!implementation) {
        reasons.add('A matching permit selector occurred without configured token and implementation provenance; ERC-2612 arguments were not inferred.');
        add({ kind: 'unverified_permission_call', contract: token, selector, framePath: path, basis: 'selector_only', tokenVerified: false });
      } else if (!HEX.test(frame.input) || frame.input.length !== 458 || !address(frame.from) || quantity(frame.value ?? '0x0') !== 0n) {
        reasons.add('A malformed or nonzero-value ERC-2612 permit call was omitted.');
      } else {
        const words = Array.from({ length: 7 }, (_, i) => `0x${frame.input.slice(10 + i * 64, 74 + i * 64)}`);
        const owner = canonicalWordAddress(words[0]), spender = canonicalWordAddress(words[1]);
        const recoveryId = BigInt(words[4]);
        if (!owner || owner === '0x' + '0'.repeat(40) || !spender || recoveryId > 255n) reasons.add('Noncanonical owner, spender or uint8 encoding in a permit call was omitted.');
        else {
          const asset = assetFor(token, metadata), deadline = BigInt(words[3]);
          const timestamp = quantity(block?.timestamp);
          const relation = deadline === MAX_UINT256 ? 'unbounded' : timestamp === null ? 'unavailable' : deadline < timestamp ? 'expired_at_execution' : 'not_expired_at_execution';
          add({
            kind: 'permit_request', asset, tokenVerified: true, implementation,
            owner, spender, submitter: address(request?.from ?? trace.from), permitCaller: address(frame.from),
            relayed: address(request?.from ?? trace.from) ? address(request?.from ?? trace.from) !== owner : null,
            ...amountFields(BigInt(words[2]), asset), deadlineRaw: deadline.toString(), deadlineRelation: relation,
            signatureVerification: 'not_independently_verified', signatureEvidence: 'public_execution_calldata', recoveryId: recoveryId.toString(),
            basis: 'erc2612_permit_calldata', standardSource: 'https://eips.ethereum.org/EIPS/eip-2612',
            origin: path === '0' ? 'top_level_request' : 'nested_call', framePath: path,
            returnStatus: frame.output === undefined || frame.output === '0x' ? 'empty' : 'unexpected_data',
            matchedEventIds: [], eventCorrelation: 'not_observed',
          });
          warnings.add('Permit owner comes from calldata. The transaction submitter and immediate permit caller are reported separately; a relayed permit is not, by itself, evidence of maliciousness.');
          warnings.add('A permit deadline limits redemption of the signature; it does not make the resulting allowance expire. Domain, nonce, signature validity and original signing intent are not independently verified here.');
          if (relation === 'expired_at_execution') reasons.add('A successful permit trace has a deadline earlier than the recorded block time; this contradicts the configured ERC-2612 semantics.');
        }
      }
    }

    if (frame.logs != null && !Array.isArray(frame.logs)) reasons.add('Malformed trace logs prevent complete permission-event interpretation.');
    for (const [logOffset, log] of (Array.isArray(frame.logs) ? frame.logs : []).entries()) {
      if (!log || typeof log !== 'object' || logsSeen.has(log) || log.removed === true) continue;
      logsSeen.add(log);
      if (typeof log.topics?.[0] !== 'string' || log.topics[0].toLowerCase() !== APPROVAL) continue;
      const eventToken = address(log.address);
      const index = quantity(log.logIndex ?? log.index);
      const fingerprint = JSON.stringify([eventToken, log.topics, log.data]).toLowerCase();
      if (index !== null) {
        const key = index.toString();
        if (globalLogs.get(key) === fingerprint) continue;
        if (globalLogs.has(key)) {
          reasons.add('Conflicting global Approval log indexes were returned; duplicate/conflicting evidence is omitted.');
          continue;
        }
        globalLogs.set(key, fingerprint);
      }
      const location = { framePath: path, logIndex: index?.toString() ?? null, logOffset };
      if (!verified(eventToken)) {
        reasons.add('An Approval signature occurred at an unverified token address; ERC20 ownership and allowance semantics were not inferred.');
        add({ kind: 'unverified_permission_event', contract: eventToken, signature: APPROVAL, basis: 'event_signature_only', tokenVerified: false, ...location });
        continue;
      }
      const owner = canonicalWordAddress(log.topics?.[1]);
      const spender = canonicalWordAddress(log.topics?.[2]);
      if (!Array.isArray(log.topics) || log.topics.length !== 3 || !owner || !spender || typeof log.data !== 'string' || !WORD.test(log.data)) {
        reasons.add('A malformed ERC20 Approval event was omitted.');
        continue;
      }
      const asset = assetFor(eventToken, metadata);
      add({ kind: 'approval_event', asset, tokenVerified: true, owner, spender, ...amountFields(BigInt(log.data), asset),
        basis: 'approval_event', matchedRequestIds: [], ...location });
    }
    if (frame.calls != null && !Array.isArray(frame.calls)) reasons.add('Malformed child calls prevent complete permission interpretation.');
    for (const [index, child] of (Array.isArray(frame.calls) ? frame.calls : []).entries()) walk(child, `${path}.${index}`);
  }
  walk(trace);
  if (discardedSubtrees) warnings.add(`${discardedSubtrees} failed or reverted call subtree(s) were excluded from permission observations.`);

  const calls = observations.filter(observation => ['approval_request', 'permit_request'].includes(observation.kind));
  const events = observations.filter(observation => observation.kind === 'approval_event');
  for (const call of calls) {
    // Attribute an event to its nearest observed permission call for that token;
    // a parent must not borrow a nested approve or permit event as its own.
    const candidates = events.filter(event => event.asset.address === call.asset.address && sameCallBranch(call, event) && !calls.some(nested =>
      nested !== call && nested.asset.address === call.asset.address &&
      nested.framePath.startsWith(`${call.framePath}.`) && sameCallBranch(nested, event)));
    const matches = candidates.filter(event => signatureMatches(call, event));
    call.matchedEventIds = matches.map(event => event.id);
    call.eventCorrelation = matches.length ? 'matched' : candidates.length ? 'mismatched' : 'not_observed';
    for (const event of matches) event.matchedRequestIds.push(call.id);
    if (call.kind === 'approval_request' && call.returnStatus === 'returned_false') {
      warnings.add(`approve for ${call.spender} returned false; EVM call success does not establish approval success.`);
      if (candidates.length) reasons.add('An approve call returned false while its call subtree emitted Approval evidence; final allowance requires separate verification.');
    }
    if (call.eventCorrelation === 'mismatched') findings.push({
      code: 'APPROVAL_EVENT_MISMATCH', severity: 'review', basis: 'calldata_event_comparison',
      token: call.asset.address, owner: call.owner, spender: call.spender, requestedAmountRaw: call.amountRaw,
      observationIds: [call.id, ...candidates.map(event => event.id)],
      message: `No emitted Approval in this call matched the requested owner ${call.owner}, spender ${call.spender}, and amount. This is an evidence mismatch, not a maliciousness verdict.`,
    });
  }

  for (const event of events.filter(event => event.allowanceKind === 'uint256_max')) findings.push({
    code: 'MAX_UINT256_APPROVAL_EVENT', severity: 'review', basis: 'approval_event',
    token: event.asset.address, owner: event.owner, spender: event.spender, amountRaw: event.amountRaw,
    observationIds: [event.id],
    message: `An Approval event reported the maximum uint256 allowance from ${event.owner} to spender ${event.spender} for token ${event.asset.address}. This is commonly called unlimited approval. This event alone does not verify final allowance; consult allowanceChanges for measured state. Spender trustworthiness is not assessed.`,
  });
  for (const call of calls.filter(call => call.allowanceKind === 'uint256_max' && !call.matchedEventIds.length && call.returnStatus !== 'returned_false')) findings.push({
    code: call.kind === 'permit_request' ? 'MAX_UINT256_PERMIT_REQUEST' : 'MAX_UINT256_APPROVAL_REQUEST', severity: 'review', basis: call.basis,
    token: call.asset.address, owner: call.owner, spender: call.spender, amountRaw: call.amountRaw,
    observationIds: [call.id],
    message: `The call requested a maximum uint256 allowance for spender ${call.spender}, but no matching Approval event was observed. The request alone does not verify final allowance; consult allowanceChanges for measured state. Spender trustworthiness is not assessed.`,
  });
  for (const call of calls.filter(call => call.kind === 'permit_request' && call.deadlineRelation === 'unbounded')) findings.push({
    code: 'PERMIT_UNBOUNDED_DEADLINE', severity: 'review', basis: 'erc2612_permit_calldata',
    token: call.asset.address, owner: call.owner, spender: call.spender, deadlineRaw: call.deadlineRaw,
    observationIds: [call.id],
    message: 'The permit request uses the maximum uint256 redemption deadline. Nonce consumption or other contract rules may still prevent reuse. This observation does not establish signature validity or maliciousness, and the deadline is not an allowance-expiration time.',
  });
  return result();
}
