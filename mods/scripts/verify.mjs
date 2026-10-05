#!/usr/bin/env node
// Verifies the mod stack on top of its upstream base:
//   1. typecheck every workspace package the stack touches,
//   2. run mod tests plus upstream tests that sit next to touched files,
//   3. lint touched source files.
// Writes mods/verify-report.md (read by the repair agent) and exits non-zero on failure.
//
//   node mods/scripts/verify.mjs [--skip-install-check]
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const upstreamScript = fileURLToPath(new URL("./upstream.mjs", import.meta.url));
const shell = process.platform === "win32";

const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const node = (...args) => execFileSync("node", args, { cwd: root, encoding: "utf8" }).trim();

const baseTag = node(upstreamScript, "base");
const baseSha = node(upstreamScript, "sha", baseTag);
const changed = git("diff", "--name-only", "--diff-filter=d", baseSha, "HEAD")
  .split("\n")
  .filter((file) => file && !file.startsWith("mods/") && !file.startsWith(".github/"));

const sourceFiles = changed.filter((file) => /\.(ts|tsx|mts|cts)$/.test(file));
const packageDirs = [
  ...new Set(
    sourceFiles
      .map((file) => /^(apps\/[^/]+|packages\/[^/]+)\//.exec(file)?.[1])
      .filter((dir) => dir && existsSync(join(root, dir, "package.json"))),
  ),
];

const isRunnableTest = (file) =>
  /\.test\.(ts|tsx|mts)$/.test(file) && !/\.browser\.test\./.test(file);

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

const testFiles = new Set();
for (const file of sourceFiles) {
  if (isRunnableTest(file)) {
    testFiles.add(file);
    continue;
  }
  // Upstream tests that cover a touched module: same directory, same stem.
  const stem = basename(file).replace(/\.(tsx?|mts|cts)$/, "");
  const dir = dirname(file);
  if (!existsSync(join(root, dir))) continue;
  for (const sibling of readdirSync(join(root, dir))) {
    if (sibling.startsWith(`${stem}.`) && isRunnableTest(sibling)) testFiles.add(`${dir}/${sibling}`);
  }
}
for (const packageDir of ["apps/web", "apps/server", "apps/desktop", "packages/contracts", "packages/shared", "packages/client-runtime"]) {
  for (const path of walk(join(root, packageDir, "src", "mods"))) {
    const file = relative(root, path).split(sep).join("/");
    if (isRunnableTest(file)) testFiles.add(file);
  }
}

const results = [];
function step(name, command, args) {
  console.log(`\n▶ ${name}\n  ${command} ${args.join(" ")}`);
  const run = spawnSync(command, args, { cwd: root, encoding: "utf8", shell, maxBuffer: 64 * 1024 * 1024 });
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  process.stdout.write(output);
  results.push({ name, ok: run.status === 0, output });
}

for (const dir of packageDirs) {
  const name = JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8")).name;
  step(`typecheck ${name}`, "vp", ["run", "--filter", name, "typecheck"]);
}
if (testFiles.size > 0) step("tests", "vp", ["test", "run", ...testFiles]);
if (sourceFiles.length > 0) step("lint", "vp", ["lint", ...sourceFiles]);

const failed = results.filter((result) => !result.ok);
const tail = (text) => text.split("\n").slice(-200).join("\n");
writeFileSync(
  join(root, "mods", "verify-report.md"),
  [
    `# Mods verify: ${failed.length === 0 ? "PASS" : "FAIL"}`,
    "",
    `Upstream base: ${baseTag} (${baseSha.slice(0, 10)})`,
    "",
    "Touched upstream files:",
    ...changed.map((file) => `- ${file}`),
    "",
    ...results.map((result) => `- ${result.ok ? "✅" : "❌"} ${result.name}`),
    "",
    ...failed.flatMap((result) => [`## ${result.name}`, "", "```", tail(result.output), "```", ""]),
  ].join("\n"),
);

console.log(`\n${results.map((r) => `${r.ok ? "PASS" : "FAIL"}  ${r.name}`).join("\n")}`);
process.exit(failed.length === 0 ? 0 : 1);
