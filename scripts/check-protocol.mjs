import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const manifest = JSON.parse(await readFile("protocol/provenance.json", "utf8"));
for (const [path, expected] of Object.entries(manifest.files)) {
  const actual = createHash("sha256")
    .update(await readFile("protocol/" + path))
    .digest("hex");
  if (actual !== expected) throw Error("Protocol drift: " + path);
}
console.log(
  "Frozen protocol matches " + manifest.repository + "@" + manifest.commit,
);
