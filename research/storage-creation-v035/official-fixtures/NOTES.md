# Official storage-creating controls: static inspection

All 15 selected state-test vectors create a new codeless account and write its storage during initialization. None attempts CREATE or CREATE2 at a preexisting storage-only account. These are useful creation-and-subsequent-CALL controls, not evidence deciding the disputed preexisting-storage collision/reset behavior.

## Acquisition boundary

The plan was written before extraction. Exactly five requested regular-file archive members were retained, with their lengths bound to the existing inventory. The stream scan read 15,460,362,240 expanded bytes in 14.58 seconds, below the 64 GiB and 900 second limits. Retained fixture payload is 114,415 bytes, below 1 MiB per file and 5 MiB total. Archive SHA-256 before and after was `e2fa7ea2ea516459f9ab92284b2927892f318f4e1f78ca802cb05a6c3b479ed9`; compressed length was 939,189,561 bytes. No archive links or unselected payloads were retained, and selected outputs used exclusive safe writes. Raw fixture bytes were not changed.

The copied CC0 license, commit-linked license provenance and source-tree evidence hashes were checked. The one Python filler referenced by every fixture was retrieved separately from the pinned public commit, with a prior 1 MiB / 30 second acquisition plan. It was read as text, never imported or executed. Its acquisition headers and content hashes are preserved.

## What the declarations establish

- Five files, three fixture IDs and one post vector per ID per fork: Shanghai, Cancun, Prague, Osaka, Amsterdam; 15 IDs and 15 vectors total.
- Across every prestate, all storage maps are empty. Every created address identified by official expected parent slot 1 is absent from prestate.
- Each transaction calls an existing parent. The selected parent bytecode has one CREATE and no CREATE2; there are no top-level creation transactions. An unrelated deployer appears in Amsterdam prestate and is not the parent under inspection.
- Initcode writes its own fresh slot 0 to 12, CALLs a separate writer that writes slot 1 to 12, and runs off its end with no runtime code. The source explicitly declares original storage value zero at both SSTOREs.
- The `with_storage` arm ends after creation. The other arms subsequently CALL the newly created account with zero or one wei. The expected CALL success flag is one. The created account has nonce one, empty code and slot 0 equal to 12 in every official expected poststate.
- The distinction matters: the codeless account already has nonce one after CREATE. It is never the nonce-zero, codeless, storage-bearing target presented before a subsequent creation attempt.
- No product, Geth, EELS, EVM or target execution was performed. Official expected roots below are copied declarations, not independently recomputed roots or pass results.

The filler source at `test_create_empty_contract_with_storage.py` lines 69–93 defines the fresh storage writes; lines 111–118 define CREATE; lines 190–218 construct the expected new account. `structural-report.json` retains complete pre/post state, selected transaction, per-row metadata, literal initcode and static disassembly, all expected roots, receipts and gas measurements. The unmodified raw fixture retains its public test signing key; the derived report omits that field.

## Exact IDs and official expected roots

- `tests/ported_static/stCreateTest/test_create_empty_contract_with_storage.py::test_create_empty_contract_with_storage[fork_Amsterdam-state_test-and_call_it_0wei]`
  - Expected root: `0xe4dd7050c09b9092b801d0b5f94f3146064e83129c21684feee722ad4d22e78c`; expected receipt gas used: 874086.
- `tests/ported_static/stCreateTest/test_create_empty_contract_with_storage.py::test_create_empty_contract_with_storage[fork_Amsterdam-state_test-and_call_it_1wei]`
  - Expected root: `0x7f34d6af5be6ae597948123318fc0a8b7dc397c7bc2ea1189ece582295d3a2d5`; expected receipt gas used: 883086.
- `tests/ported_static/stCreateTest/test_create_empty_contract_with_storage.py::test_create_empty_contract_with_storage[fork_Amsterdam-state_test-with_storage]`
  - Expected root: `0x5f2f3016a8819dc6da799bad0a4ccd8a2c3e491742d957dc6d71ec582850fe28`; expected receipt gas used: 653787.
- `tests/ported_static/stCreateTest/test_create_empty_contract_with_storage.py::test_create_empty_contract_with_storage[fork_Cancun-state_test-and_call_it_0wei]`
  - Expected root: `0x59d2001535e57340dfa2ba9e3b2141630ee58e9a2c945a78f69ea1a6616f1196`; expected receipt gas used: 188566.
- `tests/ported_static/stCreateTest/test_create_empty_contract_with_storage.py::test_create_empty_contract_with_storage[fork_Cancun-state_test-and_call_it_1wei]`
  - Expected root: `0x04293490d0c2a52cd1266555e3148c13005de2c58e7256734b796d20ab697c55`; expected receipt gas used: 195266.
- `tests/ported_static/stCreateTest/test_create_empty_contract_with_storage.py::test_create_empty_contract_with_storage[fork_Cancun-state_test-with_storage]`
  - Expected root: `0x3b38302fac90998f982ecb6bde9672634edbd071305409561ec779fd5ed1e64c`; expected receipt gas used: 144107.
- `tests/ported_static/stCreateTest/test_create_empty_contract_with_storage.py::test_create_empty_contract_with_storage[fork_Osaka-state_test-and_call_it_0wei]`
  - Expected root: `0x59d2001535e57340dfa2ba9e3b2141630ee58e9a2c945a78f69ea1a6616f1196`; expected receipt gas used: 188566.
- `tests/ported_static/stCreateTest/test_create_empty_contract_with_storage.py::test_create_empty_contract_with_storage[fork_Osaka-state_test-and_call_it_1wei]`
  - Expected root: `0x04293490d0c2a52cd1266555e3148c13005de2c58e7256734b796d20ab697c55`; expected receipt gas used: 195266.
- `tests/ported_static/stCreateTest/test_create_empty_contract_with_storage.py::test_create_empty_contract_with_storage[fork_Osaka-state_test-with_storage]`
  - Expected root: `0x3b38302fac90998f982ecb6bde9672634edbd071305409561ec779fd5ed1e64c`; expected receipt gas used: 144107.
- `tests/ported_static/stCreateTest/test_create_empty_contract_with_storage.py::test_create_empty_contract_with_storage[fork_Prague-state_test-and_call_it_0wei]`
  - Expected root: `0x59d2001535e57340dfa2ba9e3b2141630ee58e9a2c945a78f69ea1a6616f1196`; expected receipt gas used: 188566.
- `tests/ported_static/stCreateTest/test_create_empty_contract_with_storage.py::test_create_empty_contract_with_storage[fork_Prague-state_test-and_call_it_1wei]`
  - Expected root: `0x04293490d0c2a52cd1266555e3148c13005de2c58e7256734b796d20ab697c55`; expected receipt gas used: 195266.
- `tests/ported_static/stCreateTest/test_create_empty_contract_with_storage.py::test_create_empty_contract_with_storage[fork_Prague-state_test-with_storage]`
  - Expected root: `0x3b38302fac90998f982ecb6bde9672634edbd071305409561ec779fd5ed1e64c`; expected receipt gas used: 144107.
- `tests/ported_static/stCreateTest/test_create_empty_contract_with_storage.py::test_create_empty_contract_with_storage[fork_Shanghai-state_test-and_call_it_0wei]`
  - Expected root: `0x59d2001535e57340dfa2ba9e3b2141630ee58e9a2c945a78f69ea1a6616f1196`; expected receipt gas used: 188566.
- `tests/ported_static/stCreateTest/test_create_empty_contract_with_storage.py::test_create_empty_contract_with_storage[fork_Shanghai-state_test-and_call_it_1wei]`
  - Expected root: `0x04293490d0c2a52cd1266555e3148c13005de2c58e7256734b796d20ab697c55`; expected receipt gas used: 195266.
- `tests/ported_static/stCreateTest/test_create_empty_contract_with_storage.py::test_create_empty_contract_with_storage[fork_Shanghai-state_test-with_storage]`
  - Expected root: `0x3b38302fac90998f982ecb6bde9672634edbd071305409561ec779fd5ed1e64c`; expected receipt gas used: 144107.

## Follow-up candidates from existing inventory/index only

No further fixtures were extracted. The complete candidate scans are retained as JSON. In the existing Osaka index:

- `state_tests/for_osaka/frontier/create/create_collision/create_opcode_collision.json`: 32 IDs; archive member length 234,482 bytes.
- `state_tests/for_osaka/frontier/create/create_collision/create_tx_collision.json`: 48 IDs; archive member length 285,698 bytes.
- `state_tests/for_osaka/constantinople/eip1052_extcodehash/extcodehash/extcodehash_dynamic_account_overwrite.json`: two IDs, with `target_exists_False` and `target_exists_True`.

None of the Osaka index IDs contains the combination `nonce_0-no_code-storage`. That is a name-level observation only; the candidate raw payloads and fillers have not been acquired here. The archive inventory contains no `eip7610`, `initcollision` or `create2collisionStorage` path. General storage/collision/reset name scanning returned 188 state-file paths across forks, including false-positive context matches; those are candidates, not established coverage.
