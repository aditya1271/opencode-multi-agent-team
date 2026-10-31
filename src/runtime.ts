import type { WorkerRole } from "./config.ts"
import type { Fix, GivenFix } from "./fixes.ts"
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
  /** A report refused for parts code checks, kept until the writer sends the fixes asked for. */
  draft?: Report
  fixes?: Fix[]
  /** Why the last report call was refused, told again if the agent stops without reporting. */
  reportRefused?: string
  /** Times the Intern's report went back for code blocks that don't match their files. */
  quoteRejects?: number
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

export function beginRun(sessionID: string, run: Omit<SessionRun, "toolCalls" | "tools" | "prompts" | "lastActivity" | "inFlight" | "shells" | "edited" | "before">): SessionRun {
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
  }
  runs.set(sessionID, r)
  return r
}

export const touch = (sessionID: string) => {
  const r = runs.get(sessionID)
  if (r) r.lastActivity = Date.now()
}
