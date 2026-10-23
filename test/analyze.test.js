import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { analyzeTrace, formatUnits } from '../src/analyze.js';

const observed = JSON.parse(await readFile(new URL('../fixtures/hyperlend-observed-supply.json', import.meta.url), 'utf8'));
const corewriter = JSON.parse(await readFile(new URL('../fixtures/corewriter-observed-history.json', import.meta.url), 'utf8'));
const FROM = observed.input.request.from;
const TO = '0x1111111111111111111111111111111111111111';
const USDC = '0xb88339cb7199b77e23db6e890353e22632ba630f';
const HUSDC = '0x744e4f26ee30213989216e1632d9be3547c4885b';
const ZERO = '0x0000000000000000000000000000000000000000';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const MINT = '0x458f5fa412d0f69b08dd84872b0215675cc67bc1d5b6fd93300a1c3878b86196';
const word = value => `0x${BigInt(value).toString(16).padStart(64, '0')}`;
const addrWord = value => `0x${value.slice(2).padStart(64, '0')}`;
function transfer(from = FROM, to = TO, amount = 1n, token = USDC, index = 0) {
  return { address: token, topics: [TRANSFER, addrWord(from), addrWord(to)], data: word(amount), index: `0x${index.toString(16)}` };
}
function simple(logs = [], overrides = {}) {
  return {
    request: { chainId: 999, from: FROM, to: TO, data: '0x', value: '0' },
    trace: { type: 'CALL', from: FROM, to: TO, input: '0x', gasUsed: '0x5208', logs, ...overrides },
    metadata: observed.input.metadata,
    block: { number: '1', hash: '0x00', timestamp: '1' },
  };
}

test('real Hyperlend trace: exact USDC principal and distinct accrued interest', () => {
  const preview = analyzeTrace(observed.input);
  assert.equal(preview.execution.status, 'success');
  assert.equal(preview.execution.gasUsed, '165727');
  assert.equal(preview.protocol.name, 'Hyperlend');
  assert.equal(preview.protocol.amount, '15.066115');
  assert.equal(preview.coverage.status, 'supported');
  assert.equal(preview.outAssets.length, 1);
  assert.equal(preview.outAssets[0].transferOut[0].rawValue, '0xe5e403');
  assert.equal(preview.outAssets[0].transferOut[0].value, '15.066115');
  assert.equal(preview.inAssets[0].transferIn[0].value, '15.066912');
  assert.equal(preview.interestAccruals[0].balanceIncreaseRaw, '797');
  assert.equal(preview.interestAccruals[0].balanceIncrease, '0.000797');
  assert.equal(preview.interestAccruals[0].principal, '15.066115');
  assert.equal(preview.movements.length, 2, 'proxy delegate calls must not duplicate token transfers');
  assert.deepEqual(preview.security, { status: 'not_assessed', findings: [] });
  assert.ok(preview.warnings.some(warning => warning.includes('not measured before-and-after')));
});

test('real CoreWriter trace is incomplete HyperCore coverage and creates no invented assets', () => {
  const preview = analyzeTrace(corewriter.input);
  assert.equal(preview.execution.status, 'success');
  assert.equal(preview.coverage.status, 'partial');
  assert.equal(preview.protocol.transport, 'CoreWriter');
  assert.equal(preview.protocol.amount, '28.241737');
  assert.equal(preview.protocol.toPerp, false);
  assert.equal(preview.protocol.direction, 'perps_to_spot');
  assert.deepEqual(preview.inAssets, []);
  assert.deepEqual(preview.outAssets, []);
  assert.ok(preview.coverage.reasons.some(reason => reason.includes('separate HyperCore')));
});

test('a top-level revert discards every descendant log', () => {
  const input = structuredClone(observed.input);
  input.trace.error = 'execution reverted';
  input.trace.revertReason = 'insufficient allowance';
  const preview = analyzeTrace(input);
  assert.equal(preview.execution.status, 'reverted');
  assert.deepEqual(preview.movements, []);
  assert.deepEqual(preview.interestAccruals, []);
  assert.deepEqual(preview.inAssets, []);
  assert.deepEqual(preview.outAssets, []);
});

test('out-of-gas differs from a contract revert and also discards events', () => {
  const preview = analyzeTrace(simple([transfer()], { error: 'out of gas' }));
  assert.equal(preview.execution.status, 'failed');
  assert.equal(preview.execution.error, 'out of gas');
  assert.deepEqual(preview.movements, []);
});

test('caught inner failure discards its entire subtree but preserves successful siblings', () => {
  const input = simple([], {
    calls: [
      { type: 'CALL', error: 'execution reverted', logs: [transfer(FROM, TO, 90n, USDC, 0)], calls: [{ type: 'CALL', logs: [transfer(FROM, TO, 100n, USDC, 1)] }] },
      { type: 'CALL', logs: [transfer(FROM, TO, 2n, USDC, 2)] },
    ],
  });
  const preview = analyzeTrace(input);
  assert.equal(preview.execution.status, 'success');
  assert.deepEqual(preview.movements.map(m => m.amountRaw), ['2']);
  assert.ok(preview.warnings.some(warning => warning.includes('child call subtree')));
});

test('duplicate global log records are counted once; separate identical emissions remain separate', () => {
  const event = transfer(FROM, TO, 123n, USDC, 1);
  const input = simple([event], {
    calls: [{ type: 'CALL', logs: [structuredClone(event), transfer(FROM, TO, 123n, USDC, 2)] }],
  });
  const preview = analyzeTrace(input);
  assert.equal(preview.movements.length, 2);
  assert.equal(preview.outAssets[0].transferOut.length, 2);
});

test('amounts above Number.MAX_SAFE_INTEGER stay exact and decimals are never guessed', () => {
  const amount = 123456789012345678901234567890123456789n;
  const known = analyzeTrace(simple([transfer(FROM, TO, amount)]));
  assert.equal(known.outAssets[0].transferOut[0].value, '123456789012345678901234567890123.456789');
  const unknownInput = simple([transfer(FROM, TO, amount)]);
  unknownInput.metadata = {};
  const unknown = analyzeTrace(unknownInput);
  assert.equal(unknown.outAssets[0].asset.decimals, null);
  assert.equal(unknown.outAssets[0].transferOut[0].value, null);
  assert.equal(unknown.movements[0].amountRaw, amount.toString());
  assert.equal(formatUnits(1000000n, 6), '1');
  assert.equal(formatUnits(1n, 18), '0.000000000000000001');
  assert.equal(formatUnits(-797n, 6), '-0.000797');
  assert.equal(formatUnits(1n, 256), null);
});

test('deposit for another beneficiary keeps sender-only incoming assets and principal reconciliation', () => {
  const input = structuredClone(observed.input);
  const amount = 15066115n;
  input.request.data = `0x617ba037${addrWord(USDC).slice(2)}${word(amount).slice(2)}${addrWord(TO).slice(2)}${word(0n).slice(2)}`;
  input.trace = {
    type: 'CALL', from: FROM, to: input.request.to, input: input.request.data, gasUsed: '0x100',
    logs: [
      transfer(FROM, HUSDC, amount, USDC, 0),
      transfer(ZERO, TO, amount + 797n, HUSDC, 1),
      { address: HUSDC, topics: [MINT, addrWord(FROM), addrWord(TO)], data: `0x${word(amount + 797n).slice(2)}${word(797n).slice(2)}${word(1000n).slice(2)}`, index: '0x2' },
    ],
  };
  const preview = analyzeTrace(input);
  assert.equal(preview.protocol.onBehalfOf, TO);
  assert.equal(preview.coverage.status, 'supported');
  assert.equal(preview.inAssets.length, 0);
  assert.equal(preview.outAssets.length, 1);
  assert.equal(preview.interestAccruals[0].principalRaw, amount.toString());
  assert.ok(preview.warnings.some(warning => warning.includes('Receipt tokens are minted for')));
});

test('missing receipt logs downgrade otherwise recognized supply coverage', () => {
  const input = structuredClone(observed.input);
  input.trace = { type: 'CALL', from: FROM, to: input.request.to, input: input.request.data, logs: [transfer(FROM, HUSDC, 15066115n)] };
  const preview = analyzeTrace(input);
  assert.equal(preview.coverage.status, 'partial');
  assert.ok(preview.coverage.reasons.some(reason => reason.includes('do not fully reconcile')));
});

test('recognized supply with successful but empty trace is not supported complete event coverage', () => {
  const input = structuredClone(observed.input);
  input.trace = { type: 'CALL', from: FROM, to: input.request.to, input: input.request.data, gasUsed: '0x5208' };
  const preview = analyzeTrace(input);
  assert.equal(preview.execution.status, 'success');
  assert.equal(preview.protocol.name, 'Hyperlend');
  assert.equal(preview.coverage.status, 'partial');
  assert.deepEqual(preview.inAssets, []);
  assert.deepEqual(preview.outAssets, []);
  assert.ok(preview.coverage.reasons.some(reason => reason.includes('USDC transfer events do not match')));
  assert.ok(preview.coverage.reasons.some(reason => reason.includes('do not fully reconcile')));
});

test('missing or malformed token decimals downgrade known supply without inventing display units', () => {
  for (const decimals of [undefined, -1, 6.5, '6', 256]) {
    const input = structuredClone(observed.input);
    input.metadata[USDC].decimals = decimals;
    const preview = analyzeTrace(input);
    assert.equal(preview.coverage.status, 'partial');
    assert.equal(preview.protocol.amount, null);
    assert.equal(preview.outAssets[0].transferOut[0].value, null);
    assert.equal(preview.outAssets[0].transferOut[0].rawValue, '0xe5e403');
  }
});

test('unknown empty calls are unsupported rather than complete empty previews', () => {
  const preview = analyzeTrace(simple());
  assert.equal(preview.execution.status, 'success');
  assert.equal(preview.coverage.status, 'unsupported');
  assert.equal(preview.protocol, null);
  assert.deepEqual(preview.outAssets, []);
});

test('malformed events and ERC721 events are omitted, with incomplete coverage', () => {
  const nft = transfer();
  nft.topics.push(word(7n));
  nft.data = '0x';
  const malformed = transfer();
  malformed.data = '0x1';
  const malformedAddress = transfer();
  malformedAddress.address = 8;
  const malformedTopics = transfer();
  malformedTopics.topics = { ...malformedTopics.topics, length: 3 };
  const preview = analyzeTrace(simple([nft, malformed, malformedAddress, malformedTopics]));
  assert.deepEqual(preview.movements, []);
  assert.ok(preview.coverage.reasons.some(reason => reason.includes('ERC721')));
  assert.ok(preview.coverage.reasons.some(reason => reason.includes('malformed ERC20')));
});

test('protocol identity requires matching chain and deployed pool, not selector alone', () => {
  for (const mutate of [input => { input.request.to = TO; }, input => { input.request.chainId = 1; }]) {
    const input = structuredClone(observed.input);
    mutate(input);
    const preview = analyzeTrace(input);
    assert.equal(preview.protocol, null);
    assert.equal(preview.coverage.status, 'partial');
  }
});

test('native value is not silently claimed as complete ERC20 coverage', () => {
  const input = structuredClone(observed.input);
  input.trace.calls.push({ type: 'CALL', from: input.request.to, to: TO, value: '0x1' });
  const preview = analyzeTrace(input);
  assert.equal(preview.coverage.status, 'partial');
  assert.ok(preview.coverage.reasons.some(reason => reason.includes('Native-token')));
});

test('self transfers are visible in both directions without fabricating a net loss', () => {
  const preview = analyzeTrace(simple([transfer(FROM, FROM, 42n)]));
  assert.equal(preview.inAssets[0].transferIn[0].rawValue, '0x2a');
  assert.equal(preview.outAssets[0].transferOut[0].rawValue, '0x2a');
  assert.ok(preview.warnings.some(warning => warning.includes('Self-transfer')));
});

test('missing trace is a failed result rather than successful empty simulation', () => {
  const input = simple();
  input.trace = null;
  const preview = analyzeTrace(input);
  assert.equal(preview.execution.status, 'failed');
  assert.equal(preview.coverage.status, 'unsupported');
});

// Relevant observed fields projected from live report
// e27ccfe5-a11a-4be0-a77f-4bedf043fbcb at block 49317009,
// 0x10bf6d3a6a5b97bed499950150536e1fc88ad0dc935fad8a628ceae567bcf9c1.
// Other calls are omitted; alterations in tests below are explicitly synthetic.
function roundedSupplyInput({ amount = 15066115n, implied = 15066114n, index = 1065361113101347740550370852n, scaled, implementation = '0x410aa1ab680b886c875e99a7a4bfaf188508a7a3' } = {}) {
  const input = structuredClone(observed.input);
  const pool = input.request.to;
  input.request.data = `0x617ba037${addrWord(USDC).slice(2)}${word(amount).slice(2)}${addrWord(FROM).slice(2)}${word(0n).slice(2)}`;
  const accrued = 80252n;
  const scaledAmount = scaled ?? amount * 10n ** 27n / index;
  const mintInput = `0xb3f1c93d${addrWord(FROM).slice(2)}${addrWord(FROM).slice(2)}${word(scaledAmount).slice(2)}${word(index).slice(2)}`;
  input.trace = {
    type: 'CALL', from: FROM, to: pool, input: input.request.data,
    logs: [transfer(FROM, HUSDC, amount, USDC, 0)],
    calls: [{ type: 'CALL', from: pool, to: HUSDC, input: mintInput,
      calls: [{ type: 'DELEGATECALL', from: HUSDC, to: implementation, input: mintInput,
        logs: [
          transfer(ZERO, FROM, implied + accrued, HUSDC, 2),
          { address: HUSDC, topics: [MINT, addrWord(FROM), addrWord(FROM)], data: `0x${word(implied + accrued).slice(2)}${word(accrued).slice(2)}${word(index).slice(2)}`, index: '0x3' },
        ],
      }],
    }],
  };
  input.block = { number: '49317009', hash: '0x10bf6d3a6a5b97bed499950150536e1fc88ad0dc935fad8a628ceae567bcf9c1', timestamp: '1792765206' };
  return input;
}

test('observed one-unit rounding distinguishes deposited USDC from Mint-implied principal', () => {
  const preview = analyzeTrace(roundedSupplyInput());
  assert.equal(preview.coverage.status, 'supported');
  assert.equal(preview.outAssets[0].transferOut[0].value, '15.066115');
  assert.equal(preview.inAssets[0].transferIn[0].value, '15.146366');
  assert.equal(preview.protocol.requestedDepositPrincipalRaw, '15066115');
  assert.equal(preview.protocol.transferredDepositPrincipal, '15.066115');
  assert.equal(preview.protocol.mintEventImpliedPrincipal, '15.066114');
  assert.equal(preview.protocol.roundingDifferenceRaw, '-1');
  assert.equal(preview.protocol.roundingDifference, '-0.000001');
  assert.equal(preview.interestAccruals[0].mintEventImpliedPrincipalRaw, '15066114');
  assert.equal(preview.interestAccruals[0].principalBasis, 'mint_value_minus_balance_increase');
  assert.equal(preview.protocol.principalReconciliation.status, 'consistent_with_scaled_rounding');
  assert.equal(preview.protocol.principalReconciliation.scaledAmountRaw, '14141791');
  assert.equal(preview.protocol.principalReconciliation.minImpliedPrincipalRaw, '15066114');
  assert.equal(preview.protocol.principalReconciliation.maxImpliedPrincipalRaw, '15066115');
  assert.ok(preview.warnings.some(warning => warning.includes('-1 raw USDC')));
});

test('rounding reconciliation rejects values outside the mathematically derived interval', () => {
  for (const implied of [15066113n, 15066116n]) {
    const preview = analyzeTrace(roundedSupplyInput({ implied }));
    assert.equal(preview.coverage.status, 'partial');
    assert.equal(preview.protocol.principalReconciliation.status, 'outside_scaled_rounding_bounds');
    assert.ok(preview.coverage.reasons.some(reason => reason.includes('verified scaled-token rounding model')));
  }
});

test('one-unit mismatch is not accepted without the verified implementation and matching scaled mint input', () => {
  for (const options of [{ implementation: TO }, { scaled: 14141792n }]) {
    const preview = analyzeTrace(roundedSupplyInput(options));
    assert.equal(preview.coverage.status, 'partial');
    assert.equal(preview.protocol.principalReconciliation.status, 'unreconciled');
    assert.ok(preview.warnings.some(warning => warning.includes('has not been reconciled')));
  }
  const input = roundedSupplyInput();
  const mintLog = input.trace.calls[0].calls[0].logs[1];
  mintLog.data = `${mintLog.data.slice(0, -64)}${word(1065361113101347740550370853n).slice(2)}`;
  assert.equal(analyzeTrace(input).coverage.status, 'partial');
});

test('rounding bound depends on index and scaled amount, not a blanket one-unit tolerance', () => {
  const input = roundedSupplyInput({ amount: 10n, implied: 8n, index: 4n * 10n ** 27n });
  const preview = analyzeTrace(input);
  assert.equal(preview.coverage.status, 'supported');
  assert.equal(preview.protocol.roundingDifferenceRaw, '-2');
  assert.equal(preview.protocol.principalReconciliation.minImpliedPrincipalRaw, '8');
  assert.equal(preview.protocol.principalReconciliation.maxImpliedPrincipalRaw, '8');
  assert.equal(analyzeTrace(roundedSupplyInput({ amount: 10n, implied: 9n, index: 4n * 10n ** 27n })).coverage.status, 'partial');
});

test('revert decoding preserves RPC error and only interprets failed contract return data', () => {
  const panic = `0x4e487b71${word(0x11n).slice(2)}`;
  const failed = analyzeTrace(simple([], { error: 'execution reverted', output: panic }));
  assert.equal(failed.execution.error, 'execution reverted');
  assert.equal(failed.execution.revert.kind, 'panic');
  assert.equal(failed.execution.revert.source, 'contract_return_data');
  const succeeded = analyzeTrace(simple([], { output: panic }));
  assert.equal(succeeded.execution.status, 'success');
  assert.equal(succeeded.execution.revert, undefined);
});
