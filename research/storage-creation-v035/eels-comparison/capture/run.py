"""Freeze and run six declared EELS observations without any client rerun."""
from pathlib import Path
import hashlib
import json
import os
import resource
import shutil
import signal
import subprocess
import sys
import sysconfig
import time

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
ORIGINAL = 'research/amsterdam-storage-creation-v033/capture'
ORIGINAL_MANIFEST = '0de3a42d8fc949ffe1a3b65f99b9d7bbee677a5c205cf45b696b9e2ca19403b9'
LIMITS = {'cases': 6, 'processSeconds': 15, 'totalSeconds': 180,
          'outputBytes': 2097152, 'inventoryFiles': 30000,
          'inventoryBytes': 536870912, 'fileBytes': 67108864}

def sha(data):
    return hashlib.sha256(data).hexdigest()

def digest(p):
    h = hashlib.sha256()
    with p.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1048576), b''):
            h.update(chunk)
    return h.hexdigest()

def read(p):
    return json.loads(p.read_bytes())

def save(p, value):
    raw = (json.dumps(value, indent=2, sort_keys=True) + '\n').encode()
    with p.open('xb') as f:
        f.write(raw)
        f.flush()
        os.fsync(f.fileno())
    return {'bytes': len(raw), 'sha256': sha(raw)}

def bound_child_files():
    # The OS caps each child output file before any body read. The terminal
    # check also caps the combined stdout+stderr bytes for the whole attempt.
    resource.setrlimit(resource.RLIMIT_FSIZE,
                       (LIMITS['outputBytes'], LIMITS['outputBytes']))

def check_ledger(cap, ledger):
    assert tree(cap) == sorted(ledger.values(), key=lambda r: r['path'])

def entry(p, relative):
    s = p.lstat()
    if p.is_symlink():
        target = os.readlink(p)
        resolved = p.resolve(strict=True)
        assert resolved.is_file() and resolved.stat().st_size <= LIMITS['fileBytes']
        return {'path': relative, 'kind': 'symlink', 'target': target,
                'resolved': str(resolved), 'resolvedSha256': digest(resolved)}
    assert p.is_file() and s.st_size <= LIMITS['fileBytes']
    return {'path': relative, 'kind': 'file', 'bytes': s.st_size,
            'mode': s.st_mode & 511, 'sha256': digest(p)}

def tree(root, omit=()):
    rows = []
    for parent, directories, files in os.walk(root, followlinks=False):
        parent = Path(parent)
        if parent == root:
            directories[:] = [name for name in directories if name not in omit]
        for name in list(directories):
            p = parent / name
            if p.is_symlink():
                raise ValueError('Directory symlink is not supported: ' + str(p))
        for name in sorted(files):
            p = parent / name
            rows.append(entry(p, str(p.relative_to(root))))
            assert len(rows) <= LIMITS['inventoryFiles']
    assert sum(r.get('bytes', 0) for r in rows) <= LIMITS['inventoryBytes']
    return sorted(rows, key=lambda r: r['path'])

def toolchain(tool):
    stdlib = Path(sysconfig.get_path('stdlib')).resolve()
    base = Path(sys.base_prefix).resolve()
    python = tool / 'venv/bin/python'
    assert Path(sys.prefix).resolve() == (tool / 'venv').resolve()
    runtime_files = [Path(sys.executable).resolve(), base / 'lib/libpython3.12.dylib']
    zipfile = stdlib.parent / 'python312.zip'
    if zipfile.exists():
        runtime_files.append(zipfile)
    return {'toolchain': str(tool), 'python': str(python),
            'version': sys.version, 'platform': sys.platform,
            'source': tree(tool / 'source'), 'venv': tree(tool / 'venv'),
            'stdlibPath': str(stdlib), 'stdlib': tree(stdlib, ('site-packages',)),
            'runtime': [entry(p, str(p)) for p in runtime_files],
            'stdlibZipExists': zipfile.exists(),
            'scope': 'External shared toolchain, fully inventoried before and after each attempt. OS dynamic libraries are not archived.'}

def freeze(root, tool):
    cap = HERE / 'capture'
    assert not cap.exists(), 'Partial or completed capture cannot be reused.'
    assert digest(root / ORIGINAL / 'manifest.json') == ORIGINAL_MANIFEST
    original_manifest = read(root / ORIGINAL / 'manifest.json')
    tc = toolchain(tool)
    cap.mkdir()
    sources = []
    for name in ['worker.py', 'run.py', 'PLAN.md']:
        shutil.copyfile(HERE / name, cap / name)
        sources.append(entry(cap / name, name))
    tc_identity = save(cap / 'toolchain.json', tc)
    inputs = []
    (cap / 'inputs').mkdir()
    for i in range(1, 7):
        name = f'{i:03}.json'
        prior = root / ORIGINAL / 'inputs' / name
        declared = next(f for f in original_manifest['files'] if f['path'] == 'inputs/' + name)
        assert prior.stat().st_size == declared['bytes'] and digest(prior) == declared['sha256']
        shutil.copyfile(prior, cap / 'inputs' / name)
        inputs.append(entry(cap / 'inputs' / name, 'inputs/' + name))
    plan = {'schemaVersion': 1, 'createdAtUnix': time.time(), 'limits': LIMITS,
            'originalManifestSha256': ORIGINAL_MANIFEST, 'inputs': inputs,
            'sources': sources, 'toolchainIdentity': tc_identity,
            'scope': 'Six EELS Amsterdam signed transactions only; reuse all original inputs unchanged. No product/Geth rerun, public RPC, funding or broadcast. Source rules and finite development evidence do not establish population accuracy.'}
    identity = save(cap / 'plan.json', plan)
    return {'capture': str(cap), 'planSha256': identity['sha256'],
            'toolchainSha256': tc_identity['sha256'], 'cases': len(inputs)}

def verify(cap, pin):
    assert digest(cap / 'plan.json') == pin
    plan = read(cap / 'plan.json')
    assert plan['limits'] == LIMITS
    for row in plan['sources'] + plan['inputs']:
        assert entry(cap / row['path'], row['path']) == row
    tc = read(cap / 'toolchain.json')
    assert digest(cap / 'toolchain.json') == plan['toolchainIdentity']['sha256']
    assert toolchain(Path(tc['toolchain'])) == tc
    return plan, tc

def run(cap, pin):
    assert Path(__file__).resolve() == cap / 'run.py', 'Only archived driver may execute.'
    plan, tc = verify(cap, pin)
    ledger = {f['path']: f for f in tree(cap)}
    def admit(p):
        ledger[p.name] = entry(p, p.name)
    def put(name, value):
        identity = save(cap / name, value)
        admit(cap / name)
        return identity
    start_wall, start = time.time(), time.monotonic()
    put('STARTED.json', {'planSha256': pin, 'atUnix': start_wall})
    rows = [{'index': i, 'status': 'not_attempted', 'detail': None} for i in range(6)]
    fatal, total = None, 0
    try:
        for i, f in enumerate(plan['inputs']):
            verify(cap, pin)
            check_ledger(cap, ledger)
            remaining = LIMITS['totalSeconds'] - max(time.time()-start_wall, time.monotonic()-start)
            assert remaining > 0
            argv = [tc['python'], '-I', '-B', str(cap / 'worker.py'),
                    str(cap / f['path']), tc['toolchain']]
            begin_wall, begin = time.time(), time.monotonic()
            timeout = min(LIMITS['processSeconds'], remaining)
            error, code = None, None
            rows[i] = {'index': i, 'status': 'unavailable', 'detail': 'dispatch_started'}
            # Files bound memory while preserving any timeout/oversized output.
            out = cap / f'{i+1:03}.stdout'
            err = cap / f'{i+1:03}.stderr'
            with out.open('xb') as stdout, err.open('xb') as stderr:
                try:
                    result = subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=stdout,
                                            stderr=stderr, timeout=timeout,
                                            env={'PATH': '/usr/bin:/bin', 'TZ': 'UTC', 'LANG': 'C'},
                                            cwd=cap, preexec_fn=bound_child_files)
                    code = result.returncode
                except Exception as e:
                    error = {'type': type(e).__name__, 'message': str(e)}
                stdout.flush(); stderr.flush()
                os.fsync(stdout.fileno()); os.fsync(stderr.fileno())
            admit(out); admit(err)
            elapsed = {'wallSeconds': time.time()-begin_wall, 'monotonicSeconds': time.monotonic()-begin}
            size = out.stat().st_size + err.stat().st_size
            total += size
            limit_terminated = ((error or {}).get('type') == 'TimeoutExpired'
                                or code == -signal.SIGXFSZ)
            bounded = (not limit_terminated and size <= LIMITS['outputBytes']
                       and all(0 <= t <= timeout+1 for t in elapsed.values()))
            process = {'argv': argv, 'returncode': code, 'error': error, 'timeoutSeconds': timeout,
                       'elapsed': elapsed, 'limitTerminated': limit_terminated, 'bounded': bounded,
                       'stdout': entry(out, out.name), 'stderr': entry(err, err.name)}
            put(f'{i+1:03}-process.json', process)
            status, detail = 'unavailable', None
            if code == 0 and error is None and bounded:
                try:
                    observed = read(out)
                    assert observed['id'] == read(cap / f['path'])['id']
                    status = 'observed'
                except Exception as e:
                    detail = {'type': type(e).__name__, 'message': str(e)}
            rows[i] = {'index': i, 'status': status, 'detail': detail}
            assert bounded, 'Output or process bound exceeded; preserved raw files.'
            verify(cap, pin)
    except BaseException as e:
        fatal = {'type': type(e).__name__, 'message': str(e)}
    integrity = False
    try:
        verify(cap, pin)
        check_ledger(cap, ledger)
        integrity = True
    except BaseException as e:
        fatal = fatal or {'type': type(e).__name__, 'message': str(e)}
    elapsed = {'wallSeconds': time.time()-start_wall, 'monotonicSeconds': time.monotonic()-start}
    bounded = all(0 <= t <= LIMITS['totalSeconds'] for t in elapsed.values())
    results = {'rows': rows, 'unattempted': sum(r['status']=='not_attempted' for r in rows), 'fatal': fatal,
               'toolchainUnchanged': integrity, 'elapsed': elapsed, 'totalRawBytes': total,
               'evidenceUsable': integrity and bounded and fatal is None}
    put('results.json', results)
    manifest = save(cap / 'manifest.json', {'planSha256': pin, 'files': tree(cap)})
    return {**results, 'manifestSha256': manifest['sha256']}

if __name__ == '__main__':
    if sys.argv[1] == 'freeze':
        result = freeze(ROOT, Path(sys.argv[2]).resolve())
    elif sys.argv[1] == 'run':
        result = run(Path(sys.argv[2]).resolve(), sys.argv[3])
    else:
        raise ValueError('Use freeze TOOLCHAIN or archived run CAPTURE PLAN_SHA.')
    print(json.dumps(result, indent=2))
