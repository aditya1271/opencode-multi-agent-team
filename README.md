# opencode-multi-agent-team

An OpenCode V2 plugin that runs a fixed multi-agent coding workflow. Code decides which agent
runs next and enforces the limits; no model routes work. Cheap models do most of the work.
Strong models write plans and give advice only when the team is stuck.

See [overview.md](overview.md) for the workflow, and [plan.md](plan.md) for the full design.

The agents are named after coding-team roles. Earlier versions used polisher, triage,
senior, explorer, fixer, analyser and oracle; configs and saved tasks with those names still
work.

## Agents

| Agent | Job |
|---|---|
| `build-manager` | Front agent for code changes: the team plans, edits, builds and tests. |
| `plan-manager` | Front agent for plan documents: the team writes a plan for you to review. No code changes. |
| `research-manager` | Front agent for research: the team investigates and writes a findings report. No code changes. |
| `team-lead` | Searches the code, then decides between a trivial fix and a plan. Writes the brief. |
| `team-architect` | Writes plans and documents. You approve each one. Advises Lead when you keep sending its brief back. |
| `team-intern` | Does code searches for the Architect, and answers your code questions. |
| `team-developer` | Edits, builds and tests. The only agent that changes files. |
| `team-reviewer` | Diagnoses failures and reviews finished work. |
| `team-principal` | Reviews destructive plans, reviews a plan or document critically when you ask, and advises when the team is stuck or you keep sending a draft back. |

The three front agents (switch with Tab) rewrite your request, ask you to confirm it, and drive
the team. They can't read, edit or run anything, and they share the `manager` entry of the
config (model, backup). The agent you pick decides the workflow; nothing guesses it.

## Install

The plugin isn't on npm. OpenCode loads it from a local folder, so you clone the repository
first and give OpenCode the folder's path. No `npm install` or build step is needed: OpenCode
runs the TypeScript source directly. Requires OpenCode 2.2 or later.

1. **Clone the repository.** Any folder works; this example uses your home folder:

   ```sh
   git clone https://github.com/aditya1271/opencode-multi-agent-team.git ~/opencode-multi-agent-team
   ```

2. **Get the clone's full path.** You need it in the next step:

   ```sh
   cd ~/opencode-multi-agent-team
   pwd
   ```

   This prints something like `/home/alice/opencode-multi-agent-team`.
   The same path loads both the team (server part) and its sidebar section (TUI part).

3. **Add that path to OpenCode's `plugins` list.** Open the global config,
   `~/.config/opencode/opencode.json` (create it if it doesn't exist), or a project's
   `<project>/.opencode/opencode.jsonc` to use the team in one project only. Use the full
   path from step 2; `~` is not expanded here.

   ```jsonc
   {
     "plugins": ["/home/alice/opencode-multi-agent-team"]
   }
   ```

   If there is already a `plugins` list, add the path to it and keep the existing entries:
   `"plugins": ["some-other-plugin", "/home/alice/opencode-multi-agent-team"]`.

4. **Create the team's config and set the models.** Copy the example from the clone:

   ```sh
   cp ~/opencode-multi-agent-team/examples/opencode-multi-agent-team.jsonc ~/.config/opencode/opencode-multi-agent-team.json
   ```

   (or to `<project>/.opencode/opencode-multi-agent-team.json` for one project). Then set a
   model for every role. The plugin ships no default models. List a backup model from a
   different provider after the main one; the plugin switches to it when the main model fails.

5. **Set each project's build and test commands** (see
   [Build and test commands](#build-and-test-commands)). Without them, every task first asks
   you for them, or you can skip build and test.

6. **Restart OpenCode** (`opencode service restart`) and select one of the front agents, or set
   `"defaultAgent": true` in the team's config to start in `build-manager`.

To update later, run `git pull` in the clone and restart OpenCode.

## Use

- **Change something:** describe it. The manager shows the polished request and asks
  [Send] [Edit] [Cancel]. Your replies during a task (answers, plan comments, questions) are
  polished and confirmed the same way; the agents get both the polished text and your
  original words. Build/test commands are sent as typed. Set `"polish": "off"` to send
  everything as written.
- **The manager never answers you itself.** Everything you write goes to the team: a
  request, a question, a reply, or feedback (on a finished task, as a new request).
- **Ask about the code:** the Intern answers. No task starts.
- **What first, then how.** A non-trivial change is planned in two stages before anyone edits.
  When the request leaves open what the feature should do, you first approve a
  **what-document**: what it does, the process, when it happens, the choices weighed and the
  decisions (each marked yours, from your material, or assumed). No code in it. Then the team
  plans the change in fresh sessions that get only the approved what-document, and you approve
  the plan. When the request already fixes the behaviour ("add a --upper flag that uppercases
  the output"), the plan starts with a short Behaviour section instead. Trivial fixes go
  straight to the edit. If the how stage finds that a decision of the what-document can't work
  in the code, you get the what-document back with the evidence and decide.
- **Want a plan, not a quick fix?** Say so ("plan it first"). The Lead still writes the
  brief but can't take the quick path, so the Architect always plans.
- **Who knows what:** Lead reads the code and your files. The Architect and Principal have no
  file or code access: they work from Lead's brief and ask Lead (numbered questions A1, A2, …,
  answered in `brief-answer-N.md`) when they need more. Code-search tools configured for them
  are ignored, with a warning in the log.
- **Ask during a task:** while the team waits on you, a question goes to the agent the task
  waits on (Architect, or Lead before there's a plan), in its own session with the full
  context. The task doesn't move; you then answer or decide.
- **Plans:** you see what you get once you approve, the step titles, the risk and the plan file,
  and reply in your own words (approve, ask for changes, ask a question, ask for Principal's
  review, or stop). Any feedback on the plan is sent as Change.
- **Principal's review:** say "have Principal review it" while a plan or document waits for
  you, or ask for it in the request. Principal checks whether it can be built as written and
  whether it is the right design. On CHANGES the Architect revises once, and you see the review
  next to the revised version. At most `limits.principalReviews` (2) per task.
- **When a draft keeps coming back:** the writer revises alone at first. At your 3rd round of
  comments on the same brief or document, the next adviser up reads the draft and all your
  comments and gives numbered advice (ADV1, …); at the 5th, the one above it. Lead's brief is
  advised by the Architect, then Principal; the Architect's drafts by Principal. The writer
  still writes the next version and must say how it handled each item; you see "Revised
  following …'s advice" on it. A writer that reports STUCK gets the next adviser right away,
  and when none is left the task comes to you. Set the rounds in `limits.escalateAfterComments`.

### Plan documents (`plan-manager`)

A plan task has two approvals. First the Lead reads your files and the code and writes a
**concept brief**: the concerns that decide whether the result is good (yours first, in your
framing), approaches for each, feasibility notes only where an idea could fail, and
assumptions. You see it and can adjust it (`workflows.plan.confirmBrief`). The Architect then
writes the **what-document** to `prompts/plan.instructions.md`. Once you approve it, the
**how-document** (the change plan, `prompts/how.instructions.md`) is written in fresh sessions
and saved next to it as `<name>.how.md`. Nobody edits code, and there is no build or test.
The what-document is saved to `docs/<task>.md` in the project (`workflows.plan.output`), or to
the path you name. A default path never overwrites an existing file; a path you name is edited
in place. If
[opencode-edited-files](https://github.com/aditya1271/opencode-edited-files) is installed, the
saved document shows in its sidebar.

You reply in your own words. Comments on any plan or document go to the Lead first, who turns
them into a revision brief (including places with the same problem that you didn't name); the
Architect then revises it. Once you approve the how-document, an **[Implement it]** button
switches the session to `build-manager` and starts a code task in which Developer carries out
that plan directly.

### Research reports (`research-manager`)

The Lead sizes the research (quick, breadth or depth) and writes a research brief. Unless the
research is quick, you see the brief first and can adjust it (`workflows.research.confirmBrief`).
The Intern collects evidence (claim, source, verbatim excerpt) in a capped number of rounds
(`workflows.research.internRounds`). The Architect writes the report from that evidence, to
`prompts/research.instructions.md`. A follow-up question on a finished report is appended to
it as a new section.

To change what a good document looks like ("make plans verbose", "always list
alternatives"), set `workflows.plan.instructions` (what-document), `workflows.plan.howInstructions`
(how-document and code plans) or `workflows.research.instructions` (inline text or a file). The
Architect writes to it and Principal reviews against it. Code tasks use the same what and how
standards; `workflows.code.confirmBrief` (default off) shows the concept brief there too.
- **Questions:** Lead, Architect and Principal may ask you questions. Answer in your own words.
  Your answer goes back to the agent that asked, in its own session, so it keeps its context.
- **Stuck or out of attempts:** you get a report (what was tried, the last errors, the
  changed files) and choose [Retry] / [Continue +10] / [Stop].
- **Usage:** ask "how was the work divided?" to get a per-agent table (calls, prompts, tool
  calls, tokens, model) for the task, or for the last N tasks.
- **Sidebar:** a **Team** section in the session sidebar shows the current task's phase and
  attempts, then one row per agent: calls, prompts, tool calls, tokens, and that agent's
  share of the task's tokens. The running agent is marked `●` and its numbers update live.
  Under each row, a dim line shows the model the agent used (`main → backup (backup)` in
  yellow when it switched). The last lines total the task and the whole session (all tasks and
  code questions). Click **▶ Models** to list every role's configured main and backup models.
  Click the header to collapse the section. Child sessions show their manager's numbers.

  ```
  ▼ Team running · 7/40 attempts
   agent    call prmt tool   tok    %
   manager     0    6    5   41k  12%
     fuse/kimi-k2.6
   lead        1   14   22   88k  26%
     fuse/kimi-k2.6
  ●developer   2   31   58  190k  57%
     fuse/kimi-k2.6 → github-copil…
   task        3   51   85  319k
   session     9  120  170  910k
    2 tasks · 3 questions
  ▶ Models
  ```

  The section sits at the top of the sidebar in every session; without a task it shows
  "no task yet", and if the numbers can't be loaded it shows the error. If it never appears after
  updating from a version without the sidebar, the background server still has the old
  plugin list: close OpenCode and run `opencode service restart` (`/reload` isn't enough).

Edits are never reverted automatically. Every result lists the changed files.

## Limits (defaults)

| Limit | Default |
|---|---|
| Agent calls per task | 40, then [Continue +10] |
| Developer rounds per plan step | 2 |
| Failed plans before Principal advice | 2 (Principal advice: once per task) |
| Your comment rounds on one draft before advice | 3 (next adviser), 5 (the one above) |
| Searches / question rounds per task | 6 / 4 |
| Tool calls per agent call | lead 40, architect 25, intern 30, developer 150, reviewer 30, principal 20 |
| Time per agent call | 30 min (developer 240), or 15 min without activity |

All limits are in the config file under `limits`.

## Build and test commands

The team never works out how to build a project. Give the commands in the project's config,
`<project>/.opencode/opencode-multi-agent-team.json`:

```jsonc
{
  "checks": {
    "build": "make -j8 app",
    "test": "make test"
  }
}
```

Use the exact commands you would type. For a remote build, give the whole command, e.g.
`"build": "ssh buildhost \"cd /work/view3 && make -j16\""`. Leave out what doesn't exist
(e.g. only `build`).

- The commands go to Lead, Architect, Developer and the Reviewer, with the rule to use only these.
  Plans use them as check commands. A step is done only when its check really ran and passed.
- They count as builds: long timeout (`buildCommands.timeoutMin`), and the output goes to
  `logs/`.
- A project `AGENTS.md` can still explain more (targets, environment, how to read failures).

**No commands configured:** `whenMissing` decides.

| `checks.whenMissing` | What happens |
|---|---|
| `"ask"` (default) | Each task first asks you: **[Skip build/test]**, **[Give commands]** (for this task only) or **[Stop]**. |
| `"skip"` | Tasks run without build and test. |

**Build and test skipped:** agents don't build, test or look for how to, and build commands
are blocked. Developer reports a step done once its edits are made. The result says "Not built
or tested". There is no extra review, so check the changes yourself.

To skip in one project only, set `"checks": { "whenMissing": "skip" }` in that project's
config.

## Per-agent tools and instructions

Each entry under `agents` can also set code-search tools and instructions, so the team works
with whatever you use to explore code (a code graph, clangd, a docs RAG, ...):

| Key | What it does |
|---|---|
| `skills` | Skills the agent may load; it is told to load them first. |
| `mcps` | MCP servers, used through Code Mode (`execute`). |
| `tools` | Tool ids from other plugins, e.g. `docs_search`. |
| `commands` | Extra shell commands the agent may run, e.g. `graphify *`, `clangd-query *`. |
| `instructions` | Replaces the agent's editable instructions (inline text, or a `.md`/`.txt` file path). |
| `append` | Added at the end of the prompt (inline text or file path). |

```jsonc
"intern": {
  "model": ["openai/gpt-5-mini", "anthropic/claude-haiku-4-5"],
  "mcps": ["codebase-memory"], "skills": ["codebase-memory"],
  "tools": ["docs_search"], "commands": ["graphify *"],
  "instructions": "~/team-prompts/intern.md"
}
```

Each agent's prompt has a fixed core: its role, the report statuses, and the safety rules. The
editable defaults are in `prompts/<role>.instructions.md`; copy one as a starting point.
The front agents each have their own polishing instructions (the shape of the polished
request), set with `"build-manager"`, `"plan-manager"` or `"research-manager"` under `agents`
(`instructions` and `append` only; the model comes from `manager`). Defaults:
`prompts/<agent>.instructions.md`. The
configured tools are listed in the prompt. `commands` never override the ask-first list for
destructive commands.

The default instructions adapt published agent prompts: OpenCode's plan mode, Claude Code's
Explore and Plan agents (as collected in Piebald-AI/claude-code-system-prompts), the
oh-my-opencode(-slim) Explorer, Fixer and Oracle roles, and VoltAgent's debugger,
error-detective, code-reviewer and architect-reviewer subagents.

## Task folder

Each task writes to `~/.cache/opencode-multi-agent-team/<task-id>/` (`taskDir`):
- `request.md`, `brief.md`, `plan-N.md`, `doc-N.md`, `findings-N.md`, `report-N.md`,
  `analysis-N.md`, `principal-N.md`, `answers.md`, `existing.md` (the document as it was
  before a task edited it)
- how stage: `how-brief.md`, `how-answers.md`; Lead's answers to the Architect or Principal:
  `brief-answer-N.md` / `how-brief-answer-N.md`; `infeasible-N.md`; `advice-N.md` (with how
  the writer handled each item), `stuck-N.md`
- `logs/`: full build and long command output
- `state.json`

`usage.jsonl` in the task root keeps one usage line per task. `plugin.log` records what the
plugin did.

## Safety

- Each team agent's own permission rules decide what it may do. A deny in your config still
  applies.
- Developer asks before destructive commands: git reset/clean/checkout/push/rebase, `rm -rf`,
  p4 revert/submit/delete, sudo. Add more patterns with `askCommands`.
- A step counts as done only if its check command really ran in that call and exited 0.

## Development

```sh
bun test          # unit tests
npx tsc -p .      # typecheck
```

## License

MIT
