# Sepolia foundations, not execution admission

This unreleased development change is based on implementation `989e5488e2e076a249583a15e414e695c75574d0`. It does not widen the HTTP endpoint, isolated worker or transaction execution profile. The public local endpoint still rejects Sepolia. No new public RPC, wallet operation or broadcast was used for these checks.

The finite network selector accepts Ethereum mainnet or Sepolia. It uses a detached copy of the pinned EthereumJS 10.1.3 chain configuration, with Sepolia's missing Amsterdam activation supplied by the exact retained Geth configuration and source revision. It verifies the installed schedule shape before applying that overlay. Each header selects its own fork from its block number and timestamp; a caller cannot supply a schedule or hardfork override.

Header verification now handles Amsterdam's block-access-list commitment and slot number in their exact RLP order. The saved live Sepolia header hashes to its recorded block hash with 23 fields. Missing, premature, malformed or tampered fields fail. This binds execution fields to the selected hash; it does not establish consensus, finality, network membership or the contents of the committed access list.

The intrinsic gas helper implements the explicit Amsterdam base, recipient/value/create components, duplicate access-list charges and data surcharge, uniform calldata floor and per-authorization intrinsic charge. Tests compare 36 signed type-2 and sixteen signed type-4 transaction shapes with the pinned transaction implementation, plus independently specified arithmetic examples and malformed inputs. These library counterparts share EthereumJS; they are not an independent execution client or a public transaction sample. Existing fork result shapes remain unchanged.

The full local suite passes **752/752 tests** in **18.043 seconds**. Focused network/header, gas and profile-review logs are also retained. The first gas test run retained one failed assertion: the test incorrectly expected a Sepolia-height block combined with a current mainnet timestamp to select BPO2. The corrected assertion requires rejection of that inconsistent mainnet context and separately checks the valid mainnet schedule. Production arithmetic was not changed to obtain that pass.

Execution still needs the chain identity carried through proof collection, ancestry, parent/worker validation, query identities and API transport. Amsterdam transaction preparation, state-gas accounting, fees, account deletion and runtime limits need separate implementation and validation. Supporting a fork in this helper does not admit those execution paths.

`source-check.json` records the exact six implementation/test files at the successful full-suite checkpoint. Later development files are outside that snapshot. The fixtures separately retain source provenance for the network configuration and saved public header.
