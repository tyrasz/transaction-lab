// Development capture wrapper: preserves two browser and one HTTP-client API exchanges
// without changing their inputs, implementation, or RPC transport.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createAppServer } from '../../src/server.js';

const root = new URL('./', import.meta.url);
const sha = value => createHash('sha256').update(value).digest('hex');
const plan = JSON.parse(readFileSync(new URL('plan.json', root)));
if (process.env.ETHEREUM_RPC_URL && new URL(process.env.ETHEREUM_RPC_URL).href !== 'https://eth.drpc.org/') {
  throw new Error('This development capture requires its predeclared public provider.');
}
for (const source of plan.sources) {
  const current = readFileSync(new URL('../../' + source.path, root));
  if (sha(current) !== source.sha256) throw new Error('Source differs from the frozen plan: ' + source.path);
}
mkdirSync(new URL('http/', root), { recursive: true });
writeFileSync(new URL('STARTED', root), new Date().toISOString() + '\n', { flag: 'wx' });
const server = createAppServer();
let sequence = 0;
server.prependListener('request', (req, res) => {
  if (req.method !== 'POST' || req.url !== '/api/evm/simulate') return;
  const index = ++sequence, startedAt = new Date().toISOString(), chunks = [];
  req.on('data', chunk => chunks.push(Buffer.from(chunk)));
  const end = res.end;
  res.end = function (body, ...args) {
    const request = Buffer.concat(chunks), response = Buffer.from(body ?? '');
    const capture = {
      index, startedAt, completedAt: new Date().toISOString(),
      request: { method: req.method, path: req.url, contentType: req.headers['content-type'], bodyText: request.toString('utf8'), bytes: request.length, sha256: sha(request) },
      response: { status: res.statusCode, bodyText: response.toString('utf8'), bytes: response.length, sha256: sha(response) },
    };
    const destination = new URL('http/' + String(index).padStart(3, '0') + '.json', root);
    writeFileSync(destination, JSON.stringify(capture, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log('Captured API exchange ' + index + ': ' + fileURLToPath(destination));
    return end.call(this, body, ...args);
  };
});
server.requestTimeout = 30000;
server.headersTimeout = 10000;
server.listen(5174, '127.0.0.1', () => console.log('Transaction Lab capture: http://127.0.0.1:5174/'));
