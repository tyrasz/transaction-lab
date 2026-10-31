# Third-party notices

This repository includes third-party dependencies, source excerpts, and test
fixtures in its evidence archives. Their existing copyright notices and licenses
continue to apply. This index adds notices alongside the archives without
changing their sealed bytes. It does not assign a blanket license to Transaction
Lab's original work or certify legal compliance.

## Supplemental license copies

- **@noble/hashes 2.4.0 — MIT.** The partial dependency snapshot at
  `reports/blob-context-api-v2-audit/source/engines/standard-evm/node_modules/@noble/hashes/`
  contains `_u64.js`, `sha3.js`, `utils.js`, and `package.json`. Its accompanying
  copyright and permission notice is supplied in
  [LICENSES/noble-hashes-2.4.0-MIT.txt](LICENSES/noble-hashes-2.4.0-MIT.txt).
  Other archived copies retain their own package licenses.
- **@ethereumjs/mpt 10.1.3 — Mozilla Public License 2.0.** The 61 archived package
  roots ending in `node_modules/@ethereumjs/mpt` at source commit
  `42a3a987e4c86e49fb2331e214df4544fbc61f12` declare MPL-2.0 in `package.json`
  and link it from their README files. Their `src/` directories retain the
  corresponding TypeScript source alongside the distribution files. The full
  license is supplied in [LICENSES/MPL-2.0.txt](LICENSES/MPL-2.0.txt).
  These package files remain governed by MPL-2.0; this notice does not relicense
  them. Upstream source: [EthereumJS MPT](https://github.com/ethereumjs/ethereumjs-monorepo/tree/master/packages/mpt).

The exact origins and hashes of these added license files are recorded in
[LICENSES/PROVENANCE.md](LICENSES/PROVENANCE.md).

## Existing notices retained with evidence

- Go Ethereum material includes GNU GPL and LGPL notices. Representative copies
  are [COPYING.go-ethereum](engines/local-evm/test/fixtures/kzg-point-evaluation/upstream/COPYING.go-ethereum)
  and [COPYING.LESSER.go-ethereum](engines/local-evm/test/fixtures/kzg-point-evaluation/upstream/COPYING.LESSER.go-ethereum).
  Research toolchain manifests identify their pinned upstream revisions and
  build inputs. This also applies when reviewing the Geth-based diagnostic
  executable and `main.go` retained under
  `research/delegated-sender-geth-v1/fee-controls/commit-diagnostic/capture/`;
  the associated dependency and source inventories are under
  `research/delegated-sender-geth-v1/fee-controls/capture/toolchain/`.
- Execution-specification fixtures retain their source-license evidence, for
  example [LICENSE.execution-specs.md](research/storage-creation-v035/official-fixtures/LICENSE.execution-specs.md)
  and the neighboring `license-provenance.json` and `license-source-tree.json`.
- Circle contract source retains its Apache 2.0 notices in
  [evm-cctp-contracts/LICENSE](research/arbitrum-deposit-v1/sources/evm-cctp-contracts/LICENSE)
  and [hyperevm-circle-contracts/LICENSE](research/arbitrum-deposit-v1/sources/hyperevm-circle-contracts/LICENSE).
- Other vendored packages and upstream fixtures retain their local `LICENSE`,
  `COPYING`, source headers, and package metadata. Those component-specific
  notices take precedence over this short index.

Archive provenance and package version declarations should be used when locating
the corresponding upstream source; a link to an upstream default branch is not
a replacement for a recorded revision.
