// Validates nathan.config.ts for every environment it defines. Run in CI via `npm run check:config`.
import config from "../nathan.config";
import { loadConfig } from "../src/core/config";
import { features } from "../src/features";

const environments = Object.keys(config.environments);
const failures: string[] = [];
for (const envName of environments) {
  try {
    const loaded = loadConfig(config, envName, features);
    console.log(`✓ ${envName} (features enabled: ${[...loaded.features.keys()].join(", ") || "none"})`);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
}
if (environments.length === 0) failures.push("nathan.config.ts defines no environments");
if (failures.length > 0) {
  console.error(failures.join("\n\n"));
  // Uncaught, so the process exits non-zero (this file is type-checked without Node's `process` types).
  throw new Error("nathan.config.ts is invalid");
}
