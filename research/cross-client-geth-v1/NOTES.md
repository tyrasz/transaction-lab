# Independent Geth replay of 48 official fixtures

On October 28, 2026, the pinned official Geth 1.17.10 state-test executable
ran all 32 original conformance fixtures and all 16 lifecycle fixtures in their
existing order: **48 matched, 0 mismatched, 0 unavailable, 0 unattempted**.
All child processes closed; the dispatch window was 2,089 ms and the combined
retained output was 18,459 bytes. Inputs, executable and archived runtime
remained unchanged. There were no public RPC requests, retries or replacements.

This is an independent opcode implementation check against the official
expected full poststate roots and Geth's internal expected-log-hash assertion.
The earlier EthereumJS conformance path also matched these fixed fixtures.
Geth's command does not expose independent receipt, gas, return-byte or detailed
log comparisons. This is development-corpus evidence, not current local-product
coverage, five-channel agreement, economic completeness or a population accuracy
rate. The sparse API's signed-admission and fee-settlement limitations remain.

The [frozen plan](capture/plan.json), [all results](capture/results.json),
[individual raw outputs](capture/results/001.json), and
[independent offline audit](../cross-client-geth-v1-audit/NOTES.md) are retained.
The audit verifies all 148 files / 13,845,594 bytes, reuses the archived source
and input verifier, and independently parses and adjudicates the raw outputs.
All 12 audit tamper controls and 17 producer controls pass. Root repeated the
audit and its controls. It did not execute Geth a second time.

- Plan SHA256: `63495b6b39c18115c5710664007d4730abc67d70fad205cc4efce8a7b5f79081`
- Results manifest SHA256: `47342b92f1ecf622df9767fe668ba3d85ae4dc71a2d5474f373b03850bb7b175`
- Audit manifest SHA256: `517c6df58728ec2253630866558324674915351f42c1e8abb918e53a458ac158`
- Geth commit: `1df30b18d9ed35ee9d28ffd4648442c2204554ad`
- Executable SHA256: `10385eddbfd76c3d05b9853f30f4372f2468f6a8c1ac64c445a7490694fc3521`
- Toolchain manifest SHA256: `791a91bca058b516b21a66097787f96959477958219eaee9dd20e73367b21333`

The exact executable and full toolchain remain in the separate workspace
`outputs/evm-toolchains/geth-v1.17.10`; this report does not contain a portable
toolchain. Its copied manifest binds the verified Go archive, source tree,
module verification and build evidence. The first build used Go's default
local-only telemetry counters; a workspace telemetry-off cached rebuild was
byte-identical. No global telemetry setting changed.

An unrelated preliminary `t8n` smoke failure is also retained in that toolchain:
its block-transition mode required system contracts absent from the synthetic
preallocation. It was not repaired or retried. The official state-test command
used here does not perform those block system calls. The smoke is not one of
the 48 results.
