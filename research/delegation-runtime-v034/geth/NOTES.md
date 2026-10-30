# Saved delegation-runtime comparison

The sole declared run completed with **7 matched, 0 mismatched, 0 unavailable**;
all nine comparison channels agree for every row. `comparisonsUsable` is true.
Elapsed time was 6,127 ms by wall clock and 6,126.84 ms by monotonic clock;
267,729 raw output bytes were retained. All seven isolated product results and
child/broker closure checks completed before the seven Geth invocations. There
was no retry or target execution by the artifact reviewer.

External capture identities:

- Plan: `1b5baf0830d6e1b0eafcce793256a595308e688387e90abad62e1e8f80c32ff2`
- Source: `1a40aa6a391fa82c56effe29ff44453436ee331ae91de8ce6516c82372ee8a13`
- Manifest: `9f28743de55b3e66d24aa61aa6184ccc79ebafdeb4a715b9e71a03ee1ec7d4aa`

Malformed root indicators of lengths 3 and 24 in Amsterdam, and length 24 in
Prague, produce ordinary invalid-opcode transaction failures. The two nested
cases catch the failure and return zero success/data words. The exact 23-byte
root control executes its delegate and returns 42. These outcomes agree in
full poststate, committed logs, receipt status/gas, block gas, return bytes,
message gas, exact log payloads and bloom.

The seventh signed type-4 case retains its applied authority nonce/designation
when the malformed recipient enters and fails at `0xef`. It spends the declared
100 remaining message gas, with 44,190 authorization preparation debit and
35,190 state gas. Receipt gas is 67,106 and single-transaction block gas is
35,190. It is not classified as recipient-preparation OOG. This specifically
checks the parent recipient parsing correction as well as the runtime patch.

The runtime archive contains the actual patched local EVM dependencies and the
separate untouched fixture dependencies. Only three exact-length conditions in
two local ESM files differ from stock, bound by the explicit patch utility and
old/new hashes. The original stock-runtime twelve-probe diagnostic remains
unchanged and is not reclassified by these results.

## Bounded artifact confirmation

`review.mjs` ran once on the saved packet without VM, Geth or network execution.
It rehashed all 4,024 manifest entries and 3,909 runtime entries (including
3,841 copied dependency entries), checked 14 raw process records and 35 saved
proof/code replies, bound seven signed envelopes and header hashes, and rebuilt
28 full MPT roots: original allocation, amended allocation, product deltas over
initial allocation, and saved Geth allocation for each case. Its recomputed
classifications exactly equal the original seven saved comparisons. The exact
checker bytes, report and two fabricated helper controls are retained alongside
this note. The controls passed 2/2.

The checker independently applies scalar/code deltas and hashes account/storage
tries, but reuses the archived pure trace/log comparison parser. It joins saved
proof replies to broker evidence and the full initial allocation; it does not
independently walk every proof path. Chronology relies on the frozen driver and
durable product seals; Geth process records lack independent absolute start
timestamps. The recorded original argv is checked against `source.sourceRoot`,
while artifact reads use the supplied checkout path, so moving the checkout
does not require rewriting process records. The separately installed Node/Geth
binaries must remain available at their recorded paths for their identity check.

Run the read-only check from any checkout location:

```sh
node research/delegation-runtime-v034/geth/review.mjs . \
  9f28743de55b3e66d24aa61aa6184ccc79ebafdeb4a715b9e71a03ee1ec7d4aa \
  1b5baf0830d6e1b0eafcce793256a595308e688387e90abad62e1e8f80c32ff2 \
  1a40aa6a391fa82c56effe29ff44453436ee331ae91de8ce6516c82372ee8a13
```

Preparation logs preserve the initial copied-test assertion failure (expected
5M gas while the fixed input was 200k), then the 13-, 15- and final 16-control
passing runs. The declarations were not changed by that assertion correction.
Peer review added exact terminal inventory and full Geth allocation/root joins
before freezing, then caught omitted-zero-field normalization before any target
run. All corrections and prior preparation manifests remain retained. A separate
read-only control also rebuilt one previous saved Geth allocation to confirm
normalization against actual output shape.

This is a deliberately selected synthetic development comparison, with disclosed
inert system accounts and unsigned product calls versus signed transactions.
It establishes no population accuracy, consensus attestation, deployed-chain
reachability, public HTTP admission, or general delegation/precompile coverage.
