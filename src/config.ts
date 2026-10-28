import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

export const ROLES = ["polisher", "triage", "senior", "explorer", "fixer", "analyser", "oracle"] as const
export type Role = (typeof ROLES)[number]
export type WorkerRole = Exclude<Role, "polisher">

export interface ModelRef {
  providerID: string
  id: string
  variant?: string
}

export interface Config {
  agents: Partial<Record<Role, { model?: string | string[]; variant?: string }>>
  addons: Partial<Record<Role, { mcps?: string[]; skills?: string[] }>>
  polish: "on" | "off"
  agentPrefix: string
  defaultAgent: boolean
  limits: {
    taskAttempts: number
    fixerRounds: number
    planFailures: number
    oracleAdvice: number
    needInfoPerTask: number
    questionsPerTask: number
    toolCalls: Record<WorkerRole, number>
    callMinutes: { default: number; fixer: number }
    stallMinutes: number
    modelRetryWaits: number
  }
  review: { minFiles: number }
  buildCommands: { patterns: string[]; timeoutMin: number }
  askCommands: string[]
  readOnlyCommands: string[]
  taskDir: string
  promptAppend: Partial<Record<Role, string>>
}

export const DEFAULTS: Config = {
  agents: {},
  addons: {},
  polish: "on",
  agentPrefix: "team-",
  defaultAgent: false,
  limits: {
    taskAttempts: 40,
    fixerRounds: 2,
    planFailures: 2,
    oracleAdvice: 1,
    needInfoPerTask: 6,
    questionsPerTask: 4,
    toolCalls: { triage: 40, senior: 25, explorer: 30, fixer: 150, analyser: 30, oracle: 20 },
    callMinutes: { default: 30, fixer: 240 },
    stallMinutes: 15,
    modelRetryWaits: 2,
  },
  review: { minFiles: 4 },
  buildCommands: { patterns: ["make *", "ninja *", "cmake *"], timeoutMin: 120 },
  askCommands: [],
  readOnlyCommands: [
    "grep *", "rg *", "find *", "ls *", "cat *", "head *", "tail *", "wc *", "nm *", "readelf *",
    "ldd *", "objdump *", "file *", "p4 diff *", "p4 opened *", "p4 have *", "git diff *",
    "git log *", "git status *", "git show *", "pwd",
  ],
  taskDir: "~/.cache/opencode-multi-agent-team",
  promptAppend: {},
}

export const ASK_COMMANDS = [
  "git reset *", "git clean *", "git checkout *", "git push *", "git rebase *", "rm -rf *", "rm -fr *",
  "p4 revert *", "p4 submit *", "p4 delete *", "p4 obliterate *", "sudo *",
]

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
    return JSON.parse(stripJsonc(readFileSync(file, "utf8")))
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
