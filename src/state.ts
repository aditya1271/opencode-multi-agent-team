import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { Role, WorkerRole } from "./config.ts"
import type { Scope, SectionChange, SectionIndex } from "./sections.ts"
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
  | "principal_reply"
  | "principal_doc_review"
  | "lead_answer"
  | "architect_advice"
  | "principal_draft_advice"

/** Who advises a writer the user keeps sending back, in order (see limits.escalateAfterComments). */
export const LADDER: Record<"lead" | "architect", Mode[]> = {
  lead: ["architect_advice", "principal_draft_advice"],
  architect: ["principal_draft_advice"],
}

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
  principal_reply: "principal",
  principal_doc_review: "principal",
  lead_answer: "lead",
  architect_advice: "architect",
  principal_draft_advice: "principal",
}

/** code: change files (the default). plan: write a plan document. research: write a findings report. */
export type Workflow = "code" | "plan" | "research"
export const WORKFLOWS: Workflow[] = ["code", "plan", "research"]
export type ResearchDepth = "quick" | "breadth" | "depth"
export const isDocWorkflow = (task: { workflow?: Workflow }) => task.workflow === "plan" || task.workflow === "research"

/** Plan and non-trivial code tasks: first WHAT (code-independent behaviour), then HOW (the change plan). */
export type Stage = "what" | "how"

/** The Architect's next draft is a document (what-document, research report), not a step plan. */
export const draftIsDoc = (task: { workflow?: Workflow; stage?: Stage }) =>
  task.workflow === "research" || task.stage === "what" || (task.workflow === "plan" && task.stage !== "how")

/** The draft a scoped revision changes: Lead's brief, or the Architect's latest document or plan. */
export const scopedFile = (task: TaskState) =>
  task.scope?.draft === "brief" ? briefName(task) : draftIsDoc(task) ? `doc-${task.doc}.md` : `plan-${task.plan}.md`

/** This agent writes a scoped revision: it returns sections, not the whole draft. */
export const isScopedWriter = (mode: Mode, task: TaskState | undefined) =>
  !!task?.scope && !!task.sections && ((mode === "lead" && task.scope.draft === "brief" && !task.revising) || (mode === "architect" && task.scope.draft === "draft"))

/** Lead's brief for the current stage. */
export const briefName = (task: { stage?: Stage }) => (task.stage === "how" ? "how-brief.md" : "brief.md")

/** The user's answers and comments for the current stage; the how stage starts its own. */
export const answersName = (task: { stage?: Stage }) => (task.stage === "how" ? "how-answers.md" : "answers.md")

/** Lead's answers to the Architect's or Principal's questions in the current stage, oldest first. */
export const answerFiles = (task: TaskState): string[] => {
  const kind = `${briefName(task).slice(0, -3)}-answer`
  return Array.from({ length: task.seq[kind] ?? 0 }, (_, i) => `${kind}-${i + 1}.md`)
}

export type Phase = "running" | "checks" | "questions" | "brief" | "approval" | "stuck" | "budget" | "done" | "stopped"
export const TERMINAL: Phase[] = ["done", "stopped"]

export interface Pending {
  mode: Mode
  /** Extra text for this hand-off: queries, analysis, comments. */
  note?: string
  /** Start a fresh session for the role. */
  fresh?: boolean
  /** A revision Principal asked for: its review file is shown with the revised plan or document. */
  afterReview?: string
  /** Lead hand-off of the user's comments on the document (`note`), for a revision brief. */
  revision?: boolean
  /** lead_answer: the question ids Lead must answer, and the mode that asked. */
  ids?: string[]
  asker?: Mode
  /** Task files delivered with this hand-off (a continuing session sees them once). */
  files?: string[]
  /** Advice modes: whose draft is advised on, and the writer's hand-off that runs after the advice. */
  advise?: "lead" | "architect"
  then?: Pending
  /** The advice items (ADV1, …) the writer must address in `addressed`. */
  adviceIds?: string[]
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
  /** The stage run the entry belongs to (see TaskState.stageRun). */
  stageRun?: number
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
  /** Missing on tasks from before workflows: code. */
  workflow?: Workflow
  /** plan/research: the document file in the project (absolute path). */
  output?: string
  /** research: Lead's sizing; sets the Intern rounds. */
  depth?: ResearchDepth
  /** plan/research: the latest document (doc-N.md) and its summary. */
  doc?: number
  docSummary?: string
  /** The user asked for Principal's review in the request: it runs before the first approval. */
  reviewFirst?: boolean
  /** Principal reviews the user asked for. */
  reviews?: number
  /** The user commented on the document: Lead is writing a revision brief for the Architect. */
  revising?: boolean
  /** Plan and non-trivial code tasks: the current stage. */
  stage?: Stage
  /** Counts stage changes; a fresh session gets only the files of the current run. */
  stageRun?: number
  /** Lead's and the Architect's what-stage sessions, kept while the how stage runs in fresh ones. */
  whatSessions?: Partial<Record<WorkerRole, string>>
  /** The how stage found a what-decision unworkable (infeasible-N.md); the user decides. */
  infeasible?: string
  /** Questions asked of Lead so far (ids A1, A2, …). */
  askSeq?: number
  /** Rounds of user comments on the current brief or document, and the advisers already used on it. */
  commentRounds?: number
  advisors?: Mode[]
  adviceFiles?: string[]
  /** The advice the current version follows, shown to the user. */
  lastAdvice?: { role: string; file: string }
  /** Advice items given so far (ids ADV1, ADV2, …). */
  adviceSeq?: number
  /** Section ids of the current brief or draft, and the ones the user marked final. */
  sections?: SectionIndex
  /** The sections the pending revision may change (from the user's comments). */
  scope?: Scope
  /** What the last scoped revision changed, shown to the user. */
  sectionChange?: SectionChange
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

/** Told about every task file written (with its content before), so it can show in the user's edited files. */
let onWrite: ((task: TaskState, file: string, before: string | undefined) => void) | undefined
export function setOnWrite(fn: typeof onWrite) {
  onWrite = fn
}

function written(task: TaskState, file: string, write: () => void) {
  const before = onWrite && existsSync(file) ? readFileSync(file, "utf8") : undefined
  write()
  onWrite?.(task, file, before)
}

export function writeFile(task: TaskState, name: string, content: string) {
  const file = path.join(task.dir, name)
  written(task, file, () => writeFileSync(file, content.endsWith("\n") ? content : content + "\n"))
}

export function appendFile(task: TaskState, name: string, content: string) {
  const file = path.join(task.dir, name)
  written(task, file, () => appendFileSync(file, content.endsWith("\n") ? content : content + "\n"))
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
