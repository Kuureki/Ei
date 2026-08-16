# Improve loop

When the user asks you to improve a codebase ("improve <path>", "clean this
up", "make this repo better"), follow this bounded loop. There is no magic
score: the sensors are the project's own checks (tests, typecheck, lint)
plus `code_duplicates` for copy-paste hotspots, plus your own reading of the
code.

## Protocol

1. **Target.** Confirm the absolute path is a git repository. If the user
   gave no goal, the goal is: make the code healthier without breaking
   anything. Check first that a clean baseline is possible — the repo may
   have uncommitted work; do not loop on a dirty tree without a `git stash`
   first, and say what you did.

2. **Baseline.** Get the lay of the land:
   - run the project's own checks if it has them (tests, typecheck, lint)
     and note failures;
   - call `code_duplicates` on the repo for copy-paste hotspots (file:line
     clone pairs, largest first);
   - skim the structure yourself (entry points, biggest files, obvious
     smells). Pick the 2–3 problems that matter most and say what they are.

3. **Plan.** Enumerate the edits before making them. Small, concrete
   refactors with a clear reason — no shotgun edits, no speculative
   rewrites.

4. **Loop.** Repeat until one of the stop conditions fires:
   - Make a small slice of edits with `bash`, `read_file`, `write_file`
     (you have host access — the tools run on the real VPS from
     `EI_AGENT_ROOT`, default `/`).
   - Run the project's checks again; fix what your slice broke.
   - Checks still green and the change does what you said → keep. `git add`
     the changes and commit with a message that names what improved (e.g.
     "dedupe schedule tool input schemas").
   - Broken or no real improvement → revert that slice
     (`git checkout -- <paths>`) and try a smaller or different change.
   - **Stop when any of**: two consecutive rounds made no improvement, you
     hit `EI_IMPROVE_MAX_ROUNDS` (default 8 — read the env with `bash` when
     you need it), or two slices were reverted.

5. **Finish.** If the loop was net positive and the repo has a remote, push
   (never `--force`). Reply with: what was wrong, what changed, rounds run,
   commits made, files touched, and what is still worth doing. If it made no
   progress, say so plainly and show what you tried instead of padding the
   reply.

## Rules

- The round cap is a hard bound. Never loop beyond it.
- Every kept change is one commit; never lose work to an uncommitted edit.
- Destructive shell commands, package installs, and service restarts are
  allowed (the host grant), but be deliberate and state what you did.
- Leave secrets and the Ei/VPS configuration out of repo content you touch.
