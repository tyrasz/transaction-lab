# First standard deposit capture: archived source

This directory preserves the seven files bound to the first standard EVM deposit capture before the adapter changed. Every byte count and SHA-256 was checked against both the frozen plan and the capture's before/after source inventories. The original plan, capture, raw responses, and first verifier remain unchanged.

Run from the repository root:

```sh
node reports/standard-evm-deposits-v1-source/verify.mjs
```

The wrapper verifies the archived source, original verifier, and 87 referenced evidence files, reconstructs a temporary repository, and runs the unchanged first verifier there. It never reads the current engine or current `src` files. It needs Node.js and the original evidence packet; it needs no npm packages, credentials, network, or discovery sources. The temporary root has only a generated `{"type":"module"}` loader setting, the seven archived source files, the unchanged verifier, and the pinned evidence. It is removed afterward.

The complete bound source closure is:

- `engines/standard-evm/unsigned-call.js`
- `reports/standard-evm-deposits/capture.mjs`
- `src/config.js`
- `src/query-validation.js`
- `src/rpc.js`
- `src/state-diff.js`
- `src/state.js`

The six runtime files use only these local files and Node builtins. The capture runner is preserved to satisfy its original source binding but is never executed by the verifier. The additional archived original verifier is byte-identical to `reports/standard-evm-deposits/verify.mjs` (SHA-256 `3d10499d98fab682b62ce9ebe833571644d3e4d5287a9b43eee17e154c793203`). Source inventory SHA-256: `697fbebe7c94bef021e2a4dbcfdb888a9a3f77c7c36eb9ab34477767e9ca1df1`.

Offline reproduction retains both actual outcomes: Aave succeeds with four measured queries; Morpho's execution succeeds but all eight measurements remain unavailable because the original strict state-diff decoder rejects five `codeHash` fields. The first capture used 41 actual RPC responses totaling 403,724 response bytes. Reproduction uses zero network requests and replays every request/response in the original order; it does not reinterpret the evidence with the revised adapter.

This proves reproducibility of that development capture under the archived code. It is not independent execution, original-transaction-position reconstruction, a fresh simulation, a general coverage result, or a security verdict. Raw provider evidence remains untrusted. The original capture runtime was Node v22.23.2 / V8 12.4.254.21-node.56 on darwin arm64; the verification output records its actual runtime separately.
