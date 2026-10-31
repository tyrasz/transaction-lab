# Native HYPE development evidence

This work is in the development checkout. The installed 0.35 application was
not changed. Native HYPE measurements cover up to eight observed accounts,
exclude fees, and preserve incomplete or unavailable results. They do not add
WHYPE token balance measurements, HyperCore settlement, lifecycle coverage,
signed admission or an overall accuracy percentage.

## First public capture

`capture-001` executed the five fixed inputs on both declared public providers,
at HyperEVM block **50014605**,
`0x779392613a87731c62bbee28e01a15fc713c8f2f8afb77dd745e77eef5aeec00`.
Every call was unsigned and read-only. It retained 136 case RPC results plus
three block-selection results. All ten API outcomes reproduce from saved
parsed responses with zero network requests and recorded completion ordering.

| Input | Both providers' original result |
| --- | --- |
| Wallet transfer, 0.000001 HYPE | Measured sender −0.000001 and recipient +0.000001 HYPE |
| Self-transfer, 0.000001 HYPE | Measured sender net change 0 |
| WHYPE deposit, 0.000001 HYPE | Execution succeeds; native measurement unavailable |
| WHYPE withdrawal, 1 wei | Execution succeeds; native measurement unavailable |
| Original 15.066115 USDC Hyperlend supply | Reverts with `ERC20: transfer amount exceeds balance`; no measurement |

The four WHYPE measurement failures expose a provider response shape absent
from the initial synthetic controls. During a fixed BALANCE witness, the diff
also retains WHYPE as `pre: {balance, code}` and `post: {}`. The initial
nonce-only validator rejects that extra account and withholds amounts. The raw
failed responses remain unchanged in `capture-001`.

[Geth's documented diff semantics](https://geth.ethereum.org/docs/developers/evm-tracing/built-in-tracers)
describe post fields as changed fields, while pre storage omitted from post can
mean deletion. They also say unchanged accounts normally disappear. Therefore
the observed empty-post account is treated as a bounded provider compatibility
case, not assumed universal tracer behavior. Support must be restricted to
selected BALANCE accounts with independently anchored balances, no storage,
empty post objects and the original strict sender nonce transition.

First capture manifest:
`044f99cb954c798550c34b602c92aac62c4c61b60bda15e90ca3bb63f7ffb2de`.
First terminal:
`923e96af3cfb6de2562ad4bbdcf88dc2b3692254722c8d76aa6d0c389bf34ad4`.
Saved-only replay is retained in `../hype-native-current-v039-work/replay-001.json`.

## Regression evidence

The first full app run retained 818 tests: 816 passed and two failed due to
stale source-count and early-failure request-count expectations. Both affected
test files subsequently passed (8 server and 6 shared-context controls), with
all four measurement consumers checked for withheld amounts. A separate
seven-case UI run includes the corrected all-omitted budget explanation.
Fourteen original and follow-up test logs are retained with byte hashes in
`../hype-native-current-v039-work/test-log-manifest.json`; early failures are
preserved rather than overwritten. Synthetic controls and saved public replay
are distinct evidence, and neither proves population accuracy.

## Corrected public capture

`capture-002` repeats the same five unsigned inputs on the same two providers
at the same block number and hash. It changes only `src/current-state.js` in
the archived runtime. The compatibility check accepts an unchanged account
only when it is selected by the native BALANCE witness, its balance matches
the independently established state, its post object is empty, and it has no
storage fields. Known pinned code must match. The original strict sender
nonce check still applies, and the retained provider response is not edited.

| Input | Both providers' corrected result |
| --- | --- |
| Wallet transfer, 0.000001 HYPE | Measured sender −0.000001 and recipient +0.000001 HYPE |
| Self-transfer, 0.000001 HYPE | Measured sender net change 0 |
| WHYPE deposit, 0.000001 HYPE | Measured sender −0.000001 and WHYPE contract +0.000001 HYPE |
| WHYPE withdrawal, 1 wei | Measured sender +1 and WHYPE contract −1 wei |
| Original 15.066115 USDC Hyperlend supply | Same insufficient-balance revert; no measurement |

All eight successful native attempts are measured, with 14 account rows.
The two Hyperlend attempts remain reverted. This is a selected-case result,
not an estimate of general transaction accuracy. WHYPE token balances are
still outside the configured token measurement set; the native observations
do not establish the complete economic result of wrapping or unwrapping.

The corrected capture retains 148 case RPC results and two selection results.
All ten responses reproduce offline from their saved parsed RPC records in
`../hype-native-current-v039-work/replay-002.json`. These are parsed records,
not a packet capture or proof of transport drainage.

Second manifest:
`9c2c776f6e17e557119f13f3fc95fa2112f396f0a9929403cadf44804e34bbcb`.
Second terminal:
`2807490426c72ad5384673b03b68e5f0ad747b49740fc843aad2dfb44b3dc45c`.

The saved-only [capture comparison](../hype-native-current-v039-work/capture-comparison.json)
checks both external manifest and terminal pins, all archived file bytes,
fixed inputs, provider selection and original execution evidence. The original
call traces and available original state diffs are unchanged. The provider's
block `size` metadata differs (`0xf4b` versus `0xa60`), while the block number,
hash and execution header fields agree. That metadata difference remains
recorded; it is not removed from either capture.

## Independent evidence checks

The separate saved-evidence auditor imports no product simulation helpers and
performs no network requests or EVM execution. It joins each published native
amount to its pinned balance anchor, before/after witness words, permitted
query mutations, committed CALL flows and original state diff. The
[second audit](../hype-native-current-v039-work/hype-native-002-audit-second.json)
checks all 61 archived files and verifies all 14 measured rows. Its 12 controls
include altered amounts, missing anchors, changed witness output, unsupported
query mutations, reverted flows and changed execution header fields.

The original capture remains four measured, four unavailable and two not
applicable attempts under the final checker. Earlier checker failures are
retained: repeated identical code reads were initially over-restricted, and
the first second-capture audit compared block-size metadata too strictly.
The byte-preserving audit log inventory is
`../hype-native-current-v039-work/audit-retention-manifest.json`.
`audit-001.mjs` and `audit-001.test.mjs` preserve the original checker source;
the original test file still imports `./audit.mjs`, so reproducing that old
pair requires placing the original checker under that name in isolation.

The native compatibility controls first recorded 42/47 passing, then 47/47
after the bounded fix. The final current-context, replay, adapter, server and
UI integration selection passed 88/88. The original full-suite result remains
816/818 with the two affected files subsequently passing; no later full-suite
pass is claimed. All original and follow-up logs remain available in the work
directory. The installed application has not been updated.
