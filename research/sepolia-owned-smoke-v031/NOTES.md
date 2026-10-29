# One proof-backed Sepolia attempt, unavailable

The fixed public address 0x6efb29cee3b414272eb7a8f3ebabf873d36bc033 was used unchanged for an unsigned 0.001 test ETH call to 0x000000000000000000000000000000000000dead, with 21000 total gas and two explicit native balance queries. No key, signature, broadcast, faucet, state override, retry, provider fallback or substituted request was used.

The one authorized live attempt selected Sepolia block 12019991, hash 0x5a663e4c38b7e3f1e4f6b52c3ae929cd28195a3108b5e1038fd59e6a5b286c83. The full Amsterdam header hash was verified and its same-number final reread was identical. PublicNode rejected the first sender eth_getProof request using that exact hash with HTTP 200 / JSON-RPC -32602: “distance to target block exceeds maximum proof window.” This is the retained provider reply; the packet does not establish why the endpoint rejected its newly returned latest block.

No account proof was accepted, no sender or recipient code was read, no EVM frame or opcode ran, and neither native measurement was attempted. Current account balances and execution gas are therefore unknown. The internal result is unavailable, with state unchanged. The earlier v2 provider simulation is separate evidence and supplies no expected outputs here.

The separate request to the running localhost main application returned HTTP 400, UNSUPPORTED_CHAIN, “Only Ethereum chain 1 is supported.” Internal Sepolia plumbing is not a claim that the public HTTP product supports Sepolia.

Four public JSON-RPC calls and one loopback HTTP call are retained in five raw wire records. Total response bytes including loopback were 27369. Transport drained completely; terminal source-integrity verification finished after 2109.621917 milliseconds. Source inventory was unchanged. The capture contains 16 manifested files plus its manifest and is immutable.

Evidence manifest SHA256: fbe7ff9463b50e9728560234170837e3cddfc876d0536c644221c041b2691dab
Plan file SHA256: d0d9f1178c3880c224054763ee4c24134c2521955d22bb470b48c5d576592d9f
Combined harness/runtime identity: 1a17f9df7bd2b37187b918a7fae1ba2d189761296d8311840fb84572bc2f9a03
Local implementation identity: 5ab9c93ad59c6b7f8c5d16e8f5da2cf951aa69bc7513b6d9c43b3a0b216a322a

The artifact-only verifier passed: exact inventory/wire/header joins, no new network or EVM execution, zero verified accounts, unavailable result preserved. The five offline preparation controls passed, including a real synthetic isolated preview, unavailable-proof retention, cancellation and byte bounds, and a re-sealed native-value offset forgery. Peer review found and corrected proof-to-measurement binding, duplicate HTTP observation joins and terminal phase checks before this one live attempt.

The runtime inventory and Node executable identity are recorded rather than copied into a second dependency archive. This packet provides no independent-client correctness, consensus/finality, fee, inclusion, complete-effect coverage or successful native-transfer claim.
