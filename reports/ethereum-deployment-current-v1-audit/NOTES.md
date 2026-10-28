# Independent offline top-level CREATE audit

The saved local deployment reproduces exactly in a fresh child process using the frozen execution sources and four saved proof/code responses. The provider comparison remains **unavailable**: its first `debug_traceCall` returned HTTP 400 with `Error: -32602, Required "to" is empty`. No provider trace, poststate diff, or final canonical header was obtained. This is verified local reproduction, **not independent provider agreement**.

Run from this worktree's repository root:

```sh
node reports/ethereum-deployment-current-v1-audit/verify.mjs --verify
node --test reports/ethereum-deployment-current-v1-audit/verify.test.mjs
```

The audit verifies all 17 original evidence files, 1,788 archived source/dependency entries, the archived runner and Node runtime identity, and all seven exact request/response records (29,156 response bytes). It checks the selected header hash, two account proofs and matching code responses, joins each read to the child broker and input evidence, and reconstructs the claimed initial facts. All seven wire records are accounted for, including the unsuccessful provider request. No original capture file was changed and no public call was made during the audit.

At block **26,288,940**, hash `0x9d73e3dcf2701d54ca3ef88d36597307ef5847940ad31767be1379bf5768d3ea`, the sender's authenticated initial nonce is **1**. An independently encoded RLP of sender and nonce gives CREATE address **`0x3be7f950380997a5fbbd6ace42b422c7ef437f1b`**. That target's initial absence is proven; initial storage zero comes from account exclusion, not from an output trace or diff.

The replay supplies only the frozen unsigned request (`to: null`), selected header, declared limits, and exact sequential proof/code responses to the archived worker. No recorded local output, provider trace, or poststate supplies an execution input. Complete output, initial facts, usage, reads, changed state and header verification match the capture. Only input/broker durations, host duration and the fresh child process ID are excluded; successful child exit, closure and no pending requests are checked separately.

The local constructor produces the full **11-byte** runtime `0x60005460005260206000f3`, writes slot zero **0 → 42**, and gives the contract nonce **1**. The sender nonce changes **1 → 2**. These are exactly two changed accounts. Ten opcodes execute in one frame, with no logs and **53,390 intrinsic + 24,330 message = 77,720 gas**, zero refund. Creation intrinsic gas is 32,000 and the 31-byte initcode adds 2 word-gas units. These are local results only.

Seven focused audit controls pass. They reject altered raw or parsed wires, IDs, request substitutions, relabelled HTTP errors, invented parsed outputs, reordered or extra proof playback reads, provider tracing used as an input, incorrect CREATE encoding and nonce boundaries, and altered initial proof claims. A real archived child given a deliberately corrupted initial proof becomes unavailable after one read and returns no changed accounts. These are offline mutation controls, not further live cases.

The original provider run stopped after its first failed request, as declared; neither remaining provider request was attempted. The frozen comparator reproduces `provider_sequence_incomplete` with no established comparison channels. Header hash and proof verification bind the local execution to the selected state root; they do not establish consensus, finality, or a final canonical recheck. The audit does not recompute a full poststate root, settle fees, verify signatures, establish an OS sandbox, prove complete economic effects, or support a population accuracy claim. It does not broaden lifecycle support. The product fingerprint in the plan is provenance only; this capture did not invoke the product HTTP API.

Original evidence manifest: `3aab8f526c5dee2d5ce765f66ea6108119faca53bc80105d2b093921a01a3841`.

Plan: `84d716f5e6c416cbf071ff8e9a7047213b083b50895e8d0daea0da75586001f7`.
Source manifest: `87c7695fa5a93532596309b57f087959b759538279c4c9c3007db405f588b1f5`.
Runner: `bf8b272b5aec53c1eb8ceb2eb877c1ebad0f1fbbf886409bd6d81ce354eea450`.
Executed local implementation: `077c4114abe838c4705642d22ebe2cf4e125ea541a68a54b13e691e50c3909ec`.
