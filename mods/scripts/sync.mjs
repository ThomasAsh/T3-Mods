#!/usr/bin/env node
// Replays the mod stack onto a new upstream commit.
//
//   node mods/scripts/sync.mjs --target <release tag | "main"> [--prefer next]
//
// The stack is every commit on a branch that upstream cannot reach; its base is the
// parent of the oldest one. Sources are tried in order: `next` (the canary, which may
// already carry ports for the target) when its base is inside the target, then `main`.
// The result is checked out as branch `sync-work`.
//
// Exit codes: 0 rebased cleanly, 2 conflicts left for the repair step (rebase in
// progress), 1 error. Writes key=value lines to $GITHUB_OUTPUT when set.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const UPSTREAM_URL = process.env.T3MODS_UPSTREAM_URL ?? "https://github.com/pingdotgg/t3code.git";
const upstreamScript = fileURLToPath(new URL("./upstream.mjs", import.meta.url));

const run = (command, args, options = {}) =>
  execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options }).trim();
const git = (...args) => run("git", args);
const tryGit = (...args) => {
  try {
    return git(...args);
  } catch {
    return null;
  }
};
const output = (key, value) => {
  console.log(`${key}=${value}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
};

function parseArgs() {
  const args = process.argv.slice(2);
  const value = (name) => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
  };
  const target = value("--target");
  if (!target) throw new Error("Usage: sync.mjs --target <tag|main> [--prefer next]");
  return { target, prefer: value("--prefer") ?? "next" };
}

/**
 * Fetches upstream main, the stable tags and the target tag (a nightly target is not in
 * the stable list) into their own namespaces, so they never clash with mods-* tags.
 */
function fetchUpstream(target) {
  const stable = JSON.parse(
    run("node", [upstreamScript, "list"], { stdio: ["ignore", "pipe", "inherit"] }),
  );
  const tags = new Set(stable.map((entry) => entry.tag));
  if (target !== "main") tags.add(target);
  const refspecs = [
    "+refs/heads/main:refs/remotes/upstream/main",
    ...[...tags].map((tag) => `+refs/tags/${tag}:refs/upstream-tags/${tag}`),
  ];
  // The clone is partial: blobs are fetched when a rebase first needs them, from the
  // promisor remotes. origin (the fork) lacks upstream's newer objects, so upstream must
  // be one too, or a replayed commit fails to read them (7 Oct 2026: that dropped the
  // account router from main).
  if (tryGit("remote", "get-url", "upstream") === null) git("remote", "add", "upstream", UPSTREAM_URL);
  else git("remote", "set-url", "upstream", UPSTREAM_URL);
  git("config", "remote.upstream.promisor", "true");
  git("config", "remote.upstream.partialclonefilter", "blob:none");
  git("fetch", "--quiet", "--filter=blob:none", "--no-tags", "upstream", ...refspecs);
}

/** Files a commit touches. */
const filesOf = (commit) =>
  git("diff-tree", "--no-commit-id", "--name-only", "-r", "--root", commit).split("\n").filter(Boolean);
/** Upstream workflow files: the only changes the sync may drop on its own. */
const onlyUpstreamWorkflows = (files) =>
  files.length > 0 && files.every((file) => file.startsWith(".github/workflows/") && !file.includes("/mods-"));

function stackOf(branch) {
  const commits = git(
    "rev-list",
    "--reverse",
    "--topo-order",
    branch,
    "--not",
    "refs/remotes/upstream/main",
    "--glob=refs/upstream-tags/*",
  )
    .split("\n")
    .filter(Boolean);
  if (commits.length === 0) return null;
  return { branch, commits, base: git("rev-parse", `${commits[0]}^`) };
}

const isAncestor = (ancestor, descendant) =>
  tryGit("merge-base", "--is-ancestor", ancestor, descendant) !== null;

/** Workflow files upstream changes are dropped: the fork runs only mods-* workflows. */
function autoResolveConflicts() {
  const conflicted = git("diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);
  const remaining = [];
  for (const file of conflicted) {
    if (file.startsWith(".github/workflows/") && !file.includes("/mods-")) {
      git("rm", "--quiet", "--force", file);
    } else {
      remaining.push(file);
    }
  }
  return remaining;
}

function rebaseInProgress() {
  const gitDir = git("rev-parse", "--git-dir");
  return existsSync(join(gitDir, "rebase-merge")) || existsSync(join(gitDir, "rebase-apply"));
}

/** Drives a stopped rebase forward; returns the conflicts it cannot resolve itself. */
function continueRebase() {
  for (let step = 0; step < 500; step += 1) {
    if (!rebaseInProgress()) return [];
    const remaining = autoResolveConflicts();
    if (remaining.length > 0) return remaining;
    // A step that resolves to no change was already applied upstream, or only touched
    // upstream workflows the fork drops. Anything else that stops with nothing staged
    // failed (a missing object, say) and must never be skipped silently.
    const nothingStaged = git("status", "--porcelain", "--untracked-files=no") === "";
    if (nothingStaged) {
      const files = filesOf("REBASE_HEAD");
      const applied = files.length === 0 || tryGit("diff", "--quiet", "HEAD", "REBASE_HEAD", "--", ...files) !== null;
      if (!applied && !onlyUpstreamWorkflows(files)) {
        throw new Error(
          `rebase stopped on ${git("log", "-1", "--format=%h %s", "REBASE_HEAD")} with nothing staged; refusing to drop it`,
        );
      }
    }
    try {
      run("git", ["rebase", nothingStaged ? "--skip" : "--continue"], {
        env: { ...process.env, GIT_EDITOR: "true" },
      });
    } catch {
      // Stopped on the next step; the loop inspects it.
    }
  }
  throw new Error("rebase did not converge");
}

function main() {
  const { target, prefer } = parseArgs();
  fetchUpstream(target);
  const targetSha =
    target === "main"
      ? git("rev-parse", "refs/remotes/upstream/main")
      : git("rev-parse", `refs/upstream-tags/${target}^{commit}`);

  // `next` is derived from main: reuse its ports only while main is unchanged since it
  // was built (tag mods-next-source records the main commit it came from).
  const mainSha = git("rev-parse", "refs/remotes/origin/main");
  const nextSource = tryGit("rev-parse", "--verify", "--quiet", "refs/tags/mods-next-source^{commit}");
  const nextUsable =
    nextSource === mainSha &&
    tryGit("rev-parse", "--verify", "--quiet", "refs/remotes/origin/next") !== null;
  const candidates = [...(prefer === "next" && nextUsable ? ["next"] : []), "main"]
    .map((branch) => stackOf(`refs/remotes/origin/${branch}`))
    .filter(Boolean);
  output("main_sha", mainSha);
  const source = candidates.find((stack) => isAncestor(stack.base, targetSha));
  if (!source) throw new Error(`No mod stack has a base inside ${target}`);
  if (source.base === targetSha) {
    output("status", "up-to-date");
    output("source", source.branch.replace("refs/remotes/origin/", ""));
    return 0;
  }

  console.log(
    `Replaying ${source.commits.length} commits from ${source.branch} (base ${source.base.slice(0, 10)}) onto ${target} (${targetSha.slice(0, 10)})`,
  );
  git("checkout", "--quiet", "-B", "sync-work", source.branch);
  output("source", source.branch.replace("refs/remotes/origin/", ""));
  output("target_sha", targetSha);

  let remaining = [];
  try {
    git("rebase", "--quiet", "--onto", targetSha, source.base);
  } catch {
    remaining = continueRebase();
  }

  // Upstream workflows added since the last sync are dropped in the stack's own commit.
  const strays = git("ls-files", ".github/workflows")
    .split("\n")
    .filter((file) => file && !file.includes("/mods-"));
  if (remaining.length === 0 && strays.length > 0) {
    git("rm", "--quiet", ...strays);
    git("commit", "--quiet", "-m", `chore(mods): drop upstream workflows added in ${target}`);
  }

  // Tripwire: every commit of the stack must still be there, except ones that only
  // touched upstream workflows.
  if (remaining.length === 0) {
    const after = new Set(git("log", "--format=%s", `${targetSha}..HEAD`).split("\n"));
    const lost = source.commits.filter(
      (commit) => !after.has(git("log", "-1", "--format=%s", commit)) && !onlyUpstreamWorkflows(filesOf(commit)),
    );
    if (lost.length > 0) {
      throw new Error(`the rebase lost ${lost.map((commit) => git("log", "-1", "--format=%h %s", commit)).join("; ")}`);
    }
  }

  if (remaining.length > 0) {
    output("status", "conflicts");
    output("conflicts", remaining.join(","));
    console.error(`Conflicts need repair:\n${remaining.join("\n")}`);
    return 2;
  }
  output("status", "rebased");
  return 0;
}

try {
  process.exit(main());
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
