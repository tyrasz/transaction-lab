# Live Sepolia smoke test

The test selected a public funded EOA, not a new wallet under our control: `0x6efb29cee3b414272eb7a8f3ebabf873d36bc033`. At Sepolia block 12,018,196 (`0xdd182e949a9f742d2b9730c6d3d432da4ac182c5d9dc81598fc9517466fc1dc7`) it had empty code and 13,139.657516008702586959 test ETH.

The actual local application returned HTTP 400 with `UNSUPPORTED_CHAIN`: only Ethereum chain 1 is currently supported by its independent endpoint. This is an observed product gap, not a successful independent-engine Sepolia test. The captured Sepolia header also contains Amsterdam-era `blockAccessListHash` and `slotNumber`; using the pinned mainnet fork rules would be incorrect.

A separate live viem 2.57.13 provider simulation at the exact same block successfully sent 0.001 test ETH to the non-signing sink address `0x000000000000000000000000000000000000dead`. Gas was 21,000. The sender changed from 13,139.657516008702586959 to 13,139.656516008702586959 ETH, exactly −1,000,000,000,000,000 wei. Both original simulation passes succeeded; the selected header was reread unchanged. Ten public read-only RPC requests were retained, including raw `eth_simulateV1` and helper `eth_call` exchanges.

This is unsigned simulation with `validation:false` and zero gas price. No private key was created or used, no signed transaction was sent, and no wallet balance was overridden. Viem adds disposable measurement helpers and synthetic successor blocks. The provider observation is not a state-proof, real-fee, inclusion or general accuracy claim.

The first attempt in `../sepolia-smoke-v1` used a transport allowlist that omitted viem's read-only `eth_call` balance probes. Viem therefore failed even though its original simulation returned. A parallel request completed after that failure packet's manifest was written: the unchanged v1 manifest omits `rpc-07.json`, and the packet is incomplete evidence. Both the original manifest and late wire file remain unchanged. This separately declared v2 corrects the allowlist, reuses the identical address/block, rechecks balance/code and retains a complete verified manifest. No new wallet was selected to obtain a passing result.

`capture/product-request.json` and `capture/product-response.json` are the actual application exchange. `capture/viem-request.json` and `capture/viem-response.json` retain the library call/result with big integers represented as decimal strings. `capture/rpc-*.json` contain exact JSON-RPC request/response text. `verification.json` records the saved-artifact check; it does not rerun the target.
