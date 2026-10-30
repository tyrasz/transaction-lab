"""Bounded five-file acquisition only. Never executes fixtures or extracts paths."""
from pathlib import Path
import gzip
import hashlib
import json
import tarfile
import time

BASE = Path(__file__).resolve().parent
PLAN_BYTES = (BASE / 'acquisition-plan.json').read_bytes()
PLAN = json.loads(PLAN_BYTES)
START = time.monotonic()
LIMITS = PLAN['limits']

def check_clock():
    if time.monotonic() - START > LIMITS['wallSeconds']:
        raise RuntimeError('acquisition wall limit exceeded')

def digest_file(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        while chunk := stream.read(1024 * 1024):
            check_clock()
            h.update(chunk)
    return h.hexdigest()

class BoundedExpanded:
    def __init__(self, stream):
        self.stream, self.bytes = stream, 0
    def read(self, size):
        check_clock()
        data = self.stream.read(size)
        self.bytes += len(data)
        if self.bytes > LIMITS['expandedScanBytes']:
            raise RuntimeError('expanded scan limit exceeded')
        return data

archive = Path(PLAN['archive']['path'])
result = {'status': 'incomplete', 'planSha256': hashlib.sha256(PLAN_BYTES).hexdigest(),
          'files': [], 'error': None, 'targetExecution': False}
out = BASE / 'official-inputs'
out.mkdir(exist_ok=False)
expanded = None
try:
    for key in ['inventory']:
        record = PLAN[key]
        path = BASE / record['path']
        assert path.stat().st_size == record['bytes']
        assert digest_file(path) == record['sha256']
    assert archive.stat().st_size == PLAN['archive']['bytes'] <= LIMITS['compressedBytes']
    result['archiveSha256Before'] = digest_file(archive)
    print('Archive SHA-256 before:', result['archiveSha256Before'], flush=True)
    assert result['archiveSha256Before'] == PLAN['archive']['sha256']
    wanted = {row['path']: row for row in PLAN['members']}
    assert len(wanted) == LIMITS['selectedFiles'] == 5
    seen, retained = set(), 0
    with gzip.open(archive, 'rb') as compressed:
        expanded = BoundedExpanded(compressed)
        with tarfile.open(fileobj=expanded, mode='r|') as tar:
            for member in tar:
                check_clock()
                if member.name not in wanted:
                    continue
                assert member.name not in seen and member.isfile()
                assert member.size == wanted[member.name]['bytes'] <= LIMITS['fileBytes']
                relative = member.name.removeprefix('fixtures/')
                assert relative.startswith('state_tests/for_')
                assert not member.issym() and not member.islnk()
                assert '..' not in Path(relative).parts and not Path(relative).is_absolute()
                data = tar.extractfile(member).read(LIMITS['fileBytes'] + 1)
                assert len(data) == member.size
                retained += len(data)
                assert retained <= LIMITS['retainedBytes']
                destination = out / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                with destination.open('xb') as target:
                    target.write(data)
                sha = hashlib.sha256(data).hexdigest()
                assert digest_file(destination) == sha
                print('Retained', member.name, len(data), sha, flush=True)
                result['files'].append({'path': 'official-inputs/' + relative,
                                        'archivePath': member.name,
                                        'bytes': len(data), 'sha256': sha})
                seen.add(member.name)
        while expanded.read(1024 * 1024):
            pass
    assert seen == set(wanted)
    result['archiveSha256After'] = digest_file(archive)
    assert result['archiveSha256After'] == result['archiveSha256Before']
    assert (BASE / 'acquisition-plan.json').read_bytes() == PLAN_BYTES
    result['status'] = 'complete'
except BaseException as error:
    result['error'] = {'type': type(error).__name__, 'message': str(error)}
    raise
finally:
    result['expandedBytesRead'] = expanded.bytes if expanded else 0
    result['elapsedSeconds'] = time.monotonic() - START
    result['retainedBytes'] = sum(row['bytes'] for row in result['files'])
    result['extractorSha256'] = digest_file(Path(__file__))
    print('Acquisition result:', result['status'], 'expanded bytes:', result['expandedBytesRead'], 'elapsed seconds:', result['elapsedSeconds'], flush=True)
    with (BASE / 'acquisition-result.json').open('x') as target:
        target.write(json.dumps(result, indent=2) + '\n')
