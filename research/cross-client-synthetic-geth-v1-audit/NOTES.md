# Offline audit of the synthetic Geth16 capture

All 16 retained Geth results independently classify as matched: 16 matching full
poststate roots and 16 passing internal log-hash assertions. There are zero
mismatches, unavailable results or unattempted slots. Every process exited zero,
closed normally and retained exact stdout/stderr bytes; total observed output is
6,242 bytes. The original reference corpus contains 14 successful executions,
two reverts and two cases with nonempty committed logs; these are reference
classifications, not separately exposed Geth receipt checks.

[The audit report](audit.json) binds the exact 4,019 captured files (27,505,731
regular-file bytes and one dependency symlink), 3,977 archived sources and all
100 original corpus artifacts plus their manifest. It checks source/evidence
joins, the original 16 identities/order, local-before-reference seals, exact
raw stream hashes, arguments, process completion, per-case results and the
complete denominator. The reviewed archived input verifier reconstructs all
16 wrappers, initial MPTs, header/message/signature bindings and expected log
hashes. The result parser here is separate from producer adjudication.

The immutable [capture manifest](../cross-client-synthetic-geth-v1/capture/manifest.json)
is `f0a34e060f47977b5e61e3b884494c41dc8dc131dbb3701e3a7245b5049d6508`;
[plan](../cross-client-synthetic-geth-v1/capture/plan.json) is
`56e229305134c64d13398b64060d69a4d9ce2bc8e835485d05e7ac96b1325805`;
[source manifest](../cross-client-synthetic-geth-v1/capture/source-manifest.json) is
`42330c8e7f59f0ddf6c219c6995c30a858d4006c8afc0aafff130938bac58367`.
[Raw results](../cross-client-synthetic-geth-v1/capture/results.json) and the
original packet remain unchanged. This separately sealed audit is post-capture.

These are inspected synthetic counterparts from the old 0.18 corpus. Geth is a
separate opcode implementation, but the prepared inputs and expected roots/logs
come from the sealed earlier full-VM experiment. This is not original official
fixture replay, current-product accuracy, population coverage, fee correctness,
or five-channel agreement. Geth stdout does not expose full log lists, gas,
return values or receipts: log agreement relies on the pinned Geth internal
assertion. The input adapter's BLOCKHASH/blob context scan and absent-coinbase
conditions remain bounded compatibility evidence. The exact external binary and
Node executable are checked and required; the toolchain is not portable here.

No Geth target, VM execution or RPC was performed by this audit. Reproduce from
the repository root with:

```text
node research/cross-client-synthetic-geth-v1-audit/verify.mjs --verify
node --test research/cross-client-synthetic-geth-v1-audit/verify.test.mjs
```

[Nine focused controls](controls.json) cover raw-byte/hash aliases, abnormal
processes, false pass/wrong roots, foreign/ambiguous outputs, invalid UTF-8,
omitted/reordered denominator rows, unclosed-child continuation, and exact
file/symlink inventory tampering. They do not execute the 16 targets.
