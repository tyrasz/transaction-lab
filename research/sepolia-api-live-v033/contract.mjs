import { createHash } from 'node:crypto';
export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const POLICY = Object.freeze({ origin: 'http://127.0.0.1:5175', requests: 3, totalMs: 170000,
  setupMs: 10000, closeMs: 1000, setupBytes: 1024 * 1024, resultBytes: 96 * 1024 * 1024, totalBytes: 98 * 1024 * 1024 });
export const SENDER = '0x6efb29cee3b414272eb7a8f3ebabf873d36bc033', RECIPIENT = '0x000000000000000000000000000000000000dead';
export const REQUEST = Object.freeze({ chainId: 11155111, from: SENDER, to: RECIPIENT, data: '0x', value: '1000000000000000', gas: '21000', block: 'latest',
  queries: Object.freeze([Object.freeze({ kind: 'native_balance', account: SENDER }), Object.freeze({ kind: 'native_balance', account: RECIPIENT })]) });
export const STEPS = Object.freeze([{ method: 'GET', path: '/api/health' }, { method: 'GET', path: '/api/config' }, { method: 'POST', path: '/api/evm/local-preview' }].map(Object.freeze));
export const HARNESS = Object.freeze(['PLAN.md', 'contract.mjs', 'run.mjs', 'verify.mjs', 'run.test.mjs']);
export const json = value => JSON.stringify(value, null, 2) + '\n';
export function decode(bytes) { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
