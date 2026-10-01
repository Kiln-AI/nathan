// Fails when a feature imports another feature or gateway internals. Run via `npm run check:imports`.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { featureBoundaryViolations, type SourceFile } from "./lib/feature_boundaries";

const root = join(import.meta.dirname, "..");
const featuresDir = join(root, "src", "features");

const files: SourceFile[] = readdirSync(featuresDir, { recursive: true, encoding: "utf8" })
  .filter((name) => /\.(?:[cm]?[jt]s|tsx)$/.test(name))
  .map((name) => {
    const absolute = join(featuresDir, name);
    return { path: relative(root, absolute).split(sep).join("/"), source: readFileSync(absolute, "utf8") };
  });

const violations = featureBoundaryViolations(files);
for (const { file, specifier, resolved } of violations) {
  console.error(
    `${file}: imports "${specifier}" (${resolved}), outside its feature, src/core/ and the gateway entries`,
  );
}
if (violations.length > 0) process.exitCode = 1;
else console.log(`✓ feature import boundaries (${files.length} files)`);
