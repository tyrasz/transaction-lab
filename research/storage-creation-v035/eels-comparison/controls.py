"""Target-free checks of the driver's output bound and saved-file ledger."""
from pathlib import Path
import importlib.util
import json
import shutil
import signal
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('capture_driver', HERE / 'run.py')
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)
observations = []
with tempfile.TemporaryDirectory(prefix='eels-driver-controls-') as temporary:
    root = Path(temporary)
    stdout_path, stderr_path = root / 'stdout', root / 'stderr'
    with stdout_path.open('xb') as stdout, stderr_path.open('xb') as stderr:
        reply = subprocess.run(
            [sys.executable, '-I', '-B', '-c',
             'import os; data=b"x"*65536\nfor _ in range(1024): os.write(1,data)'],
            stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr,
            timeout=5, preexec_fn=driver.bound_child_files)
    assert reply.returncode != 0
    assert stdout_path.stat().st_size == driver.LIMITS['outputBytes']
    assert stderr_path.stat().st_size <= driver.LIMITS['outputBytes']
    output = driver.entry(stdout_path, 'stdout')
    observations.append({'check': 'oversized_child_output_retained_and_bounded',
                         'passed': True, 'returncode': reply.returncode,
                         'stdout': output,
                         'stderrBytes': stderr_path.stat().st_size})
    ledger = {row['path']: row for row in driver.tree(root)}
    driver.check_ledger(root, ledger)
    original = stderr_path.read_bytes()
    stderr_path.write_bytes(original + b'mutation')
    try:
        driver.check_ledger(root, ledger)
    except AssertionError:
        observations.append({'check': 'prior_output_mutation_rejected', 'passed': True})
    else:
        raise AssertionError('Modified output was accepted')
    stderr_path.write_bytes(original)
    extra = root / 'unexpected'
    extra.write_bytes(b'extra')
    try:
        driver.check_ledger(root, ledger)
    except AssertionError:
        observations.append({'check': 'unexpected_artifact_rejected', 'passed': True})
    else:
        raise AssertionError('Unexpected output was accepted')
    extra.unlink()
    driver.check_ledger(root, ledger)

# Execute the archived driver with synthetic workers. The injected verifier
# supplies a local plan only; no official input, toolchain or EVM is invoked.
for name, body in [
    ('timeout_invalidates_packet', 'import time; time.sleep(10)'),
    ('file_limit_invalidates_packet',
     'import os,signal; signal.signal(signal.SIGXFSZ,signal.SIG_DFL)\n'
     'data=b"x"*65536\nfor _ in range(1024): os.write(1,data)'),
]:
    with tempfile.TemporaryDirectory(prefix='eels-synthetic-runner-') as temporary:
        cap = Path(temporary).resolve()
        shutil.copyfile(HERE / 'run.py', cap / 'run.py')
        (cap / 'worker.py').write_text(body)
        inputs = []
        for index in range(6):
            filename = f'{index}.json'
            (cap / filename).write_text(json.dumps({'id': str(index)}))
            inputs.append({'path': filename})
        case_spec = importlib.util.spec_from_file_location('synthetic_driver', cap / 'run.py')
        candidate = importlib.util.module_from_spec(case_spec)
        case_spec.loader.exec_module(candidate)
        candidate.LIMITS = {**candidate.LIMITS, 'processSeconds': 1}
        candidate.verify = lambda *args: (
            {'inputs': inputs}, {'python': sys.executable, 'toolchain': str(cap)})
        result = candidate.run(cap, 'synthetic-control-no-target-input')
        process = json.loads((cap / '001-process.json').read_bytes())
        assert result['evidenceUsable'] is False and result['fatal'] is not None
        assert result['unattempted'] == 5 and result['rows'][0]['status'] == 'unavailable'
        assert process['limitTerminated'] is True and process['bounded'] is False
        if name.startswith('timeout'):
            assert process['error']['type'] == 'TimeoutExpired'
        else:
            assert process['returncode'] == -signal.SIGXFSZ
            assert process['stdout']['bytes'] == candidate.LIMITS['outputBytes']
        assert (cap / 'manifest.json').is_file()
        observations.append({'check': name, 'passed': True,
                             'evidenceUsable': result['evidenceUsable'],
                             'unattempted': result['unattempted'],
                             'fatal': result['fatal'], 'process': process})
print(json.dumps({'targetExecutions': 0,
                  'driverSha256': driver.digest(HERE / 'run.py'),
                  'checks': observations}, indent=2))
