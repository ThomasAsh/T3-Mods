// @effect-diagnostics nodeBuiltinImport:off - exercises real links on disk.
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { shareAccountConfig } from "./sharedAccountConfig.ts";

const write = async (file: string, text: string, mtimeSeconds?: number) => {
  await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
  await NodeFSP.writeFile(file, text);
  if (mtimeSeconds !== undefined) await NodeFSP.utimes(file, mtimeSeconds, mtimeSeconds);
};

const read = (file: string) => NodeFSP.readFile(file, "utf8").catch(() => null);

const isLink = async (file: string) => (await NodeFSP.lstat(file)).isSymbolicLink();

/** Two config dirs as the HDG server has them: the default account and a second one. */
const makeAccounts = async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "shared-config-"));
  const shared = NodePath.join(root, ".claude");
  const other = NodePath.join(root, ".claude_b");
  await write(NodePath.join(shared, "projects/live-tv/memory/rules.md"), "older", 1_000);
  await write(
    NodePath.join(shared, "projects/live-tv/memory/MEMORY.md"),
    "- [Rules](rules.md) — old\n",
  );
  await write(NodePath.join(other, "projects/live-tv/memory/rules.md"), "newer", 2_000);
  await write(NodePath.join(other, "projects/live-tv/memory/tv-app.md"), "always ship the TV app");
  await write(
    NodePath.join(other, "projects/live-tv/memory/MEMORY.md"),
    "- [Rules](rules.md) — new\n- [TV app](tv-app.md) — ship it\n",
  );
  await write(
    NodePath.join(shared, "projects/mods/memory/MEMORY.md"),
    "- [PRs](prs.md) — via PRs\n",
  );
  await write(NodePath.join(shared, "settings.json"), '{"hooks":{}}');
  await write(NodePath.join(shared, "skills/review/SKILL.md"), "review");
  await write(NodePath.join(shared, "skills/synced/mine/SKILL.md"), "shared account's sync");
  await write(NodePath.join(other, "skills/synced/theirs/SKILL.md"), "other account's sync");
  await write(NodePath.join(other, ".claude.json"), "{}");
  return { root, shared, other };
};

/** Runs `body` against fresh accounts on this host's platform, then removes them. */
const withAccounts = (
  body: (
    input: Awaited<ReturnType<typeof makeAccounts>> & { readonly platform: NodeJS.Platform },
  ) => Promise<void>,
) =>
  Effect.gen(function* () {
    const platform = yield* HostProcess.Platform;
    yield* Effect.promise(async () => {
      const accounts = await makeAccounts();
      try {
        await body({ ...accounts, platform });
      } finally {
        await NodeFSP.rm(accounts.root, { recursive: true, force: true });
      }
    });
  });

describe("shareAccountConfig", () => {
  it.effect("links the other account to one shared memory, skill and settings copy", () =>
    withAccounts(async ({ shared, other, platform }) => {
      const changes = await shareAccountConfig({
        configDirs: [other, shared],
        platform,
        stamp: "stamp",
      });
      assert.isAbove(changes.length, 0);

      const memory = NodePath.join(shared, "projects/live-tv/memory");
      assert.strictEqual(await read(NodePath.join(memory, "rules.md")), "newer");
      assert.strictEqual(await read(NodePath.join(memory, "tv-app.md")), "always ship the TV app");
      assert.strictEqual(
        await read(NodePath.join(memory, "MEMORY.md")),
        "- [Rules](rules.md) — new\n- [TV app](tv-app.md) — ship it\n",
      );
      const kept = NodePath.join(other, "projects/live-tv/memory.unshared-stamp");
      assert.strictEqual(await read(NodePath.join(kept, "rules.md.shared-older")), "older");

      // Both accounts now read and write the same memory.
      assert.isTrue(await isLink(NodePath.join(other, "projects/live-tv/memory")));
      await NodeFSP.writeFile(NodePath.join(other, "projects/live-tv/memory/new.md"), "from other");
      assert.strictEqual(await read(NodePath.join(memory, "new.md")), "from other");
      assert.strictEqual(
        await read(NodePath.join(other, "projects/mods/memory/MEMORY.md")),
        "- [PRs](prs.md) — via PRs\n",
      );

      assert.strictEqual(await read(NodePath.join(other, "settings.json")), '{"hooks":{}}');
      assert.strictEqual(await read(NodePath.join(other, "skills/review/SKILL.md")), "review");
      // Account-bound state stays apart.
      assert.isNull(await read(NodePath.join(other, "skills/synced/mine/SKILL.md")));
      assert.isNull(await read(NodePath.join(shared, "skills/synced/theirs/SKILL.md")));
      assert.isNull(await read(NodePath.join(shared, ".claude.json")));

      const again = await shareAccountConfig({
        configDirs: [shared, other],
        platform,
        stamp: "later",
      });
      assert.deepStrictEqual(again, []);
    }),
  );

  it.effect("leaves a file that differs between accounts alone and reports it once", () =>
    withAccounts(async ({ shared, other, platform }) => {
      const settings = NodePath.join(other, "settings.json");
      await write(settings, '{"theme":"dark"}');
      const reported = new Set<string>();
      const first = await shareAccountConfig({
        configDirs: [shared, other],
        platform,
        stamp: "stamp",
        reported,
      });
      assert.isTrue(first.some((line) => line.startsWith(`left ${settings}`)));
      assert.strictEqual(await read(settings), '{"theme":"dark"}');
      const second = await shareAccountConfig({
        configDirs: [shared, other],
        platform,
        stamp: "later",
        reported,
      });
      assert.deepStrictEqual(second, []);
    }),
  );

  it.effect("does nothing for relative config dirs", () =>
    withAccounts(async ({ platform }) => {
      assert.deepStrictEqual(
        await shareAccountConfig({
          configDirs: ["claudeAgent", "claudeAgent_eap"],
          platform,
          stamp: "stamp",
        }),
        [],
      );
    }),
  );
});
