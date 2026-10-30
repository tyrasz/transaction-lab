# Sepolia live API observation — 0.33

One read-only local API preview succeeded at Sepolia block **12,020,839**, hash
`0x7aad773f921db94645102f9c99c94eef8d33b2f87883b8178bb4715a8ddbabdc`.
The public sender is `0x6efb29cee3b414272eb7a8f3ebabf873d36bc033`; the destination
is `0x000000000000000000000000000000000000dead`. No ownership is claimed and
nothing was signed, funded, or broadcast. The request uses the default unsigned,
unpriced profile, so its balance changes exclude transaction fees.

The simulated value is **0.001 test ETH** (1,000,000,000,000,000 wei). Sender
balance changes from 13,134,858,998,087,397,494,778 to
13,134,857,998,087,397,494,778 wei; destination balance changes from
2,716,225,852,586,137,573,846 to 2,716,226,852,586,137,573,846 wei. Both requested
measurements are complete. Gas is 21,000; the new Amsterdam scalar and
single-transaction block-contribution fields both equal 21,000 in this case.

The complete [raw JSON](capture/api-response.json), exact HTTP request/response
bytes, selected headers, and five public RPC observations are retained. The
single attempt took 2.390 seconds, closed its isolated child normally, and
returned with no pending RPC work. There was no retry or fallback. The candidate
version and implementation matched before and after execution:
`4f2bc1a6c8bc39907eaab33b7a8d58ff132cfd2b20309bba655f151b45efcf90`.

The [artifact verification](verification.json) recomputes the execution header,
reverifies two account proofs, checks the actual native ledger, and binds both
reported balances to the original execution changes. It makes no network calls
and does not rerun the transaction. Five preparation controls passed; they used
synthetic state and injected HTTP replies. This is a single current-state API
observation, not an independent-client comparison or a population accuracy rate.

- Plan SHA-256: `e6e72f256f76860727ef3225c871372228dd371426940dc1a3772b032dad4246`
- Capture manifest SHA-256: `c60894e81d25657a40eff84b485d1b40352b6911ee279272c21c9db8923fa04b`
- Source/harness identity: `8a09cd1224be642a76d6f9ae688f599b177468513d326355160463b03df15c6b`

The earlier 0.31 live observation remains unchanged. Header and input-proof
validation does not establish consensus, finality, historical transaction
position, or coverage beyond the two requested balances.
