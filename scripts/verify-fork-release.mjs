import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { TextDecoder } from "node:util";
import { unzipSync } from "fflate";

const repository = "Qingyun0118/llm-for-zotero";
const root = `https://github.com/${repository}`;
const directory = resolve(process.argv[2] || ".scaffold/build");
const pkg = JSON.parse(await readFile("package.json", "utf8"));
const xpi = await readFile(resolve(directory, "llm-for-zotero.xpi"));
const files = unzipSync(xpi);
const manifest = JSON.parse(new TextDecoder().decode(files["manifest.json"]));
const addonID = "zotero-llm@github.com.yilewang";
assert.equal(pkg.repository.url, `git+${root}.git`);
assert.equal(pkg.config.addonID, addonID);
assert.equal(pkg.config.prefsPrefix, "extensions.zotero.llmforzotero");
assert.equal(manifest.version, pkg.version);
assert.equal(manifest.applications.zotero.id, addonID);
assert.equal(manifest.homepage_url, `${root}#readme`);
assert.equal(
  manifest.applications.zotero.update_url,
  `${root}/releases/download/release/${pkg.version.includes("-") ? "update-beta.json" : "update.json"}`,
);
if (process.env.GITHUB_REF_TYPE === "tag") {
  assert.equal(process.env.GITHUB_REF_NAME, `v${pkg.version}`);
}
for (const name of pkg.version.includes("-")
  ? ["update-beta.json"]
  : ["update.json", "update-beta.json"]) {
  const data = JSON.parse(await readFile(resolve(directory, name), "utf8"));
  const updates = data.addons[addonID].updates;
  assert.ok(updates.length > 0);
  for (const entry of updates) {
    assert.ok(entry.update_link.startsWith(`${root}/releases/download/`));
  }
  const entry = updates.find((update) => update.version === pkg.version);
  assert.ok(entry, `${name} must offer the built version`);
  assert.equal(
    entry.update_link,
    `${root}/releases/download/v${pkg.version}/llm-for-zotero.xpi`,
  );
  assert.equal(
    entry.update_hash,
    `sha512:${createHash("sha512").update(xpi).digest("hex")}`,
  );
  assert.deepEqual(entry.applications.zotero, {
    strict_min_version: manifest.applications.zotero.strict_min_version,
    strict_max_version: manifest.applications.zotero.strict_max_version,
  });
}
console.log(
  `Verified ${repository} v${pkg.version}: XPI, update URLs and SHA-512.`,
);
