# Improve loop

When the user asks you to improve a codebase ("improve <path>", "make the
dependency graph cleaner", "raise the quality score"), follow this bounded
loop. sentrux is your sensor: it scores the *structure* of the repo from
0 to 10000, and its `health` tool names the single worst root cause
(modularity, acyclicity, depth, equality, redundancy).

## Protocol

1. **Target.** Confirm the absolute path is a git repository. If the user
   gave no goal, the goal is: raise the sentrux quality signal. Check first
   that a clean baseline is possible — the repo may have uncommitted work;
   do not loop on a dirty tree without a `git stash` first, and say what
   you did.

2. **Baseline.** Call `sentrux_scan` with the repo path, then
   `sentrux_session_start`, then `sentrux_health`. Note the signal and the
   bottleneck.

3. **Plan.** Target the worst root cause with small, concrete refactors.
   Enumerate the edits before making them. Do not shotgun-edit.

4. **Loop.** Repeat until one of the stop conditions fires:
   - Make a small slice of edits with `bash`, `read_file`, `write_file`
     (you have host access — the tools run on the real VPS from
     `EI_AGENT_ROOT`, default `/`).
   - Run cheap project checks if the project has them (tests, typecheck),
     and fix what they flag.
   - Call `sentrux_rescan` and compare the signal to before the slice.
   - Improved → keep. `git add` the changes and commit with a message that
     cites the metric you moved (e.g. "improve acyclicity (pre-cycle vs
     post-cycle)").
   - Flat or worse → revert that slice (`git checkout -- <paths>`) and try
     a smaller or different change.
   - **Stop when any of**: the target is reached (or `EI_IMPROVE_TARGET`
     if set — read the env with `bash` when you need it), two consecutive
     rounds made no improvement, you hit `EI_IMPROVE_MAX_ROUNDS` (default
     8), or two slices were reverted.

5. **Finish.** If the loop was net positive and the repo has a remote,
   push (never `--force`). Reply with: signal before → after, rounds run,
   commits made, files touched, and the remaining bottlenecks. If it made
   no progress, say so plainly and show what you tried instead of padding
   the reply.

## Rules

- The round cap is a hard bound. Never loop beyond it.
- Every kept change is one commit; never lose work to an uncommitted edit.
- Destructive shell commands, package installs, and service restarts are
  allowed (the host grant), but be deliberate and state what you did.
- Leave secrets and the Ei/VPS configuration out of repo content you touch.
