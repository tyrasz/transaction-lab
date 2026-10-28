# Version 0.18 synthetic lifecycle differential

All sixteen predeclared synthetic counterparts matched across execution status,
return bytes, ordered logs, charged gas, and complete final Merkle state root.
The state comparison also matched independently observed account, code, storage
root and slot rows. There were no mismatches, unavailable results, replacements
or unattempted cases. The sources remained unchanged.

The run produced fourteen successful executions, two constructor reverts, ten
finalized created-account deletions and two committed nonempty logs. It used 154
in-memory proof/code reads containing 65,325 parsed result bytes and made no public
requests. Total recorded execution time was 4,986.085 ms; this small synthetic run
is not a production latency measurement.

Each product attempt ran first from an immutable full MPT made only from the
fixture's initial allocation. The complete product output and every proof read
were saved and fsynced before its separate signed full-VM reference started.
A third initial MPT applied only validated product net changes for comparison.
Neither official expected poststate nor reference output entered product inputs.

These are separately declared synthetic transactions: original prestate,
sender/nonce/key, destination, calldata and value; gas capped at 5,000,000; gas
price/base fee zero; a shared explicit synthetic Osaka header. They are not
replays of the original official signed vectors. Both paths use the same pinned
EthereumJS opcode library, while their transaction, proof-state and finalization
paths differ. This result tests the 0.18 sparse lifecycle implementation; it is
not an independent opcode implementation, signed-fee claim, full EIP-161 claim,
or ordinary-Ethereum coverage rate. Version 0.19 is a separate implementation.

The initial offline freeze failed while checking a dependency symlink before its
target was copied. It made no target execution. Its partial `capture` directory,
diagnostic and pre-fix helper sources remain unchanged; their provenance is bound
in the separately frozen `capture-v2` inputs. The sixteen declarations and
comparison rules were unchanged.

- Product source base: `dcc0554` (version 0.18).
- [Frozen plan](capture-v2/plan.json): `82edf8c8f06d33180ac109f61ed9247da6b596a5c618b9c2fa7ea16937fd1f86`.
- [Sealed manifest](capture-v2/manifest.json): `299980c26fde8c589f74922f2b00b93be6290b9acae3f69973f434f3e1f4bcf3`.
- [Full results](capture-v2/results.json), [run policy](PLAN.md).
- The independent supplemental replay audit is separate at
  `../evm-lifecycle-differential-v1-audit/`; its outcome is reported in its own seal.

This note is outside the sealed capture and is not an additional captured result.
