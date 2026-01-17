import { glob } from "glob";
import fs from "node:fs/promises";
import YAML from "yaml";

const files = await glob("rules/**/*.y{a,}ml", { nodir: true });

if (files.length === 0) {
  console.log("No rules YAML files found under rules/**");
  process.exit(0);
}

let failed = false;

for (const file of files) {
  const raw = await fs.readFile(file, "utf8");
  try {
    YAML.parse(raw);
    console.log(`OK  ${file}`);
  } catch (err) {
    failed = true;
    console.error(`FAIL ${file}`);
    console.error(String(err));
  }
}

process.exit(failed ? 1 : 0);
