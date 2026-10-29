# Running release verification — 0.29.0

The reviewed implementation commit is `18306831344718f9f7b5f52167560f34c400e370`. Main was fast-forwarded to it and the existing localhost server was restarted on port 5174.

The saved health response reports version **0.29.0**, status **ok** and **readOnly:true**. Configuration reports the Ethereum local, Ethereum provider and Arbitrum engines available. The local capability exposes explicit `native_balance` queries with no additional code execution or query fee; original fees appear only under the selected priced profile.

After the merge, both the native packet artifact verifier and the synthetic browser packet verifier passed again from the main checkout. These commands verified saved artifacts without rerunning any EVM target or querying a public chain. Only the two localhost health/configuration reads were made for the running-release check.

Application and local-engine regression results remain in the [sealed release review](../native-balance-v029-review/NOTES.md): 700 application controls, 711 local-engine controls, and 51 focused UI controls passed. This release adds explicit account coverage, not a universal EVM accuracy claim.
