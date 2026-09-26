# Attribution

## Fonts

Second pass. The first pass here vendored Newsreader and Source Sans 3. This
pass follows Cutaway's design language exactly, including its type — Inter
for everything, JetBrains Mono for tool names, timings
and the readback panel's fact keys, the only two families Cutaway's own
`web/index.html` names. Both are self-hosted as static woff2 files in
`src/web/fonts/` and loaded with `@font-face` in `src/web/style.ts`, for the same
reason the first pass gave: before either pass, `src/web/style.ts` named a stack
that fell back to Georgia on a judge's machine without the right font installed —
the same fallback the Ring review found two sibling apps in this hackathon
independently rendering under — and that is a real defect independent of which
reference this app follows.

### Inter

Everything: headings, body copy, labels, buttons, the authority band, the ledger.
Cutaway's own UI face (`font:14px/1.5 Inter,system-ui,...` in its `web/app.css`),
taken directly rather than approximated with a system stack.

- Designer: Rasmus Andersson.
- Source: https://fonts.google.com/specimen/Inter
- Licence: SIL Open Font License, Version 1.1.
- Weights vendored: 400 (regular), 500, 600, 700.
- Files: `Inter-Regular.woff2`, `Inter-Medium.woff2`, `Inter-SemiBold.woff2`,
  `Inter-Bold.woff2`.

### JetBrains Mono

Tool names and their measured times ("`get_visits` 1.8 ms"), the readback panel's
fact keys, and anywhere else a value needs to read as data rather than prose —
Cutaway's own choice for the same job (`.tip`, `.num`, `.chip.tool`, `pre` in its
`web/app.css`).

- Designer: JetBrains, in collaboration with Philipp Nurullin and Konstantin Bulenkov.
- Source: https://fonts.google.com/specimen/JetBrains+Mono
- Licence: SIL Open Font License, Version 1.1.
- Weights vendored: 400 (regular), 500.
- Files: `JetBrainsMono-Regular.woff2`, `JetBrainsMono-Medium.woff2`.

Both families are redistributable under the SIL OFL 1.1, which permits bundling and
self-hosting; the licence text is reproduced with the fonts themselves at
https://openfontlicense.org and is not duplicated here.

Total added weight: 6 files, ~140 KB, served from this app's own stylesheet as
inlined base64 — no third-party font request at runtime, and no `/fonts/*` static
route needed (the console serves exactly two static routes, `/app.css` and
`/health`; see `src/web/font-data.ts`'s own header comment).
