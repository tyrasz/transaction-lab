# Contributing

Start with the [README quickstart](README.md#quickstart) and [current status](STATUS.md). This is a research preview with bounded, explicit coverage. A successful execution is not a security verdict, and a small matched sample is not a population accuracy estimate.

A project license has not yet been selected. Public visibility does not establish open-source licensing terms; discuss intended reuse with the maintainers. Preserve the existing third-party license and provenance notices. This guide does not add a contributor license agreement or assign rights.

## Repository map

| Path | Purpose |
| --- | --- |
| `src/` | HTTP server, HyperEVM interpretation and validated measurements, optional-engine adapters and loaders |
| `public/` | Browser UI; no build step |
| `test/` | Application, browser-handler, API and saved-evidence regression controls |
| `engines/standard-evm/` | Ethereum provider-backed preview and ordered calls |
| `engines/local-evm/` | Proof-backed local Ethereum/Sepolia execution and isolated worker validation |
| `engines/fixture-evm/` | Separate, unmodified EthereumJS full-transaction comparison runtime |
| `engines/arbitrum-evm/` | Bounded Arbitrum provider preview |
| `fixtures/` | Declared synthetic cases and retained observations, with provenance |
| `reports/`, `research/` | Saved evidence, declarations, archived implementations and offline verifiers; some files are test dependencies |

Do not remove report or research files solely because they look generated. Tests intentionally use retained bytes and hashes. New results belong in a new declared location; frozen sources, manifests, inputs, failures and denominators must remain unchanged.

Clone the full Git history. Some provenance tests use `git show` to compare evidence with its original source commit. If your checkout is shallow, run `git fetch --unshallow` before the full test suite. CI uses `fetch-depth: 0` for the same reason.

## Setup and configuration

Use Node.js 22 or later. The root package has no dependencies; each engine has its own `package-lock.json`. Install all four engine packages with the exact commands in [Quickstart](README.md#quickstart). Keep `--ignore-scripts`, and explicitly run `prepare:runtime` only for the local engine. The runtime checker rejects unexpected dependency bytes; do not bypass it or patch the fixture engine to make comparisons agree.

The server reads these environment variables directly:

| Variable | Purpose |
| --- | --- |
| `PORT` | Local HTTP port; defaults to `5174` |
| `HYPEREVM_RPC_URL` | HyperEVM tracing and state provider |
| `ETHEREUM_RPC_URL` | Ethereum provider tracing or proof inputs, depending on engine |
| `SEPOLIA_RPC_URL` | Sepolia proof inputs for the local engine |

For example:

```sh
PORT=5174 npm start
```

`npm start` does not automatically load a `.env` file. Export environment variables in your shell or supply them through your process manager. Provider credentials belong on the backend, not in browser code, example requests, issues or committed reports. `.env` files and `node_modules` are ignored. No wallet connection or private key is needed to use the unsigned preview API; synthetic fixture signing keys are test data, not accounts to fund.

The default server binds `127.0.0.1`, rejects non-local hostnames and accepts only same-origin browser POST requests. It has no general cross-origin API. Public deployment needs an intentional backend/proxy configuration; changing a browser URL alone does not deploy the service.

## Making a change

1. Open an issue or describe the concrete behavior you intend to change. For execution rules, cite the relevant fork/specification and distinguish provider observations from independent execution evidence.
2. Work on a branch with a narrow diff. Keep unrelated dependency upgrades, formatting changes and new evidence runs separate.
3. Add a focused regression for a behavioral fix. Preserve unavailable and unsupported outcomes; do not replace missing state with zero or remove failed cases to improve a result.
4. Run the affected offline tests, then the relevant broader suite. Report the exact commands, outcomes and any checks you could not run.
5. Open a pull request describing the before/after behavior, validation and remaining scope limits. Keep raw amounts, account ownership, fee treatment and measurement provenance explicit in UI changes.

## Offline validation

After installing all four dependency trees and preparing the local runtime, run these commands from the root, one at a time:

```sh
npm test
npm run test:local
npm test --prefix engines/standard-evm
npm test --prefix engines/fixture-evm
node --test engines/arbitrum-evm/test/*.test.js
npm run benchmark
```

`npm test` runs application tests; it does not replace the separate engine suites. `npm run test:local` first verifies the prepared runtime hashes. Individual files can be run with `node --test path/to/file.test.js` after their dependencies are installed. Some tests execute synthetic bytecode or start temporary localhost servers; none of the commands above require public blockchain RPC access. Keep recorded fixtures available and allow localhost binding. The benchmark evaluates saved fixtures and writes `reports/latest-benchmark.json`; it does not produce a new live accuracy observation.

## Live checks and evidence

Live checks are opt-in, separate from normal development and CI. The root `check:live`, `compare:providers`, `check:historical`, `check:permissions` and `check:coverage*` commands make read-only provider requests and retain artifacts. Some expect a running local server; prospective studies have additional selection, source-freeze and one-shot rules. Read the corresponding script and plan before dispatch. Do not run every research script as a test suite.

For new evidence, declare inputs, provider choices, limits and comparison channels before execution; retain all selected attempts, including errors and unavailable cases. Do not retry into an existing frozen packet, silently choose another provider or account, or use expected outputs as execution inputs. Describe saved-response replay, shared-library controls, independent-client execution and provider agreement accurately. No contribution workflow requires sending a real transaction, signing with a live wallet or acquiring funds.
