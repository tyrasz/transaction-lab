# Six unchanged inputs through pinned EELS

Run each of the six original v033 Amsterdam declarations exactly once through
the official execution specification at commit
`e27f097ec7b3e6e8ee9c2c1873c183e8f7da7a6e`. Preserve every unavailable or
unattempted outcome. Do not rerun the product, EthereumJS or Geth. Their original
captures and the separately recorded root-wrapper supplement remain immutable.

The original signed type-2 bodies, sender, gas limits, fees, preallocations,
header environment and four inert system accounts are unchanged. EELS runs
`apply_body` with one signed transaction and empty withdrawals. Inputs have
already been inspected as development diagnostics; this is not a prospective
population sample. The original storage-only, absent and empty-storage cases
each have a root CREATE and an internal CREATE2 form.

Before dispatch, freeze exact input/adapter/driver bytes and a full identity of
the separately installed EELS source, Python virtual environment, standard
library, interpreter and Python shared library. These remain external shared
toolchain files, not copied dependency archives. Verify their identity before
and after every attempt and at completion. Source acquisition is bound to a
pinned official URL and retained archive hash, not independently validated Git
objects. Dependency installation records exact resolved versions/download
hashes. OS dynamic libraries are not archived. No upstream fork is patched.

Only the archived driver can run. Six child processes are bounded to 15 seconds
each, 180 seconds overall and 2 MiB combined stdout/stderr per attempt. An OS
file-size limit also caps each child output file at 2 MiB before parsing.
Over-limit or timed-out processes remain recorded and cannot yield a usable
successful packet. A saved-artifact ledger is checked between attempts and at
terminal acceptance. No retry or replacement is allowed.

The raw result includes independently serialized full postallocation, its MPT
root, receipt bytes/status/charged gas, separate block gas dimensions, logs,
target storage and the official TransactionEnd trace when available. The trace
hook observes only the declared transaction hash and does not alter execution.
Missing trace events leave return data unavailable. TransactionEnd gas includes
preparation costs and is not equated with Geth root-entry message gas.

The subsequent saved-artifact comparison uses seven declared channels:
execution status, return bytes, charged gas, single-transaction block gas,
complete state root, target account/storage and exact logs. It reuses saved
Geth observations and available original/supplemental EthereumJS observations.
It independently rebuilds EELS roots from its full allocation using the
existing JavaScript MPT helper. Product unsupported observations remain
unsupported, with no substituted expectation. Disagreements stay visible.

This packet tests the source-backed prediction that a nonce-zero, code-empty
creation target is eligible and its prior storage is cleared before initcode.
The four ordinary controls distinguish adapter mistakes from that disputed
rule. It does not establish consensus/finality, deployed-chain reachability,
all-fork execution coverage, economic-effect completeness or general accuracy.
