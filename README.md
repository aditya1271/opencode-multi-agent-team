# opencode-multi-agent-team

An OpenCode V2 plugin that runs a fixed multi-agent coding workflow. Code decides which agent
runs next and enforces the limits; no model routes work. Cheap models do most of the work.
Strong models write plans and give advice only when the team is stuck.

See [overview.md](overview.md) for the workflow, and [plan.md](plan.md) for the full design.

The agents are named after coding-team roles. Earlier versions used polisher, triage,
senior, explorer, fixer, analyser and oracle; configs and saved tasks with those names still
work. Later, lead became analyst, architect became planner and principal became architect;
configs and saved tasks still using `lead` or `principal` work, but an old `architect` entry
now means the new Architect: rename it to `planner`.

## Agents

| Agent | Job |
|---|---|
| `build-manager` | Front agent for code changes: the team plans, edits, builds and tests. |
| `plan-manager` | Front agent for plan documents: the team writes a plan for you to review. No code changes. |
| `research-manager` | Front agent for research: the team investigates and writes a findings report. No code changes. |
| `team-analyst` | Has the Intern search the code and reads only what it cites (no search tools), then decides between a trivial fix and a plan. Writes the brief. |
| `team-planner` | Writes plans and documents. You approve each one. Advises Analyst when you keep sending its brief back. |
| `team-intern` | Does code searches for Analyst and the Planner, and answers your code questions. |
| `team-developer` | Edits, builds and tests. The only agent that changes files. |
| `team-reviewer` | Diagnoses failures and reviews finished work. |
| `team-architect` | Reviews destructive plans, reviews a plan or document critically when you ask, and advises when the team is stuck or you keep sending a draft back. |
| `team-operator` | Runs things for you (and for Analyst and Developer mid-task) and returns the output: commands, scripts, API calls (curl), web pages. Changes no code (no edit tool); dangerous commands ask you first. Uses the cheap tier by default. |

Ask for something to run ("run scripts/list-models and show me the output", "curl the
models endpoint") and the manager sends it to the Operator with the `run` action, outside any
task; an open task doesn't move. No agent copies secret values (API keys, tokens) into
briefs, reports or answers: they name the variable or file instead.

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

   (or to `<project>/.opencode/opencode-multi-agent-team.json` for one project). Then set the
   models of the four tiers (`tiers.cheap`, `normal`, `good`, `expensive`). The plugin ships no
   default models. List a backup model from a different provider after the main one; the
   plugin switches to it when the main model fails. See [Models](#models).

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
  everything as written, or use an auto [mode](#modes) to skip the confirmation.
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
- **Want a plan, not a quick fix?** Say so ("plan it first"). The Analyst still writes the
  brief but can't take the quick path, so the Planner always plans.
- **Who knows what:** Analyst reads the code and your files. The Planner and Architect have no
  file or code access: they work from Analyst's brief and ask Analyst (numbered questions A1, A2, …,
  answered in `brief-answer-N.md`) when they need more. Code-search tools configured for them
  are ignored, with a warning in the log.
- **Ask during a task:** while the team waits on you, a question goes to the agent the task
  waits on (Planner, or Analyst before there's a plan), in its own session with the full
  context. The task doesn't move; you then answer or decide.
- **Plans:** you see what you get once you approve, the step titles, the risk and the plan file,
  and reply in your own words (approve, ask for changes, ask a question, ask for Architect's
  review, or stop). Any feedback on the plan is sent as Change.
- **Architect's review:** say "have Architect review it" while a plan or document waits for
  you, or ask for it in the request. Architect checks whether it can be built as written and
  whether it is the right design. On CHANGES the Planner revises once, and you see the review
  next to the revised version. At most `limits.architectReviews` (2) per task.
- **When a draft keeps coming back:** the writer revises alone at first. At your 3rd round of
  comments on the same brief or document, the next adviser up reads the draft and all your
  comments and gives numbered advice (ADV1, …); at the 5th, the one above it. Analyst's brief is
  advised by the Planner, then Architect; the Planner's drafts by Architect. The writer
  still writes the next version and must say how it handled each item; you see "Revised
  following …'s advice" on it. A writer that reports STUCK gets the next adviser right away,
  and when none is left the task comes to you. Set the rounds in `limits.escalateAfterComments`.
- **Revise some sections, keep the rest:** every brief, document and plan shows its sections
  with ids (S1, S2, …; a plan step is a section). When you comment, the manager's polished text
  starts with the scope, decided per section: **Fine-tune** (an exact edit you stated; the
  writer makes only that edit), **Revise** (you're unhappy with the substance; the writer
  reworks it), **Final** (what you called good or done), **Reopen**, **New**, and **Unchanged
  this round**. You confirm it with the rest. The writer returns only the sections in scope
  and the plugin puts them into the previous version, so every other section stays byte for
  byte. Each draft reminds you that you can mark sections **final** ("S3–S6 are final"); final
  sections (✅) stay exactly as they are until you **reopen** them, and a reply with only final
  marks just saves them. A section left unchanged this round may change only with a reason,
  shown to you as "also changed S9 (…)". Each version says what changed ("revised S5, S6 ·
  fine-tuned S8 · new S12"). A round of fine-tunes only goes straight to the writer (no
  revision brief from the Analyst) and doesn't count toward the escalation rounds.
- **One section at a time:** long briefs, documents and plans are hard to take in at once.
  At every review stop the manager asks [All at once] [One section at a time]. One at a
  time shows a section per turn (`S3 · Concerns (3 of 9)`). Every section you review ends
  with the writer's pick, `**Recommended:** <option>: <short reason>` (or "as written" when
  there's nothing to decide); the plugin refuses a draft without it. Reply "ok" (marks it final),
  "skip", a comment (polished and confirmed right away, stored as a fine-tune or revise), a
  question (answered, then the same section again), or "show the rest" (the remaining
  sections at once; your earlier replies are kept). After the last section, all comments go
  to the team as one scoped revision; when you passed every section, the manager asks once
  to approve. A brief's excerpts aren't walked through, only listed. Set `"reviewStyle"` to
  `"all"` or `"sections"` to skip the question; auto modes skip the review altogether.
  By default the review happens in a terminal UI dialog instead, with no model turn between
  sections: [o] OK, [s] Skip, [c] Comment…, [q] Question…, [r] Show the rest, [x] Stop.
  It opens on its own when you're on that session; otherwise, or to reopen it, click
  `▶ Review … · N of M done` in the Team sidebar or type `/team-review`. Esc closes it and
  keeps your progress. Comments and questions are collected as typed. When you finish, the
  manager wakes once: the agent answers your questions, then the manager polishes your
  comments and confirms them once before the scoped revision. Pass every section without
  comments and the dialog asks [Approve] [Show it all at once] itself. Say "review in chat"
  for the chat walk-through (the desktop and web apps and `opencode run` have no dialog).
- **Summary view first:** the full drafts are written for the agents (paths, commands,
  `p4` moves). You see the direction: every reviewed section opens with
  `**Summary:** <1-3 plain sentences>`, and every plan step's first line is
  `N. **Title**: <what it achieves>`. Reviews, approvals and the dialog show only those lines
  and the Recommended line; the plugin refuses a draft without them. Say "details" (or
  "details S5") for the stored full text, or press [d] in the dialog to switch views. No
  agent runs for it.
- **Modes:** from fully interactive to hands-off; see [Modes](#modes).

### Modes

Four modes decide how often the team stops for you. Each one adds to the one before it.

| Mode | Say | Polished text sent without [Send] [Edit] [Cancel] | Team answers questions and approves briefs, documents and plans | Team approves destructive plans and implements finished plans |
|---|---|---|---|---|
| **default** | (nothing) | no | no | no |
| **polished auto** | "send without asking", "no confirmations" | yes | no | no |
| **safe auto** | "just do it", "don't ask me", "decide yourself" | yes | yes | no |
| **full auto** | "full auto", "do everything" | yes | yes | yes |

- **default:** the manager shows every polished request and reply and waits for [Send]
  [Edit] [Cancel]. You answer the team's questions and approve or comment on every brief,
  document and plan.
- **polished auto:** for when you trust the polishing but want to keep the decisions. The
  manager still polishes your request and replies and shows the polished text, then sends it
  right away. Questions, briefs, documents and plans still wait for you.
- **safe auto:** for tasks where you don't mind what gets chosen. The team also takes the
  recommended answer to every question (each logged as an assumption), approves every brief,
  document and plan, and skips build and test when none are configured. It still stops at:
  - a plan with destructive or irreversible steps (`risk: yes`), which says
    "Safe auto stopped here";
  - a finished plan document: you choose [Implement it].
- **full auto:** also approves destructive plans and implements a finished plan document
  right away, in a code task that keeps full auto.

Safe and full auto still stop when the team is STUCK with no adviser left, or when the attempt
budget runs out; they never raise the budget. Each automatic decision shows as one line
("AUTO (safe): approved the concept brief"), is written to the task's answers file, and is
listed under **Decided on auto** when the task ends or stops.

**Choosing a mode:**
- **Slash command (easiest):** type `/team-mode` in the chat and pick one of the four:
  `/team-mode-default`, `/team-mode-polished`, `/team-mode-safe`, `/team-mode-full`. It
  applies to the open task right away (if the team is waiting on you at a stop the new mode
  decides, it carries on by itself) and to every new task in that chat. The plugin sets the
  mode itself; a `[team-mode]` line in the chat confirms it.
- **Per request:** say it with the request ("full auto: add a --upper flag"). The polished
  request ends with a `Mode: …` line.
- **During a task:** "polished auto", "go auto", "full auto", or "stop auto" (back to default).
  It takes effect right away, including while the team waits on you.
- **Default for new tasks:** `"auto"` in the team's config: `"off"` (default), `"polished"`,
  `"safe"` or `"full"`. A slash command overrides it for that chat; a mode named in a request
  overrides both for that task.

`"polish": "off"` is separate: the manager doesn't rewrite your text at all and sends it as
written, with no confirmation, in any mode.

### Plan documents (`plan-manager`)

A plan task has two approvals. First the Analyst reads your files and the code and writes a
**concept brief**: the concerns that decide whether the result is good (yours first, in your
framing), approaches for each, feasibility notes only where an idea could fail, and
assumptions. You see it and can adjust it (`workflows.plan.confirmBrief`). The Planner then
writes the **what-document** to `prompts/plan.instructions.md`. Once you approve it, the
**how-document** (the change plan, `prompts/how.instructions.md`) is written in fresh sessions
and saved next to it as `<name>.how.md`. Nobody edits code, and there is no build or test.
The what-document is saved to `docs/<task>.md` in the project (`workflows.plan.output`), or to
the path you name. A default path never overwrites an existing file; a path you name is edited
in place. If
[opencode-edited-files](https://github.com/aditya1271/opencode-edited-files) is installed, its
sidebar in your session shows the saved document, every file the team writes in the task folder
(brief, answers, drafts, advice, …; not `state.json` or `logs/`), and the code Developer changed.

You reply in your own words. Comments on any plan or document go to the Analyst first, who turns
them into a revision brief (including places with the same problem that you didn't name); the
Planner then revises it. Once you approve the how-document, an **[Implement it]** button
switches the session to `build-manager` and starts a code task in which Developer carries out
that plan directly.

### Research reports (`research-manager`)

The Analyst sizes the research (quick, breadth or depth) and writes a research brief. Unless the
research is quick, you see the brief first and can adjust it (`workflows.research.confirmBrief`).
The Intern collects evidence (claim, source, verbatim excerpt) in a capped number of rounds
(`workflows.research.internRounds`). The Planner writes the report from that evidence, to
`prompts/research.instructions.md`. A follow-up question on a finished report is appended to
it as a new section.

To change what a good document looks like ("make plans verbose", "always list
alternatives"), set `workflows.plan.instructions` (what-document), `workflows.plan.howInstructions`
(how-document and code plans) or `workflows.research.instructions` (inline text or a file). The
Planner writes to it and Architect reviews against it. Code tasks use the same what and how
standards; `workflows.code.confirmBrief` (default off) shows the concept brief there too.
- **Questions:** Analyst, Planner and Architect may ask you questions. Answer in your own words.
  Your answer goes back to the agent that asked, in its own session, so it keeps its context.
- **Asking the Planner mid-work:** before failing or reporting blocked, Developer can ask
  the Planner a question (status CONSULT), and Analyst can too while writing a brief. The
  Planner has no file access, so the question must carry the evidence (`path:line` and
  the code, or the exact output); the plugin refuses one without it. The answer goes back to
  the asker's session, which carries on; it isn't a failed attempt. Each pair (Developer ↔
  Planner, Analyst ↔ Planner) has its own session, apart from the Planner's planning
  session. Developer's starts fresh with each new plan, Analyst's with each stage, brief and
  round of your comments, and either after `limits.consultsPerSession` (6) questions.
  Limits: `consultsPerStep` (2) per plan step, `consultsPerBrief` (3) per brief. Architect
  never answers these.
- **Having the Operator run something mid-task:** Analyst and Developer can report status
  RUN to have the Operator run something they need: a web search or page, an API call, a
  script whose output they need (Developer still runs builds and tests itself). Each run is a
  separate Operator call you can see in the sidebar and the task folder (`run-N.md`,
  `run-result-N.md`); the result goes back to the asker's session, which carries on. It
  isn't a failed attempt. This is how research reaches the web: Analyst gathers web sources
  for the research brief. Limit: `limits.runsPerTask` (6). Turn it off with
  `"operatorCalls": false`.
- **Step fix:** when Developer reports a step blocked, the Planner first tries to fix just
  that step: it returns a replacement step, or two (a new step first, then the revised one).
  The plugin swaps them into a copy of the plan; finished steps and the rest stay as they
  are. You approve a one-line "Step N changed: …" (destructive or irreversible changes show
  the full step text, and Architect reviews them first, as for a risky plan); safe and full
  auto approve it themselves (safe still stops at a risky one). Developer then carries on at
  that step. One fix per step: if the fixed step blocks again, the plan counts as failed.
  When one step can't be patched, the Planner says so and writes a new plan as before.
- **Attempts** are failed tries: the team's own work failed and has to be redone. That
  means a Developer step that fails its check or is blocked, a review that sends the work
  back, Architect requesting changes to a plan, or an agent call that crashed, timed out or
  never reported. Info requests, Intern searches, questions to the Planner, your questions
  and answers, and revisions from your comments aren't attempts; their own limits bound them
  (`needInfoPerTask`, `analystSearchRounds`, `consultsPerStep`, `consultsPerBrief`,
  `runsPerTask`, `questionsPerTask`, `escalateAfterComments`). `limits.taskAttempts`
  (default 10) caps failed attempts per task. `limits.taskAgentCalls` (default 100) caps all
  agent calls as a silent runaway guard.
- **Stuck or out of attempts:** you get a report (what was tried, the last errors, the
  changed files) and choose [Retry] / [Continue +5 attempts, or +25 calls] / [Stop].
- **Usage:** ask "how was the work divided?" to get a per-agent table (calls, prompts, tool
  calls, tokens, model) for the task, or for the last N tasks.
- **Sidebar:** a **Team** section in the session sidebar shows the current task's phase and
  attempts, then one row per agent: calls, prompts, tool calls, tokens, and that agent's
  share of the task's tokens. The running agent is marked `●` and its numbers update live.
  Under each row, a dim line shows the model the agent used (`main → backup (backup)` in
  yellow when it switched). The last lines total the task and the whole session (all tasks and
  code questions). Click **▶ Models** to list every role's configured main and backup models.
  Click the header to collapse the section. Child sessions show their manager's numbers.
- **Token counts** are uncached input plus output. Cache reads (a few percent of the input
  price) are left out, so the numbers track what you pay.

  ```
  ▼ Team running · 1/10 attempts
   agent    call prmt tool   tok    %
   manager     0    6    5   41k  12%
     fuse/kimi-k2.6
   analyst        1   14   22   88k  26%
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
| Failed plans before Architect advice | 2 (Architect advice: once per task) |
| Your comment rounds on one draft before advice | 3 (next adviser), 5 (the one above) |
| Searches / question rounds per task | 6 / 4 |
| Analyst's search rounds (handed to the Intern) before each report | 3 |
| Tool calls per agent call | analyst 15, planner 25, intern 100, developer 150, reviewer 30, architect 20, operator 30 |
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

- The commands go to Analyst, Planner, Developer and the Reviewer, with the rule to use only these.
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

## Models

You name models per tier once; each role uses its default tier:

| Tier | Roles (default) |
|---|---|
| `cheap` | manager (the front agents), intern, operator |
| `normal` | analyst, planner, developer |
| `good` | reviewer |
| `expensive` | architect |

```jsonc
"tiers": {
  "cheap":     { "model": ["openai/gpt-5-mini", "anthropic/claude-haiku-4-5"], "variant": "low" },
  "normal":    { "model": ["openai/gpt-5-mini", "anthropic/claude-haiku-4-5"] },
  "good":      { "model": ["openai/gpt-5", "anthropic/claude-sonnet-4-5"] },
  "expensive": { "model": ["anthropic/claude-opus-4-5", "openai/gpt-5"], "variant": "high" }
},
"agents": {
  "planner": { "tier": "good" },                  // another tier for this role
  "developer": { "model": "openai/gpt-5-codex" }  // its own model always wins
}
```

Order of preference: `agents.<role>.model`, then `agents.<role>.tier`, then the role's default
tier. `agents.<role>.variant` wins over the tier's `variant`. A role whose tier has no models
and that has no model of its own can't run; the plugin log lists such roles at startup.

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

Give code-search tools to the Intern, not Analyst. Analyst doesn't search: it can read only the files
the request, your material or the Intern's findings name, and sends every search to the Intern.
Tools you add to Analyst still work, so a code-search MCP there lets it search again; add only
tools that fetch your material (an issue tracker, a wiki).

Every agent's first message starts with the working directory and its version control,
detected once per folder: a Perforce workspace (the `p4 info` client whose root contains the
folder), git, or none. Outside Perforce it also says not to use p4. So Perforce instructions
you append for all projects can apply only where they fit: start them with "Only when the
first message says this is a Perforce workspace; otherwise ignore this section."

Code-search tools often skip some files. A code graph indexes only the languages it knows,
so SWIG `.i` files, scripts or generated sources may be missing. When its search finds
nothing, the Intern falls back to glob, grep and find before reporting NOT_FOUND. To close a
gap in codebase-memory, check coverage with `check_index_coverage`, map extra extensions to a
known language in `~/.config/codebase-memory-mcp/config.json`, and re-index:

```json
{ "extra_extensions": { ".i": "cpp" } }
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
  `analysis-N.md`, `architect-N.md`, `answers.md`, `existing.md` (the document as it was
  before a task edited it)
- how stage: `how-brief.md`, `how-answers.md`; Analyst's answers to the Planner or Architect:
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
