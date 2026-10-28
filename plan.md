# opencode-multi-agent-team: plan

A multi-agent coding workflow for OpenCode V2, packaged as one shareable plugin.

> **Renamed agents.** This design uses the original names. The code now uses coding-team
> names: polisher → manager, triage → lead, senior → architect, explorer → intern,
> fixer → developer, analyser → reviewer, oracle → principal. Old names in configs and saved
> tasks are still read.

Status: revision 4, **version 1 built** (`src/`, `prompts/`) and tested headless on a
sandbox project. Where the build differs from the text below, "Built differently" wins.
- *(verify)*: depends on OpenCode behaviour that the prototype must confirm first.
- *(suggested)*: an idea taken from oh-my-opencode-slim; strike any you don't want.
- **[V2]**: not in the first version; added only if real tasks show the need (section 19).

**Contents:**
1. Why
2. Principles
3. Overview
4. Ownership: one owner per activity
5. Agents
6. The `report` tool
7. Hand-off contracts
8. Counting and escalation rules
   - 8A. Stopping mechanisms
9. State machine
10. Scenarios, step by step
11. Task folder
12. Deterministic checks and guards
    - 12A. Usage report per agent
13. Permissions
14. Configuration
15. Project AGENTS.md
16. Repo layout
17. Taken from oh-my-opencode-slim
18. Testing
19. Rollout: version 1 and version 2
20. Open questions and risks

**Changes in revision 4:**
- Fixer keeps iterating within its tool-call limit and reports `FAILED` only when stuck.
  No self-retry rule, no build cap.
- The Analyser gets the step's attempt history and decides step-level circling.
  The judge moves to version 2 and runs only before a new plan and before [Continue]/[Retry].
- Risky means destructive or irreversible only. Routine ssh/docker builds aren't risky.
- A trivial task that touches more than 1 file keeps its work and gets a quick review.
- Triage's brief includes code excerpts with line ranges. Plans name exact locations.
- The senior planner may run graph queries.
- Fewer limits. Search and question caps are per task only. Review is conditional. The
  final check is the plan's last step.
- Version 1 / version 2 split.

**Built differently (version 1):**
- Worker agent ids carry a prefix (`agentPrefix`, default `team-`: `team-fixer`, …) so they
  don't clash with other plugins' agents. The front agent is `polisher`. It is not the
  default agent unless `defaultAgent: true`.
- Permissions: each team agent starts from deny-all plus its own allows. A permission
  `evaluate` hook makes these rules decide for team agents, because OpenCode ranks global
  config rules (e.g. `read * allow`, `edit * ask`) above plugin agent rules. A deny from the
  user's config still stands. Tools an agent may not use are removed from its context.
- Triage and Explorer may run a read-only shell allowlist (`readOnlyCommands`: grep, find,
  ls, git/p4 diff, …). The Analyser is asked before any other shell command.
- `DONE` is checked when `report` is called. If the check command didn't run in that call,
  or its real exit code wasn't 0, `report` refuses DONE and the agent must run it or report
  FAILED. That is the only check; a refused DONE never reaches the state machine.
- At the tool-call limit, Fixer is told to report FAILED (diagnosis), not BLOCKED (new plan).
- Reviews and the Oracle review get the user's answers and plan comments (`answers.md`).
- `team` has extra actions: `stats` (usage for this task, or `last: N` tasks), `status`,
  `resume`.
- Usage "input" counts fresh input including cache writes. Polisher time isn't measured
  ("-").
- Long shell output (over 80 lines, or any build) goes to `logs/log-N.txt`. The agent sees
  the error lines and the tail.
- Everything per agent sits under `agents.<role>`: model, plus `skills`, `mcps`, `tools`
  (other plugins' tools), `commands` (extra shell patterns, e.g. `graphify *`),
  `instructions` and `append`. There are no `addons` or `promptAppend` keys. Prompts don't
  name any search tool; the configured tools are listed in the prompt. Senior's "graph
  queries" mean any configured code-search tool.
- Each prompt is a fixed core (role, report statuses, safety rules) plus an editable section
  (`prompts/<role>.instructions.md`, replaced by `instructions`). The ask-first list for
  destructive commands comes after `commands`, so it always wins.
- Usage tool kind "graph" is now "index" (any configured code-search tool or command).
- Build and test commands come from config (`checks.build`, `checks.test`), not from agents
  working them out. They go to every agent that builds or plans (`checks.md` in the task
  folder) and count as build patterns. With none configured, `checks.whenMissing` decides:
  `ask` (default: before triage the user picks [Skip build/test] [Give commands] [Stop]) or
  `skip`. With skip, a hook blocks build commands, DONE needs no check, and the result says
  "Not built or tested". No extra review is added. The user checks the changes.

---

## 1. Why

Measured on real tasks with oh-my-opencode-slim (view3, Orchestrator on `fuse/kimi-k2.6`):

| Session | Turns | Hand-offs | Done by the Orchestrator itself | Input tokens | Cache reads |
|---|---|---|---|---|---|
| 1 | 72 | 1 | 50 shell, 16 grep, 9 read, 2 patch | 719k | 5.75M |
| 2 | 27 | 0 | 8 shell, 5 read, 3 edit, … | 303k | 527k |

The cost came from the main agent **doing the work itself**. Every build log stayed in
its context and was re-sent on every later turn. It also ran `git reset --hard`,
`git clean -fd` and `rm -rf` on its own, with no plan and no review.

**Expected with this plan:**

| Task | Agent calls | Calls at Opus or Terra-high level |
|---|---|---|
| Trivial | 3 (polisher, triage, fixer) | 0 |
| Planned, going well | about 5–7 (plus searches) | 1 (the plan) |
| Destructive plan | +1 | +1 (Oracle) |

All with small contexts. Verified on the first real tasks (section 19).

## 2. Principles

1. **The routing is code.** The plugin runs the workflow as a fixed state machine. No
   model decides where work goes next.
2. **Models only make judgment calls,** and each kind of judgment has exactly one owner
   (section 4).
3. **Only the polisher talks to the user.** Agents never address the user directly;
   they return questions through `report`. The one exception is OpenCode's own
   permission prompts for dangerous commands.
4. **Agents report through a tool.** The tool's schema allows only valid results, and
   only the plugin writes task files.
5. **Code checks only where no human looks and a mistake is costly.** Where the user
   approves (prompt, plan), the user is the check.
6. **Don't cut good work short.** An agent that has the context keeps going until it's
   done or stuck. Limits catch runaways; they don't interrupt normal work.
7. **Expensive models only where they pay off.**
8. **Cache-friendly:** fixed prompts, nothing earlier in a conversation is changed
   *(suggested)*.
9. **Shareable:** models, add-ons and limits are configuration.

## 3. Overview

```
you ──► polisher ──► [Send] [Edit] [Cancel]
                       │ Send
                       ▼
                 team(start) ──► plugin state machine ──► runs ONE agent per call
                       ▲                │
          team(continue | answer |      ├─ progress  ─► polisher calls team(continue)
               approve | change |       ├─ questions ─► you answer
               stop | retry | extend |  ├─ approval  ─► [Approve] [Change] [Stop]
               stats)                   │
                       │                ├─ done      ─► result summary
                     polisher ◄─────────┴─ stuck / attempts used up ─► options
```

## 4. Ownership: one owner per activity

| Activity | Owner | Nobody else does it |
|---|---|---|
| Talk to the user | **polisher** | agents only return questions through `report` |
| Rewrite and confirm the request | **polisher** | |
| Decide the next step, count, enforce limits | **plugin** | no model routes or counts |
| Write task files, number them | **plugin** | agents only pass `content` to `report` |
| Decide trivial or not | **triage** | |
| Search the code **for triage** | **triage** (itself) | |
| Search the code **for the senior planner** | **explorer** (bigger searches); the senior planner may run **graph queries only** | senior doesn't grep or browse; it reads files named in the brief or findings |
| Answer the user's code questions | **explorer** | |
| Write and revise plans; set the risk flag | **senior** | |
| Edit files, run builds and tests, iterate on errors | **fixer** | analyser and explorer may only run read-only commands |
| Diagnose a failure **and decide step-level circling** (`LOCAL` / `REPLAN` / `ESCALATE`) | **analyser**, with the step's attempt history | |
| Check finished work against the request (when required, section 8) | **analyser** (review) | |
| Decide if a trivial task is done | **plugin**: Fixer's real exit code; 1-file diff → done, more → analyser review | |
| Review destructive plans | **oracle**, then **user** approves once | |
| Advise when stuck | **oracle**, at most once per task | |
| Judge progress across plans **[V2]** | **judge**, before plan 2+ and before [Continue]/[Retry] | |
| Approve plans | **user** | |
| Approve dangerous commands | **user**, via OpenCode's permission prompt | |

**Who may ask the user questions** (status `QUESTIONS`): triage, senior and oracle only.
Fixer and analyser can't ask the user. Fixer reports `BLOCKED`, and the analyser reports
`REPLAN` or `ESCALATE`.

## 5. Agents

| Agent | Role | My models (main / backup) |
|---|---|---|
| `polisher` | Front agent | `fuse/kimi-k2.6` / `github-copilot/gpt-6.1-terra` (also test `fuse/gpt-5.6-luna`) |
| `triage` | Sorts requests, searches, writes the brief | `fuse/kimi-k2.6` / `github-copilot/gpt-6.1-terra` |
| `senior` | Plans | `fuse/gpt-5.6-terra#high` / `siemens/claude-sonnet-5-5` |
| `explorer` | Searches for senior; answers code questions | `github-copilot/gpt-6-luna#low` / `fuse/gpt-5.6-luna` |
| `fixer` | Edits, builds, tests | `fuse/kimi-k2.6` / `github-copilot/gpt-6.1-terra` |
| `analyser` | Diagnoses failures; reviews when required | `fuse/gpt-5.6-terra` / `github-copilot/gpt-6.1-terra` |
| `oracle` | Reviews destructive plans; advises when stuck | `siemens/claude-opus-5-5#high` / `github-copilot/claude-opus-5.5` |
| `judge` **[V2]** | Checks progress across plans | `fuse/gpt-5.6-terra#medium` / `github-copilot/gpt-6.1-terra` |

Shared defaults ship **without** models; each user sets them (section 14). Each backup
comes from a different provider than its main model.

### 5.1 polisher (primary, default agent)

- **Polishing** (setting `polish: on`, the default):
  - turns the user's message into **Goal**, **Scope**, **Constraints**, **Done when**,
    **Unclear points**
  - shows it with **[Send] [Edit] [Cancel]**
  - on **Edit**, revises and asks again
  - on **Send**, calls `team(start)`
  - with `polish: off`, the message goes to `team(start)` as written
- **Several tasks in one message:** points this out and asks whether to send them one
  after another.
- **Code questions** (nothing to change): asks for confirmation the same way, then
  calls `team(ask)`.
- **Relays** everything `team` returns (section 7, H-U).
- **Tools:** `team` and the question tool only.
- **One active task per session.** A new request during a task gets **[Stop task] [Wait]**.

### 5.2 triage

- Searches the code itself: graph first, then grep and read.
- Decides **trivial**, if all of these hold:
  - one file
  - about 20 changed lines or less
  - no API, interface or format change
  - no build system or dependency change
  - no destructive step
  - one obvious check command

  When in doubt: not trivial.
- **The brief holds code findings only**, so later agents don't re-read the code:
  - findings with `path:line`
  - **the relevant code excerpts with line ranges**
  - open points, why it isn't trivial

  It doesn't restate the user's goal or constraints; the senior planner reads `request.md`
  itself (also in failure mode).
- **Statuses:**

  | Status | Meaning | `content` |
  |---|---|---|
  | `TRIVIAL` | Fixer can do it | instruction: file, exact location, change, check command, the excerpt |
  | `ESCALATE` | needs a plan | the brief (above) |
  | `QUESTIONS` | only the user knows | context for the questions |

### 5.3 senior

- Reads the request and the brief, and on later calls whatever the hand-off contract lists
  (section 7). The request is the source of truth for the goal, scope and constraints. The
  brief is the source of truth for code facts. Every constraint in the request is respected
  in the plan, or raised as a `QUESTION`.
- **May run graph queries** (codebase-memory: symbol search, callers, outlines, snippets)
  to check facts quickly. No grep, no browsing. Reads files named in the brief or findings.
- For bigger searches it reports `NEED_INFO`, and Explorer does them.
- **Statuses:**

  | Status | Meaning | `content` |
  |---|---|---|
  | `PLAN` | a plan (`risk` required) | the plan, format below |
  | `NEED_INFO` | needs a bigger search | the search queries |
  | `QUESTIONS` | needs the user's decision | context |
  | `ESCALATE` | stuck, or the options are too close to call | what was tried, why it failed, the question for Oracle |

- **Plan format:**
  - **Summary:** at most 10 lines
  - **Risk:** yes/no and why
  - **Steps:** for each, the **exact locations** (`path:line` ranges), the change, the
    check command
  - **Last step = the final check:** the full build or test
  - **Changes since the previous plan**
- **Risky** means **destructive or irreversible** only:
  - deleting files outside build folders
  - git reset, clean, checkout of files, rebase, push
  - p4 revert, submit or delete
  - changing or clearing shared caches (e.g. the conan cache) or shared machines

  **Not risky:** routine builds and tests, including over ssh or in docker, build system
  edits, and plans with many files. The user still approves every plan.

### 5.4 explorer

- **Senior mode:** answers senior's queries with `path:line` findings and short excerpts.
- **User mode:** answers the user's question.
- Graph first, then grep and read.
- **Statuses:** `FOUND`, `NOT_FOUND` (with what it searched).

### 5.5 fixer

- **One session per plan**, working through the steps in order. A new session for each
  new plan. Trivial tasks get their own session.
- Before editing a read-only Perforce file, the plugin runs `p4 edit` automatically.
- **Iterates freely:** edit, build, read errors, fix, rebuild, as often as needed within
  its tool-call limit (section 8A). Compile-fix-recompile cycles are normal work.
- Reports `FAILED` only when **stuck**: the same error keeps coming back, it's out of
  ideas, or the cause is outside the step.
- **Statuses:**

  | Status | Meaning | `content` |
  |---|---|---|
  | `DONE` | the check command passed | changed files, command |
  | `FAILED` | stuck on the step | key error lines, what it tried, likely cause |
  | `BLOCKED` | the plan or instruction can't work as written | why |

- The plugin verifies `DONE` against the **real exit code** of `checkCommand`. A failed
  or missing check turns it into `FAILED`.

### 5.6 analyser

- **Diagnosis mode:** gets the step's **whole attempt history** (all reports and
  analyses for this step) and the latest full log, and may run read-only commands.
  It owns the step-level circling decision: if the same error returns, or a fix undoes an
  earlier one, it must not answer `LOCAL`.

  | Status | Meaning |
  |---|---|
  | `LOCAL` | Fixer can fix it; `content` has the instructions |
  | `REPLAN` | the cause is understood and the plan is wrong, or the step is going in circles |
  | `ESCALATE` | the cause is unclear, or needs expert judgment |

- **Review mode** (only when required, section 8): compares the diff with the plan (or
  the trivial instruction) and the request.

  | Status | Meaning |
  |---|---|
  | `PASS` | done as requested |
  | `ISSUES` | gaps; `content` has instructions for Fixer |

### 5.7 oracle

- **Review mode** (destructive plan):

  | Status | Meaning |
  |---|---|
  | `APPROVE` | plan is sound; `content` has optional notes |
  | `CHANGES` | must change; `content` has what and why |

- **Advice mode** (escalation, at most once per task):

  | Status | Meaning |
  |---|---|
  | `ADVICE` | the approach the senior planner should take |
  | `QUESTIONS` | the decision belongs to the user |

### 5.8 judge (progress check) [V2]

Added only if real tasks show plans going in circles that the Analyser and the hard
limits don't catch.

- **Job:** look across **plans** and decide whether the task is getting anywhere.
  Step-level circling belongs to the Analyser (5.6).
- **Catches:** the same approach reworded as a new plan; oscillation across plans; drift
  to files unrelated to the request.
- **Runs only:**
  - before the senior planner writes **plan 2 or later**
  - before the user is offered **[Continue +10 attempts]** or **[Retry]**
- **Gets:** only `progress.md`, a digest built by the plugin: one row per attempt
  (agent, status, step, error lines), files changed per plan, each plan's step list, and
  the request's Goal and "Done when". No access to the code.
- **Statuses:**

  | Status | Effect |
  |---|---|
  | `PROGRESS` | continue as planned |
  | `CIRCLING` + `REPLAN` | the senior planner gets the verdict with the next plan request |
  | `CIRCLING` + `ESCALATE` | Oracle advice if not used yet; otherwise the user |
  | `CIRCLING` + `ASK_USER` | stuck report, with the verdict |

- **Rules:** when in doubt `PROGRESS`; `CIRCLING` must cite attempt numbers; it can only
  make things stricter, never grant attempts; its calls don't use the attempt budget
  (capped at 4 per task); if it fails, the task continues.

## 6. The `report` tool

Each agent (except the polisher) ends by calling:

```
report({
  status:    <only the statuses allowed for this agent in the current state>,
  summary:   <at most 5 lines, shown to the user>,
  content:   <markdown, written by the plugin to the matching file>,
  questions?: [<question>, …]      // QUESTIONS only
  risk?: "yes" | "no"              // senior PLAN only
  checkCommand?: <string>          // fixer DONE/FAILED only
})
```

- If an agent ends **without** calling `report`, the plugin sends it back to the same
  session once: "Finish by calling `report`." If it fails again, the task becomes **stuck**.
- After a failed trivial attempt, triage's schema allows only `ESCALATE`.
- When a per-task cap is used up (section 8A), that status is removed from the schema.

## 7. Hand-off contracts

Every hand-off is done by the plugin. "Gets" is what the plugin puts into the agent's
prompt: file paths plus a fixed instruction for that state. The project `AGENTS.md` is
loaded by OpenCode automatically.

| ID | From → To | When | Gets | Result goes to |
|---|---|---|---|---|
| H1 | polisher → plugin | user pressed Send | confirmed request → `request.md` (+ `request-original.md`) | H2 |
| H2 | plugin → **triage** | new task | `request.md` | `TRIVIAL` → `brief.md`, H3 · `ESCALATE` → `brief.md`, H5 · `QUESTIONS` → H-U2 |
| H2b | plugin → **triage** (failure mode) | trivial attempt failed, or its review found issues | `request.md`, `brief.md`, `report-N.md`, `analysis-N.md` if any | `ESCALATE` only → overwrites `brief.md`, H5 |
| H3 | plugin → **fixer** (trivial) | triage `TRIVIAL` | `request.md`, `brief.md` | `DONE` + exit 0 + 1 file → H-U5 · `DONE` + exit 0 + more files → H10 · otherwise → H2b |
| H4 | plugin → **explorer** (user mode) | `team(ask)` | the question | answer → H-U5 (no task folder) |
| H5 | plugin → **senior** | brief ready, or after H6, H7, H11, a plan failure, H-U2, H-U3 Change | `request.md`, then `brief.md` (and `answers.md`) on every new senior session; in the kept session the request stays in context, so only the **new** files since its last call follow: `findings-N`, `oracle-N`, `report-N`, `analysis-N`, `answers.md`, user comments | `PLAN` → `plan-N.md` · `NEED_INFO` → H6 · `QUESTIONS` → H-U2 · `ESCALATE` → `escalation-N.md`, H11 |
| H6 | plugin → **explorer** (senior mode) | senior `NEED_INFO` | senior's queries | `findings-N.md` → H5 (same senior session) |
| H7 | plugin → **oracle** (review) | `PLAN` with `risk: yes` (rules in section 8) | `brief.md`, `plan-N.md` | `APPROVE` → `oracle-N.md`, H-U3 · `CHANGES` → `oracle-N.md`, H5 (one revision), then H-U3 |
| H8 | plugin → **fixer** (planned) | user approved, or after each `DONE` step, or a `LOCAL`/`ISSUES` round | `plan-N.md`, the step number; on rounds also `analysis-N.md` | `DONE` → next step; after the last step → H10 if review is required, else H-U5 · `FAILED` → H9 · `BLOCKED` → plan failure |
| H9 | plugin → **analyser** (diagnosis) | fixer `FAILED` | `plan-N.md`, the step, **all** `report-N`/`analysis-N` for this step, the latest `logs/log-N.txt` | `LOCAL` → `analysis-N.md`, H8 (same fixer session) · `REPLAN` → plan failure · `ESCALATE` → H11 |
| H10 | plugin → **analyser** (review) | planned task with review required (section 8), or trivial task touching more than 1 file | `request.md`, `plan-N.md` or `brief.md`, the diff, reports | `PASS` → H-U5 · `ISSUES`: planned → `analysis-N.md`, H8 (round on the last step) · trivial → H2b |
| H11 | plugin → **oracle** (advice) | senior or analyser `ESCALATE`, or plan limit reached (section 8) | `request.md`, `brief.md`, all `plan-N`, the latest `report-N`/`analysis-N`, `escalation-N.md` if any | `ADVICE` → `oracle-N.md`, H5 · `QUESTIONS` → H-U2, then H5 |
| H12 | plugin → same agent | agent ended without `report` | "Finish by calling `report`." | its report, or stuck → H-U4 |
| H13 **[V2]** | plugin → **judge** | before plan 2+, before [Continue]/[Retry] | `progress.md` | see 5.8 |

**Hand-offs to the user** (always through the polisher):

| ID | What the user sees | User's options | Then |
|---|---|---|---|
| H-U1 | polished request | [Send] [Edit] [Cancel] | H1 / revise / end |
| H-U2 | questions from triage, senior or oracle | free-text answer → appended to `answers.md` | back to the agent that asked |
| H-U3 | plan summary, risk, Oracle's notes if any, plan path | [Approve] [Change] [Stop] | H8 / H5 with comments / end |
| H-U4 | stuck: which limit, what was tried, last errors, changed files | [Retry] (current agent, fresh session) [Stop] | resume / end |
| H-U4b | attempt budget used up: attempts per agent, what's left to do | [Continue +10 attempts] [Stop] | resume / end |
| H-U5 | done: summary, changed files, usage table per agent (section 12A) | — | end |
| H-U7 | `team(stats)`: usage table for the current or last N tasks | — | — |
| H-U6 | progress line, e.g. "fixer: step 2 of 4 done" | — | polisher calls `team(continue)` |
| — | OpenCode permission prompt for a dangerous command | allow / deny | directly in the TUI, not through the polisher |

**Stopping** (`team(stop)`, any time):
- the running agent is interrupted, and the task's state becomes `stopped`
- files already edited **stay as they are**; the polisher lists them, and nothing is
  reverted automatically
- `team(continue)` on a stopped task asks whether to resume

## 8. Counting and escalation rules

Counters live in `state.json`, and only the plugin changes them.

**Fixer rounds:** per step. The final check is the plan's last step, so it has rounds
like any other step.
- A round is one `LOCAL` or `ISSUES` sent back to Fixer. Review `ISSUES` count as a round
  on the last step; after fixing, Fixer re-runs the final check and the review runs again.
- Limit **2**. A third would-be round becomes a **plan failure**.
- Fixer's own iterations inside its session are **not** rounds.

**Plan failures:** per task. A plan fails on:
- analyser `REPLAN`
- fixer `BLOCKED`
- rounds exhausted

What happens after a plan fails:

| Failed plans so far | Oracle advice already used? | Next |
|---|---|---|
| fewer than 2 | — | senior writes the next plan (H5) |
| 2 | no | Oracle advice (H11), then senior writes the next plan |
| 2 or more | yes | **user** (stuck, H-U4) |

**Oracle advice:** at most **once per task**, from any route (senior `ESCALATE`,
analyser `ESCALATE`, or the plan limit). If a plan written **after** the advice fails,
or anyone escalates again, the user is asked (H-U4).

**Oracle review of destructive plans:**
- every `PLAN` with `risk: yes` goes to Oracle review (H7)
- **except** a revision that only answers the user's **Change** comments
- after `CHANGES`, the revised plan goes to the user **without** a second Oracle review,
  with Oracle's notes attached

**Review is required only when** at least one holds:
- the plan had a failure (a `FAILED` step in this plan, or an earlier plan failed)
- the plan is risky
- the diff touches **more than 3 files**

Otherwise Fixer's passing final check means done.

**Trivial tasks:**
- `DONE`, exit code 0, 1 file → done
- `DONE`, exit code 0, more than 1 file → the work is kept and the analyser reviews it
  (H10). `PASS` → done; `ISSUES` → triage failure mode (H2b).
- `FAILED`, `BLOCKED` or a failed exit code → triage failure mode (H2b), then the senior
  planner. This is entering the planned path, not a plan failure. Edits are kept, and
  the brief lists them.

**Not counted** (as rounds or plan failures; they still use attempts):
- revisions after Oracle's `CHANGES`
- revisions after the user's **Change**
- `NEED_INFO` and `QUESTIONS` round trips (they have their own per-task caps, 8A)

**Attempt budget:** the budget is a number of **attempts**, not tokens or time.
- **One attempt = one agent call** (every hand-off H2–H12).
- Default: **40 attempts per task**, checked before every hand-off. When used up: H-U4b.
- The limits above still apply inside it. The budget caps the total.
- Tokens are **not** limited. They're only tracked and shown in the summaries.

## 8A. Stopping mechanisms

**Goal:** every task ends in a bounded number of steps, with **done**, **stopped** or
**stuck**. Never an endless loop, never silent waiting. All limits are enforced by the
plugin in code and are configurable (section 14). There are deliberately few of them.

```
L1 inside one agent call      tool-call limit, hang protection
L2 between agents             rounds, plan failures, Oracle once, per-task caps on searches and questions
L3 no-progress                analyser owns step circling (V1); code checks and judge [V2]
L4 whole task                 attempt budget (number of agent calls)
L5 always the same exit       stuck report to the user; nothing retries silently
```

### L1. Inside one agent call

| Limit | Default | How | When reached |
|---|---|---|---|
| Tool calls per agent call | triage 40, senior 25, explorer 30, fixer 150, analyser 30, oracle 20 | plugin counts calls (`execute.before` / permission hook) *(verify)* | every tool except `report` is denied: "limit reached: call `report` now" |
| Hang: time per agent call | 30 min; fixer 4 h | plugin timer | interrupted → stuck (H-U4) |
| Hang: stall | 15 min with no activity and no command running | session events | interrupted → stuck |
| Single command | `buildCommands` timeout (120 min), others 2 min | shell hook | killed; Fixer sees the timeout |
| No `report` at the end | 1 re-prompt (H12) | plugin | stuck |

The time limits only catch something that has hung. They don't limit normal work.

### L2. Between agents

| Back-and-forth | Cap | When reached |
|---|---|---|
| Fixer rounds (`LOCAL`/`ISSUES`) | 2 per step | plan failure |
| Plan failures | 2, then Oracle advice once, then the user | stuck |
| Oracle review revision (`CHANGES`) | 1 per plan | the plan goes to the user with Oracle's notes |
| Senior ⇄ Explorer (`NEED_INFO`) | 6 per task | `NEED_INFO` removed from the schema: "plan with what you have, or `ESCALATE`" |
| Agent ⇄ user (`QUESTIONS`) | 4 per task | `QUESTIONS` removed from the schema |
| Backup models | each model tried once per agent call, at most 2 short waits for rate limits | stuck: "all models for `<role>` failed" |
| Polisher Edit / user Change | none (the user drives it) | — |

### L3. No-progress

- **V1:** the Analyser sees the step's full attempt history and answers `REPLAN` instead
  of `LOCAL` when the step is going in circles (same error back, a fix undone).
- **[V2], only if data shows the need:**
  - **same error:** normalised error-line hash matches the previous attempt on the step →
    `LOCAL` removed from the analyser's schema
  - **no change:** Fixer's diff identical to before its round → same effect
  - **judge** (5.8) before plan 2+ and before [Continue]/[Retry]

### L4. Whole task

| Limit | Default | When reached |
|---|---|---|
| Attempt budget (agent calls per task) | 40 | H-U4b: [Continue +10 attempts] [Stop] |

No token limit and no task time limit.

### L5. One exit: the stuck report

Whatever limit is hit, the task stops at a safe point (between agents, or by
interrupting the current one) and the user gets one report (H-U4):
- **which limit** was hit and where (agent, step)
- **what was tried:** plans, rounds, the last error lines
- **files changed so far** (kept, not reverted)
- **the usage table per agent** (section 12A) and attempts left
- **options:**
  - **[Retry]** runs the current agent once more in a fresh session. Counters are **not**
    reset; it grants exactly one extra attempt.
  - **[Stop]**
  - when the attempt budget is used up: **[Continue +10 attempts]**

Nothing retries silently, and no limit resets itself.

**Worst case, by construction:** a trivial attempt (+ review), at most 3 plans (2 + 1
after Oracle) with at most 2 rounds per step, at most 6 searches, 4 question rounds and
1 Oracle advice, every agent call capped in tool calls and protected against hangs, and
the 40-attempt budget on top.

## 9. State machine

```
            ┌────────────── QUESTIONS ⇄ user ──────────────┐
request ─► TRIAGE ─TRIVIAL─► FIX(trivial) ─DONE, 1 file─► DONE
            │  ▲                 │ DONE, >1 file ─► REVIEW ─PASS─► DONE
            │  │                 │ FAILED / BLOCKED     │ ISSUES
            │  └── failure mode ◄┴──────────────────────┘
            │ ESCALATE
            ▼
         SENIOR (graph queries) ⇄ NEED_INFO ⇄ EXPLORER     (QUESTIONS ⇄ user)
            │ PLAN
            ├─ destructive ─► ORACLE_REVIEW ─CHANGES─► SENIOR (1 revision) ─┐
            │                      │ APPROVE                                │
            ▼                      ▼                                        ▼
         APPROVAL (user) ◄─────────────────────────────────────────────────┘
            │ Approve                     Change ─► SENIOR      Stop ─► STOPPED
            ▼
         FIX(step k) ─DONE─► … ─► FIX(last step = final check) ─DONE─┬─ review not required ─► DONE
            │ FAILED   (Fixer iterates freely inside each step)       └─ required ─► REVIEW
            ▼                                                               PASS ─► DONE
         DIAGNOSE (step history) ─LOCAL─► FIX (same session, round+1)       ISSUES ─► FIX last step (round+1)
            │ REPLAN / BLOCKED / rounds exhausted ─► plan failure ─► SENIOR | ORACLE_ADVICE | USER
            │ ESCALATE ─► ORACLE_ADVICE (once) ─ADVICE─► SENIOR
any state: any limit from section 8A ─► STUCK report (attempt budget: option to continue)
           missing report ×2 ─► STUCK · team(stop) ─► STOPPED
```

## 10. Scenarios, step by step

**S1. Code question**
1. User asks "where is X parsed?". Polisher polishes it and shows it; the user presses Send.
2. `team(ask)` → explorer (H4) → `FOUND`.
3. Polisher shows the answer. No task folder.

**S2. Trivial change, succeeds**
1. Polished request → Send → `team(start)` → triage (H2).
2. Triage searches, reports `TRIVIAL` with the excerpt and exact location → fixer (H3).
3. Fixer edits, builds, fixes a typo it introduced, rebuilds, reports `DONE`. The plugin
   confirms exit code 0 and a 1-file diff.
4. User sees: done, changed file, attempts and tokens.

**S3. Trivial change, fails**
1. As S2, but Fixer gets stuck and reports `FAILED`.
2. Triage, failure mode (H2b): writes the brief, listing the kept edits, `ESCALATE` →
   continue as S4 from step 2.

**S3b. Trivial change touches 2 files**
1. Fixer `DONE`, exit code 0, but it also fixed a header.
2. Analyser review (H10): `PASS` → done. (`ISSUES` → as S3 step 2.)

**S4. Planned task, succeeds**
1. Triage `ESCALATE` with the brief and excerpts.
2. Senior (H5) checks two callers with graph queries, then `NEED_INFO` for a wider search →
   explorer (H6) → findings → senior `PLAN` with exact locations, risk no, 3 files.
3. User sees the summary → Approve.
4. Fixer (H8): step 1 `DONE` → step 2 `DONE` → last step (final check) `DONE`.
5. No failure, not risky, 3 files → no review → user sees: done, files, attempts, tokens.

**S5. Destructive plan**
1. Senior `PLAN` that deletes an old generated folder outside `build/`: risk yes →
   Oracle review (H7).
2. If `CHANGES`: senior revises once.
3. User sees the plan plus Oracle's notes → Approve → as S4 step 4. Review runs at the end.
4. When Fixer runs the `rm -rf`, OpenCode also asks the user directly.

A plan that builds over ssh in docker is **not** risky: no Oracle.

**S6. A step fails and is fixed locally**
1. Fixer iterates on step 2 but is stuck on a linker error → `FAILED` → analyser (H9)
   `LOCAL` (missing library in the link line).
2. Same Fixer session gets the analysis (round 1 of step 2) → `DONE` → continues.
3. At the end, review runs because the plan had a failure.

**S7. The plan is wrong**
1. Step 2 fails; analyser `LOCAL`; it fails again; the analyser sees the same error in the
   history → `REPLAN` → plan failure 1 → senior writes plan 2 (gets the reports and analyses).
2. User approves plan 2 → a new Fixer session.
3. Plan 2 also fails → plan failure 2 → Oracle advice (H11) → senior writes plan 3 →
   user approves.
4. Plan 3 fails → user sees stuck (H-U4): [Retry] [Stop].

**S8. Senior is stuck early**
1. Senior `ESCALATE` with `escalation-1.md` → Oracle advice (H11), now used.
2. Senior writes plan 1 using the advice → if it fails → user (stuck).

**S9. Questions for the user**
1. Triage, senior or Oracle reports `QUESTIONS`.
2. Polisher shows them; the user answers → `answers.md` → back to the same agent session.

**S10. User changes the plan**
1. At approval, the user presses **Change** and types comments.
2. Senior revises (not counted; no Oracle review for this revision) → approval again.

**S11. Final check or review finds problems**
- The final check is the last step: `FAILED` → diagnosis → `LOCAL` → round on the last step.
- Review `ISSUES` → round on the last step → Fixer fixes, re-runs the final check →
  review again.
- After 2 rounds: plan failure (as S7).

**S12. Stop, budget, model failure, missing report**
- **Stop:** the agent is interrupted, edits are kept and listed, and the state is `stopped`.
- **Attempt budget used up:** H-U4b: [Continue +10 attempts] or [Stop].
- **Model failure:** switch to the backup model. If that fails too: stuck → [Retry] [Stop].
- **Missing `report`:** re-prompted once (H12), then stuck.

**S13. New request during a task**
- Polisher: [Stop task] [Wait]. Only one task runs per session.

**S14. Runaway or hung agent call**
1. Fixer keeps editing and rebuilding without converging. At 150 tool calls, everything
   except `report` is denied → it reports `FAILED` → normal diagnosis.
2. If it hangs instead (15 min with no activity and no command running): interrupted →
   stuck report.

**S15. Circling across plans [V2]**
1. Plan 1 failed. Before plan 2, the judge (H13) reads `progress.md`.
2. Verdict `PROGRESS` → senior writes plan 2. Or `CIRCLING` + `ESCALATE` → Oracle advice.

## 11. Task folder

Default `~/.cache/opencode-multi-agent-team/<task-id>/`, configurable. It stays outside the
workspace, and it is under home so Fuse works. `<task-id>` = `YYYYMMDD-HHMM-<slug>`.
**Only the plugin writes here.**

```
request.md            confirmed request                      H1
request-original.md   user's original (reference only)        H1
brief.md              triage instruction or brief + excerpts  H2, H2b
answers.md            user answers, appended                  H-U2
findings-N.md         explorer results                        H6
plan-N.md             plans                                   H5
escalation-N.md       senior's escalation                     H5
oracle-N.md           Oracle reviews and advice               H7, H11
report-N.md           fixer reports (step inside)             H3, H8
analysis-N.md         diagnoses and reviews                   H9, H10
logs/log-N.txt        full build/test output                  guards
state.json            state, counters, session IDs, usage per agent    plugin
../usage.jsonl        one usage line per finished task (shared)       plugin
progress.md           attempt digest for the judge [V2]       H13
judge-N.md            judge verdicts [V2]                     H13
```

## 12. Deterministic checks and guards (plugin)

| Check | How | Why | Version |
|---|---|---|---|
| `report` required, valid statuses only | tool schema + one re-prompt | routing never depends on free text | V1 |
| Fixer's real exit code | `ctx.tool.hook("execute.after")` on shell | a `DONE` can't hide a failed build | V1 |
| Build log trimming | same hook: full output to `logs/`, Fixer sees errors and the tail | the biggest token saving for long builds | V1 |
| Long build timeouts | `ctx.shell.hook("create.before")` with `buildCommands` patterns | builds exceed the default 2 min | V1 |
| Automatic `p4 edit` | `execute.before` on edit/write for read-only files in a p4 workspace | Fixer doesn't fail on read-only files | V1 |
| Trivial task file count | diff after Fixer | decides done vs review | V1 |
| Dangerous commands ask the user | permission rules (section 13) | destructive commands need the user's OK | V1 |
| Tool-call limit and hang protection | section 8A L1 | runaways | V1 |
| Backup models | `retry` hook + `switchModel` | Fuse outages, Copilot's allowance | V1 |
| Attempt counting | plugin counts every agent call | the attempt budget | V1 |
| Usage per agent (information only) | session data / events, tool-call counts | section 12A; never stops a task | V1 |
| Same-error / no-change checks | hashes (8A L3) | exact repeats | V2 |
| Repeated identical tool calls | warn at 3, block at 5 *(suggested)* | cheap models loop | V2 |
| Broken tool-call JSON | append a "fix your JSON" note *(suggested)* | cheap models send malformed calls | V2 |
| Quota-aware fallback | used-up quota marks a provider unavailable for a while *(suggested)* | avoid retrying a dead provider | V2 |

## 12A. Usage report per agent

Shows whether work is divided as intended. For example, it shows when the polisher or
the senior planner does work that belongs to Fixer or Explorer, or when the Analyser
gets called on every small error. It's for information only and never stops a task.

**Measured per agent, per task:**

| Metric | Meaning |
|---|---|
| Calls | agent calls (attempts) handed to this agent |
| Prompts | model requests processed (turns), including tool-call turns |
| Tool calls | by type: read, search, graph, edit, shell, build |
| Input tokens | new input tokens |
| Cache reads | input tokens served from the cache |
| Output tokens | including reasoning |
| Model | the main model, or the backup if one was used |
| Time | wall-clock time inside the agent's calls |

The polisher is measured too, for the turns it spends on this task.

**Where it's shown:**
- **At the end of every task** (H-U5) and **in every stuck report** (H-U4): a compact table
  with one row per agent plus a total.
- **`team(stats)`** at any time: the same table for the current task (or the last one).
- **`team(stats, last: N)`**: totals over the last N tasks, per agent, with each agent's
  share of calls, prompts and tokens.

Example:

```
agent     calls prompts tools  input  cache  output  model
polisher      1       3     2    12k    30k      1k  fuse/kimi-k2.6
triage        1       9     8    41k   180k      3k  fuse/kimi-k2.6
senior        2       6     4    35k    60k      8k  fuse/gpt-5.6-terra
explorer      1       7     6    28k    90k      2k  github-copilot/gpt-6-luna
fixer         3      38    35   160k   1.2M     12k  fuse/kimi-k2.6
analyser      1       4     3    22k    10k      2k  fuse/gpt-5.6-terra
total         9      67    58   298k   1.6M     28k
```

**Expected split (written next to the table as hints, not enforced):**
- polisher: 0 read, search, shell or edit calls
- senior: only graph queries, a few prompts per call
- Fixer: most of the tool calls and cache reads
- Analyser and Oracle: few calls

A line such as "polisher used 4 search calls" or "analyser: 5 calls for 1 step" is shown
when an agent is far outside its expected split.

**Stored:** per task in `state.json`, and one line per finished task appended to
`~/.cache/opencode-multi-agent-team/usage.jsonl`. That file feeds `team(stats, last: N)` and the
version 2 decisions (section 19).

## 13. Permissions

Set by the plugin per agent (last matching rule wins). *(verify exact action names.)*

| Agent | read | search | edit | shell | tools |
|---|---|---|---|---|---|
| polisher | ✗ | ✗ | ✗ | ✗ | `team`, question |
| triage | ✓ | ✓ | ✗ | ✗ | `report` |
| senior | ✓ | **graph queries only** | ✗ | ✗ | `report` |
| explorer | ✓ | ✓ | ✗ | read-only list | `report` |
| fixer | ✓ | ✓ | ✓ | ✓ (ask-list asks) | `report` |
| analyser | ✓ | ✓ | ✗ | read-only list (others ask) | `report` |
| oracle | ✓ | ✓ | ✗ | ✗ | `report` |
| judge [V2] | `progress.md` only | ✗ | ✗ | ✗ | `report` |

- **Ask-list** (extendable): `git reset*`, `git clean*`, `git checkout*`, `git push*`,
  `rm -rf*`, `p4 revert*`, `p4 submit*`, `p4 delete*`, `sudo*`. Routine `docker` and
  `ssh` builds are **not** on the list; add them with `askCommands` if you want.
- **Read-only list:** `grep`, `rg`, `find`, `ls`, `cat`, `head`, `tail`, `wc`, `nm`,
  `readelf`, `ldd`, `objdump`, `file`, `p4 diff`, `p4 opened`, `p4 have`, `git diff`,
  `git log`, `git status`.
- **Add-ons per agent:** skills and MCP tools from the config.

## 14. Configuration

`~/.config/opencode/opencode-multi-agent-team.json` (a project-level file overrides it):

```jsonc
{
  "agents": {
    "polisher": { "model": ["fuse/kimi-k2.6", "github-copilot/gpt-6.1-terra"] },
    "triage":   { "model": ["fuse/kimi-k2.6", "github-copilot/gpt-6.1-terra"], "variant": "medium" },
    "senior":   { "model": ["fuse/gpt-5.6-terra", "siemens/claude-sonnet-5-5"], "variant": "high" },
    "explorer": { "model": ["github-copilot/gpt-6-luna", "fuse/gpt-5.6-luna"], "variant": "low" },
    "fixer":    { "model": ["fuse/kimi-k2.6", "github-copilot/gpt-6.1-terra"], "variant": "medium" },
    "analyser": { "model": ["fuse/gpt-5.6-terra", "github-copilot/gpt-6.1-terra"] },
    "oracle":   { "model": ["siemens/claude-opus-5-5", "github-copilot/claude-opus-5.5"], "variant": "high" }
  },
  "addons": {
    "triage":   { "mcps": ["codebase-memory"], "skills": ["csh-terminal", "codebase-memory"] },
    "senior":   { "mcps": ["codebase-memory"], "skills": ["codebase-memory"] },
    "explorer": { "mcps": ["codebase-memory"], "skills": ["csh-terminal", "codebase-memory"] },
    "oracle":   { "mcps": ["codebase-memory"], "skills": ["codebase-memory"] },
    "fixer":    { "skills": ["csh-terminal"] },
    "analyser": { "skills": ["csh-terminal"] }
  },
  "polish": "on",
  "limits": {
    "taskAttempts": 40,
    "fixerRounds": 2,
    "planFailures": 2,
    "oracleAdvice": 1,
    "needInfoPerTask": 6,
    "questionsPerTask": 4,
    "toolCalls": { "triage": 40, "senior": 25, "explorer": 30, "fixer": 150, "analyser": 30, "oracle": 20 },
    "callMinutes": { "default": 30, "fixer": 240 },
    "stallMinutes": 15
  },
  "review": { "minFiles": 4 },
  "buildCommands": { "patterns": ["qftcmake*", "onespincmake*", "make*", "ninja*"], "timeoutMin": 120 },
  "askCommands": [],
  "taskDir": "~/.cache/opencode-multi-agent-team",
  "promptAppend": { "explorer": "~/.config/opencode/opencode-multi-agent-team/explorer_append.md" }
}
```

A role without a model gives a clear error at startup that names the role.

**[V2]:** `presets` (e.g. a `no-fuse` preset for projects outside home *(suggested)*),
`judge` settings, guard settings.

## 15. Project AGENTS.md (per codebase, not in the plugin)

Holds what agents would otherwise have to work out on every task:
- environment setup
- incremental and full builds, with durations
- where builds run (local, or ssh to which machine)
- single test and suite, and where logs end up
- docker/conan steps
- version control rules and forbidden actions

The plugin ships a template. For view2/view3 the user provides the recipes.

## 16. Repo layout

```
opencode-multi-agent-team/
  plan.md  README.md  package.json
  src/
    index.ts      entry: config, agents, tools, hooks
    config.ts     config
    agents.ts     agent definitions and permissions
    team.ts       team tool and state machine (sections 7–9)
    messages.ts   per-state hand-off prompts and the team tool's results
    state.ts      task state and task-folder files
    run.ts        runs one agent call (limits, stall, stop after report)
    runtime.ts    per-call counters shared by hooks and the report tool
    report.ts     report tool (schema per agent and state), DONE check
    guards.ts     exit codes, log trimming, timeouts, p4 edit, tool-call limits, hangs
    match.ts      glob and shell-command matching
    fallback.ts   backup models
    usage.ts      per-agent usage: calls, prompts, tool calls, tokens (section 12A)
  prompts/        <role>.md core prompts + <role>.instructions.md editable defaults
  examples/       opencode-multi-agent-team.json, AGENTS.md template
```

**[V2]:** `src/progress.ts` (digest, judge checkpoints), `prompts/judge.md`, `evals/`.

## 17. Taken from oh-my-opencode-slim

**Reused in V1 (ideas and prompt text, not code):**
- Explorer, Fixer and Oracle prompts as a starting point, plus the graph-first addition
- cache-safe prompts *(suggested)*
- backup models

**Candidates for V2:** tool-loop-guard, json-error-recovery, quota-aware fallback,
presets, the eval approach *(all suggested)*. Later, if needed: `doctor` setup check
(when sharing); path rescue.

**Left out:**
- an Orchestrator that does work
- reminder and wake hooks
- the background job system
- council, designer, observer, interview dashboard, companion, marketplace

## 18. Testing

Scenarios **S1–S14** (section 10) in a small throwaway C++ repo under home, with Slim
still installed.

**Checked for every scenario:**
- the expected hand-offs happen in the expected order (from `state.json`)
- the polisher made no read, search, shell or edit calls
- no agent other than Fixer edited anything
- the usage table per agent matches the expected split (section 12A)

Then real view2/view3 tasks with the project `AGENTS.md`, compared against section 1.
Any graph indexes created by tests are deleted.

## 19. Rollout: version 1 and version 2

**Version 1** (enough to replace Slim and measure):

1. **Prototype the uncertain V2-OpenCode parts *(verify)*:**
   1. Sessions created by the plugin show up in the TUI as children of the polisher's session.
   2. Permission prompts from those sessions reach the user.
   3. `team(stop)` interrupts the running agent (`ctx.session.interrupt`).
   4. Tools can be limited to certain agents (`report`, `team`, graph-only for senior).
   5. The shell `execute.after` hook sees the exit code and can replace the output.
   6. Token counts (input, cache read, output) and the number of model requests can be
      read per session, including the polisher's own turns.
   7. The user's answer can be taken word for word from their last message.
   8. The plugin can count an agent's tool calls and deny further calls with a message.
   9. The plugin can watch a running session for activity (stall detection).
2. Plugin skeleton, config, agent registration, prompts.
3. `team` state machine and `report` tool.
4. Guards (V1 rows of section 12), backup models, attempt and token tracking.
5. Scenarios S1–S14.
6. About 5 real tasks in view2/view3 with the project `AGENTS.md`.
7. Switch the default agent to `polisher`, remove Slim, write the README; the user pushes.

**Version 2** (each item only if `state.json` from real tasks shows the problem):

| Feature | Add when the data shows |
|---|---|
| judge (5.8) | plans repeating the same approach, or [Continue]/[Retry] decisions without a clear picture |
| same-error / no-change checks | the analyser answering `LOCAL` on repeated errors |
| loop and JSON guards | cheap models repeating calls or sending broken JSON |
| quota-aware fallback | repeated failed calls to a provider that's out of quota |
| presets (`no-fuse`) | real use outside home, or sharing with others |
| evals | prompt changes that need regression checks |
| parallel Fixers | plans with independent steps where speed matters |

## 20. Open questions and risks

- **Polisher model:** Kimi is the safe choice; test Luna on 5–6 real requests.
- **Speed:** one agent at a time, and a round trip per call. Parallel work in V2.
- **Fuse is a single local proxy:** if it goes down, most agents switch to backups.
- **Fixer iterating freely** relies on the tool-call limit (150) to catch runaways. Tune
  it from the first real tasks.
- **Cost display:** Fuse and Siemens show $0 in the token summary. Add prices to the
  provider config if the summary should show money.
- **Less flexible than an LLM orchestrator:** exceptions need explicit `team` options or config.
- **Edits are kept on stop or stuck.** Reverting is left to the user, because automatic
  reverts are a destructive action.
