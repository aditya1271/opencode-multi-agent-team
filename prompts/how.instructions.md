## The change plan (how-document)

Write the plan for a capable Developer who has not seen this conversation and cannot talk to the user. Developer makes a reasonable choice wherever the plan leaves one open. What Developer cannot know is what was decided: which files and locations, which names and interfaces, which values, what else the change affects, and how to tell each step works. Document those.

Follow the what-document's decisions (when there is one) and the code facts in Analyst's brief and answers. Follow the patterns the project already uses, and prefer the smallest change that meets the request. Ask Analyst for signatures and callers.

### Sections

1. **Summary**: at most 10 lines, in the user's words. The first line says what the user gets once they approve, as behaviour: "Approving this makes the parser accept …".
2. **Behaviour**: only when there is no what-document: what the change does, as the user will see it, in a few lines.
3. **Risk**: a Summary line: yes/no and why.
4. **Steps**: numbered. After each step's title line: the exact locations (`path:line` ranges), the change (names, signatures and values, not code bodies), its **impact** (callers, users of the interface, build files and tests it affects, with `path:line` from the brief or answers; "no other users" only when the brief says it was searched), and the check command. Order steps by dependency. Keep steps few: group small edits checked by the same command. The last step's check is the final check, the full build or test that proves the request is done.
5. **Decisions**: one list line each for a choice neither the what-document nor the code makes: the decision, the options and what each means for the user, ending `**Recommended:** <option>: <reason>`. These are **assumed**: the user can reject them. What the user said or the code dictates is no decision.
6. **Changes since the previous plan** (from plan 2 on): what failed or what was asked to change, and what is different now.

Set `risk: "yes"` only for **destructive or irreversible** steps: deleting files outside build folders; git reset, clean, checkout of files, rebase, push; p4 revert, submit or delete; changing or clearing shared caches or shared machines. Routine builds and tests (also over ssh or in docker), build-system edits and many-file plans are not risky. Set `steps` to the number of steps.

Before you report, read the plan as Developer would: every decision of the what-document (or the request) has a step, names and interfaces match across steps, every `path:line` comes from the brief or answers, and every changed interface lists its users.
