# Observed Sepolia API result

The one authorized candidate-server API attempt completed successfully. The
client made exactly three requests to `127.0.0.1:5175`: health, config, and one
local preview POST. No retries, alternate addresses, overrides, signing or
broadcast occurred. The earlier smoke packets, including failures, are unchanged.

The server selected Sepolia block **12020571**, hash
`0x5645815f244ffdb6b25a2c2279b4bb1d68c5d852e00448767b174c3be57593a2`.
Its five public provider reads were chain ID, initial header, sender account
proof, recipient account proof and the identical final header. No `eth_getCode`
was needed: the authenticated account code hashes established empty code.

| Explicit account | Before, wei | Simulated after, wei | Change, wei |
| --- | ---: | ---: | ---: |
| `0x6efb29cee3b414272eb7a8f3ebabf873d36bc033` | 13135108997887418357978 | 13135107997887418357978 | -1000000000000000 |
| `0x000000000000000000000000000000000000dead` | 2716225852586137573846 | 2716226852586137573846 | 1000000000000000 |

This is exactly **0.001 test ETH**, not mainnet ETH. The original call succeeded,
charged 21000 gas in the unpriced model, returned `0x`, and included no simulated
transaction fees. Both requested native observations were measured. The child
exited normally with code 0; both child broker and provider drain reported no
pending work. The client window was 2412.293042 ms. This was an unsigned preview;
the displayed after balances were not written to Sepolia.

The implementation identity before the request, in the response and afterward
was `5527057b0dc45bf210cdfa8ca5be415b27321f9122dd92fb0ac811a32f410bef`
(version 0.31.0), and the recorded source/runtime inventory was unchanged.

The offline preparation suite passed **5/5**. It used injected HTTP responses
and authenticated synthetic state with real isolated execution; it made no
network request. It covers exact response/proof joins, amount/context tampering,
bounded raw body retention and closure, late/unavailable results, saved-byte
substitution and second-dispatch refusal.

The saved-artifact verifier then passed on the actual packet, checking nine
captured files, exact HTTP/RPC bodies, two account proofs, both balance pairs,
the selected/final header, original accounting and child/drain closure. It made
no network request and did not re-execute a VM. Its production validators share
the application's implementation: this is source/proof-bound API evidence, not
independent-client correctness, consensus/finality, comprehensive effect coverage
or a security verdict. Only the two requested accounts are reported.

Pins:

- Plan: `0316cace2938ccd03e3b59ec5d644745af8d8825cc50c688c48560faf125d4c6`
- Source packet: `f4190fbc848e775d6ad983620695ed2bb0c3753bcf869b6c2d1788c7b9872f14`
- Capture manifest: `74ae79246cda8dc4fbd332c83308a41d761edd61206ea191dd462e24a466d5a6`

`capture/api-response.json` is the full API JSON. `capture/http-3.json` retains
the exact response bytes and HTTP metadata. `verification.json` is the
artifact-only result; `controls.tap` is the complete preparation test output.
No ignored dependency copies were created by this packet; it records the
complete existing implementation inventory instead of duplicating that runtime.
