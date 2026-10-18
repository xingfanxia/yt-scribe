# Scribe (yt-scribe) — agent guide

**Profile: personal browser extension, public MIT repository, published free on the Chrome Web Store.**
A Chrome MV3 extension (plain JS, no build step) that copies, exports and chats with YouTube and Bilibili
transcripts. Structure, fetch pipelines and release steps are in `README.md`.

- The requested behaviour defines completion. Check a change with what covers it: `npm test` for
  `src/shared/core.js` / `markdown.js`, `npm run e2e` when fetching, page buttons, popup, side panel or
  export change (`BILI_COOKIES` for the signed-in Bilibili path, `ANTHROPIC_API_KEY` for chat).
- User-facing strings come from the table in `scripts/build-locales.py` (en + zh_CN); run
  `npm run locales`, never edit `_locales/*.json` by hand.
- `docs/privacy.md` is the published privacy policy and `docs/store/listing.md` holds the store
  disclosures: update both in the same change whenever the extension starts reading, storing or sending
  something new, or gains a permission.
- Deliberate boundaries: no server, telemetry or licensing; no remotely hosted code (vendored libraries
  live in `src/vendor/`, see its README); model replies go through the escaping Markdown renderer.
- This is an independent reimplementation; nothing copied from another extension's source may enter
  this repository. The store name must not contain third-party trademarks.
