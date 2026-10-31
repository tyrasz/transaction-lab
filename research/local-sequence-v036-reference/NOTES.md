# First fixed sequence comparison — unavailable

This first capture is preserved unchanged. Its plan SHA256 is
`76fb2f64a719f5e577869a43f915e4b555547bf85f1b6a8d769e96de5d557030`;
the sealed capture manifest is
`adad620ff6b97af186670c3af46b40e662539a167ef392bb9c1b5be84f10b6b9`.
The archive contains 3,911 product/adapter/dependency source files and four
fixed declarations with twelve ordered positions. All eight input-only
preparation processes passed before freezing. Product and reference inputs
were identical synthetic complete allocations; no public network was used.

All four product processes completed with confirmed child closure and drained
proof reads. All four reference processes failed in the adapter's sender-funds
check before their first transaction execution: mixed EELS `Uint` and `U256`
arithmetic raised `TypeError`. Each raw reference report retains its first
position as unavailable and the remaining two positions as not attempted.
The run's source, process and original-write checks passed; this means the
failure evidence is usable, not that an execution comparison succeeded.

The frozen saved-artifact comparator also rejected every product projection.
Its new duplicate-storage guard incorrectly required a `storage` array on
account rows that contain only nonce or balance changes. The raw product
results are preserved; they do not become independent agreement evidence.

The frozen comparison therefore has **zero comparable execution positions,
zero matched channels, zero measured disagreements and 72 unavailable channel
positions**. There is no independent accuracy result from this packet. Raw
process attempts are four product observations and four reference failures;
do not substitute the comparator's conservative unavailable projections for
those distinct process outcomes.

Preparation, freeze, run and comparison outputs are retained in
`../local-sequence-v036-work/reference-*`. Earlier input/control failures and
runtime-drift findings remain in that directory's `reference-source-controls`.
The corrected sibling experiment in `../local-sequence-v036-reference-v2`
must keep the same four inputs, identify both adapter corrections, and retain
this packet. Any repeated executions are the same cases, not additional
transaction or protocol coverage. No original artifact is overwritten or
silently excluded from reporting.
