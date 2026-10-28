# Independent saved Geth result audit

The sealed 48-case packet passes this offline artifact/result audit: 48 matched, 0 mismatched, 0 unavailable, 0 unattempted. All 148 captured files (13,845,594 bytes), the exact Node/tool identities and the frozen 32+16 input selections were checked. All 48 child records report exit zero, no signal or failure reason, confirmed closure, exact Osaka identity, boolean pass and the expected full state root. The retained stdout/stderr contain 18,459 bytes, independently decoded and hash/count checked.

External plan SHA256: `63495b6b39c18115c5710664007d4730abc67d70fad205cc4efce8a7b5f79081`.
External capture manifest SHA256: `47342b92f1ecf622df9767fe668ba3d85ae4dc71a2d5474f373b03850bb7b175`.
Frozen producer SHA256: `eafecc8f260a0136cbc005bd1d713ac3cabb29886c26e0d2b443eaf273788236`.
Geth binary SHA256: `10385eddbfd76c3d05b9853f30f4372f2468f6a8c1ac64c445a7490694fc3521`.

Reproduce without target execution:

```sh
node research/cross-client-geth-v1-audit/verify.mjs research/cross-client-geth-v1/capture 63495b6b39c18115c5710664007d4730abc67d70fad205cc4efce8a7b5f79081 47342b92f1ecf622df9767fe668ba3d85ae4dc71a2d5474f373b03850bb7b175
node --test research/cross-client-geth-v1-audit/verify.test.mjs
```

The audit reuses the archived producer's input/source/tool verifier only. Its raw-output adjudicator is separate and does not call the producer's adjudicator. Twelve synthetic tamper controls pass, covering pass/root distinctions, foreign or ambiguous output, process failure/closure, byte/UTF-8 integrity, exact command arguments, 48-row ordering/counts, false summary claims and artifact inventory drift.

This is saved-output verification, with no new Geth or local VM execution and no public requests. The log-hash check is the pinned Geth test runner's internal assertion; this audit does not recompute logs. Receipt fields, gas, return data and detailed logs were not independently compared. These already-inspected official fixtures do not establish current local-product coverage, a five-channel agreement result, or a population accuracy rate. The separate binary/toolchain remains required to verify its present identity; the packet is not a portable toolchain archive. No original capture bytes were changed.
