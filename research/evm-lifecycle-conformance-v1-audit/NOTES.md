# Supplemental official lifecycle replay audit

This separate audit binds the original 16-case frozen plan
`0e8cfe9f56e75f090ea2468fb19348914d3ba438fb9bceeec33be016b9e412b5`
and result manifest
`de6a85b5734c2e985c51dac592e0d80a199223107b3d65ee58cd29338e993942`.
It neither modifies nor replaces the original packet.

The verifier checks all archived source bytes, the actual Node executable,
exact case and result inventories, raw child output, original signed transaction
bytes, official final state root, logs hash and exact receipt logs, status, gas,
transaction hash and bloom. A fresh archived worker reexecutes every fixed case.
Only parent-measured elapsed time is excluded from equality; all VM output and
comparison fields must reproduce exactly. No network is used.

`verification.json` retains the observed counts and replay identities. These
sixteen original signed fixtures all matched their published expectations:
fourteen successful top-level executions, two constructor reverts, and two
committed nonempty logs. This extends the earlier, separate 32-case dependency
packet; it does not validate the sparse product's deletion finalizer or give a
general EVM accuracy denominator.

Recheck the sealed audit and replay all vectors with:

```
node research/evm-lifecycle-conformance-v1-audit/verify.mjs --replay
node --test research/evm-lifecycle-conformance-v1-audit/verify.test.mjs
```
