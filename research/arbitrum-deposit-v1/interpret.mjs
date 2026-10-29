import declaredMetadata from './deployment-metadata.json' with { type: 'json' };

const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
export const DEPLOYMENT_METADATA = freeze(declaredMetadata);
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO = '0x' + '0'.repeat(40);
const required = ['chainId', 'from', 'to', 'value', 'data'];
const result = (status, reason) => freeze({ status, reason, intent: null });
const units = n => {
  const raw = n.toString().padStart(7, '0');
  return (raw.slice(0, -6) + '.' + raw.slice(-6)).replace(/\.?0+$/, '');
};

/** Recognize one declared route from calldata only. No state, events, balance
 * observations, fee quote, execution success or destination settlement enters
 * this function. Narrower than every encoding accepted by the contracts. */
export function decodeCctpHypercoreIntent(input) {
  if (!input || typeof input !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) return result('malformed', 'input_object');
  const descriptors = Object.getOwnPropertyDescriptors(input), keys = Reflect.ownKeys(descriptors);
  if (keys.length !== required.length || !required.every(k => keys.includes(k)) ||
      keys.some(k => typeof k !== 'string' || !('value' in descriptors[k]) || !descriptors[k].enumerable)) return result('malformed', 'input_fields');
  const values = Object.fromEntries(required.map(k => [k, descriptors[k].value]));
  if (typeof values.chainId !== 'string' || !/^(0|[1-9][0-9]*)$/.test(values.chainId) || values.chainId.length > 20 ||
      typeof values.from !== 'string' || !ADDRESS.test(values.from) ||
      typeof values.to !== 'string' || !ADDRESS.test(values.to) ||
      typeof values.value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(values.value) || values.value.length > 78 ||
      typeof values.data !== 'string' || values.data.length > 8194 || !/^0x(?:[0-9a-fA-F]{2})*$/.test(values.data)) return result('malformed', 'input_encoding');
  const from = values.from.toLowerCase(), to = values.to.toLowerCase(), data = values.data.toLowerCase();
  if (from === ZERO) return result('malformed', 'zero_sender');
  if (values.chainId !== DEPLOYMENT_METADATA.chainId || to !== DEPLOYMENT_METADATA.tokenMessenger) return result('unrecognized', 'chain_or_target');
  if (data.slice(0, 10) !== DEPLOYMENT_METADATA.selector) return result('unrecognized', 'selector');
  if (values.value !== '0') return result('unsupported', 'nonzero_native_value');
  // Eight 32-byte head words, one length word, then exactly 56 hook bytes and
  // eight zero padding bytes. Aliased tails, gaps and trailing bytes are refused.
  if (data.length !== 2 + (4 + 8 * 32 + 32 + 64) * 2) return result('malformed', 'calldata_length');
  const body = data.slice(10), word = n => body.slice(n * 64, (n + 1) * 64);
  if (BigInt('0x' + word(7)) !== 256n || BigInt('0x' + word(8)) !== 56n) return result('malformed', 'abi_offset_or_length');
  if (!/^0{56}[0-9a-f]{8}$/.test(word(1)) || !/^0{56}[0-9a-f]{8}$/.test(word(6)) ||
      !/^0{24}[0-9a-f]{40}$/.test(word(3))) return result('malformed', 'abi_word_width');
  // bytes32 is unrestricted in the general ABI; this EVM-address route requires
  // canonical zero-left-padding for both recipient and permitted caller.
  if (!/^0{24}[0-9a-f]{40}$/.test(word(2)) || !/^0{24}[0-9a-f]{40}$/.test(word(4))) return result('unsupported', 'non_evm_recipient_encoding');
  const amount = BigInt('0x' + word(0)), domain = Number(BigInt('0x' + word(1)));
  const mintRecipient = '0x' + word(2).slice(24), token = '0x' + word(3).slice(24);
  const destinationCaller = '0x' + word(4).slice(24), maxFee = BigInt('0x' + word(5));
  const finality = Number(BigInt('0x' + word(6)));
  if (domain !== DEPLOYMENT_METADATA.destinationCctpDomain || token !== DEPLOYMENT_METADATA.token ||
      mintRecipient !== DEPLOYMENT_METADATA.forwarder || destinationCaller !== DEPLOYMENT_METADATA.forwarder) return result('unsupported', 'undeclared_route');
  if (amount === 0n || maxFee >= amount) return result('unsupported', 'amount_or_fee_cap');
  if (![1000, 2000].includes(finality)) return result('unsupported', 'finality_threshold');
  const tail = body.slice(9 * 64), hook = tail.slice(0, 112);
  if (tail.slice(112) !== '0'.repeat(16)) return result('malformed', 'abi_tail_padding');
  if (hook.slice(0, 48) !== '636374702d666f7277617264'.padEnd(48, '0') ||
      hook.slice(48, 56) !== '00000000' || hook.slice(56, 64) !== '00000018') return result('unsupported', 'forwarding_hook_format');
  const recipient = '0x' + hook.slice(64, 104), dex = BigInt('0x' + hook.slice(104, 112)).toString();
  // The managed token and configured tokenSystemAddress are distinct. Only the
  // zero address and declared wallet identity are excluded without live state.
  if ([ZERO, DEPLOYMENT_METADATA.coreDepositWallet].includes(recipient)) return result('unsupported', 'invalid_hypercore_recipient');
  if (!Object.hasOwn(DEPLOYMENT_METADATA.recognizedDestinationDexes, dex)) return result('unsupported', 'unknown_destination_dex');
  return freeze({ status: 'recognized_intent', reason: null, intent: {
    kind: 'cctp_v2_hypercore_forwarding', sourceChainId: values.chainId, sourceCctpDomain: DEPLOYMENT_METADATA.sourceCctpDomain,
    sender: from, tokenMessenger: to, function: DEPLOYMENT_METADATA.signature,
    requestedBurn: { token, symbol: 'USDC', decimals: 6, amountRaw: amount.toString(), amountFormatted: units(amount) },
    destination: { cctpDomain: domain, chainId: DEPLOYMENT_METADATA.destinationChainId, mintRecipient, destinationCaller,
      hypercoreRecipient: recipient, recipientIsSender: recipient === from, destinationDex: dex,
      requestedBalance: DEPLOYMENT_METADATA.recognizedDestinationDexes[dex] },
    maxFee: { raw: maxFee.toString(), formatted: units(maxFee), kind: 'cap_not_quote' }, minFinalityThreshold: finality,
    hook: { raw: '0x' + hook, magic: 'cctp-forward', version: 0, payloadBytes: 24, totalBytes: 56 },
    basis: { kind: 'calldata_and_declared_deployment_metadata', metadataId: DEPLOYMENT_METADATA.id,
      contractIdentityVerified: false, balancesRead: false, allowanceRead: false, sourceExecutionObserved: false,
      destinationRecipientValidationVerified: false },
    sourceExecution: null, measuredOutgoingAmount: null, destinationSettlement: null, destinationCreditAmount: null,
    limitations: ['Requested perps routing can fall back to spot under destination configuration.',
      'Configured tokenSystemAddress and recipient blacklist state are unobserved; recipient eligibility is not established.',
      'Current fees, account charges, liquidity, attestation and forwarding state are not observed.',
      'No chain balance, approval sufficiency, execution result or destination credit is inferred.'],
  } });
}
