import { readFile, writeFile } from "node:fs/promises";
import YAML from "yaml";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import standalone from "ajv/dist/standalone/index.js";
const api = YAML.parse(
  await readFile(new URL("../protocol/openapi.yaml", import.meta.url), "utf8"),
);
const ajv = new Ajv({
  strict: false,
  code: { source: true, esm: true },
  allErrors: false,
});
addFormats(ajv);
ajv.addSchema({
  $id: "https://griefseed.invalid/protocol.json",
  components: api.components,
});
const exports = {};
for (const name of Object.keys(api.components.schemas)) {
  const id = `https://griefseed.invalid/protocol.json#/components/schemas/${name}`;
  ajv.compile({ $id: `https://griefseed.invalid/schemas/${name}`, $ref: id });
  exports[name] = `https://griefseed.invalid/schemas/${name}`;
}
const rtc = JSON.parse(
  await readFile(
    new URL("../protocol/rtc-v1/command.schema.json", import.meta.url),
    "utf8",
  ),
);
ajv.addSchema(rtc);
exports.RTCSignalCommand = rtc.$id;
await writeFile(
  new URL("../src/generated/validators.js", import.meta.url),
  standalone(ajv, exports),
);
await writeFile(
  new URL("../src/generated/validators.d.ts", import.meta.url),
  Object.keys(exports)
    .map((n) => `export function ${n}(value:unknown):boolean;`)
    .join("\n") + "\n",
);
