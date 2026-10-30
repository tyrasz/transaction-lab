# Eight-case historical creation and rollback preparation

This is a fixed synthetic development matrix, not public-chain activity or a
holdout. No declared target may execute during preparation. Existing sealed
packets remain unchanged. Signed EELS transactions and the product's unsigned
equivalents use identical initial allocations, environments and call fields.

The eight declarations are, in order:

1. Shanghai root CREATE succeeds.
2. Cancun internal CREATE succeeds.
3. Prague root CREATE succeeds.
4. Osaka internal CREATE2 succeeds.
5. Osaka internal CREATE2 constructor reverts and its caller continues.
6. Osaka successful CREATE2 is rolled back by a caught ancestor revert.
7. Amsterdam root CREATE constructor reverts.
8. Amsterdam successful CREATE2 is rolled back by a caught ancestor revert.

Every target starts with nonce zero, balance 17, empty code, and storage slots
0=999 and 991=123456. Creation sends value 5. Initcode reads hidden slot 991 into
slot 1, writes 999 back to slot 0, and writes 42 to slot 2. The old-equal write
distinguishes the complete fresh namespace from a sparse diff and checks the
zero original-value gas baseline. No expected poststate enters execution.

Internal callers start with slot 0=12, write 55 before creation or the helper
CALL, then restore 12 afterward. That probes unrelated original-storage cache
preservation through clearing and rollback, including charged gas/refund/fees
when the final storage has no net change. Ancestor helpers also write slot 1
from 5 to 43 before creation and revert after the constructor has returned.
The root catches that revert. Constructor-revert cases use actual REVERT in
initcode; they are not collisions, host failures or a success relabeled later.

Four declared nonce-one STOP system accounts preserve full apply_body wrapper
behavior without unmodeled system storage writes. They are identical in product
and EELS allocations and are inert even in earlier forks that do not need all
four. Their inclusion is explicit, not a claim about deployed chain state.

Commands have separate boundaries:

- `node run.mjs prepare` writes the eight input declarations and the pinned
  toolchain identity, validates product/EELS input preparation only, and returns
  before any execution entrypoint. It may not create a capture STARTED file.
- `node run.mjs freeze` archives the exact source, complete Node dependency
  trees, prepared input bytes, Node identity, toolchain manifest, and successful
  preparation record. Freeze runs no declared target. It requires a fresh
  capture directory and rejects source/input drift or failed preparation.
- Only `node run.mjs run PLAN_SHA256 --execute-frozen-targets` can dispatch the
  sixteen processes (product and EELS for each fixed declaration). This command
  is not part of preparation. Dispatch requires successful preparation matching
  the final source and review of the execution and saved-comparison paths.
- `node run.mjs compare PLAN_SHA256 MANIFEST_SHA256` reads the sealed observations
  and reconstructs roots/receipts/logs without running an EVM or client.

Each target process is limited to 20 seconds and 8 MiB combined stdout/stderr.
All sixteen processes share 360 seconds and 80 MiB. Freeze validates all external
EELS source, venv, standard-library and runtime files against the prior pinned
manifest; checks repeat before and after attempts. Product source/dependencies
run from the archived tree. Retain every failure and unattempted position; no
retry or replacement inside a capture. Source drift, timeout, output overflow,
or failure to close the product's isolated child makes observations unusable.

The EELS adapter selects only official fork modules and stock apply_body. It
branches explicitly for historical environment, intrinsic-gas, trace and receipt
fields; unavailable dimensions remain null. It never patches source or imports
product predictions. Its prepare-only return precedes BlockEnvironment creation,
trace installation and apply_body. The input hash is an explicit worker
argument; the driver verifies the toolchain against the pinned manifest hash.
Neither is dynamically accepted from reference results.

The saved comparison reconstructs complete allocations from initial full MPT
state plus product deltas. Creation resets must authenticate the old full target
storage root before clearing and preserve nonce/balance/code bases. Rollback
results have no retained target reset. Deletion and SELFDESTRUCT are excluded
from this matrix. Compare status, return bytes, charged gas, block gas, full
state root, complete target account/storage and logs; unavailable results remain
null. No success-rate or general release-certification claim follows from eight
known development inputs. OS shared libraries are not fully archived.
