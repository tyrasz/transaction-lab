"""Bounded pinned-source acquisition; never executes the acquired code."""
from pathlib import Path
import hashlib
import json
import tarfile
import time

BASE = Path(__file__).resolve().parent
TOOL = BASE.parents[3] / 'evm-toolchains/eels-e27f097ec7'
ARCHIVE = TOOL / 'source.tar.gz'
PREFIX = 'execution-specs-e27f097ec7b3e6e8ee9c2c1873c183e8f7da7a6e/'
ROOT_FILES = {'pyproject.toml', 'README.md', 'LICENSE', 'LICENSE.md', 'AGENTS.md'}
LIMITS = {'compressedBytes': 67108864, 'expandedBytes': 536870912,
          'fileBytes': 16777216, 'files': 30000, 'seconds': 120}
start = time.monotonic()
def digest(p):
    h = hashlib.sha256()
    with p.open('rb') as f:
        for chunk in iter(lambda: f.read(1048576), b''):
            h.update(chunk)
    return h.hexdigest()
assert ARCHIVE.stat().st_size <= LIMITS['compressedBytes']
plan = {'commit': PREFIX[len('execution-specs-'):-1],
        'archiveUrl': 'https://codeload.github.com/ethereum/execution-specs/tar.gz/' + PREFIX[len('execution-specs-'):-1],
        'archiveBytes': ARCHIVE.stat().st_size, 'archiveSha256': digest(ARCHIVE),
        'selection': ['src/**', *sorted(ROOT_FILES)], 'limits': LIMITS,
        'scope': 'Pinned URL source acquisition, not Git object validation or target execution.'}
with (BASE / 'source-extraction-plan.json').open('x') as f:
    f.write(json.dumps(plan, indent=2) + '\n')
out = TOOL / 'source'
out.mkdir(exist_ok=False)
records, seen, expanded, members = [], set(), 0, 0
try:
    with tarfile.open(ARCHIVE, 'r|gz') as tar:
        for member in tar:
            assert time.monotonic() - start <= LIMITS['seconds']
            members += 1
            expanded += member.size
            assert members <= LIMITS['files'] and expanded <= LIMITS['expandedBytes']
            assert member.name == PREFIX[:-1] or member.name.startswith(PREFIX)
            relative = member.name[len(PREFIX):]
            if not relative or member.isdir():
                continue
            assert not Path(relative).is_absolute() and '..' not in Path(relative).parts
            if not (relative.startswith('src/') or relative in ROOT_FILES):
                continue
            assert member.isfile() and 0 <= member.size <= LIMITS['fileBytes']
            assert relative not in seen
            seen.add(relative)
            data = tar.extractfile(member).read(LIMITS['fileBytes'] + 1)
            assert len(data) == member.size
            p = out / relative
            p.parent.mkdir(parents=True, exist_ok=True)
            with p.open('xb') as f:
                f.write(data)
            records.append({'path': relative, 'bytes': len(data),
                            'sha256': hashlib.sha256(data).hexdigest()})
    assert digest(ARCHIVE) == plan['archiveSha256']
    assert (out / 'pyproject.toml').read_bytes() == (BASE / 'pyproject.toml').read_bytes()
    status, error = 'complete', None
except BaseException as e:
    status, error = 'incomplete', {'type': type(e).__name__, 'message': str(e)}
    raise
finally:
    result = {'status': status, 'error': error, 'elapsedSeconds': time.monotonic()-start,
              'archiveMembers': members, 'expandedMemberBytes': expanded,
              'sourceFiles': sorted(records, key=lambda r: r['path']), 'targetExecution': False}
    with (BASE / 'source-extraction-result.json').open('x') as f:
        f.write(json.dumps(result, indent=2) + '\n')
