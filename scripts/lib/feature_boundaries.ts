// Enforces architecture §2: a feature imports only its own folder, src/core/, and the gateways'
// public surface (src/slack/index.ts, src/github/index.ts). Biome's import patterns match the raw
// specifier text, so they can't express this independent of file depth; this resolves each import.
// Package imports (slack-edge, @octokit/*) are restricted in biome.json.

export interface SourceFile {
  /** Repo-relative POSIX path, e.g. "src/features/pr_management/state.ts". */
  path: string;
  source: string;
}

export interface BoundaryViolation {
  file: string;
  specifier: string;
  resolved: string;
}

const FEATURES_DIR = "src/features/";
const GATEWAY_ENTRIES = new Set(["src/slack", "src/github"]);

const IMPORT_PATTERNS = [
  /\b(?:import|export)\b[^'"`;]*?\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
];

export function importSpecifiers(source: string): string[] {
  return IMPORT_PATTERNS.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1] ?? ""));
}

/** Resolves a relative specifier to a module id: no extension, and "dir/index" becomes "dir". */
export function resolveImport(fromFile: string, specifier: string): string {
  const segments = fromFile.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "..") segments.pop();
    else if (part !== "." && part !== "") segments.push(part);
  }
  return segments
    .join("/")
    .replace(/\.(?:[cm]?[jt]s|tsx)$/, "")
    .replace(/\/index$/, "");
}

export function featureBoundaryViolations(files: readonly SourceFile[]): BoundaryViolation[] {
  return files.flatMap((file) => {
    if (!file.path.startsWith(FEATURES_DIR)) return [];
    const isAllowed = allowedTargets(file.path);
    return importSpecifiers(file.source)
      .filter((specifier) => specifier.startsWith("."))
      .map((specifier) => ({ file: file.path, specifier, resolved: resolveImport(file.path, specifier) }))
      .filter(({ resolved }) => !isAllowed(resolved));
  });
}

function allowedTargets(path: string): (target: string) => boolean {
  const isCore = (target: string) => target.startsWith("src/core/");
  const [featureId, ...rest] = path.slice(FEATURES_DIR.length).split("/");
  if (rest.length === 0) {
    // src/features/index.ts: the feature registry may import any feature's entry point.
    return (target) =>
      isCore(target) || (target.startsWith(FEATURES_DIR) && !target.slice(FEATURES_DIR.length).includes("/"));
  }
  const featureRoot = `${FEATURES_DIR}${featureId}`;
  return (target) =>
    isCore(target) || GATEWAY_ENTRIES.has(target) || target === featureRoot || target.startsWith(`${featureRoot}/`);
}
