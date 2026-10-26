# First prospective pilot: selection failed

The frozen version in git commit `1842375` ran once from T0 **2026-10-26 04:23:53.888 UTC**. It made **9 read-only RPC requests**, received **13,512 response bytes**, and stopped after **180,160 ms**. The frozen source remained unchanged; no product outputs were created. There were no retries, replacement blocks, alternative providers, transaction simulations, or comparator adjudications.

**No cohort was accepted: `N: null`, zero attempted transactions, and `metrics: null`.** This is a selection failure, not a 0% or 100% transaction accuracy result. The original immutable manifest, cohort outcome, empty product seal, RPC ledger, denominator ledger and report are preserved. [Raw calls and responses](rpc.json), [report](report.json), [artifact checksums](artifact-index.json), [frozen protocol](frozen-protocol.md), [source revision](source-revision.json).

## Observed disagreement

The first finalized observation selected F = **49,544,165**. Both later finalized observations reached **49,544,287**, beyond the required F+2. Parent continuity and future timestamps were sufficient.

For block **49,544,166**, both providers returned hash `0x1a90cb1b12defb35c5b542b1218b4b5f8524d7eea721ab1f0cf28e8b6af8e2b4`, timestamp **2026-10-26 04:24:54 UTC**, and identical header fields except `transactions` and `size`.

| Provider | Transaction hashes | Reported size |
| --- | ---: | ---: |
| A: hyperliquid.drpc.org | 5 | 2,736 bytes |
| B: rpc.hyperlend.finance/archive | 8 | 3,949 bytes |

B's last five hashes exactly match A's complete ordered list. B additionally prepends:

- `0xc9d5e5dfb1b07ed8d7bb0373618767191bd7ad9bcc11d9185bff886ba7ab088a`
- `0x14f094947b7c9ca7d83baad145e0e26e3c770a884709e7dc4b3e539d222664d8`
- `0x395725735b69f19ffcb48893a82942e932bfd719ef10faf666ae739d2a510939`

The next selected block, **49,544,167**, has identical complete responses with five transaction hashes on both providers. Thus the first block's transaction-list disagreement is sufficient to reject the cohort under the frozen selection rule. The failure is not explained by insufficient finalization or old timestamps.

## Interpretation and next work

This evidence alone does not establish which provider view is correct. Hyperliquid documents separate RPC methods for transactions originating from HyperCore, and a provider documents that its archive route includes system transactions omitted by the standard route. That is a possible explanation to investigate, not a conclusion from this pilot. [Hyperliquid JSON-RPC documentation](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/json-rpc), [provider route documentation](https://www.quicknode.com/docs/hyperliquid/hyperevm-overview).

Any follow-up diagnosis belongs in a separate development evidence packet. It cannot retroactively change this failed pilot, reinterpret its denominator or supply an accuracy score. A revised comparison protocol must explicitly model proven provider differences and select a newly preregistered future cohort. The complete observed run is also replayed offline by `test/coverage-pilot-replay.test.js` without new RPC responses or altered transaction lists.

## Subsequent separate diagnostic

A later fixed 12-request capture maps each of the three extra B entries uniquely to an official HyperCore system action on twelve matching fields. The official ordinary block list matches A; the official system hashes and signature fields differ from A/B's representations. This supports the system-action explanation above without proving transaction-position or execution equivalence. [Separate findings](../../system-transaction-diagnostic/NOTES.md), [raw responses](../../system-transaction-diagnostic/capture.json). This note does not modify the frozen protocol, pilot evidence, status, denominator or metrics.
