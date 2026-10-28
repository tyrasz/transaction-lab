import assert from 'node:assert/strict';

// Older sealed call-only captures predate transaction-end cleanup. For these
// fixed traces, derive its additional cached account reads and require every
// distinct input/read identity to remain exact. No frozen bytes are rewritten.
export function assertReadsWithCleanup(actual, saved, trace) {
  const touched = new Set([trace.from]);
  function walk(frame, retained) {
    assert.ok(['CALL', 'STATICCALL', 'DELEGATECALL', 'CALLCODE'].includes(frame.type));
    assert.equal(frame.selfdestruct, undefined);
    assert.notEqual(frame.executionAddress, '0x0000000000000000000000000000000000000003');
    const commits = retained && frame.error === null;
    if (commits && frame.type !== 'DELEGATECALL') { touched.add(frame.from); touched.add(frame.executionAddress); }
    for (const child of frame.calls) walk(child, commits);
  }
  walk(trace, true);
  assert.equal(actual.total, saved.total + touched.size, 'Only the declared transaction-end account reads may differ');
  assert.deepEqual({ ...actual, total: saved.total }, saved);
}
