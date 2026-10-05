#!/usr/bin/env node
// Resolves upstream (pingdotgg/t3code) stable release tags for the mods pipeline.
//
//   node mods/scripts/upstream.mjs base     newest stable tag that HEAD is built on
//   node mods/scripts/upstream.mjs latest   newest stable tag upstream has published
//   node mods/scripts/upstream.mjs sha <tag> commit a tag points at
//
// Stable tags are plain vX.Y.Z; nightly and preview tags carry a suffix and are
// ignored. Works in treeless clones: only commit ancestry is consulted.
import { execFileSync } from "node:child_process";

const UPSTREAM_URL = process.env.T3MODS_UPSTREAM_URL ?? "https://github.com/pingdotgg/t3code.git";

const git = (args, options = {}) =>
  execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
    ...options,
  }).trim();

const compareVersions = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

export function listStableTags() {
  const tags = new Map();
  for (const line of git(["ls-remote", "--tags", UPSTREAM_URL, "v*"]).split("\n")) {
    const [sha, ref] = line.split("\t");
    const match = /^refs\/tags\/(v(\d+)\.(\d+)\.(\d+))(\^\{\})?$/.exec(ref ?? "");
    if (!match) continue;
    const [, tag, major, minor, patch, peeled] = match;
    // Annotated tags list twice; the peeled (^{}) entry is the commit.
    if (peeled || !tags.has(tag)) {
      tags.set(tag, { tag, sha, version: [Number(major), Number(minor), Number(patch)] });
    }
  }
  return [...tags.values()].sort((a, b) => compareVersions(b.version, a.version));
}

function isAncestorOfHead(sha) {
  try {
    git(["cat-file", "-e", `${sha}^{commit}`]);
    git(["merge-base", "--is-ancestor", sha, "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

function main() {
  const [command, arg] = process.argv.slice(2);
  const tags = listStableTags();
  if (command === "latest") {
    console.log(tags[0]?.tag ?? "");
    return;
  }
  if (command === "sha") {
    const entry = tags.find((candidate) => candidate.tag === arg);
    if (!entry) throw new Error(`Unknown upstream stable tag: ${arg}`);
    console.log(entry.sha);
    return;
  }
  if (command === "base") {
    const base = tags.find((candidate) => isAncestorOfHead(candidate.sha));
    if (!base) throw new Error("HEAD is not based on any upstream stable tag");
    console.log(base.tag);
    return;
  }
  throw new Error(`Usage: upstream.mjs base|latest|sha <tag>`);
}

main();
