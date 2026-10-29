// Retained runner, NOT executed when this review packet was assembled.
// Explicit invocation performs the five original synthetic bytecode controls;
// it does not invoke a public RPC, Geth, or the frozen diagnostic packet.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('../../', import.meta.url));
const identity = JSON.parse(readFileSync(new URL('./reviewed-sources.json', import.meta.url)));
for (const row of identity.files) {
  const data = readFileSync(new URL('../../' + row.path, import.meta.url));
  if (data.length !== row.bytes || createHash('sha256').update(data).digest('hex') !== row.sha256) {
    throw Error('Reviewed source changed: ' + row.path);
  }
}
const result = spawnSync(process.execPath, ['--input-type=module'], {
  cwd: root, input: readFileSync(new URL('./original-stdin.mjs', import.meta.url)),
  encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024,
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
if (result.status !== 0 || result.signal !== null) throw Error('Synthetic controls failed or were interrupted.');
