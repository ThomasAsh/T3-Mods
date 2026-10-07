#!/usr/bin/env node
// Writes the release manifest the updaters verify before installing.
//   node mods/scripts/manifest.mjs <version> <upstreamTag> <commit> <build> \
//     --installer <win.exe> --appimage <linux.AppImage> --server <t3-linux-x64.tar.gz>
//
// `installer` is the Windows build (the key predates the other platforms, so older
// Windows updaters keep working); `appimage` is the Linux desktop build and `server`
// the headless Linux CLI archive the HD/HDG containers run.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";

const args = process.argv.slice(2);
const [version, upstreamTag, commit, build] = args;
const flag = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const assets = { installer: flag("--installer"), appimage: flag("--appimage"), server: flag("--server") };
if (!version || !upstreamTag || !commit || !build || Object.values(assets).some((path) => !path)) {
  throw new Error(
    "Usage: manifest.mjs <version> <upstreamTag> <commit> <build> --installer <exe> --appimage <AppImage> --server <tar.gz>",
  );
}

const describe = (path) => ({
  name: basename(path),
  size: statSync(path).size,
  sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
});
const mods = JSON.parse(readFileSync(new URL("../mods.json", import.meta.url), "utf8"));

console.log(
  JSON.stringify(
    {
      schema: 2,
      version,
      upstreamTag,
      commit,
      build: Number(build),
      builtAt: new Date().toISOString(),
      installer: describe(assets.installer),
      appimage: describe(assets.appimage),
      server: describe(assets.server),
      mods: mods.mods.filter((mod) => mod.enabled).map(({ id, title }) => ({ id, title })),
    },
    null,
    2,
  ),
);
