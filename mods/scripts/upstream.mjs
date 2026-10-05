#!/usr/bin/env node
// Resolves upstream (pingdotgg/t3code) release tags for the mods pipeline.
//
//   node mods/scripts/upstream.mjs channel  release channel the stack follows now
//   node mods/scripts/upstream.mjs base     newest release tag (any channel) HEAD is built on
//   node mods/scripts/upstream.mjs latest   newest upstream tag on the followed channel
//   node mods/scripts/upstream.mjs sha <tag> commit a tag points at
//   node mods/scripts/upstream.mjs list     stable tags as JSON [{ tag, sha }]
//
// Stable tags are plain vX.Y.Z; nightly tags are vX.Y.Z-nightly.YYYYMMDD.N. Preview tags
// are ignored. The channel comes from mods.json `upstream`: { channel, stableFrom }. A
// "nightly" stack follows nightlies until a stable tag at or above `stableFrom` exists,
// then follows stable releases. Works in treeless clones: only commit ancestry is used.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const UPSTREAM_URL = process.env.T3MODS_UPSTREAM_URL ?? "https://github.com/pingdotgg/t3code.git";
const TAG_PATTERN = /^refs\/tags\/(v(\d+)\.(\d+)\.(\d+)(?:-nightly\.(\d{8})\.(\d+))?)(\^\{\})?$/;

const git = (args, options = {}) =>
  execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
    ...options,
  }).trim();

// [major, minor, patch, stable(1) above its own nightlies(0), nightly date, nightly build]
const compareKeys = (a, b) => {
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
};

/** Every stable and nightly tag, newest first. */
function listTags() {
  const tags = new Map();
  for (const line of git(["ls-remote", "--tags", UPSTREAM_URL, "v*"]).split("\n")) {
    const [sha, ref] = line.split("\t");
    const match = TAG_PATTERN.exec(ref ?? "");
    if (!match) continue;
    const [, tag, major, minor, patch, date, build, peeled] = match;
    const stable = date === undefined;
    // Annotated tags list twice; the peeled (^{}) entry is the commit.
    if (peeled || !tags.has(tag)) {
      tags.set(tag, {
        tag,
        sha,
        channel: stable ? "stable" : "nightly",
        key: [Number(major), Number(minor), Number(patch), stable ? 1 : 0, Number(date ?? 0), Number(build ?? 0)],
      });
    }
  }
  return [...tags.values()].sort((a, b) => compareKeys(b.key, a.key));
}

function readUpstreamConfig() {
  const mods = JSON.parse(readFileSync(new URL("../mods.json", import.meta.url), "utf8"));
  return { channel: "stable", stableFrom: null, ...mods.upstream };
}

/** The channel to follow now: nightly only until a stable release reaches `stableFrom`. */
function resolveChannel(tags, config = readUpstreamConfig()) {
  if (config.channel !== "nightly") return "stable";
  if (!config.stableFrom) return "nightly";
  const [major, minor, patch] = config.stableFrom.split(".").map(Number);
  const floor = [major, minor, patch, 1, 0, 0];
  const caughtUp = tags.some((entry) => entry.channel === "stable" && compareKeys(entry.key, floor) >= 0);
  return caughtUp ? "stable" : "nightly";
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
  const tags = listTags();
  const channel = resolveChannel(tags);
  if (command === "channel") {
    console.log(channel);
    return;
  }
  if (command === "list") {
    const stable = tags.filter((entry) => entry.channel === "stable");
    console.log(JSON.stringify(stable.map(({ tag, sha }) => ({ tag, sha }))));
    return;
  }
  if (command === "latest") {
    console.log(tags.find((entry) => entry.channel === channel)?.tag ?? "");
    return;
  }
  if (command === "sha") {
    const entry = tags.find((candidate) => candidate.tag === arg);
    if (!entry) throw new Error(`Unknown upstream tag: ${arg}`);
    console.log(entry.sha);
    return;
  }
  if (command === "base") {
    const base = tags.find((candidate) => isAncestorOfHead(candidate.sha));
    if (!base) throw new Error("HEAD is not based on any upstream release tag");
    console.log(base.tag);
    return;
  }
  throw new Error(`Usage: upstream.mjs channel|base|latest|list|sha <tag>`);
}

main();
