# DavraBox redesign - independent critic report (2026-11-23)

Raw evidence (screenshots, axe and metric JSON) is in this folder; the agent that produced it did not touch source files.
Measured on the real stack (Edge, fake media, 3 participants) and on lab pages (synthetic video, production build); touch was emulated.

## Verdict
No blocker. Identity (mandala, turquoise/indigo/gold, Onest) is distinctive; axe clean in 412 runs (180 home, 221 call, 11 real); 50 fps, 0 long tasks even at 4x CPU throttle. Weak spots: call screen (names, share size, host actions), keyboard order, 44 px touch targets.

## Major
- D-01 Host Remove/Mute/Co-host on tiles: no confirmation, aria-label has no participant name (Tile.tsx:147, Call.tsx:380). Fix: name in label, confirm Remove, reveal actions on tap for coarse pointers.
- D-02 Tab order: tile buttons come before the control bar (~40 Tabs to reach mic with 12 people). Fix: remove tile actions from tab order (People panel has them) and add "skip to controls".
- D-03 Ring names cut to ~11 chars; hidden at 360 px (call.css ~186-205). Fix: wider pill under the circle; initials/name on focus for xs.
- D-04 Screen share ~580x325 in Davra vs ~816x560 in speaker. Fix: auto-switch to speaker/presentation on share with "Return to Davra", or give share ~70% of stage.
- D-05 Coarse-pointer targets under 44 px: meeting-row Join 32, Admin 83x32, Sign out 44x32, dialog close 44x32, Lock 44x32, tile actions 44x28, roster buttons 44x32, Admit/Deny 32 high, notice dismiss, file chip. Cause: ui.css:485 only raises default .dx-btn.
- D-06 Home with 71 meetings = 7,000 px single list. Fix: cap groups at 5-8 rows + "show all", filter above ~15.

## Minor
D-07 layout popover focuses a 1x1 hidden radio (check ring on label). D-08 popovers declare aria-haspopup=dialog but are non-modal. D-09 join-request tray overlays tiles while People panel open. D-10 auto-grid notice covers first row. D-11 dotted ghost seat reads as failed tile. D-12 join form keeps red error after clearing. D-13 passcode field always visible. D-14 first visit dark although OS light; color-scheme meta says "dark light" (document the decision). D-15 at 360 px layout switch only inside More (current mode invisible). D-16 Styleguide chunk (43 kB JS) ships in prod. D-17 og:image hard-codes davrabox.bugvector.uz.

## Polish
Russian "Давра" unexplained; U+2713 falls back to system font; body font-variant-numeric normal (timers should use tabular); share-label pill shade differs; in 1:1 Davra is effectively speaker view (default to speaker for n<=2); waiting screen status above headline; /admin not restyled.

## Uzbek microcopy (needs native editor)
Mixed nouns "davra" vs "uchrashuv" - pick one. "Kod to'g'ri" only checks format -> "Kod formati to'g'ri". "o'zingiz kirasiz" -> "avtomatik kirasiz". "Yana" on More reads "again" -> "Qo'shimcha". Russian "Закрыта" for locked meeting reads as ended -> "Вход закрыт".

## Performance
Main JS 1,102,039 B (315,758 gzip) single chunk; CSS 61,751 B; AdminApp 25 kB; Styleguide 43 kB; MediaPipe wasm 9.4 MB each. All scenes 50 fps, 0 frames >33 ms (Davra n=2/6/12, grid 13/30, 4x throttle, reduced motion). n=30 renders 5,766 DOM nodes, no pagination.

## Not verified
Real calls with 6/12/13+ people, Firefox/Safari/Electron, real touch devices, screen-reader output, real HD streams / memory over time, contrast of name pills over live video, real-stack share in speaker view.
