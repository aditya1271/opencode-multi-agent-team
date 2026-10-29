import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { Plugin } from "@opencode/plugin"
type Context = Plugin.Context
import { agentId, evaluate, permissionsFor, roleOf, toolVisible, type Rule } from "./agents.ts"
import { matchesAny } from "./match.ts"
import { buildPatterns, ROLES, type Config, type Role } from "./config.ts"
import { allowedStatuses, reportSchema } from "./report.ts"
import { counter, runs, touch, type ToolKind } from "./runtime.ts"
import { nextLogPath, save, type TaskState } from "./state.ts"

const EDIT_TOOLS = new Set(["edit", "write", "patch"])
const TRIM_LINES = 80
const ERROR_LINE = /\b(error|fatal|undefined reference|cannot find|no such file|failed|segmentation fault|assert(ion)?|traceback)\b/i

export function toolKind(tool: string, input: unknown, config: Config): ToolKind {
  if (tool === "read") return "read"
  if (tool === "grep" || tool === "glob") return "search"
  if (EDIT_TOOLS.has(tool)) return "edit"
  const agents = ROLES.map((r) => config.agents[r])
  if (tool === "shell") {
    const cmd = String((input as { command?: unknown })?.command ?? "")
    if (matchesAny(cmd, buildPatterns(config))) return "build"
    return matchesAny(cmd, agents.flatMap((a) => a?.commands ?? [])) ? "index" : "shell"
  }
  if (tool === "execute" || tool.includes("_") || agents.some((a) => a?.tools?.includes(tool))) return "index"
  return "other"
}

function editedPaths(input: unknown, cwd: string): string[] {
  const i = (input ?? {}) as Record<string, unknown>
  const direct = i.filePath ?? i.path ?? i.file_path ?? i.file
  if (typeof direct === "string") return [path.resolve(cwd, direct)]
  const patch = String(i.patchText ?? i.patch ?? i.input ?? "")
  return [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => path.resolve(cwd, m[1].trim()))
}

function resultText(result: unknown): string {
  const r = result as { output?: { output?: unknown }; content?: Array<{ type?: string; text?: string }> }
  if (typeof r?.output?.output === "string") return r.output.output
  return (r?.content ?? []).map((c) => (c.type === "text" ? c.text ?? "" : "")).join("\n")
}

const ASK_INTERN = "Send the Intern a NEED_INFO with precise queries; its findings come back to you, and then you can read the files they cite."

/**
 * Lead doesn't search: it reads only files whose path appears in what it was given (the request, the user's answers
 * and material, the Intern's findings, briefs and drafts: the task folder). Why a read is refused, or undefined.
 */
export function leadReadProblem(task: TaskState, input: unknown): string | undefined {
  const i = (input ?? {}) as Record<string, unknown>
  const given = i.filePath ?? i.path ?? i.file_path
  if (typeof given !== "string") return undefined
  const file = path.resolve(task.workspace, given)
  const inTask = (p: string) => !path.relative(task.dir, p).startsWith("..")
  if (inTask(file)) return undefined
  if (!existsSync(file))
    return existsSync(path.join(task.dir, path.basename(file)))
      ? `${path.basename(file)} is a task file: its content is already in your prompt.`
      : undefined
  if (statSync(file).isDirectory()) return `Listing folders is searching, which the Intern does for you. ${ASK_INTERN}`
  let text = ""
  for (const name of readdirSync(task.dir)) if (name.endsWith(".md")) text += readFileSync(path.join(task.dir, name), "utf8") + "\n"
  const mentioned = (p: string) => new RegExp(`(^|[^\\w.-])${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\w-])`).test(text)
  const rel = path.relative(task.workspace, file)
  if (mentioned(file) || mentioned(rel) || mentioned(path.basename(file))) return undefined
  return `${rel} isn't named in the request, the user's material or the Intern's findings, so reading it would be searching. ${ASK_INTERN}`
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
    if (role !== "manager") delete event.tools.team
    if (role) for (const id of Object.keys(event.tools)) if (!toolVisible(rules[role], id)) delete event.tools[id]
    const run = runs.get(event.sessionID)
    if (!run) {
      delete event.tools.report
      if (role === "manager") counter(event.sessionID).prompts++
      return
    }
    // After `report`, the turn's last step gets no tools, so the session ends on its own
    // (outcome "succeeded") instead of being interrupted.
    if (run.report) {
      for (const id of Object.keys(event.tools)) delete event.tools[id]
      event.system.push({ type: "text", text: "Your report was accepted. Reply with the single word: done." })
      return
    }
    run.prompts++
    touch(event.sessionID)
    const report = event.tools.report
    if (report) {
      const statuses = allowedStatuses(config, run.mode, run.task)
      event.tools.report = { ...report, input: reportSchema(run.mode, statuses, run.task) as never }
    }
  })

  await ctx.tool.hook("execute.before", async (event) => {
    const run = runs.get(event.sessionID)
    const kind = toolKind(event.tool, event.input, config)
    if (!run) {
      if (roleOf(config, event.agent) === "manager" && event.tool !== "team") {
        const c = counter(event.sessionID)
        c.tools[kind] = (c.tools[kind] ?? 0) + 1
        if (!toolVisible(rules.manager, event.tool))
          throw new Error(`The manager doesn't use ${event.tool}. Send code questions and changes through the team tool.`)
      }
      return
    }
    touch(event.sessionID)
    if (event.tool === "report") return
    if (run.report) throw new Error("You already called report. Stop now.")
    if (run.toolCalls >= run.toolLimit)
      throw new Error(
        `Limit reached: ${run.toolLimit} tool calls in this agent call. Call report now with what you have.` +
          (run.role === "developer"
            ? " Running out of tool calls is not a reason for BLOCKED: report DONE only if the check passed, otherwise FAILED with the current error and what you tried."
            : ""),
      )
    if (run.task?.skipChecks && kind === "build")
      throw new Error("Build and test are skipped for this task (the user chose this). Don't build or test; finish the edits and report.")
    if (run.role === "lead" && event.tool === "read" && run.task) {
      const problem = leadReadProblem(run.task, event.input)
      if (problem) {
        // Refused reads don't use up the tool calls; from the third one on, Lead is told to stop trying.
        run.refused = (run.refused ?? 0) + 1
        throw new Error(run.refused >= 3 ? `${problem} Stop reading now: report NEED_INFO with all your queries in one round.` : problem)
      }
    }
    run.toolCalls++
    run.tools[kind] = (run.tools[kind] ?? 0) + 1
    run.inFlight++
    if (EDIT_TOOLS.has(event.tool)) {
      const cwd = run.task?.workspace ?? ctx.location.directory
      for (const file of editedPaths(event.input, cwd)) {
        if (!run.before.has(file)) run.before.set(file, existsSync(file) ? readFileSync(file, "utf8") : undefined)
      }
    }
  })

  await ctx.tool.hook("execute.after", (event) => {
    const run = runs.get(event.sessionID)
    if (!run || event.tool === "report") return
    touch(event.sessionID)
    run.inFlight = Math.max(0, run.inFlight - 1)
    if (event.status !== "completed") return
    const cwd = run.task?.workspace ?? ctx.location.directory
    if (EDIT_TOOLS.has(event.tool)) for (const file of editedPaths(event.input, cwd)) run.edited.add(file)
    if (event.tool !== "shell") return
    const command = String((event.input as { command?: unknown })?.command ?? "")
    const exit = resultExit(event.result)
    const shell = { command, exit, log: undefined as string | undefined }
    run.shells.push(shell)
    const task = run.task
    if (!task || (run.role !== "developer" && run.role !== "reviewer")) return
    const text = resultText(event.result)
    const build = matchesAny(command, buildPatterns(config))
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
    if (matchesAny(event.command, buildPatterns(config)))
      event.timeout = Math.max(event.timeout, config.buildCommands.timeoutMin * 60_000)
  })
}
