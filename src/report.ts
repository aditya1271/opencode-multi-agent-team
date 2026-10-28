import type { Config } from "./config.ts"
import { commandParts } from "./match.ts"
import { runs, type Report, type ShellRun } from "./runtime.ts"
import type { Mode, TaskState } from "./state.ts"

const BASE: Record<Mode, string[]> = {
  triage: ["TRIVIAL", "ESCALATE", "QUESTIONS"],
  triage_fail: ["ESCALATE"],
  fix_trivial: ["DONE", "FAILED", "BLOCKED"],
  review_trivial: ["PASS", "ISSUES"],
  senior: ["PLAN", "NEED_INFO", "QUESTIONS", "ESCALATE"],
  explorer: ["FOUND", "NOT_FOUND"],
  oracle_review: ["APPROVE", "CHANGES"],
  fix: ["DONE", "FAILED", "BLOCKED"],
  diagnose: ["LOCAL", "REPLAN", "ESCALATE"],
  review: ["PASS", "ISSUES"],
  oracle_advice: ["ADVICE", "QUESTIONS"],
  triage_reply: ["ANSWER"],
  senior_reply: ["ANSWER"],
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
    if (task.trivialFailed && mode === "triage") list = ["ESCALATE"]
    if (task.forcePlan && mode === "triage") list = list.filter((s) => s !== "TRIVIAL")
    if (task.questionRounds >= config.limits.questionsPerTask) list = list.filter((s) => s !== "QUESTIONS")
    if (mode === "senior" && task.needInfo >= config.limits.needInfoPerTask) list = list.filter((s) => s !== "NEED_INFO")
  }
  return list
}

export function reportSchema(mode: Mode, statuses: string[]) {
  const properties: Record<string, unknown> = {
    status: { type: "string", enum: statuses },
    summary: { type: "string", description: "At most 5 lines, shown to the user." },
    content: { type: "string", description: "Markdown. The plugin writes it to the task folder." },
  }
  if (statuses.includes("QUESTIONS"))
    properties.questions = { type: "array", items: { type: "string" }, description: "Required for QUESTIONS." }
  if (mode === "senior") {
    properties.risk = { type: "string", enum: ["yes", "no"], description: "Required for PLAN: yes only for destructive or irreversible steps." }
    properties.steps = { type: "integer", minimum: 1, description: "Required for PLAN: number of plan steps." }
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
  },
  required: ["status", "summary", "content"],
}

export const REPORT_DESCRIPTION =
  "Finish your work by calling this exactly once. Only the listed statuses are valid now. After calling it, stop."

/** Validates and stores the report for the session. Throws a message the model sees. */
export function acceptReport(config: Config, sessionID: string, input: Report): string {
  const run = runs.get(sessionID)
  if (!run) throw new Error("report is only for team agents running a task.")
  const statuses = allowedStatuses(config, run.mode, run.task)
  if (!statuses.includes(input.status)) throw new Error(`Invalid status "${input.status}". Allowed now: ${statuses.join(", ")}.`)
  if (typeof input.summary !== "string" || typeof input.content !== "string") throw new Error("summary and content are required.")
  if (input.status === "QUESTIONS" && !input.questions?.length) throw new Error("QUESTIONS needs a non-empty questions list.")
  if (input.status === "PLAN") {
    if (input.risk !== "yes" && input.risk !== "no") throw new Error('PLAN needs risk: "yes" or "no".')
    if (!Number.isInteger(input.steps) || (input.steps ?? 0) < 1) throw new Error("PLAN needs steps: the number of plan steps.")
  }
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
  return "Report received. You are done; stop now without further text."
}
