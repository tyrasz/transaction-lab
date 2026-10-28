# Headless browser context checks

Chrome 156.0.8078.48 ran with a fresh temporary profile against localhost5174 and the 0.15.0 UI. The completed attempt passed all 17 checks at desktop 1440×1000 and mobile 390×844. The browser report retains local UI/package hashes, actual intercepted request bodies, synthetic responses, geometry, screenshot hashes and zero page/console errors.

- [Browser checks](browser-checks.json)
- [Desktop context](attempts/2026-10-28T00-24-32.318Z/01-desktop-context-blank.png)
- [Provider request lock](attempts/2026-10-28T00-24-32.318Z/02-provider-request-locked.png)
- [Local synthetic response](attempts/2026-10-28T00-24-32.318Z/04-local-synthetic-response.png)
- [Per-step sequence context](attempts/2026-10-28T00-24-32.318Z/05-sequence-synthetic-response.png)
- [Mobile context](attempts/2026-10-28T00-24-32.318Z/06-mobile-context.png)

The successful attempt intercepted four POSTs: provider context, local context, per-step sequence context after reordering, and blank provider context. Exact list order and duplicates survived forwarding; manual query descriptors stayed unchanged. Request controls locked while pending. Malformed JSON blocked dispatch. Example selection, network changes and native form reset cleared prior context; HyperEVM hid it. No production simulation handler, local engine or public RPC was invoked. All other observed page requests were restricted to the declared localhost static/config GETs.

The first attempt is retained under attempts/: it stopped after two intercepted POSTs because the test looked for the synthetic error label inside the local result card. The application correctly displayed it in the execution-error section and withheld unverified measurement values. Only the harness selector was corrected; the successful second attempt made four synthetic POSTs. Total across both attempts: six synthetic POSTs, zero public RPC and zero product source edits.

Screenshots were visually reviewed. No horizontal overflow or clipped context controls appeared in the two declared viewports. The context text is 10px with 17px line height; this is not an accessibility certification. Brown screenshot labels identify test-only synthetic content. These checks establish UI behavior, not execution accuracy, chain observations or protocol coverage.
