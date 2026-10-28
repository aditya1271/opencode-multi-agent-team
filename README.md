# opencode-multi-agent-team

An OpenCode V2 plugin that runs a fixed multi-agent coding workflow. Code decides which agent
runs next and enforces the limits; no model routes work. Cheap models do most of the work.
Strong models write plans and give advice only when the team is stuck.

See [overview.md](overview.md) for the workflow, and [plan.md](plan.md) for the full design.

## Agents

| Agent | Job |
|---|---|
| `polisher` | Front agent. Rewrites your request, asks you to confirm it, and drives the team. It can't read, edit or run anything. |
| `team-triage` | Searches the code, then decides between a trivial fix and a plan. Writes the brief. |
| `team-senior` | Writes plans. You approve each one. |
| `team-explorer` | Does code searches for the senior planner, and answers your code questions. |
| `team-fixer` | Edits, builds and tests. The only agent that changes files. |
| `team-analyser` | Diagnoses failures and reviews finished work. |
| `team-oracle` | Reviews destructive plans, and advises once when the team is stuck. |

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

6. **Restart OpenCode** and select the `polisher` agent, or set `"defaultAgent": true` in the
   team's config.

To update later, run `git pull` in the clone and restart OpenCode.

## Use

- **Change something:** describe it. The polisher shows the polished request and asks
  [Send] [Edit] [Cancel]. Your replies during a task (answers, plan comments, questions) are
  polished and confirmed the same way; the agents get both the polished text and your
  original words. Build/test commands are sent as typed. Set `"polish": "off"` to send
  everything as written.
- **The polisher never answers you itself.** Everything you write goes to the team: a
  request, a question, a reply, or feedback (on a finished task, as a new request).
- **Ask about the code:** the Explorer answers. No task starts.
- **Want a plan, not a quick fix?** Say so ("plan it first"). Triage still writes the brief
  but can't take the quick path, so Senior always plans.
- **Ask during a task:** while the team waits on you, a question goes to the agent the task
  waits on (Senior, or Triage before there's a plan), in its own session with the full
  context. The task doesn't move; you then answer or decide.
- **Plans:** you see each plan's summary and file path and choose [Approve] [Change] [Stop].
  Any feedback on the plan is sent as Change.
- **Questions:** Triage, Senior and Oracle may ask you questions. Answer in your own words.
- **Stuck or out of attempts:** you get a report (what was tried, the last errors, the
  changed files) and choose [Retry] / [Continue +10] / [Stop].
- **Usage:** ask "how was the work divided?" to get a per-agent table (calls, prompts, tool
  calls, tokens, model) for the task, or for the last N tasks.
- **Sidebar:** a **Team** section in the session sidebar shows the current task's phase and
  attempts, then one row per agent: calls, prompts, tool calls, tokens, and that agent's
  share of the task's tokens. The running agent is marked `●` and its numbers update live.
  The last lines total the task and the whole session (all tasks and code questions). Click
  the header to collapse it. Child sessions show their polisher's numbers.

  ```
  ▼ Team fixing · 7/40 attempts
   agent    call prmt tool   tok    %
   polisher    0    6    5   41k  12%
   triage      1   14   22   88k  26%
  ●fixer       2   31   58  190k  57%
   analyser    1    4    6   17k   5%
   task        4   55   91  336k
   session     9  120  170  910k
    2 tasks · 3 questions
  ```

  The section appears once the session has a task or a question. If it never appears after
  updating from a version without the sidebar, the background server still has the old
  plugin list: close OpenCode and run `opencode service restart` (`/reload` isn't enough).

Edits are never reverted automatically. Every result lists the changed files.

## Limits (defaults)

| Limit | Default |
|---|---|
| Agent calls per task | 40, then [Continue +10] |
| Fixer rounds per plan step | 2 |
| Failed plans before Oracle advice | 2 (Oracle advice: once per task) |
| Searches / question rounds per task | 6 / 4 |
| Tool calls per agent call | triage 40, senior 25, explorer 30, fixer 150, analyser 30, oracle 20 |
| Time per agent call | 30 min (fixer 240), or 15 min without activity |

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

- The commands go to Triage, Senior, Fixer and the Analyser, with the rule to use only these.
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
are blocked. Fixer reports a step done once its edits are made. The result says "Not built
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
"explorer": {
  "model": ["openai/gpt-5-mini", "anthropic/claude-haiku-4-5"],
  "mcps": ["codebase-memory"], "skills": ["codebase-memory"],
  "tools": ["docs_search"], "commands": ["graphify *"],
  "instructions": "~/team-prompts/explorer.md"
}
```

Each agent's prompt has a fixed core: its role, the report statuses, and the safety rules. The
editable defaults are in `prompts/<role>.instructions.md`; copy one as a starting point. The
configured tools are listed in the prompt. `commands` never override the ask-first list for
destructive commands.

The default instructions adapt published agent prompts: OpenCode's plan mode, Claude Code's
Explore and Plan agents (as collected in Piebald-AI/claude-code-system-prompts), the
oh-my-opencode(-slim) Explorer, Fixer and Oracle roles, and VoltAgent's debugger,
error-detective, code-reviewer and architect-reviewer subagents.

## Task folder

Each task writes to `~/.cache/opencode-multi-agent-team/<task-id>/` (`taskDir`):
- `request.md`, `brief.md`, `plan-N.md`, `report-N.md`, `analysis-N.md`, `oracle-N.md`,
  `answers.md`
- `logs/`: full build and long command output
- `state.json`

`usage.jsonl` in the task root keeps one usage line per task. `plugin.log` records what the
plugin did.

## Safety

- Each team agent's own permission rules decide what it may do. A deny in your config still
  applies.
- Fixer asks before destructive commands: git reset/clean/checkout/push/rebase, `rm -rf`,
  p4 revert/submit/delete, sudo. Add more patterns with `askCommands`.
- A step counts as done only if its check command really ran in that call and exited 0.

## Development

```sh
bun test          # unit tests
npx tsc -p .      # typecheck
```

## License

MIT
