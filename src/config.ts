import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { migrateNames } from "./state.ts"

export const ROLES = ["manager", "analyst", "planner", "intern", "developer", "reviewer", "architect", "operator"] as const
export type Role = (typeof ROLES)[number]
export type WorkerRole = Exclude<Role, "manager">

export interface ModelRef {
  providerID: string
  id: string
  variant?: string
}

export interface AgentConfig {
  model?: string | string[]
  variant?: string
  /** Skills the agent loads first. */
  skills?: string[]
  /** MCP servers, used through Code Mode (`execute`). */
  mcps?: string[]
  /** Tool ids from other plugins (e.g. a docs search). */
  tools?: string[]
  /** Extra shell command patterns the agent may run (e.g. "graphify *"). */
  commands?: string[]
  /** Replaces the role's default instructions: inline text or a file path. */
  instructions?: string
  /** Added at the end of the prompt: inline text or a file path. */
  append?: string
}

/** The three front agents share agents.manager (model, permissions); each can have its own polishing instructions. */
export type FrontAgent = "build-manager" | "plan-manager" | "research-manager"

export interface Config {
  agents: Partial<Record<Role, AgentConfig>> & Partial<Record<FrontAgent, Pick<AgentConfig, "instructions" | "append">>>
  polish: "on" | "off"
  /** Mode for new tasks unless the user asks otherwise: off (interactive), polished, safe or full auto. */
  auto: "off" | "polished" | "safe" | "full"
  /** How the user reviews briefs, documents and plans: asked at every stop, all at once, or one section at a time. */
  reviewStyle: "ask" | "all" | "sections"
  agentPrefix: string
  defaultAgent: boolean
  /** Analyst and Developer may have the Operator run something for them mid-task (status RUN). */
  operatorCalls: boolean
  limits: {
    /** Failed tries per task before the team stops and asks: a failed Developer step, a review sending work back, Architect requesting changes, an agent call that broke. */
    taskAttempts: number
    /** Agent calls per task, failed or not: a runaway guard. */
    taskAgentCalls: number
    developerRounds: number
    planFailures: number
    architectAdvice: number
    /** The user's comment rounds on one brief or document after which the next adviser up is consulted (Planner, then Architect). */
    escalateAfterComments: number[]
    /** Architect reviews of a plan or document the user can ask for per task. */
    architectReviews: number
    needInfoPerTask: number
    /** Rounds of search queries Analyst may hand to the Intern before each report. */
    analystSearchRounds: number
    questionsPerTask: number
    /** Questions Developer may ask the Planner per plan step, and Analyst per brief (status CONSULT). */
    consultsPerStep: number
    consultsPerBrief: number
    /** Questions one pair session with the Planner takes before the next starts fresh. */
    consultsPerSession: number
    /** Operator runs Analyst and Developer may ask for per task (status RUN). */
    runsPerTask: number
    toolCalls: Record<WorkerRole, number>
    callMinutes: { default: number; developer: number }
    stallMinutes: number
    modelRetryWaits: number
  }
  review: { minFiles: number }
  /**
   * `output` is relative to the project ({task} = the task name). `instructions` / `howInstructions` replace the built-in
   * standards (inline text or a file): the what-document and how-document standards apply to code tasks too.
   * `confirmBrief`: the user sees Analyst's brief before the Planner writes.
   */
  workflows: {
    code: { confirmBrief: boolean }
    plan: { output: string; instructions: string; howInstructions: string; confirmBrief: boolean }
    research: { output: string; instructions: string; confirmBrief: boolean; internRounds: { quick: number; breadth: number; depth: number } }
  }
  /** The project's build and test commands. When both are empty, whenMissing decides. */
  checks: { build: string; test: string; whenMissing: "ask" | "skip" }
  buildCommands: { patterns: string[]; timeoutMin: number }
  askCommands: string[]
  readOnlyCommands: string[]
  taskDir: string
}

export const DEFAULTS: Config = {
  agents: {},
  polish: "on",
  auto: "off",
  reviewStyle: "ask",
  agentPrefix: "team-",
  defaultAgent: false,
  operatorCalls: true,
  limits: {
    taskAttempts: 10,
    taskAgentCalls: 100,
    developerRounds: 2,
    planFailures: 2,
    architectAdvice: 1,
    escalateAfterComments: [3, 5],
    architectReviews: 2,
    needInfoPerTask: 6,
    analystSearchRounds: 3,
    questionsPerTask: 4,
    consultsPerStep: 2,
    consultsPerBrief: 3,
    consultsPerSession: 6,
    runsPerTask: 6,
    toolCalls: { analyst: 15, planner: 25, intern: 100, developer: 150, reviewer: 30, architect: 20, operator: 30 },
    callMinutes: { default: 30, developer: 240 },
    stallMinutes: 15,
    modelRetryWaits: 2,
  },
  review: { minFiles: 4 },
  workflows: {
    code: { confirmBrief: false },
    plan: { output: "docs/{task}.md", instructions: "", howInstructions: "", confirmBrief: true },
    research: { output: "docs/{task}.md", instructions: "", confirmBrief: true, internRounds: { quick: 1, breadth: 2, depth: 3 } },
  },
  checks: { build: "", test: "", whenMissing: "ask" },
  buildCommands: { patterns: ["make *", "ninja *", "cmake *"], timeoutMin: 120 },
  askCommands: [],
  readOnlyCommands: [
    "grep *", "rg *", "find *", "ls *", "cat *", "head *", "tail *", "wc *", "nm *", "readelf *",
    "ldd *", "objdump *", "file *", "p4 diff *", "p4 opened *", "p4 have *", "git diff *",
    "git log *", "git status *", "git show *", "pwd",
  ],
  taskDir: "~/.cache/opencode-multi-agent-team",
}

export const ASK_COMMANDS = [
  "git reset *", "git clean *", "git checkout *", "git push *", "git rebase *", "rm -rf *", "rm -fr *",
  "p4 revert *", "p4 submit *", "p4 delete *", "p4 obliterate *", "sudo *",
]

/** Build patterns plus the configured build and test commands (long timeout, output to logs/). */
export const buildPatterns = (config: Config) =>
  [...config.buildCommands.patterns, ...[config.checks.build, config.checks.test].filter((c) => c.trim()).map((c) => `${c.trim()} *`)]

export const expandHome = (p: string) => (p.startsWith("~") ? path.join(homedir(), p.slice(1)) : p)

/** Removes // and /* *\/ comments and trailing commas outside strings. */
export function stripJsonc(text: string): string {
  let out = ""
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      out += c
      if (c === "\\") out += text[++i] ?? ""
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') {
      inString = true
      out += c
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++
      out += "\n"
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++
      i++
    } else out += c
  }
  return out.replace(/,(\s*[}\]])/g, "$1")
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

export function merge<T>(base: T, over: unknown): T {
  if (!isObject(base) || !isObject(over)) return (over === undefined ? base : over) as T
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(over)) out[k] = k in out ? merge(out[k], v) : v
  return out as T
}

function readConfigFile(file: string): unknown {
  if (!existsSync(file)) return undefined
  try {
    return JSON.parse(migrateNames(stripJsonc(readFileSync(file, "utf8"))))
  } catch (e) {
    throw new Error(`opencode-multi-agent-team: cannot parse ${file}: ${(e as Error).message}`)
  }
}

export function loadConfig(directory: string, options: unknown): Config {
  const name = "opencode-multi-agent-team"
  const files = [
    path.join(homedir(), ".config", "opencode", `${name}.json`),
    path.join(homedir(), ".config", "opencode", `${name}.jsonc`),
    path.join(directory, ".opencode", `${name}.json`),
    path.join(directory, ".opencode", `${name}.jsonc`),
  ]
  let config = DEFAULTS
  for (const file of files) config = merge(config, readConfigFile(file))
  if (isObject(options)) config = merge(config, options)
  return config
}

export function parseModel(spec: string, variant?: string): ModelRef {
  const [main, hashVariant] = spec.split("#")
  const slash = main.indexOf("/")
  if (slash < 1) throw new Error(`invalid model "${spec}": use provider/model or provider/model#variant`)
  const ref: ModelRef = { providerID: main.slice(0, slash), id: main.slice(slash + 1) }
  const v = hashVariant ?? variant
  if (v) ref.variant = v
  return ref
}

/** Models for a role, main first. Empty when the user configured none. */
export function modelsFor(config: Config, role: Role): ModelRef[] {
  // The Operator runs on the Intern's model unless it has its own.
  if (role === "operator" && !config.agents.operator?.model) return modelsFor(config, "intern")
  const entry = config.agents[role]
  if (!entry?.model) return []
  const list = Array.isArray(entry.model) ? entry.model : [entry.model]
  return list.map((m) => parseModel(m, entry.variant))
}

export const modelLabel = (m?: ModelRef) => (m ? `${m.providerID}/${m.id}${m.variant ? "#" + m.variant : ""}` : "?")
