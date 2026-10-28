# Geth check of the sealed synthetic lifecycle corpus

The adapter remains preparation-only. The separate archive/runner now implements
input verification and bounded dispatch. A reviewed freeze and explicit external
plan-hash authorization must precede execution of the 16 targets; creating or
testing these sources authorizes no target execution or public requests.

Use all 16 declarations in their existing order from
`research/evm-lifecycle-differential-v1/capture-v2`. Its manifest SHA256 is
`299980c26fde8c589f74922f2b00b93be6290b9acae3f69973f434f3e1f4bcf3`;
plan SHA256 is
`82edf8c8f06d33180ac109f61ed9247da6b596a5c618b9c2fa7ea16937fd1f86`.
That experiment evaluated product 0.18.0 at `dcc0554`, with full-VM reference
results and independent delta-to-MPT application. Keep all original identities,
artifact hashes and product-before-reference seals. These are inspected
development cases, not holdouts or a sample of ordinary transactions.

For each one-key Geth wrapper, copy the declaration's entire `pre` unchanged.
Map its declared synthetic header to the state-test environment: miner,
difficulty, randomness, gas limit, number, timestamp, base fee and excess blob
gas. Preserve the exact declared message, gas, sender nonce, private test key
and serialized signed bytes. Root creation uses the state-test empty recipient
string. Independently reconstruct the initial MPT root and signature binding;
do not import any original official expected poststate. There are no state
repairs, injected system contracts, changed gas limits or replacement cases.

The sole post entry is `Osaka[0]`, indexes zero, without an admission-exception
expectation. Its root comes from the sealed full-VM reference result. Its log
hash is Keccak-256 of the consensus RLP list of the reference's ordered
`[address, topics, data]` logs. Exact reference raw stdout/result agreement,
sealed old-product log agreement and the existing comparison root are checked.
Expected outputs occur only in post assertions, never in execution inputs.

Use the exact already-built official Geth 1.17.10 executable, commit
`1df30b18d9ed35ee9d28ffd4648442c2204554ad`, with the toolchain manifest and binary
digest bound by the future freeze. The intended command is
`evm statetest --statetest.fork=Osaka --run=^<escaped exact ID>$ <wrapper>`.
Reuse the separately reviewed Geth48 process/result harness only after its
release. Proposed limits remain five seconds and 1 MiB output per case, six
minutes overall, 16 fixed slots, no retry or replacement. Require clean process
closure and strict one-result identity/fork/root validation; exit zero alone is
not a pass. Preserve mismatch, unavailable and unattempted results.

Compatibility is bounded to this corpus. The pinned Geth
[state-test implementation](https://github.com/ethereum/go-ethereum/blob/1df30b18d9ed35ee9d28ffd4648442c2204554ad/tests/state_test_util.go)
uses `ApplyMessage` with transaction cleanup, not block system calls. It supplies
invented `BLOCKHASH` values, derives blob base fee from excess blob gas, and adds
a zero-value coinbase touch. The fixed declarations are legacy chain-1 zero-fee
transactions at the declared Osaka header; every coinbase is absent before and
in the sealed reference afterstate. An instruction-boundary scan of initial
code and recorded constructor/runtime bytes finds no BLOCKHASH, BLOBHASH or
BLOBBASEFEE. The adapter refuses such opcodes rather than claiming equivalent
context. This scan is conservative evidence, not an opcode/reachability proof.
Signature bytes are independently bound here because Geth's state-test runner
recovers them separately from its fixture-derived message. Geth's
[fork configuration](https://github.com/ethereum/go-ethereum/blob/1df30b18d9ed35ee9d28ffd4648442c2204554ad/tests/init.go)
selects Osaka explicitly; a block-number/timestamp fork auto-selection is not
being tested.

The result would add a different opcode implementation's check of the full
poststate root and Geth's internal log-hash assertion for the old synthetic
corpus. The command does not independently expose/check gas, return bytes,
receipt status or five-channel agreement. It is not a current-product accuracy
rate, population coverage estimate, economic completeness claim or original
official fixture replay. New adapter/runtime dependencies and all consumed
sealed artifacts must be bound again by the future freeze; the original
capture remains unchanged.


The archive includes the complete installed fixture/local dependencies and runtime,
shared context, this harness/adapter/tests, the exact released Geth48 dispatcher
(`eafecc8f260a0136cbc005bd1d713ac3cabb29886c26e0d2b443eaf273788236`),
its Node identity helper, and all 100 consumed old evidence artifacts plus their
original manifest. The executable stays external and must match its pinned tool
manifest/binary. Wrapper preparation and every `--check` recompute all 16 exact
wrapper bytes and provenance from this archived corpus. Expected roots/log hashes
remain only in post assertions. The old product corpus remains version 0.18;
archiving current helpers does not relabel it as current-product accuracy.

The run must enter through the archived module and writes exclusive, fsynced
`STARTED.json` before dispatch. Each exact wrapper and binary is checked before
its attempt. Raw output and observed outcomes are saved once; all 16 rows survive
ordinary failures, closure failures and the six-minute dispatch deadline. An
unconfirmed close stops later targets. Final archive, wrapper, binary and Node
checks determine validity before results and a complete artifact inventory seal.
The one-second killed-process close grace is additional to each five-second
dispatch cap. Geth's 256 MiB memory setting is a soft Go target, not an RSS bound
or OS sandbox. Preparation, recomputation and terminal hashing/sealing are
separately timed and are not claimed to be preemptively bounded by the child timer.
