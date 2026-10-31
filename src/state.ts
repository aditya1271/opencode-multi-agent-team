import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { Role, WorkerRole } from "./config.ts"
import type { Scope, SectionChange, SectionIndex } from "./sections.ts"
import type { AgentUsage } from "./usage.ts"

/** The user goes through a draft one section at a time; the replies go to the team together at the end. */
export interface Walk {
  /** The sections index key the walk belongs to. */
  key: string
  ids: string[]
  at: number
  replies: { id: string; verdict: "ok" | "skip" | "finetune" | "revise"; note?: string }[]
  /** The user asked to see the remaining sections at once. */
  rest?: boolean
  /** Every section was gone through without comments: waits for the approval. */
  done?: boolean
  /** The walk runs in a TUI dialog: comments and questions are collected there, as typed, and handled together at the end. */
  dialog?: {
    comments: { id: string; text: string }[]
    questions: { id: string; text: string }[]
    /** Unset while the dialog is open. */
    end?: DialogEnd
  }
}

/** How the user left the review dialog: went through every section, chose to see the rest at once, approved, or stopped. */
export type DialogEnd = "done" | "rest" | "approve" | "stop"

export type Mode =
  | "analyst"
  | "analyst_fail"
  | "fix_trivial"
  | "review_trivial"
  | "planner"
  | "intern"
  | "architect_review"
  | "fix"
  | "diagnose"
  | "review"
  | "architect_advice"
  | "analyst_reply"
  | "planner_reply"
  | "architect_reply"
  | "architect_doc_review"
  | "analyst_answer"
  | "planner_advice"
  | "architect_draft_advice"
  | "planner_consult"
  | "planner_stepfix"
  | "operator"

/** Who asks the Planner a question mid-work (status CONSULT); each has its own pair session with the Planner. */
export type ConsultSide = "developer" | "analyst"
export const consultSide = (mode: Mode): ConsultSide | undefined => (mode === "fix" ? "developer" : mode === "analyst" ? "analyst" : undefined)

/**
 * What a pair session is about: when it changes, the next question starts a fresh Planner session. Developer: the
 * approved plan. Analyst: the stage, the brief it writes, and each round of the user's comments.
 */
export const pairKey = (task: TaskState, side: ConsultSide) =>
  side === "developer" ? `plan-${task.plan}` : `stage-${task.stageRun ?? 0}-comments-${task.commentRounds ?? 0}-doc-${task.doc ?? 0}-plan-${task.plan}${task.revising ? "-revising" : ""}`

/** What the question limit counts over: one plan step for Developer (limits.consultsPerStep), one brief for Analyst (limits.consultsPerBrief). */
export const consultKey = (task: TaskState, side: ConsultSide) => (side === "developer" ? `plan-${task.plan}-step-${task.step}` : pairKey(task, "analyst"))

export const consultsUsed = (task: TaskState, side: ConsultSide) => {
  const c = task.consults?.[side]
  return c?.key === consultKey(task, side) ? c.n : 0
}

/** Who advises a writer the user keeps sending back, in order (see limits.escalateAfterComments). */
export const LADDER: Record<"analyst" | "planner", Mode[]> = {
  analyst: ["planner_advice", "architect_draft_advice"],
  planner: ["architect_draft_advice"],
}

export const MODE_ROLE: Record<Mode, WorkerRole> = {
  analyst: "analyst",
  analyst_fail: "analyst",
  fix_trivial: "developer",
  review_trivial: "reviewer",
  planner: "planner",
  intern: "intern",
  architect_review: "architect",
  fix: "developer",
  diagnose: "reviewer",
  review: "reviewer",
  architect_advice: "architect",
  analyst_reply: "analyst",
  planner_reply: "planner",
  architect_reply: "architect",
  architect_doc_review: "architect",
  analyst_answer: "analyst",
  planner_advice: "planner",
  architect_draft_advice: "architect",
  planner_consult: "planner",
  planner_stepfix: "planner",
  operator: "operator",
}

/** code: change files (the default). plan: write a plan document. research: write a findings report. */
export type Workflow = "code" | "plan" | "research"
export const WORKFLOWS: Workflow[] = ["code", "plan", "research"]
export type ResearchDepth = "quick" | "breadth" | "depth"
export const isDocWorkflow = (task: { workflow?: Workflow }) => task.workflow === "plan" || task.workflow === "research"

/** Plan and non-trivial code tasks: first WHAT (code-independent behaviour), then HOW (the change plan). */
export type Stage = "what" | "how"

/** The Planner's next draft is a document (what-document, research report), not a step plan. */
/**
 * Each level adds to the one before: polished = the manager sends polished replies without [Send] [Edit] [Cancel];
 * safe = the team also takes the recommended choice at questions and approvals, but stops at risky plans and doesn't
 * implement a finished plan; full = neither. Safe and full stop when stuck or out of budget.
 */
export type AutoLevel = "polished" | "safe" | "full"

/** Auto mode decides this stop itself: the user isn't asked. */
export const autoDecides = (task: TaskState) =>
  (task.auto === "safe" || task.auto === "full") &&
  (["checks", "questions", "brief"].includes(task.phase) ||
    (task.phase === "approval" && !(task.auto === "safe" && (task.stepFix?.waiting ? task.stepFix.risk : task.planRisk) && !draftIsDoc(task))))

export const draftIsDoc = (task: { workflow?: Workflow; stage?: Stage }) =>
  task.workflow === "research" || task.stage === "what" || (task.workflow === "plan" && task.stage !== "how")

/** The draft a scoped revision changes: Analyst's brief, or the Planner's latest document or plan. */
export const scopedFile = (task: TaskState) =>
  task.scope?.draft === "brief" ? briefName(task) : draftIsDoc(task) ? `doc-${task.doc}.md` : `plan-${task.plan}.md`

/** This agent writes a scoped revision: it returns sections, not the whole draft. */
export const isScopedWriter = (mode: Mode, task: TaskState | undefined) =>
  !!task?.scope && !!task.sections && ((mode === "analyst" && task.scope.draft === "brief" && !task.revising) || (mode === "planner" && task.scope.draft === "draft"))

/** Analyst's brief for the current stage. */
export const briefName = (task: { stage?: Stage }) => (task.stage === "how" ? "how-brief.md" : "brief.md")

/** The user's answers and comments for the current stage; the how stage starts its own. */
export const answersName = (task: { stage?: Stage }) => (task.stage === "how" ? "how-answers.md" : "answers.md")

/** Analyst's answers to the Planner's or Architect's questions in the current stage, oldest first. */
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
  /** A revision Architect asked for: its review file is shown with the revised plan or document. */
  afterReview?: string
  /** Analyst hand-off of the user's comments on the document (`note`), for a revision brief. */
  revision?: boolean
  /** analyst_answer: the question ids Analyst must answer, and the mode that asked; intern: analyst when Analyst sent the queries. */
  ids?: string[]
  asker?: Mode
  /** Task files delivered with this hand-off (a continuing session sees them once). */
  files?: string[]
  /** Advice modes: whose draft is advised on, and the writer's hand-off that runs after the advice. */
  advise?: "analyst" | "planner"
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
  /** Failed tries: the team's own work failed and has to be redone (see README, Attempts). */
  attempts: number
  attemptLimit: number
  /** Every agent call of the task: a silent runaway guard, not shown as attempts. Missing on tasks from before: migrated on load. */
  agentCalls?: number
  agentCallLimit?: number
  /** Why the task is in phase "budget". */
  budgetReason?: "attempts" | "calls"
  sessions: Partial<Record<WorkerRole, string>>
  seq: Record<string, number>
  trivialFailed?: boolean
  /** Missing on tasks from before workflows: code. */
  workflow?: Workflow
  /** plan/research: the document file in the project (absolute path). */
  output?: string
  /** research: Analyst's sizing; sets the Intern rounds. */
  depth?: ResearchDepth
  /** plan/research: the latest document (doc-N.md) and its summary. */
  doc?: number
  docSummary?: string
  /** The user asked for Architect's review in the request: it runs before the first approval. */
  reviewFirst?: boolean
  /** Architect reviews the user asked for. */
  reviews?: number
  /** The user commented on the document: Analyst is writing a revision brief for the Planner. */
  revising?: boolean
  /** Plan and non-trivial code tasks: the current stage. */
  stage?: Stage
  /** Counts stage changes; a fresh session gets only the files of the current run. */
  stageRun?: number
  /** Analyst's and the Planner's what-stage sessions, kept while the how stage runs in fresh ones. */
  whatSessions?: Partial<Record<WorkerRole, string>>
  /** The how stage found a what-decision unworkable (infeasible-N.md); the user decides. */
  infeasible?: string
  /** Questions asked of Analyst so far (ids A1, A2, …). */
  askSeq?: number
  /** Rounds of user comments on the current brief or document, and the advisers already used on it. */
  commentRounds?: number
  advisors?: Mode[]
  adviceFiles?: string[]
  /** The advice the current version follows, shown to the user. */
  lastAdvice?: { role: string; file: string }
  /** Advice items given so far (ids ADV1, ADV2, …). */
  adviceSeq?: number
  /** Questions Developer and Analyst asked the Planner mid-work, counted per step or brief (see consultKey). */
  consults?: Partial<Record<ConsultSide, { key: string; n: number }>>
  /** Operator runs Analyst and Developer asked for (status RUN). */
  runs?: number
  /**
   * The Planner's latest step fix: in plan `plan` (the spliced copy), steps `from`..`to` replace the blocked one.
   * A fixed step that blocks again fails the plan. `waiting`: the user approves it (approval phase).
   */
  stepFix?: { plan: number; from: number; to: number; risk: boolean; summary: string; waiting?: boolean }
  /** Their pair sessions with the Planner, apart from its planning session; `asked` caps the size (limits.consultsPerSession). */
  pairs?: Partial<Record<ConsultSide, { key: string; session?: string; asked: number }>>
  /** Section ids of the current brief or draft, and the ones the user marked final. */
  sections?: SectionIndex
  /** The sections the pending revision may change (from the user's comments). */
  scope?: Scope
  /** What the last scoped revision changed, shown to the user. */
  sectionChange?: SectionChange
  /** How the user reviews briefs, documents and plans (config reviewStyle, set at start). */
  reviewStyle?: "ask" | "all" | "sections"
  /** The section-by-section review of the waiting brief, document or plan. */
  walk?: Walk
  /** Auto mode: replies sent without confirmation (polished), and the team deciding the user's stops (safe, full). */
  auto?: AutoLevel
  /** What auto mode decided, shown to the user at the end. */
  autoLog?: string[]
  /** The user asked for a plan: analyst can't pick TRIVIAL. */
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
  architectAdviceUsed: number
  skipArchitectReview: boolean
  needInfo: number
  /** The Planner's rounds of questions (ASK, or NEED_INFO in research) since its last draft (limits.askRoundsPerDraft). */
  draftAsks?: number
  /** Intern rounds Analyst used since its last report (limits.analystSearchRounds). */
  analystSearches?: number
  questionRounds: number
  developerSeenPlan: boolean
  /** Files the planner hasn't seen yet. */
  plannerUnseen: string[]
  editedFiles: string[]
  latestLog?: string
  history: HistoryEntry[]
  usage: Partial<Record<Role, AgentUsage>>
  managerBaseline?: { input: number; output: number; reasoning: number; cacheRead: number; prompts: number; tools: Record<string, number> }
  planSummary?: string
  architectNote?: string
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

export function newTask(root: string, managerSession: string, workspace: string, request: string, attemptLimit: number, agentCallLimit?: number): TaskState {
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
    agentCalls: 0,
    agentCallLimit,
    sessions: {},
    seq: {},
    plan: 0,
    planSteps: 0,
    planRisk: false,
    planHadFailure: false,
    step: 0,
    rounds: 0,
    planFailures: 0,
    architectAdviceUsed: 0,
    skipArchitectReview: false,
    needInfo: 0,
    questionRounds: 0,
    developerSeenPlan: false,
    plannerUnseen: [],
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
  triage: "analyst",
  senior: "planner",
  explorer: "intern",
  fixer: "developer",
  analyser: "reviewer",
  oracle: "architect",
  // Second rename (lead → analyst, architect → planner, principal → architect). The old "architect"
  // is ambiguous with the new one, so saved data using it is not converted.
  lead: "analyst",
  principal: "architect",
}
const OLD_NAME = new RegExp(Object.keys(OLD_NAMES).join("|"), "gi")

/** Saved data from before the agents were renamed: renames quoted identifiers ("senior", "seniorUnseen", "oracle_advice", "lead"), not free text. */
export const migrateNames = (json: string) =>
  json.replace(/"[A-Za-z_]+"/g, (token) =>
    token.replace(OLD_NAME, (w) => {
      const n = OLD_NAMES[w.toLowerCase()]
      return w[0] === w[0].toUpperCase() ? n[0].toUpperCase() + n.slice(1) : n
    }),
  )

export function loadTask(dir: string): TaskState | undefined {
  try {
    const task = JSON.parse(migrateNames(readFileSync(path.join(dir, "state.json"), "utf8"))) as TaskState
    // Before attempts meant failed tries, they counted every agent call.
    if (task.agentCalls === undefined) {
      task.agentCalls = task.attempts
      task.attempts = 0
    }
    return task
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
