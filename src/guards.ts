import { execFile } from "node:child_process"
import { accessSync, constants, existsSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { Plugin } from "@opencode/plugin"
type Context = Plugin.Context
import { agentId, evaluate, permissionsFor, roleOf, toolVisible, type Rule } from "./agents.ts"
import { ROLES, type Config, type Role } from "./config.ts"
import { allowedStatuses, reportSchema } from "./report.ts"
import { counter, runs, touch, type ToolKind } from "./runtime.ts"
import { nextLogPath, save } from "./state.ts"

const EDIT_TOOLS = new Set(["edit", "write", "patch"])
const TRIM_LINES = 80
const ERROR_LINE = /\b(error|fatal|undefined reference|cannot find|no such file|failed|segmentation fault|assert(ion)?|traceback)\b/i

function globToRegExp(glob: string): RegExp {
  const body = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")
  return new RegExp(`^${body}$`)
}

/** Splits a command line into simple commands, unwrapping `bash -c '...'`. */
export function commandParts(command: string): string[] {
  const unwrapped = command.replace(/\b(?:bash|sh|csh|tcsh)\s+-l?c\s+(['"])([\s\S]*)\1/g, (_, __, inner: string) => ` ; ${inner} ; `)
  return unwrapped
    .split(/&&|\|\||;|\||\n/)
    .map((p) => p.trim().replace(/^(?:\w+=\S*\s+)*/, "").replace(/^(?:cd\s+\S+\s*)$/, ""))
    .filter(Boolean)
}

export function matchesAny(command: string, patterns: string[]): boolean {
  const res = patterns.map((p) => (p.endsWith(" *") ? [globToRegExp(p), globToRegExp(p.slice(0, -2))] : [globToRegExp(p)])).flat()
  return commandParts(command).some((part) => res.some((re) => re.test(part)))
}

export function toolKind(tool: string, input: unknown, config: Config): ToolKind {
  if (tool === "read") return "read"
  if (tool === "grep" || tool === "glob") return "search"
  if (EDIT_TOOLS.has(tool)) return "edit"
  const agents = Object.values(config.agents)
  if (tool === "shell") {
    const cmd = String((input as { command?: unknown })?.command ?? "")
    if (matchesAny(cmd, config.buildCommands.patterns)) return "build"
    return matchesAny(cmd, agents.flatMap((a) => a?.commands ?? [])) ? "index" : "shell"
  }
  if (tool === "execute" || tool.includes("_") || agents.some((a) => a?.tools?.includes(tool))) return "index"
  return "other"
}

function editedPaths(tool: string, input: unknown, cwd: string): string[] {
  const i = (input ?? {}) as Record<string, unknown>
  const direct = i.filePath ?? i.path ?? i.file_path ?? i.file
  if (typeof direct === "string") return [path.resolve(cwd, direct)]
  const patch = String(i.patchText ?? i.patch ?? i.input ?? "")
  return [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => path.resolve(cwd, m[1].trim()))
}

function p4Edit(file: string): Promise<void> {
  return new Promise((resolve) => {
    execFile("p4", ["edit", file], { cwd: path.dirname(file), timeout: 30000 }, () => resolve())
  })
}

function isReadOnly(file: string): boolean {
  if (!existsSync(file)) return false
  try {
    accessSync(file, constants.W_OK)
    return false
  } catch {
    return true
  }
}

function resultText(result: unknown): string {
  const r = result as { output?: { output?: unknown }; content?: Array<{ type?: string; text?: string }> }
  if (typeof r?.output?.output === "string") return r.output.output
  return (r?.content ?? []).map((c) => (c.type === "text" ? c.text ?? "" : "")).join("\n")
}

function resultExit(result: unknown): number | undefined {
  const r = result as { metadata?: { exit?: unknown }; output?: { exit?: unknown } }
  const exit = r?.metadata?.exit ?? r?.output?.exit
  return typeof exit === "number" ? exit : undefined
}

export function trimLog(text: string, exit: number | undefined, logFile: string): string {
  const lines = text.split("\n")
  const errors: string[] = []
  const seen = new Set<string>()
  for (const line of lines) {
    if (!ERROR_LINE.test(line)) continue
    const key = line.trim()
    if (seen.has(key)) continue
    seen.add(key)
    errors.push(line.length > 400 ? line.slice(0, 400) + "…" : line)
    if (errors.length >= 40) break
  }
  const tail = lines.slice(-30)
  return [
    `[output trimmed: ${lines.length} lines, exit ${exit ?? "?"}; full log: ${logFile}]`,
    errors.length ? `--- error lines (${errors.length}) ---\n${errors.join("\n")}` : "--- no error lines found ---",
    `--- last ${tail.length} lines ---\n${tail.join("\n")}`,
  ].join("\n")
}

export async function registerGuards(ctx: Context, config: Config) {
  const polisherId = agentId(config, "polisher")
  const rules = Object.fromEntries(ROLES.map((r) => [r, permissionsFor(config, r)])) as Record<Role, Rule[]>

  // The team's rules decide for team agents, so global allow/ask rules don't loosen or block them.
  // A deny from the user's own config still stands.
  await ctx.permission.hook("evaluate", (event) => {
    const role = roleOf(config, event.agent)
    if (!role || event.effect === "deny") return
    event.effect = evaluate(rules[role], event.action, event.resources)
  })

  await ctx.session.hook("context", (event) => {
    const role = roleOf(config, event.agent)
    if (event.agent !== polisherId) delete event.tools.team
    if (role) for (const id of Object.keys(event.tools)) if (!toolVisible(rules[role], id)) delete event.tools[id]
    const run = runs.get(event.sessionID)
    if (!run) {
      delete event.tools.report
      if (role === "polisher") counter(event.sessionID).prompts++
      return
    }
    run.prompts++
    touch(event.sessionID)
    const report = event.tools.report
    if (report) {
      const statuses = allowedStatuses(config, run.mode, run.task)
      event.tools.report = { ...report, input: reportSchema(run.mode, statuses) as never }
    }
  })

  await ctx.tool.hook("execute.before", async (event) => {
    const run = runs.get(event.sessionID)
    const kind = toolKind(event.tool, event.input, config)
    if (!run) {
      if (roleOf(config, event.agent) === "polisher" && event.tool !== "team") {
        const c = counter(event.sessionID)
        c.tools[kind] = (c.tools[kind] ?? 0) + 1
        if (!toolVisible(rules.polisher, event.tool))
          throw new Error(`The polisher doesn't use ${event.tool}. Send code questions and changes through the team tool.`)
      }
      return
    }
    touch(event.sessionID)
    if (event.tool === "report") return
    if (run.report) throw new Error("You already called report. Stop now.")
    if (run.toolCalls >= run.toolLimit)
      throw new Error(
        `Limit reached: ${run.toolLimit} tool calls in this agent call. Call report now with what you have.` +
          (run.role === "fixer"
            ? " Running out of tool calls is not a reason for BLOCKED: report DONE only if the check passed, otherwise FAILED with the current error and what you tried."
            : ""),
      )
    run.toolCalls++
    run.tools[kind] = (run.tools[kind] ?? 0) + 1
    run.inFlight++
    if (run.role === "fixer" && (event.tool === "edit" || event.tool === "write" || event.tool === "patch")) {
      const cwd = run.task?.workspace ?? ctx.location.directory
      for (const file of editedPaths(event.tool, event.input, cwd)) if (isReadOnly(file)) await p4Edit(file)
    }
  })

  await ctx.tool.hook("execute.after", (event) => {
    const run = runs.get(event.sessionID)
    if (!run || event.tool === "report") return
    touch(event.sessionID)
    run.inFlight = Math.max(0, run.inFlight - 1)
    if (event.status !== "completed") return
    const cwd = run.task?.workspace ?? ctx.location.directory
    if (EDIT_TOOLS.has(event.tool)) for (const file of editedPaths(event.tool, event.input, cwd)) run.edited.add(file)
    if (event.tool !== "shell") return
    const command = String((event.input as { command?: unknown })?.command ?? "")
    const exit = resultExit(event.result)
    const shell = { command, exit, log: undefined as string | undefined }
    run.shells.push(shell)
    const task = run.task
    if (!task || (run.role !== "fixer" && run.role !== "analyser")) return
    const text = resultText(event.result)
    const build = matchesAny(command, config.buildCommands.patterns)
    if (!build && text.split("\n").length <= TRIM_LINES) return
    const logFile = nextLogPath(task)
    writeFileSync(logFile, `$ ${command}\n${text}\n[exit ${exit ?? "?"}]\n`)
    shell.log = logFile
    task.latestLog = logFile
    save(task)
    if (text.split("\n").length > TRIM_LINES) {
      event.result = { ...event.result, content: [{ type: "text", text: trimLog(text, exit, logFile) }] } as never
    }
  })

  await ctx.shell.hook("create.before", (event) => {
    if (matchesAny(event.command, config.buildCommands.patterns))
      event.timeout = Math.max(event.timeout, config.buildCommands.timeoutMin * 60_000)
  })
}
