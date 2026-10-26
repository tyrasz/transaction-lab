# Preserved v1 engine source

These ten engine, package, lock and test files reproduce the exact source inventory bound by the immutable `../local-execution-comparison/results.json`. Each archived file was checked against that report's SHA-256 inventory. The two edited files were recovered from their recorded pre-edit contents and verified byte for byte against the sealed hashes; all other files were copied unchanged. The original packet remains untouched.

Run `node reports/local-execution-comparison-v1-source/verify.mjs` from the project root. The offline verifier creates a temporary workspace, installs no packages, copies the preserved source and original sealed packets, links the existing dependency directory, then executes the original unchanged verifier. It removes its temporary workspace afterward. The original verifier checks Node/runtime and direct installed package versions against its sealed inventory; full installed dependency contents are not independently attested.

The current comparator adds stricter context, required-field and supplied log-topology checks. Its separate corrected report is `../local-execution-comparison-v2/`; the old report is a historical record of the earlier comparator and does not acquire those later checks retroactively.
