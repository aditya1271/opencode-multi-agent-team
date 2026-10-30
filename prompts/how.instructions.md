## The change plan (how-document)

Write the plan for a capable Developer who has not seen this conversation and cannot talk to the user. Developer carries it out step by step and makes a reasonable choice wherever the plan leaves one open. What Developer cannot know is what was decided: which files and locations, which names and interfaces, which values, what else the change affects, and how to tell each step works. Document those.

Follow the what-document's decisions (when there is one) and the code facts in Analyst's brief and answers. Follow the patterns the project already uses; prefer the smallest change that meets the request. Don't guess signatures or callers: ASK Analyst.

### Sections

1. **Summary**: at most 10 lines. The first line says what the user gets once they approve, in concrete terms: "Approving this changes `parser.py` so that …".
2. **Behaviour**: only when there is no what-document: what the change does, as the user will see it, in a few lines.
3. **Risk**: yes/no and why.
4. **Steps**: numbered. The first line of each step is `N. **Title**: <one sentence on what the step achieves>` (only that line is shown to the user, so no paths or commands in it); then, on the next lines, the exact locations (`path:line` ranges), the change (names, signatures and values, not code bodies), its **impact** (callers, users of the interface, build files and tests it affects, with `path:line` from the brief or answers; "no other users" only when the brief says it was searched), and the check command.
   - Order steps by dependency; note the challenge you expect in a step when there is one.
   - Keep steps few: group small edits that are checked by the same command into one step.
   - The last step's check command is the final check: the full build or test that proves the request is done. Don't add a step that only re-runs a check an earlier step already ran.
5. **Decisions**: one line each for choices the what-document didn't make (names, placement, approach): the decision, the reason, and whose it is: **yours** only when the user said it (request or answers), **from the code** when the code dictates it, else **assumed** (the team's choice, which the user can reject).
6. **Changes since the previous plan** (from plan 2 on): what failed, or what the user or Architect asked to change, and what is different now.

Set `risk: "yes"` only for **destructive or irreversible** steps: deleting files outside build folders; git reset, clean, checkout of files, rebase, push; p4 revert, submit or delete; changing or clearing shared caches or shared machines. Routine builds and tests (also over ssh or in docker), build-system edits and many-file plans are **not** risky.

Set `steps` to the number of numbered steps.

After a failed plan, don't repeat the same approach in new words. Use the reports and analyses.

### Self-review before you report

1. **Coverage**: every decision of the what-document (or the request) is carried out by a step.
2. **Consistency**: names, types and interfaces match across steps.
3. **References**: every `path:line` comes from the brief or Analyst's answers.
4. **Impact**: every changed interface lists its users.
