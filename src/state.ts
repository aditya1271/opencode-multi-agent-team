import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { Role, WorkerRole } from "./config.ts"
import type { AgentUsage } from "./usage.ts"

export type Mode =
  | "lead"
  | "lead_fail"
  | "fix_trivial"
  | "review_trivial"
  | "architect"
  | "intern"
  | "principal_review"
  | "fix"
  | "diagnose"
  | "review"
  | "principal_advice"
  | "lead_reply"
  | "architect_reply"

export const MODE_ROLE: Record<Mode, WorkerRole> = {
  lead: "lead",
  lead_fail: "lead",
  fix_trivial: "developer",
  review_trivial: "reviewer",
  architect: "architect",
  intern: "intern",
  principal_review: "principal",
  fix: "developer",
  diagnose: "reviewer",
  review: "reviewer",
  principal_advice: "principal",
  lead_reply: "lead",
  architect_reply: "architect",
}

export type Phase = "running" | "checks" | "questions" | "approval" | "stuck" | "budget" | "done" | "stopped"
export const TERMINAL: Phase[] = ["done", "stopped"]

export interface Pending {
  mode: Mode
  /** Extra text for this hand-off: queries, analysis, comments. */
  note?: string
  /** Start a fresh session for the role. */
  fresh?: boolean
}

export interface HistoryEntry {
  n: number
  mode: Mode
  role: WorkerRole
  status: string
  summary: string
  file?: string
  step?: number
  plan?: number
}

export interface TaskState {
  id: string
  dir: string
  managerSession: string
  workspace: string
  created: number
  updated: number
  phase: Phase
  pending?: Pending
  questions?: string[]
  questionsFrom?: Mode
  askedAt?: number
  stuckReason?: string
  attempts: number
  attemptLimit: number
  sessions: Partial<Record<WorkerRole, string>>
  seq: Record<string, number>
  trivialFailed?: boolean
  /** The user asked for a plan: lead can't pick TRIVIAL. */
  forcePlan?: boolean
  /** The user chose to skip build and test: no check commands, builds are blocked. */
  skipChecks?: boolean
  plan: number
  planSteps: number
  planRisk: boolean
  planHadFailure: boolean
  step: number
  rounds: number
  planFailures: number
  principalAdviceUsed: number
  skipPrincipalReview: boolean
  needInfo: number
  questionRounds: number
  developerSeenPlan: boolean
  /** Files the architect hasn't seen yet. */
  architectUnseen: string[]
  editedFiles: string[]
  latestLog?: string
  history: HistoryEntry[]
  usage: Partial<Record<Role, AgentUsage>>
  managerBaseline?: { input: number; output: number; reasoning: number; cacheRead: number; prompts: number; tools: Record<string, number> }
  planSummary?: string
  principalNote?: string
  doneSummary?: string
}

export function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/, "") || "task"
  )
}

export function taskId(request: string, now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0")
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  return `${stamp}-${slug(request.split("\n").find((l) => l.trim() && !/^\W*goal\W*$/i.test(l.trim())) ?? request)}`
}

export function newTask(root: string, managerSession: string, workspace: string, request: string, attemptLimit: number): TaskState {
  const id = taskId(request)
  const dir = path.join(root, id)
  mkdirSync(path.join(dir, "logs"), { recursive: true })
  const now = Date.now()
  return {
    id,
    dir,
    managerSession,
    workspace,
    created: now,
    updated: now,
    phase: "running",
    attempts: 0,
    attemptLimit,
    sessions: {},
    seq: {},
    plan: 0,
    planSteps: 0,
    planRisk: false,
    planHadFailure: false,
    step: 0,
    rounds: 0,
    planFailures: 0,
    principalAdviceUsed: 0,
    skipPrincipalReview: false,
    needInfo: 0,
    questionRounds: 0,
    developerSeenPlan: false,
    architectUnseen: [],
    editedFiles: [],
    history: [],
    usage: {},
  }
}

export function save(task: TaskState) {
  task.updated = Date.now()
  writeFileSync(path.join(task.dir, "state.json"), JSON.stringify(task, null, 2))
}

export function writeFile(task: TaskState, name: string, content: string) {
  writeFileSync(path.join(task.dir, name), content.endsWith("\n") ? content : content + "\n")
}

export function appendFile(task: TaskState, name: string, content: string) {
  appendFileSync(path.join(task.dir, name), content.endsWith("\n") ? content : content + "\n")
}

/** Writes `<kind>-N.md` with the next number and returns its name. */
export function writeNumbered(task: TaskState, kind: string, content: string): string {
  const n = (task.seq[kind] ?? 0) + 1
  task.seq[kind] = n
  const name = `${kind}-${n}.md`
  writeFile(task, name, content)
  return name
}

export function readTaskFile(task: TaskState, name: string): string {
  const file = path.join(task.dir, name)
  return existsSync(file) ? readFileSync(file, "utf8").trim() : ""
}

export function nextLogPath(task: TaskState): string {
  const n = (task.seq.log ?? 0) + 1
  task.seq.log = n
  return path.join(task.dir, "logs", `log-${n}.txt`)
}

const OLD_NAMES: Record<string, string> = {
  polisher: "manager",
  triage: "lead",
  senior: "architect",
  explorer: "intern",
  fixer: "developer",
  analyser: "reviewer",
  oracle: "principal",
}
const OLD_NAME = new RegExp(Object.keys(OLD_NAMES).join("|"), "gi")

/** Saved data from before the agents were renamed: renames quoted identifiers ("senior", "seniorUnseen", "oracle_advice"), not free text. */
export const migrateNames = (json: string) =>
  json.replace(/"[A-Za-z_]+"/g, (token) =>
    token.replace(OLD_NAME, (w) => {
      const n = OLD_NAMES[w.toLowerCase()]
      return w[0] === w[0].toUpperCase() ? n[0].toUpperCase() + n.slice(1) : n
    }),
  )

export function loadTask(dir: string): TaskState | undefined {
  try {
    return JSON.parse(migrateNames(readFileSync(path.join(dir, "state.json"), "utf8"))) as TaskState
  } catch {
    return undefined
  }
}

/** Most recent task started from this manager session. */
export function findTask(root: string, managerSession: string): TaskState | undefined {
  if (!existsSync(root)) return undefined
  const dirs = readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .reverse()
  for (const name of dirs) {
    const task = loadTask(path.join(root, name))
    if (task?.managerSession === managerSession) return task
  }
  return undefined
}
