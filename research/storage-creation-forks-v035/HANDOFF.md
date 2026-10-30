# Preparation checkpoint — no target execution

Prepared alongside repository HEAD `11a98230f18ba5c38a45387d5a0b0394f70d8a2f`.
The new files are not committed. No main engine file or sealed packet was edited
for this task. There is no `capture/` directory and no `STARTED.json`.

The fixed order is Shanghai root CREATE success; Cancun internal CREATE success;
Prague root CREATE success; Osaka internal CREATE2 success; Osaka caught
constructor REVERT; Osaka caught ancestor REVERT after successful creation;
Amsterdam root constructor REVERT; Amsterdam caught ancestor REVERT after
successful creation. The exact bytes and addresses are in `prepared/inputs/`.

The target begins with nonce 0, empty code, balance 17 and two nonzero storage
slots. The constructor reads hidden slot 991, writes the old value 999 back to
slot 0, and writes 42 to slot 2. Every internal caller dirties then restores an
unrelated slot (12 → 55 → 12). Ancestor helpers dirty their own slot before
creation and execute REVERT only after the constructor has returned. These
inputs distinguish whole-namespace clearing, sparse deltas, original-value gas
baselines, and caller/ancestor rollback. They do not directly establish the
behavior of a sticky created-account marker when no later executable target
code remains. SELFDESTRUCT is outside this eight-case matrix.

Validation completed:

- `preparation-tests-final.tap`: 21/21 offline groups pass. These cover signed
  declarations, roots, creator derivations, bytecode copy offsets, genuine
  rollback paths, delta reconstruction negatives, and driver protocol/gates.
- `prepared/attempts/002/report.json`: all 16 preparation subprocesses pass
  (eight product, eight stock EELS); `executionInvoked: false`,
  `sourceUnchanged: true`, `fatal: null`. Every worker was passed
  `--prepare-only`. Elapsed time was 11.62 seconds; raw output was 19,559 bytes.
- The preparation manifest covers 3,905 product/helper/dependency source files
  (24,047,354 bytes). The external pinned EELS identity covers 5,080 entries.
- Attempt 001 remains intact: product input preparation passed, while every
  EELS input preparation rejected a Uint/int comparison in an admission check.
  The adapter now converts those operands to plain integers. No EELS execution
  entrypoint had been reached, and attempt 002 preserves the separate retry.

Pinned evidence:

| File | SHA256 |
| --- | --- |
| `prepared/attempts/002/report.json` | `5acdf62d049e09281d06bec481f4d265f86f0185a50bcc87271cde6f019de3fd` |
| `prepared/attempts/002/manifest.json` | `e40d42a73ba6650268bf095ccd90d83242695daff429b73f1ae878903a38b759` |
| `prepared/attempts/002/plan.json` | `ae78c160867a2d6430670d2f52f26171229ae7f93a79f9a858c6e8dc8cf63fe5` |
| `preparation-tests-final.tap` | `635d68a26fe7685e447dbec5bca7207505e921e3f57ed65d5475434f9667f377` |
| `prepared/toolchain.json` | `5e67873833811992160173737d5c6f229dad327281e7e915ecce206cac4cb005` |

`run.mjs` contains prepare, freeze, execution and saved-comparison paths. Only
prepare was invoked. Future freeze rejects source/input drift and requires the
latest successful preparation record. Future execution additionally requires
the exact frozen plan hash and `--execute-frozen-targets`. Its sixteen target
processes, execution-only EELS projection and comparison of actual results have
deliberately not been exercised. Review those paths before freezing; this
checkpoint is prepared research, not new execution evidence or a release gate.

The driver validates the preparation manifest against the frozen plan, imports
the toolchain verifier from the bound archived tree, and preserves unavailable
channels. A process-group SIGKILL is recorded only as cleanup-signal acceptance;
product isolation separately must report a closed child and zero pending broker
requests. External EELS source, Python, venv and stdlib inventories are checked
before and after preparation/target attempts; OS shared libraries are not fully
archived. Four explicit inert system-account additions are the same on both
sides. Their presence is synthetic and is not a claim about deployed chain state.

If implementation or helper files change, rerun only preparation into a new
attempt before considering freeze. Do not rewrite earlier attempts. No accuracy
percentage or public-cohort result follows from this development matrix.
