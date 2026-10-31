// Event-derived previews are evidence of emitted logs, not measured balance deltas.
import { decodeRevert } from './revert.js';
import { decodeLendingCall, supportsLending, reconcileLending, isKnownLiability } from './lending.js';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const MINT = '0x458f5fa412d0f69b08dd84872b0215675cc67bc1d5b6fd93300a1c3878b86196';
const POOL = '0x00a89d7a5a02160f20150ebea7a2b5e4879a1a8b';
const USDC = '0xb88339cb7199b77e23db6e890353e22632ba630f';
const HUSDC = '0x744e4f26ee30213989216e1632d9be3547c4885b';
const HUSDC_SCALED_IMPLEMENTATION = '0x410aa1ab680b886c875e99a7a4bfaf188508a7a3';
const RAY = 10n ** 27n;
const HUSDC_ROUNDING_SOURCE = 'https://hyperevmscan.io/address/0x410aa1ab680b886c875e99a7a4bfaf188508a7a3#code';
const CORE_WRITER = '0x3333333333333333333333333333333333333333';
const ZERO = '0x0000000000000000000000000000000000000000';
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const WORD = /^0x[0-9a-f]{64}$/i;
const HEX = /^0x(?:[0-9a-f]{2})*$/i;

function address(value) {
  return typeof value === 'string' && ADDRESS.test(value) ? value.toLowerCase() : null;
}

function quantity(value) {
  if (typeof value === 'bigint') return value >= 0n ? value : null;
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  return typeof value === 'string' && /^(?:0x[0-9a-f]+|[0-9]+)$/i.test(value) ? BigInt(value) : null;
}

function wordAddress(word) {
  return typeof word === 'string' && /^0x0{24}[0-9a-f]{40}$/i.test(word) ? address(`0x${word.slice(-40)}`) : null;
}

function words(data, count) {
  if (typeof data !== 'string' || !HEX.test(data) || data.length !== 2 + count * 64) return null;
  return Array.from({ length: count }, (_, i) => `0x${data.slice(2 + i * 64, 66 + i * 64)}`);
}

export function formatUnits(raw, decimals) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) return null;
  const amount = typeof raw === 'bigint' ? raw : BigInt(raw);
  const negative = amount < 0n;
  const digits = (negative ? -amount : amount).toString().padStart(decimals + 1, '0');
  const whole = decimals ? digits.slice(0, -decimals) : digits;
  const fraction = decimals ? digits.slice(-decimals).replace(/0+$/, '') : '';
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

function getAsset(token, metadata) {
  const entry = metadata?.[token];
  const decimals = Number.isInteger(entry?.decimals) && entry.decimals >= 0 && entry.decimals <= 255 ? entry.decimals : null;
  return {
    address: token,
    decimals,
    symbol: typeof entry?.symbol === 'string' ? entry.symbol : null,
    name: typeof entry?.name === 'string' ? entry.name : null,
    type: 'ERC20',
  };
}

function decodeSupply(request, metadata) {
  if (quantity(request.chainId) !== 999n || address(request.to) !== POOL || !/^0x617ba037/i.test(request.data ?? '')) return null;
  const args = words(`0x${request.data.slice(10)}`, 4);
  if (!args) return null;
  const asset = wordAddress(args[0]);
  const onBehalfOf = wordAddress(args[2]);
  const referral = BigInt(args[3]);
  if (!asset || !onBehalfOf || referral > 65535n) return null;
  const amountRaw = BigInt(args[1]);
  return {
    name: 'Hyperlend', operation: 'supply', asset,
    amountRaw: amountRaw.toString(), amount: formatUnits(amountRaw, getAsset(asset, metadata).decimals),
    onBehalfOf, referralCode: Number(referral), account: address(request.from),
  };
}

function decodeClassTransfer(frame) {
  const input = typeof frame.input === 'string' ? frame.input.toLowerCase() : '';
  if (!HEX.test(input) || !input.startsWith('0x17938e13') || input.length < 10 + 128) return null;
  const args = input.slice(10);
  // sendRawAction(bytes) has one dynamic parameter, with a canonical offset of 32.
  if (BigInt(`0x${args.slice(0, 64)}`) !== 32n) return null;
  const length = BigInt(`0x${args.slice(64, 128)}`);
  if (length !== 68n || args.length < 128 + 136) return null;
  const action = args.slice(128, 128 + 136);
  if (!action.startsWith('01000007')) return null;
  const amount = BigInt(`0x${action.slice(8, 72)}`);
  const direction = BigInt(`0x${action.slice(72, 136)}`);
  if (amount > (1n << 64n) - 1n || direction > 1n) return null;
  return {
    name: 'HyperCore', operation: 'usdClassTransfer', transport: 'CoreWriter',
    account: address(frame.from), amountRaw: amount.toString(), amount: formatUnits(amount, 6),
    toPerp: direction === 1n, direction: direction === 1n ? 'spot_to_perps' : 'perps_to_spot',
  };
}

function frameError(frame) {
  if (typeof frame?.error === 'string' && frame.error) return frame.error;
  if (frame?.error) return 'Execution failed';
  if (typeof frame?.revertReason === 'string' && frame.revertReason) return frame.revertReason;
  return null;
}

function scaledMintCall(frame, path) {
  if (frame.type !== 'CALL' || address(frame.from) !== POOL || address(frame.to) !== HUSDC || !/^0xb3f1c93d/i.test(frame.input ?? '')) return null;
  const args = words(`0x${frame.input.slice(10)}`, 4);
  if (!args || !wordAddress(args[0]) || !wordAddress(args[1])) return null;
  // The verified implementation accepts scaled units. Do not apply this model
  // to another implementation, even if its external mint selector is identical.
  const implementationIndex = (Array.isArray(frame.calls) ? frame.calls : []).findIndex(child =>
    child?.type === 'DELEGATECALL' && address(child.from) === HUSDC &&
    address(child.to) === HUSDC_SCALED_IMPLEMENTATION && !frameError(child) &&
    child.input?.toLowerCase() === frame.input.toLowerCase());
  if (implementationIndex < 0) return null;
  return { caller: wordAddress(args[0]), onBehalfOf: wordAddress(args[1]), scaledAmount: BigInt(args[2]), index: BigInt(args[3]), framePath: path, implementationPath:`${path}.${implementationIndex}` };
}

function reconcileScaledPrincipal({ requested, implied, mintEvents, mintCalls, account, beneficiary }) {
  if (mintEvents.length !== 1 || mintCalls.length !== 1) return null;
  const event = mintEvents[0];
  const call = mintCalls[0];
  if (call.index <= 0n || call.caller !== account || call.onBehalfOf !== beneficiary ||
      event.caller !== call.caller || event.onBehalfOf !== call.onBehalfOf ||
      BigInt(event.indexRaw) !== call.index || event.framePath !== call.implementationPath) return null;
  const expectedScaled = requested * RAY / call.index;
  if (call.scaledAmount !== expectedScaled || expectedScaled === 0n) return null;
  // Let q=floor(A*R/I), s=the prior scaled balance, and P be Mint.value-interest.
  // Verified source gives P=floor((s+q)*I/R)-floor(s*I/R), so P is either
  // floor(q*I/R) or ceil(q*I/R). This is a derived interval, not a fixed tolerance.
  // Prior scaled balance is not read here, so this checks consistency with the
  // model and does not claim to independently reconstruct the exact balance delta.
  const product = expectedScaled * call.index;
  const minimum = product / RAY;
  const maximum = (product + RAY - 1n) / RAY;
  return {
    status: implied >= minimum && implied <= maximum ? 'consistent_with_scaled_rounding' : 'outside_scaled_rounding_bounds',
    model: 'floor_scaled_mint_and_floor_balance',
    minImpliedPrincipalRaw: minimum.toString(), maxImpliedPrincipalRaw: maximum.toString(),
    scaledAmountRaw: expectedScaled.toString(), indexRaw: call.index.toString(),
    implementation: HUSDC_SCALED_IMPLEMENTATION, source: HUSDC_ROUNDING_SOURCE,
    basis: 'verified_implementation_and_traced_mint_inputs',
  };
}

/** Analyze a callTracer result without treating emitted events as balance queries. */
export function analyzeTrace({ request, trace, block = null, metadata = {}, mode = 'simulation' }) {
  const warnings = new Set([
    'The inAssets, outAssets and movements fields describe ERC20 Transfer events, not measured before-and-after balances. Separately measured balanceChanges, when available, describe those balances. Events alone are not proof of a balance change.',
    'Security has not been assessed. Successful execution is not a safety verdict.',
  ]);
  const reasons = new Set();
  const account = address(request?.from);
  const recognizedSupply = decodeSupply(request ?? {}, metadata);
  const recognizedLending = decodeLendingCall(request ?? {}, metadata);
  const supportedLending = supportsLending(recognizedLending);
  let protocol = recognizedSupply ?? recognizedLending;
  const validTrace = trace && typeof trace === 'object' && !Array.isArray(trace) && typeof trace.type === 'string';
  const error = validTrace ? frameError(trace) : 'Missing or invalid callTracer result';
  const status = error ? (/revert/i.test(error) || trace?.revertReason ? 'reverted' : 'failed') : 'success';
  const execution = {
    status, gasUsed: quantity(trace?.gasUsed)?.toString() ?? null,
    returnData: typeof trace?.output === 'string' ? trace.output : '0x', error,
  };
  if (status === 'reverted') execution.revert = decodeRevert(execution.returnData);
  const supportedSupply = recognizedSupply?.asset === USDC;
  if (supportedSupply) warnings.add('Supported coverage means the Hyperlend supply adapter recognizes the call and, on success, reconciles its principal and mint events. It does not imply complete balance, fee, or security analysis.');
  if (!supportedSupply && !supportedLending) reasons.add('Protocol coverage is limited to Hyperlend USDC supply, withdrawal, variable-rate borrowing and repayment on HyperEVM; other executions are not fully interpreted.');
  if (supportedLending) warnings.add('Lending coverage reconciles cash and position events with the verified scaled-token implementation. Separately measured balanceChanges are required to verify actual balances.');
  if (!validTrace) reasons.add('The provider did not return a valid callTracer result.');
  if (!account) reasons.add('A valid account is required to determine the preview perspective.');
  if (mode === 'historical_trace') warnings.add('This is historical execution evidence, not a prediction of execution against current state.');
  if (!block) warnings.add('No block identity was supplied with this trace.');
  for (const [traceKey, requestKey] of [['from', 'from'], ['to', 'to'], ['input', 'data']]) {
    if (typeof trace?.[traceKey] === 'string' && typeof request?.[requestKey] === 'string' && trace[traceKey].toLowerCase() !== request[requestKey].toLowerCase()) {
      reasons.add(`Trace ${traceKey} does not match the requested ${requestKey}.`);
    }
  }

  const logs = [];
  const seenFrames = new WeakSet();
  const seenLogs = new WeakSet();
  const indexedLogs = new Map();
  const coreCalls = [];
  const scaledMintCalls = [];
  const successfulFrames = [];
  let nativeValue = (quantity(request?.value) ?? 0n) > 0n;
  let revertedChildren = 0;
  function walk(frame, path = '0') {
    if (!frame || typeof frame !== 'object' || seenFrames.has(frame)) return;
    seenFrames.add(frame);
    if (frameError(frame)) { revertedChildren++; return; }
    successfulFrames.push({frame,path});
    if (address(frame.to) === CORE_WRITER && quantity(request?.chainId) === 999n) coreCalls.push(frame);
    if (supportedSupply) {
      const mintCall = scaledMintCall(frame, path);
      if (mintCall) scaledMintCalls.push(mintCall);
    }
    if (['CALL', 'CREATE', 'CREATE2', 'SELFDESTRUCT'].includes(frame.type) && (quantity(frame.value) ?? 0n) > 0n) nativeValue = true;
    if (frame.logs != null && !Array.isArray(frame.logs)) reasons.add('A trace frame contains malformed logs; event coverage is incomplete.');
    for (const [logOffset, log] of (Array.isArray(frame.logs) ? frame.logs : []).entries()) {
      if (!log || typeof log !== 'object') { reasons.add('A malformed event was omitted.'); continue; }
      if (seenLogs.has(log)) continue;
      seenLogs.add(log);
      if (log.removed === true) continue;
      const index = quantity(log.logIndex ?? log.index);
      if (index !== null) {
        const key = index.toString();
        const fingerprint = JSON.stringify([
          typeof log.address === 'string' ? log.address.toLowerCase() : log.address,
          Array.isArray(log.topics) ? log.topics.map(topic => typeof topic === 'string' ? topic.toLowerCase() : topic) : log.topics,
          typeof log.data === 'string' ? log.data.toLowerCase() : log.data,
        ]);
        if (indexedLogs.get(key) === fingerprint) continue;
        if (indexedLogs.has(key)) reasons.add('Conflicting global log indexes were returned; event completeness cannot be guaranteed.');
        indexedLogs.set(key, fingerprint);
      }
      logs.push({ log, logIndex: index?.toString() ?? null, framePath: path, logOffset });
    }
    if (frame.calls != null && !Array.isArray(frame.calls)) reasons.add('A trace frame contains malformed child calls; coverage is incomplete.');
    for (const [i, child] of (Array.isArray(frame.calls) ? frame.calls : []).entries()) walk(child, `${path}.${i}`);
  }
  if (status === 'success') walk(trace);
  if (revertedChildren) warnings.add(`${revertedChildren} reverted or failed child call subtree(s) were excluded from asset movements.`);
  if (logs.length && logs.every(entry => entry.logIndex !== null)) {
    logs.sort((a, b) => BigInt(a.logIndex) < BigInt(b.logIndex) ? -1 : BigInt(a.logIndex) > BigInt(b.logIndex) ? 1 : 0);
  }
  if (nativeValue) reasons.add('Native-token value transfers occurred. Check the separate HYPE balance view for available current-state measurements; ERC20 event totals exclude native value, and network fees are not calculated.');
  if (coreCalls.length) {
    reasons.add('CoreWriter submits actions for separate HyperCore processing. This EVM trace does not simulate or verify the resulting Spot or Perps balance changes.');
    if (!protocol) protocol = coreCalls.map(decodeClassTransfer).find(Boolean) ?? { name: 'HyperCore', operation: 'unknown', transport: 'CoreWriter' };
    warnings.add('An accepted CoreWriter call is not confirmation of the subsequent HyperCore action.');
  }

  const movements = [];
  const interestAccruals = [];
  for (const { log, ...location } of logs) {
    const signature = typeof log.topics?.[0] === 'string' ? log.topics[0].toLowerCase() : null;
    if (signature !== TRANSFER && signature !== MINT) continue;
    const token = address(log.address);
    if (signature === TRANSFER) {
      // ERC721's Transfer uses four topics and no uint256 data; do not classify it as ERC20.
      if (Array.isArray(log.topics) && log.topics.length === 4) { reasons.add('ERC721 Transfer events were present and are outside ERC20 coverage.'); continue; }
      const from = wordAddress(log.topics?.[1]);
      const to = wordAddress(log.topics?.[2]);
      if (!token || !Array.isArray(log.topics) || log.topics.length !== 3 || !from || !to || !WORD.test(log.data ?? '')) {
        reasons.add('A malformed ERC20 Transfer event was omitted.'); continue;
      }
      movements.push({ address: token, from, to, amountRaw: BigInt(log.data).toString(), basis: 'transfer_event', ...location });
    } else if (quantity(request?.chainId) === 999n && token === HUSDC) {
      const caller = wordAddress(log.topics?.[1]);
      const onBehalfOf = wordAddress(log.topics?.[2]);
      const fields = words(log.data, 3);
      if (!caller || !onBehalfOf || !Array.isArray(log.topics) || log.topics.length !== 3 || !fields) {
        reasons.add('A malformed Hyperlend Mint event was omitted.'); continue;
      }
      const [value, balanceIncrease, index] = fields.map(field => BigInt(field));
      const decimals = getAsset(token, metadata).decimals;
      const principal = supportedSupply && onBehalfOf === protocol.onBehalfOf ? value - balanceIncrease : null;
      interestAccruals.push({
        address: token, caller, onBehalfOf,
        valueRaw: value.toString(), balanceIncreaseRaw: balanceIncrease.toString(), principalRaw: principal?.toString() ?? null,
        value: formatUnits(value, decimals), balanceIncrease: formatUnits(balanceIncrease, decimals),
        principal: principal === null ? null : formatUnits(principal, decimals), indexRaw: index.toString(),
        // principal / principalRaw remain compatibility aliases. They describe
        // Mint.value minus interest, not necessarily the deposited USDC amount.
        mintEventImpliedPrincipalRaw: principal?.toString() ?? null,
        mintEventImpliedPrincipal: principal === null ? null : formatUnits(principal, decimals),
        principalBasis: 'mint_value_minus_balance_increase',
        basis: 'hyperlend_mint_event', ...location,
      });
    }
  }

  const incoming = new Map();
  const outgoing = new Map();
  function addAsset(map, movement, direction) {
    const asset = getAsset(movement.address, metadata);
    if (asset.decimals === null) reasons.add(`Token decimals are unknown for ${movement.address}; amounts remain in raw units.`);
    if (!map.has(movement.address)) map.set(movement.address, { asset, transferIn: [], transferOut: [] });
    const value = formatUnits(BigInt(movement.amountRaw), asset.decimals);
    const label = value === null ? `${movement.amountRaw} raw units of ${asset.symbol ?? movement.address}` : `${value} ${asset.symbol ?? movement.address}`;
    map.get(movement.address)[direction].push({
      rawValue: `0x${BigInt(movement.amountRaw).toString(16)}`, value,
      summary: `${direction === 'transferIn' ? 'Receiving' : 'Sending'} ${label}`,
      basis: 'transfer_event',
    });
  }
  for (const movement of movements) {
    if (isKnownLiability(request.chainId,movement.address)) {
      warnings.add('Variable-debt token events represent a non-transferable liability. They are preserved in raw movements and positionChanges, and excluded from spendable incoming/outgoing assets.');
      continue;
    }
    if (account && movement.from === account) addAsset(outgoing, movement, 'transferOut');
    if (account && movement.to === account) addAsset(incoming, movement, 'transferIn');
    if (account && movement.from === account && movement.to === account) warnings.add('Self-transfer events appear in both incoming and outgoing assets and are not a net balance change.');
    if (supportedSupply && movement.address !== USDC && movement.address !== HUSDC) reasons.add('Additional token movements fall outside the supported Hyperlend USDC supply interpretation.');
  }
  if (supportedSupply && status === 'success') {
    const principalOut = movements.filter(m => m.address === USDC && m.from === account && m.to === HUSDC).reduce((sum, m) => sum + BigInt(m.amountRaw), 0n);
    const mintEvents = interestAccruals.filter(m => m.onBehalfOf === protocol.onBehalfOf);
    const receiptIn = movements.filter(m => m.address === HUSDC && m.from === ZERO && m.to === protocol.onBehalfOf).reduce((sum, m) => sum + BigInt(m.amountRaw), 0n);
    const minted = mintEvents.reduce((sum, m) => sum + BigInt(m.valueRaw), 0n);
    const principalMinted = mintEvents.reduce((sum, m) => sum + BigInt(m.principalRaw), 0n);
    const requested = BigInt(protocol.amountRaw);
    const decimals = getAsset(USDC, metadata).decimals;
    const roundingDifference = principalMinted - requested;
    const rounding = reconcileScaledPrincipal({ requested, implied: principalMinted, mintEvents, mintCalls: scaledMintCalls, account, beneficiary: protocol.onBehalfOf });
    Object.assign(protocol, {
      requestedDepositPrincipalRaw: requested.toString(), requestedDepositPrincipal: formatUnits(requested, decimals),
      transferredDepositPrincipalRaw: principalOut.toString(), transferredDepositPrincipal: formatUnits(principalOut, decimals),
      mintEventImpliedPrincipalRaw: mintEvents.length ? principalMinted.toString() : null,
      mintEventImpliedPrincipal: mintEvents.length ? formatUnits(principalMinted, decimals) : null,
      roundingDifferenceRaw: mintEvents.length ? roundingDifference.toString() : null,
      roundingDifference: mintEvents.length ? formatUnits(roundingDifference, decimals) : null,
      roundingDifferenceBasis: 'mint_event_implied_principal_minus_requested_deposit',
      principalReconciliation: rounding ?? { status: principalMinted === requested && mintEvents.length ? 'exact_event_match' : 'unreconciled', model: null },
    });
    if (principalOut !== requested) reasons.add('Observed USDC transfer events do not match the requested supply principal.');
    const scaledConsistent = rounding?.status === 'consistent_with_scaled_rounding';
    if (!mintEvents.length || minted !== receiptIn || (principalMinted !== requested && !scaledConsistent) || rounding?.status === 'outside_scaled_rounding_bounds') reasons.add('Receipt-token Transfer and Mint events do not fully reconcile to the supplied principal and verified scaled-token rounding model.');
    if (roundingDifference !== 0n && mintEvents.length) {
      warnings.add(scaledConsistent
        ? `Mint-event implied principal differs from the requested deposit by ${roundingDifference} raw USDC unit(s), consistent with the verified scaled-token rounding interval. The USDC deposit amount is reported separately; balanceChanges reports whether exact pre/post balances were measured.`
        : `Mint-event implied principal differs from the requested deposit by ${roundingDifference} raw USDC unit(s). This difference has not been reconciled to a verified rounding model.`);
    }
    if (protocol.onBehalfOf !== account) warnings.add(`Receipt tokens are minted for ${protocol.onBehalfOf}; incoming assets are shown only for the submitting account ${account}.`);
    if (interestAccruals.some(m => BigInt(m.balanceIncreaseRaw) !== 0n)) warnings.add('The Hyperlend receipt-token mint includes accrued interest. Principal and interest are shown separately from the Transfer event total.');
  }
  let positionChanges = [];
  if (supportedLending && status === 'success') {
    const lending = reconcileLending({protocol,logs,movements,frames:successfulFrames,returnData:execution.returnData});
    positionChanges = lending.positionChanges;
    for (const reason of lending.reasons) reasons.add(reason);
    if (protocol.operation === 'repay' && protocol.actualAmountRaw !== protocol.amountRaw) warnings.add('Repayment used the executed amount, which can be capped by outstanding debt. The requested amount is shown separately.');
    if (positionChanges.some(p=>BigInt(p.accruedInterestRaw)!==0n)) warnings.add('Position Mint/Burn totals include accrued interest already reflected in balanceOf. The implied position change removes this interest.');
  }
  if (status !== 'success') warnings.add('The top-level transaction did not succeed; all event-derived asset movements were discarded.');
  const coverageStatus = (supportedSupply || supportedLending) && !reasons.size ? 'supported' : (supportedSupply || protocol || movements.length ? 'partial' : 'unsupported');
  return {
    execution, coverage: { status: coverageStatus, reasons: [...reasons] }, protocol,
    inAssets: [...incoming.values()], outAssets: [...outgoing.values()], movements, interestAccruals, positionChanges,
    warnings: [...warnings], security: { status: 'not_assessed', findings: [] },
  };
}
