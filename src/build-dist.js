import { glob } from "glob";
import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";

await fs.mkdir("dist", { recursive: true });

const files = await glob("rules/**/ruleset.y{a,}ml", { nodir: true });

for (const file of files) {
  const raw = await fs.readFile(file, "utf8");
  const ruleset = YAML.parse(raw);

  const outName = `${ruleset.id}.json`;
  const outPath = path.join("dist", outName);

  const payload = {
    ...ruleset,
    createdAt: new Date().toISOString(),
  };

  await fs.writeFile(outPath, JSON.stringify(payload, null, 2), "utf8");
  console.log(`Wrote ${outPath}`);
}
