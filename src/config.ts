import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { migrateNames } from "./state.ts"

export const ROLES = ["manager", "lead", "architect", "intern", "developer", "reviewer", "principal"] as const
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
  agentPrefix: string
  defaultAgent: boolean
  limits: {
    taskAttempts: number
    developerRounds: number
    planFailures: number
    principalAdvice: number
    /** Principal reviews of a plan or document the user can ask for per task. */
    principalReviews: number
    needInfoPerTask: number
    questionsPerTask: number
    toolCalls: Record<WorkerRole, number>
    callMinutes: { default: number; developer: number }
    stallMinutes: number
    modelRetryWaits: number
  }
  review: { minFiles: number }
  /** Workflows whose deliverable is a document. `output` is relative to the project ({task} = the task name); `instructions` replaces the built-in document standard (inline text or a file). */
  workflows: {
    plan: { output: string; instructions: string }
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
  agentPrefix: "team-",
  defaultAgent: false,
  limits: {
    taskAttempts: 40,
    developerRounds: 2,
    planFailures: 2,
    principalAdvice: 1,
    principalReviews: 2,
    needInfoPerTask: 6,
    questionsPerTask: 4,
    toolCalls: { lead: 40, architect: 25, intern: 30, developer: 150, reviewer: 30, principal: 20 },
    callMinutes: { default: 30, developer: 240 },
    stallMinutes: 15,
    modelRetryWaits: 2,
  },
  review: { minFiles: 4 },
  workflows: {
    plan: { output: "docs/{task}.md", instructions: "" },
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
  const entry = config.agents[role]
  if (!entry?.model) return []
  const list = Array.isArray(entry.model) ? entry.model : [entry.model]
  return list.map((m) => parseModel(m, entry.variant))
}

export const modelLabel = (m?: ModelRef) => (m ? `${m.providerID}/${m.id}${m.variant ? "#" + m.variant : ""}` : "?")
