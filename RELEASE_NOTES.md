# v3.9.12 — Qingyun maintained release

Based on upstream v3.9.11, with upstream sidebar/standalone coexistence,
AnySearch, citation and retry fixes retained.

- Restore literature conversation titles derived from Zotero metadata
  (`author · year · title`), durable URL bindings and manual title synchronization
  with ChatGPT. The browser companion is Sync for Zotero v0.0.19.
- Preserve ASCII diagram indentation, blank lines and literal code contents,
  including code highlight cache keys and Zotero note rendering.
- Preserve portable SVG and image answers through the browser companion.
- Move plugin updates and downloads to Qingyun0118/llm-for-zotero. Keep the
  existing plugin ID, preferences and data locations for an in-place upgrade.
- Require quality checks and verify packaged update URLs and hashes before
  publishing a release.

Original project by Yile Wang and contributors; this fork retains its license.
