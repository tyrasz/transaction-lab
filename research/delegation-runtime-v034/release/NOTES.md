# Release 0.34 validation

This release corrects three delegation predicates in the pinned local
EthereumJS EVM 10.1.3 runtime. Only an exact 23-byte `ef0100 || address`
designation resolves delegated code or incurs its access charge. Other lengths
remain ordinary runtime bytes. Their leading invalid opcode produces a normal
entered EVM failure: message writes and value transfer revert, while the outer
nonce, applicable fees and successful authorization preparation remain. A parent
call can catch the failed internal call. Code inspection sees the original bytes.

The dependency correction is an explicit, byte-pinned preparation step over two
ESM files and three conditions. It never runs implicitly on import or while
serving a request. Both application startup and execution refuse unverified
runtime bytes. Public implementation metadata discloses the patch and the full
source inventory binds its utility and corrected dependency files. The separate
fixture dependency and previous evidence archives remain stock and unchanged.
Sender and authorization eligibility still require exact valid designations.

The Amsterdam parent validator now derives zero recipient-delegation cost for
malformed runtime code. It does not misclassify that entered failure as
recipient-preparation out-of-gas or discard successful authorizations.

## Retained validation

- The complete engine suite passed **996/996** in 52.652 seconds.
- Eight focused execution groups cover 33 actual isolated children, including
  all four CALL variants, exact/short/long indicators, one-hop resolution,
  preactivation behavior, original code inspection, missing proof/code rollback,
  and authorization retention. The initial startup refusal before the explicit
  patch remains in `runtime-before-explicit-patch.tap`; the corrected run passed.
- Six patch-utility controls cover exact replacements, idempotence, partial
  preparation and refusal of unrecognized bytes, versions and file kinds.
- Two parent groups use actual execution baselines and fabricated metadata
  controls. The fabricated cases test the derivation validator directly, not
  altered worker messages through IPC.
- The Sepolia application controls include three actual API simulations over
  authenticated synthetic state: unpriced, priced and self-authorized malformed
  recipients. They preserve normal failed execution and measurable fee effects.
  These are not fresh public-chain observations.
- Loader controls copy the actual utility and corrected ESM bytes into temporary
  fixtures. Stock bytes refuse startup without mutation; explicitly corrected
  bytes load and disclose inventory-backed patch metadata. The initial fixture
  omission failures are retained alongside the passing correction.
- The first complete application run passed **719/720**. Its independent
  source-closure test caught the new utility missing from the standard engine's
  hardcoded inventory. Both that inventory and its independent expectation were
  corrected. The initial result remains in `application-first.tap`.
  The second full run passed **717/720** in 84.276 seconds; its three failures
  were stale copies of that inventory in the HTTP integration expectations.
  Correcting those expectations yielded **8/8** passing affected HTTP tests in
  12.422 seconds. All 720 distinct application checks have final passing
  observations, but no subsequent all-green full-suite run is claimed.

The immutable 12-case stock-runtime probe remains under `../probe/`, with its
original unavailable cases and source identities. The independent Geth packet
is separate under `../geth/`; it must not rewrite the original observations or
be presented as a population accuracy sample.

Read-only peer review checked the three actual dependency sites, preparation
utility, startup/execution guards, source identity and strict sender/authority
gates. It also caught two comparison-integrity gaps before independent target
execution: exact terminal inventory and joining Geth's saved full allocation to
its reported state root. Review of the latter caught Geth's omitted empty-field
serialization, which the capture reader must normalize explicitly.

Storage-only creation remains unsupported because of the retained client
disagreement. Complete economic-effect discovery, local API sequences,
HyperCore execution, consensus/finality and representative EVM accuracy remain
unestablished. Security is not assessed. No wallet signature or transaction
broadcast is part of this release.

## Independent client result

The frozen seven-case packet matched **7/7** on all nine comparison channels: final state root, log hash, receipt status, charged gas, block gas, return data, message gas, exact logs and bloom. All seven product executions were sealed before any Geth execution. There were no retries, unavailable rows or excluded cases. The saved full Geth allocations reconstruct their reported roots. The original stock-runtime probe remains unchanged.

The type-4 case entered its malformed recipient with 100 gas, retained its successful authorization, and matched Geth at 67,106 charged gas and 35,190 single-transaction block gas. These selected synthetic cases do not establish population accuracy.

Capture plan: `1b5baf0830d6e1b0eafcce793256a595308e688387e90abad62e1e8f80c32ff2`. Capture manifest: `9f28743de55b3e66d24aa61aa6184ccc79ebafdeb4a715b9e71a03ee1ec7d4aa`. The candidate has a 1,725-file local API identity, `2dcd852867697a0f64e2787187fa16b16df6270a0e7e873d19aed7a80f6dde25`, and discloses the exact two corrected dependency hashes. The browser interface bytes are unchanged.
