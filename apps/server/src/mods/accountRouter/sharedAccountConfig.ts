// @effect-diagnostics nodeBuiltinImport:off - FileSystem has no lstat or Windows junctions, which linking needs.
/**
 * Pooled Claude accounts share one user config (t3-mods: account-router).
 *
 * Each account is its own config dir, so a thread the router moves would lose
 * what the other account knows: project memory, skills, settings and global
 * instructions. The first config dir (sorted) keeps the shared copy and the
 * others link to it. Account-bound state stays apart: credentials,
 * `.claude.json`, sessions, transcripts and skills synced from claude.ai.
 *
 * Nothing is deleted. A memory dir folded into the shared copy is kept beside
 * its link as `memory.unshared-<stamp>`, together with any shared file a newer
 * copy replaced. A file or entry that differs between accounts is left alone.
 * Uses only Node built-ins, so it runs the same on every host.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

const SHARED_FILES = ["CLAUDE.md", "settings.json"];
const SHARED_ENTRY_DIRS = ["skills", "agents", "commands", "output-styles"];
/** Entries Claude keeps per account: skills synced from claude.ai, deleted skills. */
const ACCOUNT_ENTRIES = new Set(["synced", ".trash"]);
const MEMORY_INDEX = "MEMORY.md";

type Kind = "missing" | "link" | "dir" | "file";

const kindOf = async (target: string): Promise<Kind> => {
  try {
    const stat = await NodeFSP.lstat(target);
    if (stat.isSymbolicLink()) return "link";
    return stat.isDirectory() ? "dir" : "file";
  } catch {
    return "missing";
  }
};

const isDir = async (target: string) => {
  try {
    return (await NodeFSP.stat(target)).isDirectory();
  } catch {
    return false;
  }
};

const samePath = (windows: boolean, left: string, right: string) =>
  windows ? left.toLowerCase() === right.toLowerCase() : left === right;

const linksTo = async (windows: boolean, link: string, target: string) => {
  try {
    return samePath(windows, await NodeFSP.realpath(link), await NodeFSP.realpath(target));
  } catch {
    return false;
  }
};

const sameFile = async (left: string, right: string) => {
  try {
    const [a, b] = await Promise.all([NodeFSP.readFile(left), NodeFSP.readFile(right)]);
    return a.equals(b);
  } catch {
    return false;
  }
};

/** Junctions on Windows need no privilege; file links need Developer Mode there. */
const link = async (windows: boolean, target: string, at: string) => {
  await NodeFSP.mkdir(NodePath.dirname(at), { recursive: true });
  const dir = await isDir(target);
  await NodeFSP.symlink(target, at, dir ? (windows ? "junction" : "dir") : "file");
};

const entriesOf = async (dir: string) => {
  try {
    return (await NodeFSP.readdir(dir)).filter(
      (name) => !name.startsWith(".") && !ACCOUNT_ENTRIES.has(name),
    );
  } catch {
    return [];
  }
};

const indexTarget = (line: string) => /\]\(([^)\s]+)\)/.exec(line)?.[1] ?? null;

const readLines = async (file: string) => {
  try {
    return (await NodeFSP.readFile(file, "utf8")).split(/\r?\n/);
  } catch {
    return null;
  }
};

/** Folds `from`'s memory index into `into`'s: new entries are added, replaced files take `from`'s line. */
const mergeIndex = async (from: string, into: string, replaced: ReadonlySet<string>) => {
  const fromLines = await readLines(from);
  if (fromLines === null) return;
  const intoLines = await readLines(into);
  if (intoLines === null) {
    await NodeFSP.copyFile(from, into);
    return;
  }
  const fromByTarget = new Map(
    fromLines.flatMap((line) => {
      const target = indexTarget(line);
      return target === null ? [] : [[target, line] as const];
    }),
  );
  const intoTargets = new Set(intoLines.map(indexTarget));
  const kept = intoLines.map((line) => {
    const target = indexTarget(line);
    return target !== null && replaced.has(target) ? (fromByTarget.get(target) ?? line) : line;
  });
  const added = fromLines.filter((line) => {
    const target = indexTarget(line);
    return target !== null && !intoTargets.has(target);
  });
  if (added.length === 0 && kept.every((line, index) => line === intoLines[index])) return;
  while (kept.length > 0 && kept[kept.length - 1] === "") kept.pop();
  await NodeFSP.writeFile(into, `${[...kept, ...added].join("\n")}\n`);
};

/** Copies `from`'s memory into `into`. On a clash the newer file wins; the older shared copy is kept in `from`. */
const mergeMemory = async (from: string, into: string) => {
  const replaced = new Set<string>();
  for (const entry of await NodeFSP.readdir(from, { withFileTypes: true })) {
    if (entry.name === MEMORY_INDEX) continue;
    const source = NodePath.join(from, entry.name);
    const target = NodePath.join(into, entry.name);
    const targetKind = await kindOf(target);
    if (targetKind === "missing") {
      await NodeFSP.cp(source, target, { recursive: true });
      continue;
    }
    if (!entry.isFile() || targetKind !== "file" || (await sameFile(source, target))) continue;
    const [sourceStat, targetStat] = await Promise.all([NodeFSP.stat(source), NodeFSP.stat(target)]);
    if (sourceStat.mtimeMs <= targetStat.mtimeMs) continue;
    await NodeFSP.copyFile(target, NodePath.join(from, `${entry.name}.shared-older`));
    await NodeFSP.copyFile(source, target);
    replaced.add(entry.name);
  }
  await mergeIndex(NodePath.join(from, MEMORY_INDEX), NodePath.join(into, MEMORY_INDEX), replaced);
};

/**
 * Links `others`' copies of the shared config to `configDirs`' first (sorted)
 * dir and folds in project memory each account kept alone. Returns one line per
 * change. `reported` remembers clashes already returned, so a sweep reports
 * each one once.
 */
export async function shareAccountConfig(input: {
  readonly configDirs: ReadonlyArray<string>;
  readonly platform: NodeJS.Platform;
  readonly stamp: string;
  readonly reported?: Set<string>;
}): Promise<ReadonlyArray<string>> {
  const windows = input.platform === "win32";
  const dirs = [...new Set(input.configDirs)].filter((dir) => NodePath.isAbsolute(dir)).toSorted();
  if (dirs.length < 2) return [];
  for (const dir of dirs) if (!(await isDir(dir))) return [];
  const [shared, ...others] = dirs as [string, ...Array<string>];
  const changes: Array<string> = [];
  const reported = input.reported ?? new Set<string>();
  const report = (line: string) => {
    if (reported.has(line)) return;
    reported.add(line);
    changes.push(line);
  };
  const attempt = async (what: string, action: () => Promise<void>) => {
    try {
      await action();
    } catch (error) {
      report(`failed to ${what}: ${(error as NodeJS.ErrnoException).code ?? String(error)}`);
    }
  };

  /** Links `at` to `shared`'s copy; an account-only copy becomes the shared one first. */
  const shareEntry = async (sharedPath: string, at: string) => {
    const sharedKind = await kindOf(sharedPath);
    const atKind = await kindOf(at);
    if (sharedKind === "missing") {
      if (atKind !== "file" && atKind !== "dir") return;
      await NodeFSP.mkdir(NodePath.dirname(sharedPath), { recursive: true });
      await NodeFSP.rename(at, sharedPath);
      await link(windows, sharedPath, at);
      changes.push(`moved ${at} to ${sharedPath} and linked it`);
      return;
    }
    // A shared entry that is itself a link (e.g. an installed skill) is linked at its real path.
    const target = sharedKind === "link" ? await NodeFSP.realpath(sharedPath) : sharedPath;
    if (atKind === "missing") {
      await link(windows, target, at);
      changes.push(`linked ${at}`);
      return;
    }
    if (atKind === "link") {
      if (!(await linksTo(windows, at, sharedPath))) report(`left ${at}: links elsewhere`);
      return;
    }
    if (atKind === "file" && !(await isDir(target)) && (await sameFile(at, target))) {
      await NodeFSP.rm(at);
      await link(windows, target, at);
      changes.push(`linked ${at} (same as shared)`);
      return;
    }
    report(`left ${at}: differs from ${sharedPath}`);
  };

  for (const other of others) {
    for (const name of SHARED_FILES) {
      await attempt(`share ${NodePath.join(other, name)}`, () =>
        shareEntry(NodePath.join(shared, name), NodePath.join(other, name)),
      );
    }
    for (const parent of SHARED_ENTRY_DIRS) {
      const names = new Set([
        ...(await entriesOf(NodePath.join(shared, parent))),
        ...(await entriesOf(NodePath.join(other, parent))),
      ]);
      for (const name of names) {
        await attempt(`share ${NodePath.join(other, parent, name)}`, () =>
          shareEntry(NodePath.join(shared, parent, name), NodePath.join(other, parent, name)),
        );
      }
    }
  }

  const projects = new Set<string>();
  for (const dir of dirs) {
    for (const name of await entriesOf(NodePath.join(dir, "projects"))) projects.add(name);
  }
  for (const project of projects) {
    const sharedMemory = NodePath.join(shared, "projects", project, "memory");
    await attempt(`share memory of ${project}`, async () => {
      const sharedKind = await kindOf(sharedMemory);
      if (sharedKind === "link" || sharedKind === "file") return;
      const copies = await Promise.all(
        others.map(async (other) => {
          const at = NodePath.join(other, "projects", project, "memory");
          return { at, kind: await kindOf(at) };
        }),
      );
      if (sharedKind === "missing" && !copies.some((copy) => copy.kind === "dir")) return;
      await NodeFSP.mkdir(sharedMemory, { recursive: true });
      for (const copy of copies) {
        if (copy.kind === "link") {
          if (!(await linksTo(windows, copy.at, sharedMemory))) report(`left ${copy.at}: links elsewhere`);
          continue;
        }
        if (copy.kind === "file") continue;
        if (copy.kind === "dir") {
          await mergeMemory(copy.at, sharedMemory);
          const kept = `${copy.at}.unshared-${input.stamp}`;
          await NodeFSP.rename(copy.at, kept);
          try {
            await link(windows, sharedMemory, copy.at);
          } catch (error) {
            await NodeFSP.rename(kept, copy.at);
            throw error;
          }
          changes.push(`merged ${copy.at} into ${sharedMemory} and linked it (kept ${kept})`);
          continue;
        }
        await link(windows, sharedMemory, copy.at);
        changes.push(`linked ${copy.at}`);
      }
    });
  }
  return changes;
}
