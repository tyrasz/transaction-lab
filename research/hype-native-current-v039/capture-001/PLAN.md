# Current native HYPE validation

This development packet adds measured native balances to the current HyperEVM
API. It does not change the installed 0.35 application or claim population
accuracy. Synthetic controls and public-provider observations remain separate.

The implementation must retain the exact unsigned original value, check upfront
funding, reconcile every observed native candidate against the complete state
diff and committed CALL values, and independently anchor selected accounts.
Before/after BALANCE witnesses must agree with those anchors and changes, use
the pinned header, and mutate only the probe sender nonce. Token queries run
first; the eight-account display cap and remaining RPC budget never truncate
mandatory state validation. Shared failures withhold all actionable amounts.

The following inputs are fixed before any public outcome is obtained. Every
attempt remains in the report, including failed execution or missing provider
capabilities. All calls are read-only, unsigned and unpriced; none are broadcast.

1. Existing public Hyperlend example sender to `0x000000000000000000000000000000000000dEaD`, 0.000001 HYPE.
2. The same sender to itself, 0.000001 HYPE.
3. The same sender calls WHYPE `deposit()` with 0.000001 HYPE.
4. The same sender calls WHYPE `withdraw(1)` with zero original value.
5. The existing 15.066115 USDC Hyperlend supply input, unchanged.

Sender: `0x9a1dbc6a6e7e59f6beb23db0d00b603fc90e94d0`. WHYPE candidate:
`0x5555555555555555555555555555555555555555`, also listed by
[hx.finance](https://docs.hx.finance/technical/smart-contracts). A documentation
label is not runtime code attestation. The wrapped token itself is not yet a
configured HyperEVM balance query, so these cases measure native HYPE only and
retain incomplete token/protocol coverage.

Both fixed public providers (`hyperliquid.drpc.org` and
`rpc.hyperlend.finance/archive`) receive the same selected block number, two
blocks behind the first provider's head. Each result must independently bind
the selected hash. No provider, account, amount or method fallback is allowed.
Agreement between providers is consistency evidence, not proof of independent
clients, complete HyperEVM semantics or future transaction inclusion.

Freeze copies the server's static import closure and the source files used by
its implementation fingerprint. Optional Ethereum/Arbitrum engines are absent
and unused in that archive. The archived server executes the HyperEVM entrypoint
directly. Source hashes are verified before and after dispatch. Each attempt
retains ordered parsed request/response records and the full API JSON; output files are
created exclusively. Offline replay must consume each recorded request exactly
once and reproduce the semantic response, excluding timestamps, run UUIDs and
timings. Frozen files and original outcomes are never overwritten by a fix.

Each case is limited to 70 RPCs and 225 seconds, checked with both wall and
monotonic clocks before dispatch and after responses. The matrix has a
900-second scheduling bound; an in-flight transport has its separate 25-second
timeout. This is not a claim of confirmed underlying network drainage. A
clock-dependent failure remains retained even if fast offline replay cannot
reproduce the elapsed-time decision. Such a replay must fail verification,
never turn an unavailable result into a passing comparison.

Run and replay require the archived driver and the externally supplied manifest
SHA-256 printed by freeze. The manifest binds this plan, all fixed inputs, the
driver and runtime source files. Node version, platform, architecture and binary
hash must match. This packet retains parsed RPC results, not original HTTP
wire bytes. It is API replay and provider consistency evidence, not independent
client execution or transport-closure evidence.
