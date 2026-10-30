import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, lstatSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { isDeepStrictEqual as equal } from 'node:util';
const sha = value => createHash('sha256').update(value).digest('hex');
const need = (ok, code) => { if (!ok) throw Object.assign(new Error(code), { code }); };
function inventory(directory) {
  const files = []; let total = 0;
  function walk(path = '') {
    const directoryStat = lstatSync(join(directory, path));
    need(directoryStat.isDirectory() && !directoryStat.isSymbolicLink(), 'artifact_directory_invalid');
    for (const name of readdirSync(join(directory, path)).sort()) {
      if (!path && ['runtime', 'evidence-manifest.json'].includes(name)) continue;
      const sub = path ? `${path}/${name}` : name, stat = lstatSync(join(directory, sub));
      need(!stat.isSymbolicLink(), 'evidence_symlink');
      if (stat.isDirectory()) walk(sub);
      else {
        need(stat.isFile() && stat.size <= 256 * 1024 * 1024 && files.length < 30000, 'evidence_inventory_limit');
        const bytes = readFileSync(join(directory, sub)); total += bytes.length; need(total <= 8 * 1024 * 1024 * 1024, 'evidence_total_limit');
        files.push({ path: sub, bytes: bytes.length, sha256: sha(bytes) });
      }
    }
  }
  walk(); return files.sort((a, b) => a.path.localeCompare(b.path));
}
export function createArtifactWriter(directory) {
  const root = resolve(directory); let failed = false;
  const ledger = new Map(inventory(root).map(entry => [entry.path, { ...entry, origin: 'preexisting' }]));
  function syncDirectory(path) { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
  function protect(operation) { try { return operation(); } catch { failed = true; throw Object.assign(new Error('artifact_save_failed'), { code: 'artifact_save_failed' }); } }
  const writer = Object.freeze({
    get failed() { return failed; },
    verify(path) {
      return protect(() => {
        const expected = ledger.get(path); need(expected, 'artifact_unregistered');
        let parent = root; for (const part of path.split('/').slice(0, -1)) { parent = join(parent, part); const s = lstatSync(parent); need(s.isDirectory() && !s.isSymbolicLink(), 'artifact_parent_invalid'); }
        const stat = lstatSync(join(root, path)); need(stat.isFile() && !stat.isSymbolicLink() && stat.size === expected.bytes, 'artifact_identity_changed');
        need(sha(readFileSync(join(root, path))) === expected.sha256, 'artifact_identity_changed');
        return { path, bytes: expected.bytes, sha256: expected.sha256 };
      });
    },
    verifyAll() {
      return protect(() => {
        const expected = [...ledger.values()].map(({ origin, ...entry }) => entry).sort((a,b) => a.path.localeCompare(b.path));
        need(equal(inventory(root), expected), 'artifact_inventory_changed'); return true;
      });
    },
    sealLedger() {
      writer.verifyAll();
      writer.write('write-ledger.json', { schemaVersion: '1.0', files: [...ledger.values()].sort((a,b) => a.path.localeCompare(b.path)) });
      writer.verifyAll();
    },
    write(path, value) {
      let fd;
      try {
        need(typeof path === 'string' && /^[a-zA-Z0-9_./-]+$/.test(path) && !path.startsWith('/') && !path.split('/').some(p => !p || p === '.' || p === '..'), 'artifact_path_invalid');
        const target = join(root, path), parents = path.split('/').slice(0, -1); let current = root;
        need(lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink(), 'artifact_root_invalid');
        for (const part of parents) { const parent = current; current = join(current, part); try { mkdirSync(current); syncDirectory(parent); } catch (error) { if (error.code !== 'EEXIST') throw error; } const s = lstatSync(current); need(s.isDirectory() && !s.isSymbolicLink(), 'artifact_parent_invalid'); }
        const serialized = JSON.stringify(value, null, 2); need(typeof serialized === 'string', 'artifact_json_invalid');
        const text = serialized + '\n'; need(Buffer.byteLength(text) <= 256 * 1024 * 1024, 'artifact_size_limit');
        fd = openSync(target, 'wx', 0o444); writeFileSync(fd, text); fsyncSync(fd); closeSync(fd); fd = undefined;
        syncDirectory(dirname(target));
        ledger.set(path, { path, bytes: Buffer.byteLength(text), sha256: sha(text), origin: 'written' });
      } catch { failed = true; throw Object.assign(new Error('artifact_save_failed'), { code: 'artifact_save_failed' }); }
      finally { if (fd !== undefined) closeSync(fd); }
    },
  });
  return writer;
}

export function sealEvidence(directory, planSha256, sourceManifestSha256, { writer } = {}) {
  writer?.verifyAll();
  const files = inventory(directory), total = files.reduce((sum, entry) => sum + entry.bytes, 0);
  const manifest = { schemaVersion: '1.0', planSha256, sourceManifestSha256, files };
  createArtifactWriter(directory).write('evidence-manifest.json', manifest);
  writer?.verifyAll();
  return { manifestSha256: sha(readFileSync(join(directory, 'evidence-manifest.json'))), files: files.length, bytes: total };
}
