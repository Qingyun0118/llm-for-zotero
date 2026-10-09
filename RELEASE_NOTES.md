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
- Fetch model capability metadata from this fork and point the settings panel's
  browser-companion download instructions at the maintained companion repository.
- Require quality checks and verify packaged update URLs and hashes before
  publishing a release.
- Keep sidebar mode tabs equally sized across Linux fonts, and allow CI graph
  checks and asynchronous MinerU tooltips to finish before test assertions.
- Read release notes through the scaffold callback and verify the final rebuilt
  package immediately before uploading it.
- Collect every native workflow failure and keep layout fixtures independent of
  history refreshes, covering the upstream Task progress button.
- Create and verify the version tag after the quality gate when publishing
  from main, as required by the scaffold release CLI.

Original project by Yile Wang and contributors; this fork retains its license.

- Pass one build command to bumpp; the build itself includes type and release
  verification. Preserve a backup of the unpublished first tag when recovering
  the failed initial publication, without moving any published release tag.
