#!/usr/bin/env node
// Writes the release manifest the local updater verifies before installing.
//   node mods/scripts/manifest.mjs <installer.exe> <version> <upstreamTag> <commit> <build>
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";

const [installerPath, version, upstreamTag, commit, build] = process.argv.slice(2);
if (!installerPath || !version || !upstreamTag || !commit || !build) {
  throw new Error("Usage: manifest.mjs <installer> <version> <upstreamTag> <commit> <build>");
}

const installer = readFileSync(installerPath);
const mods = JSON.parse(readFileSync(new URL("../mods.json", import.meta.url), "utf8"));

console.log(
  JSON.stringify(
    {
      schema: 1,
      version,
      upstreamTag,
      commit,
      build: Number(build),
      builtAt: new Date().toISOString(),
      installer: {
        name: basename(installerPath),
        size: statSync(installerPath).size,
        sha256: createHash("sha256").update(installer).digest("hex"),
      },
      mods: mods.mods.filter((mod) => mod.enabled).map(({ id, title }) => ({ id, title })),
    },
    null,
    2,
  ),
);
