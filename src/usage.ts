import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { ROLES, type Role } from "./config.ts"
import type { ToolKind } from "./runtime.ts"
import { migrateNames } from "./state.ts"

export interface AgentUsage {
  calls: number
  prompts: number
  tools: Partial<Record<ToolKind, number>>
  input: number
  cacheRead: number
  output: number
  models: string[]
  ms: number
}

export interface UsageDelta {
  calls?: number
  prompts: number
  tools: Partial<Record<ToolKind, number>>
  input: number
  cacheRead: number
  output: number
  model?: string
  ms?: number
}

export const empty = (): AgentUsage => ({ calls: 0, prompts: 0, tools: {}, input: 0, cacheRead: 0, output: 0, models: [], ms: 0 })

export function add(usage: Partial<Record<Role, AgentUsage>>, role: Role, d: UsageDelta) {
  const u = (usage[role] ??= empty())
  u.calls += d.calls ?? 0
  u.prompts += d.prompts
  u.input += d.input
  u.cacheRead += d.cacheRead
  u.output += d.output
  u.ms += d.ms ?? 0
  for (const [k, v] of Object.entries(d.tools)) u.tools[k as ToolKind] = (u.tools[k as ToolKind] ?? 0) + (v ?? 0)
  if (d.model && !u.models.includes(d.model)) u.models.push(d.model)
}

export const toolTotal = (u: AgentUsage) => Object.values(u.tools).reduce((a, b) => a + (b ?? 0), 0)

const num = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n))
const dur = (ms: number) => (ms >= 3600e3 ? `${(ms / 3600e3).toFixed(1)}h` : ms >= 60e3 ? `${Math.round(ms / 60e3)}m` : `${Math.round(ms / 1e3)}s`)

export function table(usage: Partial<Record<Role, AgentUsage>>, share = false): string {
  const rows: string[][] = [["agent", "calls", "prompts", "tools", "input", "cache", "output", "time", "model"]]
  const present = ROLES.filter((r) => usage[r])
  const sum: Partial<Record<Role, AgentUsage>> = {}
  for (const role of present) add(sum, "manager", { ...usage[role]!, model: undefined })
  const total = sum.manager ?? empty()
  for (const role of present) {
    const u = usage[role]!
    const pct = (a: number, b: number) => (b ? ` ${Math.round((100 * a) / b)}%` : "")
    rows.push([
      role,
      String(u.calls) + (share ? pct(u.calls, total.calls) : ""),
      String(u.prompts) + (share ? pct(u.prompts, total.prompts) : ""),
      String(toolTotal(u)),
      num(u.input),
      num(u.cacheRead),
      num(u.output) + (share ? pct(u.input + u.cacheRead + u.output, total.input + total.cacheRead + total.output) : ""),
      role === "manager" && !u.ms ? "-" : dur(u.ms),
      u.models.join(", "),
    ])
  }
  rows.push(["total", String(total.calls), String(total.prompts), String(toolTotal(total)), num(total.input), num(total.cacheRead), num(total.output), dur(total.ms), ""])
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)))
  return rows.map((r) => r.map((c, i) => (i === 0 || i === r.length - 1 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join("  ").trimEnd()).join("\n")
}

/** Points out agents far outside the expected split. Information only. */
export function hints(usage: Partial<Record<Role, AgentUsage>>, steps = 1): string[] {
  const out: string[] = []
  const p = usage.manager
  if (p) {
    const work = (p.tools.read ?? 0) + (p.tools.search ?? 0) + (p.tools.shell ?? 0) + (p.tools.edit ?? 0) + (p.tools.build ?? 0)
    if (work) out.push(`manager used ${work} read/search/shell/edit calls (expected 0)`)
  }
  for (const role of ["architect", "principal"] as const) {
    const s = usage[role]
    if (!s) continue
    const k = s.tools
    const work = (k.read ?? 0) + (k.search ?? 0) + (k.index ?? 0) + (k.shell ?? 0) + (k.edit ?? 0) + (k.build ?? 0)
    if (work) out.push(`${role} used ${work} file or code tool calls (expected 0: it asks Lead)`)
  }
  const s = usage.architect
  if (s?.calls && s.prompts / s.calls > 15) out.push(`architect: ${Math.round(s.prompts / s.calls)} prompts per call (expected a few)`)
  for (const role of ["lead", "architect", "intern", "reviewer", "principal"] as const) {
    const edits = usage[role]?.tools.edit ?? 0
    if (edits) out.push(`${role} made ${edits} edit calls (only developer edits)`)
  }
  const a = usage.reviewer
  if (a && a.calls > Math.max(3, steps * 2)) out.push(`reviewer: ${a.calls} calls for ${steps} step(s)`)
  const o = usage.principal
  if (o && o.calls > 2) out.push(`principal: ${o.calls} calls (expected rare)`)
  const f = usage.developer
  const all = ROLES.reduce((n, r) => n + (usage[r] ? toolTotal(usage[r]!) : 0), 0)
  if (f && all >= 60 && toolTotal(f) < all * 0.3) out.push(`developer did only ${Math.round((100 * toolTotal(f)) / all)}% of tool calls (expected most)`)
  return out
}

export function report(usage: Partial<Record<Role, AgentUsage>>, steps = 1): string {
  const h = hints(usage, steps)
  return "```\n" + table(usage) + "\n```" + (h.length ? "\nOutside the expected split:\n" + h.map((x) => `- ${x}`).join("\n") : "")
}

export interface UsageLine {
  task: string
  /** The manager session (set for code questions, which have no task folder). */
  session?: string
  time: number
  outcome: string
  usage: Partial<Record<Role, AgentUsage>>
}

export function appendUsage(root: string, line: UsageLine) {
  mkdirSync(root, { recursive: true })
  appendFileSync(path.join(root, "usage.jsonl"), JSON.stringify(line) + "\n")
}

export function lastUsage(root: string, n: number): { lines: UsageLine[]; total: Partial<Record<Role, AgentUsage>> } {
  const file = path.join(root, "usage.jsonl")
  const lines: UsageLine[] = existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .flatMap((l) => {
          try {
            return [JSON.parse(migrateNames(l)) as UsageLine]
          } catch {
            return []
          }
        })
        .slice(-n)
    : []
  const total: Partial<Record<Role, AgentUsage>> = {}
  for (const line of lines) for (const role of ROLES) if (line.usage[role]) add(total, role, { ...line.usage[role]!, model: undefined })
  for (const line of lines) for (const role of ROLES) for (const m of line.usage[role]?.models ?? []) if (!total[role]!.models.includes(m)) total[role]!.models.push(m)
  return { lines, total }
}
