import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { simulateArbitrumCall, validateArbitrumCall, ARBITRUM_CAPABILITIES } from '../engines/arbitrum-evm/index.js';
import { InputError } from './validate.js';
import { decodeCctpHypercoreIntent } from './arbitrum-cctp.js';
import example from './arbitrum-example.json' with { type: 'json' };
import contractExample from './arbitrum-contract-example.json' with { type: 'json' };

export { ARBITRUM_CAPABILITIES };
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
export const ARBITRUM_EXAMPLES = freeze([{
  id: 'arbitrum-cctp-usdc-hypercore', title: 'CCTP · request 100 USDC to HyperCore',
  description: 'Public unsigned inputs. Current balance and allowance can change; this example previously reverted with insufficient USDC. Destination credit is not simulated.',
  request: example,
}, {
  id: 'arbitrum-cctp-contract-usdc-hypercore', title: 'CCTP · 100 USDC from a public contract account',
  description: 'Unsigned call from a contract account with publicly observed USDC and allowance at block 519242987. This does not establish wallet signing or contract authorization. Current state can change; destination credit is unverified.',
  request: contractExample,
}]);

export function validateArbitrumSimulation(input) {
  try { return validateArbitrumCall(input); }
  catch (error) {
    if (error?.code === 'ARBITRUM_INPUT') throw new InputError(error.message, error.code);
    throw error;
  }
}

export function withholdArbitrumSimulation(report, code) {
  report.status = 'unavailable';
  report.error = { code, message: 'The preview could not be confirmed. Inspect the retained raw evidence; unavailable values are not zero.' };
  report.execution = { status: 'unavailable', data: null, gasUsed: null, logs: [], error: report.error };
  report.assetChanges = [];
  report.coverage = { ...report.coverage, status: 'unavailable', inventoryComplete: false,
    measuredAssets: 0, unverifiedAssets: null, observationsWithheld: true,
    destinationCreditVerified: false, feesVerified: false, securityAssessed: false };
  return report;
}

export async function simulateArbitrum(input, options = {}) {
  const started = performance.now(), request = validateArbitrumSimulation(input);
  const result = await simulateArbitrumCall(request, options);
  const { rpcEvidence, usage, ...observations } = result;
  const report = { ...observations, id: randomUUID(), createdAt: new Date().toISOString(),
    protocol: decodeCctpHypercoreIntent({ chainId: '42161', from: request.from, to: request.to, data: request.data, value: request.value }),
    transportEvidence: rpcEvidence ?? [], usage,
    security: { status: 'not_assessed' }, timing: { totalMs: Math.max(0, performance.now() - started) } };
  if (options.signal?.aborted) withholdArbitrumSimulation(report, 'ARBITRUM_CANCELLED');
  return report;
}
