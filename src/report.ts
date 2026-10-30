import type { Config } from "./config.ts"
import { commandParts } from "./match.ts"
import { runs, type Report, type ShellRun } from "./runtime.ts"
import { checkEdits, missingRecommendations, missingSummaries, shownTitle, splice, split } from "./sections.ts"
import { consultSide, consultsUsed, draftIsDoc, isDocWorkflow, isScopedWriter, readTaskFile, scopedFile, type Mode, type TaskState } from "./state.ts"

const SECTION_EDIT = {
  type: "object",
  properties: {
    id: { type: "string" },
    content: { type: "string" },
    reason: { type: "string" },
    after: { type: "string" },
  },
  required: ["id", "content"],
  additionalProperties: false,
}

const BASE: Record<Mode, string[]> = {
  analyst: ["TRIVIAL", "ESCALATE", "QUESTIONS", "NEED_INFO", "CONSULT", "INFEASIBLE", "STUCK"],
  analyst_fail: ["ESCALATE"],
  fix_trivial: ["DONE", "FAILED", "BLOCKED"],
  review_trivial: ["PASS", "ISSUES"],
  planner: ["PLAN", "ASK", "QUESTIONS", "ESCALATE", "INFEASIBLE", "STUCK"],
  intern: ["FOUND", "NOT_FOUND"],
  architect_review: ["APPROVE", "CHANGES", "ASK"],
  fix: ["DONE", "FAILED", "BLOCKED", "CONSULT"],
  diagnose: ["LOCAL", "REPLAN", "ESCALATE"],
  review: ["PASS", "ISSUES"],
  architect_advice: ["ADVICE", "QUESTIONS", "ASK"],
  analyst_reply: ["ANSWER"],
  planner_reply: ["ANSWER"],
  architect_reply: ["ANSWER"],
  architect_doc_review: ["APPROVE", "CHANGES", "ASK"],
  analyst_answer: ["ANSWER", "NEED_INFO"],
  planner_advice: ["ADVICE", "ASK"],
  architect_draft_advice: ["ADVICE", "ASK"],
  planner_consult: ["ANSWER"],
  planner_stepfix: ["STEP", "REPLAN"],
}

/** A plan step's first line: `N. **Title**: <what the step achieves>`. */
const STEP_LINE = /^\d+\.\s+\*\*.+?\*\*:?\s*\S/

/** CONSULT needs the facts the question rests on: the Planner can't look them up. */
const EVIDENCE = /```|\S+:\d+/

const ADVICE_MODES: Mode[] = ["planner_advice", "architect_draft_advice"]

/** STUCK: the writer can't resolve the user's comments (Analyst on its brief, the Planner on its draft). */
const mayBeStuck = (mode: Mode, task: TaskState) =>
  !!task.commentRounds && (mode === "planner" || (mode === "analyst" && !task.revising && !task.doc && !task.plan))

/** Code task, Analyst's first sort: ESCALATE must say whether the request already fixes the behaviour. */
const needsWhat = (mode: Mode, task?: TaskState) =>
  mode === "analyst" && !!task && !task.workflow && !task.stage && !task.revising && !task.trivialFailed

/** Rounds of questions to Analyst (or the Intern, in research): per research depth, else the task-wide limit. */
export function needInfoLimit(config: Config, task: TaskState): number {
  if (task.workflow === "research" && task.depth) return config.workflows.research.internRounds[task.depth]
  return config.limits.needInfoPerTask
}

/** Why a DONE doesn't hold: the check command wasn't run in this call, or its real exit code wasn't 0. */
export function checkProblem(checkCommand: string, shells: ShellRun[]): string | undefined {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim()
  const check = norm(checkCommand)
  const last = (s: string) => commandParts(s).at(-1)
  const match = [...shells].reverse().find((s) => {
    const cmd = norm(s.command)
    return cmd.includes(check) || last(cmd) === last(check)
  })
  if (!match) return `the check command \`${check}\` was not run in this call`
  const cmd = norm(match.command)
  const after = cmd.includes(check) ? cmd.slice(cmd.lastIndexOf(check) + check.length) : ""
  if (/[|;&]/.test(after.replace(/\d?>&\d/g, "").replace(/^\s*&&[\s\S]*$/, "")))
    return `the check command \`${check}\` was piped or followed by another command, so its exit code is unknown; run it exactly as written`
  if (match.exit !== 0) return `the check command \`${check}\` exited with ${match.exit ?? "unknown"}`
  return undefined
}

/** Statuses the agent may report now; per-task caps remove statuses. */
export function allowedStatuses(config: Config, mode: Mode, task?: TaskState): string[] {
  let list = BASE[mode]
  if (task) {
    if (task.trivialFailed && mode === "analyst") list = ["ESCALATE"]
    if ((task.forcePlan || isDocWorkflow(task) || task.stage) && mode === "analyst") list = list.filter((s) => s !== "TRIVIAL")
    // Only the how stage can find an approved what-decision unworkable.
    if (task.stage !== "how" || !task.doc || task.revising) list = list.filter((s) => s !== "INFEASIBLE")
    if (!mayBeStuck(mode, task)) list = list.filter((s) => s !== "STUCK")
    if (task.workflow === "research" && mode === "planner") list = list.map((s) => (s === "ASK" ? "NEED_INFO" : s))
    if (draftIsDoc(task) && mode === "planner") list = list.map((s) => (s === "PLAN" ? "DOC" : s))
    if (task.questionRounds >= config.limits.questionsPerTask) list = list.filter((s) => s !== "QUESTIONS")
    const side = consultSide(mode)
    if (side && consultsUsed(task, side) >= (side === "developer" ? config.limits.consultsPerStep : config.limits.consultsPerBrief))
      list = list.filter((s) => s !== "CONSULT")
    if (mode === "analyst" || mode === "analyst_answer") {
      if ((task.analystSearches ?? 0) >= config.limits.analystSearchRounds) list = list.filter((s) => s !== "NEED_INFO")
    } else if (task.needInfo >= needInfoLimit(config, task)) list = list.filter((s) => s !== "NEED_INFO" && s !== "ASK")
  } else list = list.filter((s) => s !== "INFEASIBLE" && s !== "STUCK" && s !== "CONSULT")
  return list
}

export function reportSchema(mode: Mode, statuses: string[], task?: TaskState) {
  const properties: Record<string, unknown> = {
    status: { type: "string", enum: statuses },
    summary: { type: "string", description: "At most 5 lines, shown to the user." },
    content: { type: "string", description: "Markdown. The plugin writes it to the task folder." },
  }
  const asks = [statuses.includes("QUESTIONS") && "QUESTIONS (to the user)", statuses.includes("ASK") && "ASK (to Analyst)", statuses.includes("CONSULT") && "CONSULT (to the Planner)"].filter(Boolean)
  if (asks.length)
    properties.questions = { type: "array", items: { type: "string" }, description: `Required for ${asks.join(" and ")}: one question per item.` }
  if (needsWhat(mode, task) && statuses.includes("ESCALATE"))
    properties.what = { type: "string", enum: ["settled", "open"], description: "Required for ESCALATE: settled when the request already fixes the behaviour, else open." }
  if (mode === "analyst" && task?.workflow === "research")
    properties.depth = { type: "string", enum: ["quick", "breadth", "depth"], description: "Required for ESCALATE: how big the research is." }
  if (mode === "planner" && statuses.includes("PLAN")) {
    properties.risk = { type: "string", enum: ["yes", "no"], description: "Required for PLAN: yes only for destructive or irreversible steps." }
    properties.steps = { type: "integer", minimum: 1, description: "Required for PLAN: number of plan steps." }
  }
  if (statuses.includes("STEP"))
    properties.risk = { type: "string", enum: ["yes", "no"], description: "Required for STEP: yes only if the new step(s) are destructive or irreversible." }
  if (ADVICE_MODES.includes(mode))
    properties.items = { type: "array", items: { type: "string" }, description: "Required for ADVICE: one concrete instruction per item, unnumbered." }
  if ((mode === "analyst" || mode === "planner") && task?.pending?.adviceIds?.length)
    properties.addressed = { type: "string", description: `Required for your draft: how you handled each advice item, one line per id (${task.pending.adviceIds.join(", ")}).` }
  if (isScopedWriter(mode, task))
    properties.sections = {
      type: "array",
      items: SECTION_EDIT,
      description: "Required for your revised draft: only the sections that change (id, the whole section from its heading line; reason for one outside the scope; id \"new\" with after for a new one).",
    }
  if (mode === "fix" || mode === "fix_trivial")
    properties.checkCommand = { type: "string", description: "Required for DONE: the exact check command you ran last." }
  return { type: "object", properties, required: ["status", "summary", "content"], additionalProperties: false }
}

/** Registered schema: accepts every field. Each agent sees a narrowed schema (context hook), and acceptReport validates. */
export const REPORT_INPUT = {
  type: "object",
  properties: {
    status: { type: "string" },
    summary: { type: "string" },
    content: { type: "string" },
    questions: { type: "array", items: { type: "string" } },
    risk: { type: "string" },
    steps: { type: "integer" },
    checkCommand: { type: "string" },
    depth: { type: "string" },
    what: { type: "string" },
    items: { type: "array", items: { type: "string" } },
    addressed: { type: "string" },
    sections: { type: "array", items: SECTION_EDIT },
  },
  required: ["status", "summary", "content"],
}

export const REPORT_DESCRIPTION =
  "Finish your work by calling this exactly once. Only the listed statuses are valid now. After calling it, stop."

/**
 * Briefs, documents and plans the user reviews: each reviewed section opens with a Summary line and ends with the writer's pick. A brief counts only
 * with its "Concept brief" or "Research brief" heading (how-stage briefs aren't shown to the user). A scoped revision
 * is checked as merged into the previous version.
 */
function recommendProblem(role: string, input: Report, task: TaskState | undefined, scoped: boolean): string | undefined {
  const analyst = role === "analyst" && input.status === "ESCALATE"
  if (!analyst && !(role === "planner" && (input.status === "DOC" || input.status === "PLAN"))) return undefined
  let text = input.content
  // A scoped revision answers only for the sections it returns: the others it may not touch.
  let returned: Set<string> | undefined
  if (scoped && task?.sections && input.sections?.length) {
    try {
      text = splice(readTaskFile(task, scopedFile(task)), task.sections, input.sections, task.scope?.finetune ?? []).text
    } catch {
      return undefined
    }
    returned = new Set(input.sections.flatMap((e) => split(e.content, true).sections.map((s) => shownTitle(s.title).replace(/^#+\s*/, ""))))
  }
  const check = (f: (text: string, under?: string) => string[]) =>
    (analyst ? [...f(text, "Concept brief"), ...f(text, "Research brief")] : f(text)).filter((t) => !returned || returned.has(t))
  const missing = check(missingRecommendations)
  const unsummed = check(missingSummaries)
  if (!missing.length && !unsummed.length) return undefined
  return [
    missing.length
      ? `Every section the user reviews ends with a line "**Recommended:** <option>: <short reason>" (several choices in one section: the pick for each, in that line; nothing to decide: "**Recommended:** as written"). Missing in: ${missing.join("; ")}.`
      : "",
    unsummed.length
      ? `Every section the user reviews opens with a line "**Summary:** <1-3 plain sentences: the direction and why, not the mechanics>", and every plan step's first line is "N. **Title**: <one sentence on what the step achieves>". The user sees only those lines unless they ask for details. Missing in: ${unsummed.join("; ")}.`
      : "",
    scoped ? "Return those sections too, with only the missing lines added." : "",
  ]
    .filter(Boolean)
    .join(" ")
}

/** Validates and stores the report for the session. Throws a message the model sees. */
export function acceptReport(config: Config, sessionID: string, input: Report): string {
  const run = runs.get(sessionID)
  if (!run) throw new Error("report is only for team agents running a task.")
  const statuses = allowedStatuses(config, run.mode, run.task)
  if (!statuses.includes(input.status)) throw new Error(`Invalid status "${input.status}". Allowed now: ${statuses.join(", ")}.`)
  if (typeof input.summary !== "string" || typeof input.content !== "string") throw new Error("summary and content are required.")
  if ((input.status === "QUESTIONS" || input.status === "ASK" || input.status === "CONSULT") && !input.questions?.length) throw new Error(`${input.status} needs a non-empty questions list.`)
  if (input.status === "CONSULT" && !EVIDENCE.test(input.content))
    throw new Error("CONSULT needs the evidence in content: the Planner has no file access. Quote the code (`path:line` and the lines, in a code block) and the exact output or facts the question rests on.")
  if (input.status === "ESCALATE" && needsWhat(run.mode, run.task)) {
    if (input.what !== "settled" && input.what !== "open") throw new Error('ESCALATE needs what: "settled" or "open".')
    if (input.what === "settled" && !/^#+\s*Why the behaviour is settled/im.test(input.content))
      throw new Error('what "settled" needs a "## Why the behaviour is settled" section at the top of content.')
  }
  if (input.status === "ADVICE" && ADVICE_MODES.includes(run.mode) && !input.items?.length) throw new Error("ADVICE needs a non-empty items list.")
  const adviceIds = run.mode === "analyst" || run.mode === "planner" ? (run.task?.pending?.adviceIds ?? []) : []
  if (adviceIds.length && ["ESCALATE", "DOC", "PLAN"].includes(input.status)) {
    const missing = adviceIds.filter((id) => !new RegExp(`\\b${id}\\b`).test(input.addressed ?? ""))
    if (missing.length) throw new Error(`addressed must say how you handled every advice item by id; missing: ${missing.join(", ")}.`)
  }
  const task = run.task
  // With every section open and none final, the whole draft is as good as sections.
  const whole = task?.scope?.open && !task.sections?.final.length && !input.sections?.length
  if (["ESCALATE", "DOC", "PLAN"].includes(input.status) && isScopedWriter(run.mode, task) && !whole && task) {
    const errors = checkEdits(task.sections!, task.scope!, input.sections, readTaskFile(task, scopedFile(task)))
    if (errors.length) throw new Error(`This revision is scoped:\n- ${errors.join("\n- ")}`)
  }
  const recommendErr = recommendProblem(run.role, input, task, !whole && isScopedWriter(run.mode, task))
  if (recommendErr) throw new Error(recommendErr)
  if (run.mode === "analyst_answer") {
    const missing = (run.task?.pending?.ids ?? []).filter((id) => !new RegExp(`\\b${id}\\b`).test(input.content))
    if (missing.length) throw new Error(`Answer every question by its id; missing: ${missing.join(", ")}.`)
  }
  if (input.status === "STEP") {
    if (input.risk !== "yes" && input.risk !== "no") throw new Error('STEP needs risk: "yes" or "no".')
    const { head, sections } = split(input.content.trim(), true)
    if (head.trim() || !sections.length || sections.length > 2 || sections.some((s) => !s.step || !STEP_LINE.test(s.text.split("\n")[0]!)))
      throw new Error(
        "STEP content is only the step(s) that replace the blocked one: one step, or two when a new step must come first. Each starts with `N. **Title**: <what the step achieves>`, the details on the next lines. Nothing before the first step.",
      )
  }
  if (input.status === "PLAN") {
    if (input.risk !== "yes" && input.risk !== "no") throw new Error('PLAN needs risk: "yes" or "no".')
    if (!Number.isInteger(input.steps) || (input.steps ?? 0) < 1) throw new Error("PLAN needs steps: the number of plan steps.")
  }
  if (input.status === "ESCALATE" && run.mode === "analyst" && run.task?.workflow === "research" && !run.task.revising && !["quick", "breadth", "depth"].includes(input.depth ?? ""))
    throw new Error('ESCALATE needs depth: "quick", "breadth" or "depth".')
  const skip = run.task?.skipChecks
  if (input.status === "DONE" && !skip && !input.checkCommand?.trim()) throw new Error("DONE needs checkCommand: the check command you ran.")
  if (run.report) return "Already reported. Stop now."
  if (input.status === "DONE" && !skip) {
    const why = checkProblem(input.checkCommand ?? "", run.shells)
    if (why)
      throw new Error(
        run.toolCalls >= run.toolLimit
          ? `DONE not accepted: ${why}. You have no tool calls left: report FAILED with what you have.`
          : `DONE not accepted: ${why}. Run the check command now, in this call, then report DONE if it exits 0, otherwise FAILED.`,
      )
  }
  run.report = { ...input, summary: input.summary.split("\n").slice(0, 5).join("\n") }
  return "Report received. You are done; reply with the single word: done."
}
