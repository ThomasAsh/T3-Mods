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
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const upstreamScript = fileURLToPath(new URL("./upstream.mjs", import.meta.url));
const UPSTREAM_URL = process.env.T3MODS_UPSTREAM_URL ?? "https://github.com/pingdotgg/t3code.git";
const shell = process.platform === "win32";

const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const node = (...args) => execFileSync("node", args, { cwd: root, encoding: "utf8" }).trim();

// The stack's base is the parent of its oldest commit that upstream cannot reach. On the
// canary that is an upstream main commit newer than any release tag; diffing against the
// tag instead would verify upstream's own changes as if the stack made them.
const baseTag = node(upstreamScript, "base");
const tagSha = node(upstreamScript, "sha", baseTag);
const upstreamMain = "refs/remotes/upstream/main";
try {
  git(
    "fetch",
    "--quiet",
    "--filter=blob:none",
    "--no-tags",
    UPSTREAM_URL,
    `+refs/heads/main:${upstreamMain}`,
  );
} catch {
  console.warn("Could not fetch upstream main; using the local copy if there is one.");
}
const hasUpstreamMain =
  spawnSync("git", ["rev-parse", "--verify", "--quiet", upstreamMain], { cwd: root }).status === 0;
const stack = git(
  "rev-list",
  "--reverse",
  "--topo-order",
  "HEAD",
  "--not",
  tagSha,
  ...(hasUpstreamMain ? [upstreamMain] : []),
)
  .split("\n")
  .filter(Boolean);
const baseSha = stack.length > 0 ? git("rev-parse", `${stack[0]}^`) : git("rev-parse", "HEAD");
const baseLabel = baseSha === tagSha ? baseTag : "upstream main";
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
    if (sibling.startsWith(`${stem}.`) && isRunnableTest(sibling))
      testFiles.add(`${dir}/${sibling}`);
  }
}
for (const packageDir of [
  "apps/web",
  "apps/server",
  "apps/desktop",
  "packages/contracts",
  "packages/shared",
  "packages/client-runtime",
]) {
  for (const path of walk(join(root, packageDir, "src", "mods"))) {
    const file = path.slice(root.length).replace(/\/g, "/").replace(/^\//, "");
    if (isRunnableTest(file)) testFiles.add(file);
  }
}

const results = [];
function exec(command, args) {
  const run = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    shell,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { ok: run.status === 0, output: `${run.stdout ?? ""}${run.stderr ?? ""}` };
}
function step(name, command, args) {
  console.log(`\n▶ ${name}\n  ${command} ${args.join(" ")}`);
  const { ok, output } = exec(command, args);
  process.stdout.write(output);
  results.push({ name, command, args, ok, output });
}

for (const dir of packageDirs) {
  const name = JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8")).name;
  step(`typecheck ${name}`, "vp", ["run", "--filter", name, "typecheck"]);
}
if (testFiles.size > 0) step("tests", "vp", ["test", "run", ...testFiles]);
if (sourceFiles.length > 0) step("lint", "vp", ["lint", ...sourceFiles]);

// Upstream main is sometimes red on its own. A failed typecheck is re-run on the base
// commit; when every error it reports is already there, upstream owns it, not the stack.
// Needs a clean tree, since it checks out the base in place.
const typeErrors = (output) =>
  new Set(
    output
      .split("\n")
      .filter((line) => /\berror TS\d+:/.test(line))
      .map((line) => line.trim()),
  );
const failedTypechecks = results.filter(
  (result) => !result.ok && result.name.startsWith("typecheck "),
);
if (failedTypechecks.length > 0) {
  if (git("status", "--porcelain") !== "") {
    console.warn(
      "\nWorking tree is not clean; skipping the upstream baseline for failed typechecks.",
    );
  } else {
    const branch = spawnSync("git", ["symbolic-ref", "--short", "-q", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    });
    const restore = branch.status === 0 ? branch.stdout.trim() : git("rev-parse", "HEAD");
    console.log(`\n▶ upstream baseline at ${baseSha.slice(0, 10)}`);
    git("checkout", "--quiet", "--detach", baseSha);
    try {
      for (const result of failedTypechecks) {
        const errors = typeErrors(result.output);
        const atBase = typeErrors(exec(result.command, result.args).output);
        if (errors.size > 0 && [...errors].every((line) => atBase.has(line))) {
          result.ok = true;
          result.upstream = [...errors];
          console.log(`  ${result.name}: all ${errors.size} errors also fail upstream`);
        }
      }
    } finally {
      git("checkout", "--quiet", restore);
    }
  }
}

const failed = results.filter((result) => !result.ok);
const upstreamOnly = results.filter((result) => result.upstream);
const tail = (text) => text.split("\n").slice(-200).join("\n");
writeFileSync(
  join(root, "mods", "verify-report.md"),
  [
    `# Mods verify: ${failed.length === 0 ? "PASS" : "FAIL"}`,
    "",
    `Upstream base: ${baseLabel} (${baseSha.slice(0, 10)})`,
    "",
    "Touched upstream files:",
    ...changed.map((file) => `- ${file}`),
    "",
    ...results.map(
      (result) => `- ${result.upstream ? "⚠️" : result.ok ? "✅" : "❌"} ${result.name}`,
    ),
    "",
    ...upstreamOnly.flatMap((result) => [
      `## ${result.name}: upstream errors (also at the base, not caused by the stack)`,
      "",
      "```",
      ...result.upstream,
      "```",
      "",
    ]),
    ...failed.flatMap((result) => [`## ${result.name}`, "", "```", tail(result.output), "```", ""]),
  ].join("\n"),
);

console.log(
  `\n${results.map((r) => `${r.upstream ? "UPSTREAM" : r.ok ? "PASS" : "FAIL"}  ${r.name}`).join("\n")}`,
);
process.exit(failed.length === 0 ? 0 : 1);
