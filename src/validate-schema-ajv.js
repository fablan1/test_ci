import { glob } from "glob";
import fs from "node:fs/promises";
import YAML from "yaml";
import Ajv2020 from "ajv/dist/2020.js";
import Ajv from "ajv";
import addFormats from "ajv-formats";

const schemaRaw = await fs.readFile("schema/ruleset.schema.json", "utf8");
const schema = JSON.parse(schemaRaw);

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

const validate = ajv.compile(schema);

const files = await glob("rules/**/ruleset.y{a,}ml", { nodir: true });

if (files.length === 0) {
  console.log("No ruleset.yml files found under rules/**");
  process.exit(0);
}

let failed = false;

for (const file of files) {
  const raw = await fs.readFile(file, "utf8");
  const data = YAML.parse(raw);

  const ok = validate(data);
  if (!ok) {
    failed = true;
    console.error(`FAIL schema ${file}`);
    for (const e of validate.errors ?? []) {
      const path = e.instancePath || "(root)";
      console.error(` - ${path}: ${e.message}`);
    }
  } else {
    console.log(`OK   schema ${file}`);
  }
}

process.exit(failed ? 1 : 0);
