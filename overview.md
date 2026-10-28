# opencode-multi-agent-team: workflow overview

A multi-agent coding workflow for OpenCode. Version 1 is built and tested on a sandbox
project; feedback on the workflow itself is welcome.

## The problem

With a single "orchestrator" agent, the main agent ends up doing most of the work itself:
searching, building, reading long logs. Every log stays in its context and is re-sent on
every turn, so cost grows fast. It also takes destructive actions (reset, clean, delete)
without a plan or review.

## Core ideas

1. **Fixed routing.** A fixed workflow decides which agent runs next. No model decides
   where work goes.
2. **One owner per job.** Each kind of decision belongs to exactly one agent.
3. **One agent talks to the user.** The others return results and questions in a fixed
   format.
4. **The user is the check** where they look anyway (the request, the plan). Automatic
   checks are used only where nobody looks.
5. **Cheap models do most of the work.** Strong models are used only for planning and for
   expert advice.
6. **Don't cut good work short.** An agent keeps going until it's done or stuck. Limits
   catch runaways, not normal work.
7. **Least tools.** Each agent can use only the tools its job needs. For example, only
   Developer edits files, and the Manager can't read or run anything.
8. **"Done" is checked, not claimed.** A step counts as done only if its check command
   (build or test) really ran in that call and passed.

## Agents

| Agent | Job | Model tier |
|---|---|---|
| **Manager** | Talks to the user. Rewrites the request into Goal / Scope / Constraints / Done when / Unclear points and asks for confirmation. | cheap |
| **Lead** | Searches the code and decides: trivial, or needs a plan. Writes a brief including the relevant code excerpts. | cheap |
| **Architect** | Writes plans with exact file locations and a check command for each step. Flags destructive plans. | strong |
| **Intern** | Does larger code searches for Architect, and answers the user's code questions. | cheap |
| **Developer** | The only agent that edits files and runs builds and tests. Iterates on errors until done or stuck. | cheap |
| **Reviewer** | Diagnoses failures, looking at all attempts on the step. Reviews finished work when needed. | mid |
| **Principal** | Reviews destructive plans. Gives expert advice when stuck, at most once per task. | strongest |

Each agent's code-search tools (a code graph, clangd, a docs RAG, …) and working
instructions are set in the config. Its role, its report outcomes and the safety rules are
fixed.

## Flow

```
user ─► Manager ─► [Send] [Edit] [Cancel]
                       │
                       ▼
                    Lead ──── trivial ───► Developer ─► done
                       │                       (more than 1 file touched → quick review)
                       │ needs a plan
                       ▼
                    Architect ⇄ Intern (searches)
                       │ plan
                       ├── destructive? ─► Principal review
                       ▼
                 user approves the plan (free reply)
                       │
                       ▼
                 Developer: step 1 … last step (full build/test)
                       │ stuck on a step
                       ▼
                    Reviewer
                       ├─ fixable here     ─► back to Developer (max 2 rounds per step)
                       ├─ plan is wrong    ─► Architect writes a new plan
                       └─ unclear          ─► Principal advice ─► Architect
```

**Code questions** go straight to Intern, and the answer comes back to the user. A
question asked **while a task waits on the user** goes to the agent the task waits on
(Architect, or Lead before there's a plan), which knows the task. The task doesn't move.
The user can ask for a plan, which takes the trivial path away from Lead. The Manager
never answers the user itself; it only rewrites and forwards.

## User touchpoints

- **Confirm the request** after it's rewritten. Replies during the task (answers, plan
  comments, questions) are rewritten and confirmed the same way; agents also get the
  user's original words.
- **Build and test commands** are set per project. Agents never work out how to build. If
  none are set, the task first asks the user for them, or the user skips build and test
  (the result then says "not built or tested").
- **Answer questions.** Only Lead, Architect and Principal can ask them.
- **Approve every plan,** together with Principal's notes on destructive plans.
- **Allow or deny dangerous commands** (reset, clean, delete, revert, submit) when they run.
- **Decide when stuck:** retry, continue with more attempts, or stop.
- **Stop at any time.** Edits are kept and listed, never reverted automatically.

## What counts as "destructive"

Deleting files outside build folders, git reset/clean/push, Perforce revert/submit/delete,
and changing shared caches or machines. Routine builds are **not** destructive, even
over ssh or in docker.

## Review after the work

The Reviewer reviews the finished work only if:
- the plan had a failure,
- the plan was destructive, or
- more than 3 files changed.

Otherwise the passing full build/test means done.

## Stopping: no endless loops

Every task ends as **done**, **stopped** or **stuck**:

- **Attempt budget:** 40 agent calls per task. When it's used up, the user chooses
  [Continue +10] or [Stop]. Tokens and time are not limited, only shown.
- **Developer rounds:** at most 2 fix-ups per step from the Reviewer. After that, the plan
  counts as failed.
- **Failed plans:** 2, then Principal advice once, then one more plan, then the user decides.
- **Circling:** the Reviewer sees every attempt on a step. If the same error comes back
  or a fix undoes an earlier one, it sends the step back for a new plan instead of
  another round.
- **Searches and questions:** capped per task.
- **Per agent call:** a tool-call limit, and protection against hung agents or commands.
- **One exit:** every limit ends in the same report to the user: what was tried, the
  last errors, and the files changed. Nothing retries silently.

## Usage report per agent

After every task, in every stuck report, and on request, the user sees one row per agent:
calls, prompts processed, tool calls, input / cache / output tokens, and the model used.
A totals view over the last N tasks shows each agent's share. This makes it visible
whether the work is divided as intended. For example:
- the Manager should do no searching or editing
- Developer should carry most of the tool calls
- the Reviewer and Principal should be called rarely

Agents far outside their expected share are pointed out. The report is for information
only and never stops a task.

## Typical cost

| Task | Agent calls | Strong-model calls |
|---|---|---|
| Trivial | 2–3 | 0 |
| Planned, going well | about 5–7 | 1 (the plan) |
| Destructive plan | +2 (Principal review, final review) | +1 (Principal review) |

Measured on the sandbox: a trivial change took 2 agent calls, and a 3-step plan took 5. A
destructive 4-step plan with one round of user changes took 9.

## Later, only if real use shows the need

- A **judge** agent that checks across plans whether the task is going in circles.
- Automatic detection of identical errors or unchanged edits.
- Parallel Developers for independent steps.

## Questions for reviewers

- Is any role unnecessary, or is a role missing?
- Are the user touchpoints right: too many, or too few?
- Are the limits sensible (40 attempts, 2 rounds per step, 2 failed plans)?
- Is "destructive only" the right trigger for the expert review?
- Any failure case where this workflow would loop, stall or waste effort?
