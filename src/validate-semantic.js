import { glob } from "glob";
import fs from "node:fs/promises";
import YAML from "yaml";

const RULESET_GLOB = "rules/**/ruleset.y{a,}ml";
const SELECTORS_PATH = "schema/selectors.yml";

// Keep MVP tight: must match what your engine supports
const ALLOWED_OPS = new Set(["count", "term_density", "llm"]);
const ALLOWED_SEVERITIES = new Set(["low", "medium", "high"]);
const ALLOWED_DIMENSIONS = new Set([
  "structure",
  "answerability",
  "neutrality",
  "topical_focus",
  "entity_binding",
]);

const REQUIRED_WEIGHTS = [
  "structure",
  "answerability",
  "neutrality",
  "topical_focus",
  "entity_binding",
];

function isObject(x) {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}

function approxEquals(a, b, eps = 1e-4) {
  return Math.abs(a - b) <= eps;
}

function fail(errors, file, path, message) {
  errors.push({ file, path, message });
}

// --- Load selectors.yml (fail fast if missing/empty) ---
let selectorsDoc = null;
try {
  const selectorsRaw = await fs.readFile(SELECTORS_PATH, "utf8");
  selectorsDoc = YAML.parse(selectorsRaw);
} catch {
  selectorsDoc = null;
}

if (!isObject(selectorsDoc) || !isObject(selectorsDoc.selectors)) {
  console.error(
    `FAIL ${SELECTORS_PATH}: missing/empty/invalid. Expected:\n` +
      `version: v1\nselectors:\n  h1: { kind: heading, level: 1 }\n  p: { kind: paragraph }\n`
  );
  process.exit(1);
}

const allowedSelectors = new Set(Object.keys(selectorsDoc.selectors));

// --- Find rulesets ---
const rulesetFiles = await glob(RULESET_GLOB, { nodir: true });

if (rulesetFiles.length === 0) {
  console.log(`OK semantic: no files matched ${RULESET_GLOB}`);
  process.exit(0);
}

let failedAny = false;

for (const file of rulesetFiles) {
  const errors = [];
  const warnings = [];

  // Parse YAML
  let ruleset = null;
  try {
    const raw = await fs.readFile(file, "utf8");
    ruleset = YAML.parse(raw);
  } catch (e) {
    fail(errors, file, "(root)", `YAML parse error: ${String(e)}`);
  }

  if (ruleset === null) {
    fail(errors, file, "(root)", "Ruleset is empty (YAML parsed to null).");
  } else if (!isObject(ruleset)) {
    fail(errors, file, "(root)", "Ruleset must be an object.");
  }

  // Early print if totally broken
  if (errors.length > 0) {
    failedAny = true;
    for (const e of errors)
      console.error(`FAIL ${e.file} ${e.path}: ${e.message}`);
    continue;
  }

  // --- Top-level checks (semantic, beyond AJV friendliness) ---
  // language: accept "DE" / "de" etc. Warn if not normalized
  if (typeof ruleset.language === "string") {
    const lang = ruleset.language;
    const normalized = lang.trim().toLowerCase();
    if (lang !== normalized && lang !== normalized.toUpperCase()) {
      warnings.push(
        `WARN ${file} language: '${lang}' unusual formatting; consider 'de' or 'en'.`
      );
    }
    if (!/^[a-z]{2}(-[a-z0-9]+)?$/i.test(lang.trim())) {
      warnings.push(
        `WARN ${file} language: '${lang}' doesn't look like a BCP-47 code.`
      );
    }
  } else if (ruleset.language !== undefined) {
    warnings.push(`WARN ${file} language: should be a string (e.g., "de").`);
  }

  // weights: sum ~= 1.0, and all required keys present if weights provided
  if (ruleset.weights !== undefined) {
    if (!isObject(ruleset.weights)) {
      fail(errors, file, "weights", "weights must be an object if provided.");
    } else {
      const w = ruleset.weights;
      const missing = REQUIRED_WEIGHTS.filter((k) => typeof w[k] !== "number");
      if (missing.length > 0) {
        warnings.push(
          `WARN ${file} weights: missing or non-numeric keys: ${missing.join(
            ", "
          )}`
        );
      } else {
        const sum = REQUIRED_WEIGHTS.reduce((acc, k) => acc + Number(w[k]), 0);
        if (!approxEquals(sum, 1.0, 1e-4)) {
          warnings.push(
            `WARN ${file} weights: sum is ${sum.toFixed(
              6
            )}, expected ~1.0 (±1e-4).`
          );
        }
      }
    }
  }

  // checks array
  if (!Array.isArray(ruleset.checks)) {
    fail(errors, file, "checks", "checks must be an array.");
  }

  const checks = Array.isArray(ruleset.checks) ? ruleset.checks : [];
  const seenIds = new Set();

  // --- Per-check checks ---
  for (let i = 0; i < checks.length; i++) {
    const c = checks[i];
    const base = `checks[${i}]`;

    if (!isObject(c)) {
      fail(errors, file, base, "check must be an object.");
      continue;
    }

    // id
    if (typeof c.id !== "string" || c.id.trim().length === 0) {
      fail(
        errors,
        file,
        `${base}.id`,
        "id is required and must be a non-empty string."
      );
    } else {
      if (seenIds.has(c.id)) {
        fail(errors, file, `${base}.id`, `duplicate id '${c.id}'`);
      }
      seenIds.add(c.id);
    }

    // severity/dimension
    if (typeof c.severity !== "string" || !ALLOWED_SEVERITIES.has(c.severity)) {
      fail(
        errors,
        file,
        `${base}.severity`,
        `severity must be one of: ${Array.from(ALLOWED_SEVERITIES).join(", ")}`
      );
    }
    if (
      typeof c.dimension !== "string" ||
      !ALLOWED_DIMENSIONS.has(c.dimension)
    ) {
      fail(
        errors,
        file,
        `${base}.dimension`,
        `dimension must be one of: ${Array.from(ALLOWED_DIMENSIONS).join(", ")}`
      );
    }

    // penalty/message
    if (typeof c.penalty !== "number" || Number.isNaN(c.penalty)) {
      fail(errors, file, `${base}.penalty`, "penalty must be a number.");
    } else if (c.penalty < 0) {
      fail(errors, file, `${base}.penalty`, "penalty must be >= 0.");
    }

    if (typeof c.message !== "string" || c.message.trim().length === 0) {
      fail(
        errors,
        file,
        `${base}.message`,
        "message must be a non-empty string."
      );
    }

    // rule
    if (!isObject(c.rule)) {
      fail(
        errors,
        file,
        `${base}.rule`,
        "rule is required and must be an object."
      );
      continue;
    }

    const op = c.rule.op;
    if (typeof op !== "string" || !ALLOWED_OPS.has(op)) {
      fail(
        errors,
        file,
        `${base}.rule.op`,
        `op must be one of: ${Array.from(ALLOWED_OPS).join(", ")}`
      );
      continue;
    }

    // op=count
    if (op === "count") {
      const selector = c.rule.selector;

      if (typeof selector !== "string" || selector.trim().length === 0) {
        fail(
          errors,
          file,
          `${base}.rule.selector`,
          "selector is required for op=count."
        );
      } else if (!allowedSelectors.has(selector)) {
        fail(
          errors,
          file,
          `${base}.rule.selector`,
          `'${selector}' is not defined in ${SELECTORS_PATH}`
        );
      }

      const min = c.rule.min;
      const max = c.rule.max;

      if (!Number.isInteger(min) || min < 0) {
        fail(errors, file, `${base}.rule.min`, "min must be an integer >= 0.");
      }
      if (!Number.isInteger(max) || max < 0) {
        fail(errors, file, `${base}.rule.max`, "max must be an integer >= 0.");
      }
      if (Number.isInteger(min) && Number.isInteger(max) && min > max) {
        fail(
          errors,
          file,
          `${base}.rule`,
          `min (${min}) must be <= max (${max}).`
        );
      }
    }

    // op=term_density
    if (op === "term_density") {
      const terms = c.rule.terms;
      const maxDensity = c.rule.maxDensity;

      if (
        !Array.isArray(terms) ||
        terms.length === 0 ||
        terms.some((t) => typeof t !== "string" || t.trim().length === 0)
      ) {
        fail(
          errors,
          file,
          `${base}.rule.terms`,
          "terms must be a non-empty array of strings."
        );
      }

      if (
        typeof maxDensity !== "number" ||
        Number.isNaN(maxDensity) ||
        maxDensity < 0 ||
        maxDensity > 1
      ) {
        fail(
          errors,
          file,
          `${base}.rule.maxDensity`,
          "maxDensity must be a number between 0 and 1."
        );
      }
    }

    // op=llm
    if (op === "llm") {
      const ref = c.rule.promptRef;

      if (typeof ref !== "string" || ref.trim().length === 0) {
        fail(
          errors,
          file,
          `${base}.rule.promptRef`,
          "promptRef is required for op=llm."
        );
      } else {
        try {
          await fs.access(ref);
        } catch {
          fail(
            errors,
            file,
            `${base}.rule.promptRef`,
            `file not found '${ref}'`
          );
        }
      }

      if (c.rule.introBlocks !== undefined) {
        const ib = c.rule.introBlocks;
        if (!Number.isInteger(ib) || ib < 1) {
          fail(
            errors,
            file,
            `${base}.rule.introBlocks`,
            "introBlocks must be an integer >= 1."
          );
        }
      }
    }
  }

  // Print warnings
  for (const w of warnings) console.warn(w);

  // Print final status
  if (errors.length > 0) {
    failedAny = true;
    for (const e of errors)
      console.error(`FAIL ${e.file} ${e.path}: ${e.message}`);
  } else {
    console.log(`OK   semantic ${file}`);
  }
}

process.exit(failedAny ? 1 : 0);
