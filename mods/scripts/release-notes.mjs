#!/usr/bin/env node
// Release notes: the upstream base plus the mod commits stacked on it.
//   node mods/scripts/release-notes.mjs <upstreamTag> <commit>
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const [upstreamTag, commit] = process.argv.slice(2);
const upstreamScript = fileURLToPath(new URL("./upstream.mjs", import.meta.url));
const upstreamSha = execFileSync("node", [upstreamScript, "sha", upstreamTag], {
  encoding: "utf8",
}).trim();
const stack = execFileSync(
  "git",
  ["log", "--reverse", "--format=- %s (%h)", `${upstreamSha}..${commit}`],
  { encoding: "utf8" },
).trim();

console.log(`Upstream: [${upstreamTag}](https://github.com/pingdotgg/t3code/releases/tag/${upstreamTag})

Mod stack:
${stack || "- (none)"}

Installed automatically by the T3 Mods Updater. Manual install: run the .exe.`);
