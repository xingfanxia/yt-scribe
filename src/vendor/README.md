# Vendored libraries

Copied unchanged from npm (`package.json` pins the same version) because the extension has no
build step. Update by bumping the version, `npm install`, and copying the file again.

| File | Package | License |
|---|---|---|
| `pdfkit.standalone.js` | `pdfkit@0.20.2` (`js/pdfkit.standalone.js`, bundles fontkit) | MIT, see `pdfkit.LICENSE` |

pdfkit replaced pdf-lib because `@pdf-lib/fontkit@1.1.1` drops glyphs (digits, 年/月/日, …)
when subsetting the Google Fonts Noto instances below; pdfkit's current fontkit subsets them
correctly. Verify after any upgrade: `npm run e2e` renders a Chinese PDF to
`scratch/media/e2e/pdf-bilibili-1.png`.

Fonts in `/fonts` are Noto Sans and Noto Sans SC Regular (static TrueType instances served by
Google Fonts), licensed under the SIL Open Font License 1.1 (`/fonts/OFL.txt`).
