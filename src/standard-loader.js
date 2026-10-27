import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { VERSION } from './config.js';

// Include the complete statically imported server closure: these modules are
// evaluated at startup even when their exported HyperEVM functions are unused.
const files = Object.freeze([
  'package.json', 'src/config.js', 'src/server.js', 'src/validate.js',
  'src/account-effects.js', 'src/affected-balances.js', 'src/allowances.js',
  'src/analyze.js', 'src/balances.js', 'src/current-state.js',
  'src/historical-state.js', 'src/lending-balances.js', 'src/lending.js',
  'src/permissions.js', 'src/revert.js',
  'src/standard-loader.js', 'src/standard-rpc.js', 'src/standard-simulation.js',
  'src/rpc.js', 'src/state.js', 'src/state-diff.js', 'src/query-validation.js',
  'engines/standard-evm/package.json', 'engines/standard-evm/package-lock.json',
  'engines/standard-evm/unsigned-call.js', 'engines/standard-evm/position-queries.js', 'engines/standard-evm/provider-state-diff.js', 'engines/standard-evm/discovery.js', 'engines/standard-evm/native-effects.js', 'engines/standard-evm/sequence-state.js',
  ...['package.json', 'sha3.js', '_u64.js', 'utils.js'].map(name => 'engines/standard-evm/node_modules/@noble/hashes/' + name),
].sort());
const root = new URL('../', import.meta.url);
let loading;
async function fingerprint() {
  const hash = createHash('sha256');
  for (const file of files) hash.update(file + '\0').update(await readFile(new URL(file, root))).update('\0');
  return hash.digest('hex');
}

// Complete this snapshot during module initialization, before the server can
// accept requests. A later lazy import must not label cached startup modules
// with a fingerprint of different on-disk code. Capture optional-file absence
// here as well, so installing a dependency cannot change this process's engine.
const startup = await fingerprint().then(
  sourceSha256 => ({ sourceSha256 }),
  error => ({ error }),
);

// The optional dependency must not prevent the established HyperEVM API from
// starting. Installing it after startup requires a restart to load a new engine.
export function loadStandardApi() {
  return loading ??= (async () => {
    if (startup.error) {
      if (['ERR_MODULE_NOT_FOUND', 'ENOENT'].includes(startup.error.code)) return null;
      throw startup.error;
    }
    try {
      const before = await fingerprint();
      if (before !== startup.sourceSha256) throw new Error('Standard engine source changed after startup; restart is required.');
      const api = await import('./standard-simulation.js');
      const after = await fingerprint();
      if (after !== startup.sourceSha256) throw new Error('Standard engine source changed while loading; restart is required.');
      return { ...api, implementation: Object.freeze({ name: 'Transaction Lab Ethereum preview', version: VERSION, sourceSha256: startup.sourceSha256, sourceFiles: files }) };
    } catch (error) {
      if (['ERR_MODULE_NOT_FOUND', 'ENOENT'].includes(error.code)) return null;
      throw error;
    }
  })();
}
