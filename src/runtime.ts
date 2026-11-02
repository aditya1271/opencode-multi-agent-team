import type { WorkerRole } from "./config.ts"
import type { Evidence } from "./evidence.ts"
import type { Block, BlockDraft, FillMap } from "./blocks.ts"
import type { Fix, GivenFix } from "./fixes.ts"
import type { VerdictSpec } from "./polish.ts"
import type { SectionEdit } from "./sections.ts"
import type { Mode, TaskState } from "./state.ts"

export interface Report {
  status: string
  summary: string
  content: string
  questions?: string[]
  risk?: "yes" | "no"
  steps?: number
  checkCommand?: string
  depth?: "quick" | "breadth" | "depth"
  /** Code task, Analyst's ESCALATE: is the behaviour already fixed by the request? */
  what?: "settled" | "open"
  /** ADVICE in an advice mode: one instruction per item. */
  items?: string[]
  /** A revision after advice: how each advice item (by id) was handled. */
  addressed?: string
  /** A scoped revision: only the sections that change. */
  sections?: SectionEdit[]
  /** After a refusal that kept the report: the missing parts, by fix id. */
  fixes?: GivenFix[]
  /** The Intern: where the code that proves its findings is; the plugin writes the code from the files. */
  evidence?: Evidence[]
  /** A what-document as blocks (config workflows.plan.blocks): the layout, then the fill of each block; `content` is written from them. */
  title?: string
  layout?: Block[]
  fill?: FillMap
  blocks?: { title: string; layout: Block[]; fill: FillMap }
}

export interface ShellRun {
  command: string
  exit: number | undefined
  log?: string
}

export type ToolKind = "read" | "search" | "index" | "edit" | "shell" | "build" | "other"

/** Per worker session; reset for each agent call. */
export interface SessionRun {
  role: WorkerRole
  mode: Mode
  task?: TaskState
  toolLimit: number
  toolCalls: number
  /** Analyst's reads the plugin refused (they don't count toward toolLimit). */
  refused?: number
  tools: Partial<Record<ToolKind, number>>
  prompts: number
  report?: Report
  lastActivity: number
  /** Tool calls started and not finished, including ones waiting for a permission reply. */
  inFlight: number
  shells: ShellRun[]
  edited: Set<string>
  /** Each edited file's content before this call's first edit (undefined: it didn't exist). */
  before: Map<string, string | undefined>
  /** Session token counts when the call started, for live usage. */
  base?: { input: number; cacheRead: number; output: number }
  /** The role's skills, added to each request's system prompt so the agent doesn't spend steps loading them. */
  skills?: string
  /** A what-document being built: the accepted layout and the blocks filled so far. */
  blocks?: BlockDraft
  /** A report refused for parts code checks, kept until the writer sends the fixes asked for. */
  draft?: Report
  fixes?: Fix[]
  /** Why the last report call was refused, told again if the agent stops without reporting. */
  reportRefused?: string
  /** The Intern: what its tools showed it, kept across the calls of a session, to check its evidence against. */
  seen?: string
  /** Times the Intern's report went back for code blocks that don't match their files. */
  quoteRejects?: number
  /** The verdict lines this report must hold (read-back, assumption check, review), and times it went back for them. */
  verdicts?: VerdictSpec
  verdictRejects?: number
  /** What went differently than planned in this call (a denied tool, a model switch): text, how often, and the first example. */
  notes: Map<string, { n: number; eg?: string }>
}

/** Prompt and tool counts for sessions outside a worker call (the manager). */
export interface Counter {
  prompts: number
  tools: Partial<Record<ToolKind, number>>
  /** Manager sessions: question-tool calls, so a confirmation can be checked. */
  asked?: number
}

export const runs = new Map<string, SessionRun>()
export const counters = new Map<string, Counter>()

export function counter(sessionID: string): Counter {
  let c = counters.get(sessionID)
  if (!c) counters.set(sessionID, (c = { prompts: 0, tools: {} }))
  return c
}

export function beginRun(sessionID: string, run: Omit<SessionRun, "toolCalls" | "tools" | "prompts" | "lastActivity" | "inFlight" | "shells" | "edited" | "before" | "notes">): SessionRun {
  const r: SessionRun = {
    ...run,
    toolCalls: 0,
    tools: {},
    prompts: 0,
    lastActivity: Date.now(),
    inFlight: 0,
    shells: [],
    edited: new Set(),
    before: new Map(),
    notes: new Map(),
    seen: runs.get(sessionID)?.seen,
  }
  runs.set(sessionID, r)
  return r
}

export function note(run: SessionRun, text: string, example?: string) {
  const seen = run.notes.get(text)
  if (seen) seen.n++
  else run.notes.set(text, { n: 1, eg: example })
}

export const notesOf = (run: SessionRun | undefined): string[] =>
  [...(run?.notes ?? [])].map(([text, { n, eg }]) => `${text}${n > 1 ? ` ×${n}` : ""}${eg ? ` (first: ${eg.length > 60 ? `${eg.slice(0, 59)}…` : eg})` : ""}`)

export const touch = (sessionID: string) => {
  const r = runs.get(sessionID)
  if (r) r.lastActivity = Date.now()
}
