// ERC-20 approve/Approval semantics: https://eips.ethereum.org/EIPS/eip-20
// This module observes permission requests and events. It does not query allowance
// state, classify spenders, or provide a transaction-wide security verdict.
import { CHAIN_ID, USDC, HUSDC } from './config.js';

const APPROVE = '0x095ea7b3';
const APPROVAL = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';
const MAX_UINT256 = (1n << 256n) - 1n;
const VERIFIED_TOKENS = new Set([USDC, HUSDC]);
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
  if (!WORD.test(output)) return 'malformed';
  const value = BigInt(output);
  return value === 1n ? 'returned_true' : value === 0n ? 'returned_false' : 'malformed';
}

function signatureMatches(a, b) {
  return a.asset.address === b.asset.address && a.owner === b.owner && a.spender === b.spender && a.amountRaw === b.amountRaw;
}

function sameCallBranch(call, event) {
  return event.framePath === call.framePath || event.framePath.startsWith(`${call.framePath}.`);
}

/** Analyze permission evidence from a completed callTracer result, without RPC IO. */
export function analyzePermissions({ request, trace, metadata = {} } = {}) {
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
      if (!Array.isArray(log.topics) || log.topics.length !== 3 || !owner || !spender || !WORD.test(log.data ?? '')) {
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

  const calls = observations.filter(observation => observation.kind === 'approval_request');
  const events = observations.filter(observation => observation.kind === 'approval_event');
  for (const call of calls) {
    // Attribute an event to its nearest observed approve call for that token;
    // a parent call must not borrow a nested approve's event as its own evidence.
    const candidates = events.filter(event => event.asset.address === call.asset.address && sameCallBranch(call, event) && !calls.some(nested =>
      nested !== call && nested.asset.address === call.asset.address &&
      nested.framePath.startsWith(`${call.framePath}.`) && sameCallBranch(nested, event)));
    const matches = candidates.filter(event => signatureMatches(call, event));
    call.matchedEventIds = matches.map(event => event.id);
    call.eventCorrelation = matches.length ? 'matched' : candidates.length ? 'mismatched' : 'not_observed';
    for (const event of matches) event.matchedRequestIds.push(call.id);
    if (call.returnStatus === 'returned_false') {
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
    message: `An Approval event reported the maximum uint256 allowance from ${event.owner} to spender ${event.spender} for token ${event.asset.address}. This is commonly called unlimited approval; the final allowance and spender trustworthiness were not verified.`,
  });
  for (const call of calls.filter(call => call.allowanceKind === 'uint256_max' && !call.matchedEventIds.length && call.returnStatus !== 'returned_false')) findings.push({
    code: 'MAX_UINT256_APPROVAL_REQUEST', severity: 'review', basis: 'approve_calldata',
    token: call.asset.address, owner: call.owner, spender: call.spender, amountRaw: call.amountRaw,
    observationIds: [call.id],
    message: `The call requested a maximum uint256 allowance for spender ${call.spender}, but no matching Approval event was observed. Permission activation and spender trustworthiness were not verified.`,
  });
  return result();
}
