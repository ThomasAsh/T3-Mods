#!/usr/bin/env node
// Builds the prompt for the headless Claude Code repair step.
//   node mods/scripts/repair-prompt.mjs conflicts <target> <targetSha>
//   node mods/scripts/repair-prompt.mjs verify <target> <targetSha>
import { execFileSync } from "node:child_process";
import { readdirSync, existsSync } from "node:fs";

const [kind, target, targetSha] = process.argv.slice(2);
if (!["conflicts", "verify"].includes(kind) || !target || !targetSha) {
  throw new Error("Usage: repair-prompt.mjs conflicts|verify <target> <targetSha>");
}

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const intents = readdirSync("mods", { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(`mods/${entry.name}/INTENT.md`))
  .map((entry) => `- mods/${entry.name}/INTENT.md`);

const shared = `You maintain a personal patch stack ("mods") for T3 Code. This repository is upstream
pingdotgg/t3code with the mod commits replayed on top. The stack is being moved onto upstream ${target}
(${targetSha.slice(0, 12)}).

Read before changing anything:
- mods/README.md: how the stack is organised and the rules for hooks
${intents.join("\n")}
- AGENTS.md: upstream conventions, which the mods follow

Principles:
- Upstream's new code wins. Re-apply each mod on top of it; never restore old upstream code to make a mod fit.
- Every mod must still do exactly what its INTENT.md says.
- Keep edits to upstream files as thin hooks tagged with a \`t3-mods:\` comment. Put real logic in mod-owned
  files (apps/*/src/mods/**). If upstream deleted something a mod relies on, follow that INTENT.md's
  "Known upstream changes" section and move what the mod needs into its own files.
- If hook locations change, update the "Where it hooks in" table in that INTENT.md.
- Do not push. Do not run repo-wide checks (\`vp check\`, \`vp run -r ...\`). Do not drop or disable a mod.`;

const prompts = {
  conflicts: `${shared}

Situation: \`git rebase\` stopped with conflicts in:
${git("diff", "--name-only", "--diff-filter=U") || "(see git status)"}

The commit being replayed: run \`git show REBASE_HEAD\`.

Do this:
1. Resolve each conflicted file per the principles above.
2. \`git add\` the resolved files, then run \`GIT_EDITOR=true git rebase --continue\`.
3. If the rebase stops again, repeat. Keep the original commit messages.
4. Stop when \`git status\` shows no rebase in progress.`,

  verify: `${shared}

Situation: the rebase finished, but verification fails. The report is mods/verify-report.md (typecheck, tests and
lint for the packages the stack touches). Dependencies are installed.

Do this:
1. Fix the failures per the principles above.
2. Re-run \`node mods/scripts/verify.mjs\` (a few minutes) until it passes.
3. Fold each fix into the mod commit it belongs to: \`git commit --fixup=<that mod's commit>\` (list the stack
   with \`git log --oneline ${targetSha}..HEAD\`), then \`GIT_SEQUENCE_EDITOR=true git rebase -i --autosquash ${targetSha}\`.
4. Stop when verify passes and the working tree is clean.`,
};

console.log(prompts[kind]);
