import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { Plugin } from "@opencode/plugin"
type Context = Plugin.Context
import { FRONT_AGENTS } from "./agents.ts"
import { expandHome, modelLabel, modelsFor, ROLES, type Config, type Role, type WorkerRole } from "./config.ts"
import { buildPrompt, checksText, docName, draftFile, howOutput, join, render, SKIP_CHECKS } from "./messages.ts"
import { EditedFilesTrack, type SidebarStats } from "./rpc.ts"
import { runAgent, tokenCounts, type RunResult } from "./run.ts"
import { counter, runs, type Report, type ToolKind } from "./runtime.ts"
import {
  answersName,
  appendFile,
  briefName,
  draftIsDoc,
  findTask,
  isDocWorkflow,
  loadTask,
  MODE_ROLE,
  newTask,
  save,
  TERMINAL,
  writeFile,
  writeNumbered,
  WORKFLOWS,
  type Mode,
  type Workflow,
  type Pending,
  type Phase,
  type TaskState,
} from "./state.ts"
import { add, appendUsage, lastUsage, report as usageReport, table, toolTotal, type AgentUsage, type UsageDelta } from "./usage.ts"

export const TEAM_ACTIONS = ["start", "ask", "continue", "answer", "approve", "change", "review", "implement", "stop", "resume", "retry", "extend", "stats", "status"] as const
export type TeamAction = (typeof TEAM_ACTIONS)[number]

export interface TeamInput {
  action: TeamAction
  text?: string
  last?: number
  plan?: boolean
  /** Set by the plugin from the calling front agent, not by the model. */
  workflow?: Workflow
  output?: string
  review?: boolean
}

export const TEAM_DESCRIPTION = [
  "Runs the multi-agent team. One call runs at most one agent and returns what to do next.",
  "Actions: start (text = the confirmed request; plan = true when a code request should get a plan, not a quick fix; output = where the plan or research document goes, if the user named a path; review = true when the user asked Principal to review the plan or document),",
  "ask (text = a question; while a task is open, the agent it waits on answers),",
  "continue, answer (text = the user's confirmed answer), approve, change (text = the user's confirmed comments), review (Principal critically reviews the waiting plan or document; text = what to look at),",
  "implement (after an approved plan document: switches to build-manager and starts a code task that carries it out), stop, resume,",
  "retry, extend, stats (last = N tasks), status.",
  "Always follow the NEXT ACTION line of the result.",
].join(" ")

export const TEAM_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: [...TEAM_ACTIONS] },
    text: { type: "string", description: "The confirmed request, question, answer or comments. Build/test commands word for word." },
    last: { type: "integer", minimum: 1, description: "stats only: totals over the last N tasks." },
    plan: { type: "boolean", description: "start only: the user wants a plan, not a quick fix." },
    output: { type: "string", description: "start only, plan/research: the document path the user named." },
    review: { type: "boolean", description: "start only: the user asked for Principal's review of the plan or document." },
  },
  required: ["action"],
  additionalProperties: false,
}

const SESSION_MODES: Partial<Record<Mode, WorkerRole>> = {
  lead: "lead",
  lead_fail: "lead",
  lead_answer: "lead",
  architect: "architect",
  fix: "developer",
  principal_advice: "principal",
  // Kept so a review can continue after Lead answers its questions; each review starts fresh.
  principal_review: "principal",
  principal_doc_review: "principal",
}

export class Team {
  readonly root: string
  private tasks = new Map<string, TaskState>()
  /** Task folders per manager session, built on first use. */
  private sessionDirs?: Map<string, string[]>
  /** Code questions per manager session (they have no task folder). */
  private questions = new Map<string, { count: number; usage: Partial<Record<Role, AgentUsage>> }>()
  /** Called when a session's numbers change (the sidebar refreshes). */
  onChange: (managerSession: string) => void = () => {}

  constructor(
    private ctx: Context,
    private config: Config,
    private log: (msg: string) => void,
  ) {
    this.root = expandHome(config.taskDir)
  }

  // ---- sidebar ----

  /** Per-agent usage of the session's current task (live during a call), and totals over the session. */
  async sidebar(sessionID: string): Promise<SidebarStats> {
    const task = this.task(sessionID)
    const asked = this.questionsIn(sessionID)
    const session = { tasks: 0, questions: asked.count, total: { calls: 0, prompts: 0, tools: 0, tokens: 0 } }
    const sum = (usage: Partial<Record<Role, AgentUsage>>) => {
      for (const u of Object.values(usage)) {
        if (!u) continue
        session.total.calls += u.calls
        session.total.prompts += u.prompts
        session.total.tools += toolTotal(u)
        session.total.tokens += u.input + u.cacheRead + u.output
      }
    }
    sum(asked.usage)
    let current: SidebarStats["task"]
    if (task) {
      if (!TERMINAL.includes(task.phase)) await this.refreshManager(task)
      const usage = structuredClone(task.usage)
      const live = await this.liveCall(task)
      if (live) add(usage, live.role, live.delta)
      const rows = ROLES.filter((r) => usage[r]).map((role) => {
        const u = usage[role]!
        const models = u.models?.length ? u.models : modelsFor(this.config, role).slice(0, 1).map(modelLabel)
        return { role, calls: u.calls, prompts: u.prompts, tools: toolTotal(u), input: u.input, cacheRead: u.cacheRead, output: u.output, running: live?.role === role, models }
      })
      current = { id: task.id, workflow: task.workflow ?? "code", phase: task.phase, attempts: task.attempts, attemptLimit: task.attemptLimit, rows }
      sum(usage)
      session.tasks++
    }
    for (const dir of this.dirsOf(sessionID)) {
      if (dir === task?.dir) continue
      const other = loadTask(dir)
      if (!other) continue
      sum(other.usage)
      session.tasks++
    }
    const models = ROLES.map((role) => ({ role, models: modelsFor(this.config, role).map(modelLabel) }))
    // The RPC output check rejects `task: undefined`; leave the key out instead.
    return current ? { task: current, models, session } : { models, session }
  }

  /** The call running for this task right now, with its usage so far. */
  private async liveCall(task: TaskState): Promise<{ role: Role; delta: UsageDelta } | undefined> {
    const entry = [...runs.entries()].find(([, r]) => r.task?.id === task.id)
    if (!entry) return undefined
    const [sessionID, run] = entry
    const info = await this.ctx.session.get({ sessionID }).catch(() => undefined)
    const now = info ? tokenCounts(info.tokens as never) : run.base
    const base = run.base ?? now
    return {
      role: run.role,
      delta: {
        prompts: run.prompts,
        tools: run.tools,
        input: Math.max(0, (now?.input ?? 0) - (base?.input ?? 0)),
        cacheRead: Math.max(0, (now?.cacheRead ?? 0) - (base?.cacheRead ?? 0)),
        output: Math.max(0, (now?.output ?? 0) - (base?.output ?? 0)),
      },
    }
  }

  private dirsOf(managerSession: string): string[] {
    if (!this.sessionDirs) {
      this.sessionDirs = new Map()
      const names = existsSync(this.root) ? readdirSync(this.root, { withFileTypes: true }).filter((d) => d.isDirectory()) : []
      for (const d of names) {
        const t = loadTask(path.join(this.root, d.name))
        if (!t) continue
        const list = this.sessionDirs.get(t.managerSession) ?? []
        list.push(t.dir)
        this.sessionDirs.set(t.managerSession, list)
      }
    }
    return this.sessionDirs.get(managerSession) ?? []
  }

  private questionsIn(managerSession: string) {
    let q = this.questions.get(managerSession)
    if (!q) {
      q = { count: 0, usage: {} }
      for (const line of lastUsage(this.root, Number.MAX_SAFE_INTEGER).lines)
        if (line.task === "ask" && line.session === managerSession) {
          q.count++
          for (const [role, u] of Object.entries(line.usage)) if (u) add(q.usage, role as Role, u)
        }
      this.questions.set(managerSession, q)
    }
    return q
  }

  async handle(input: TeamInput, managerSession: string, signal: AbortSignal): Promise<string> {
    const task = this.task(managerSession)
    if (task) task.usage.manager = { ...(task.usage.manager ?? this.emptyManager()), calls: (task.usage.manager?.calls ?? 0) + 1 }
    switch (input.action) {
      case "start":
        return this.start(managerSession, input.text ?? "", signal, input)
      case "ask":
        if (task && !TERMINAL.includes(task.phase)) return this.reply(task, input.text ?? "", signal)
        return this.ask(managerSession, input.text ?? "", signal)
      case "stats":
        return this.stats(managerSession, input.last)
    }
    if (!task) return "No task in this session. NEXT ACTION: polish the user's request and call team with action \"start\"."
    switch (input.action) {
      case "status":
        return render(task)
      case "continue":
        if (task.phase === "stopped")
          return `Task ${task.id} is stopped.\nNEXT ACTION: ask the user whether to resume it. Yes → call team with action "resume".`
        return this.step(task, signal)
      case "resume":
        if (task.phase !== "stopped") return render(task)
        task.phase = task.pending ? "running" : "stuck"
        save(task)
        return this.step(task, signal)
      case "answer":
        return this.answer(task, input.text ?? "", signal)
      case "approve":
        if (task.phase === "brief") {
          task.phase = "running"
          task.pending = { mode: "architect" }
          save(task)
          return this.step(task, signal)
        }
        if (task.phase !== "approval") return this.wrongPhase(task, "approve")
        if (task.stage === "what") {
          this.toHow(task)
          save(task)
          return this.step(task, signal)
        }
        if (isDocWorkflow(task)) {
          this.done(task, (task.stage === "how" ? task.planSummary : task.docSummary) ?? "")
          await this.finish(task, "done")
          return render(task)
        }
        task.phase = "running"
        task.step = 1
        task.rounds = 0
        task.developerSeenPlan = false
        task.pending = { mode: "fix", fresh: true }
        save(task)
        return this.step(task, signal)
      case "change":
        return this.change(task, input.text ?? "", signal)
      case "review":
        return this.review(task, input.text ?? "", signal)
      case "implement":
        return this.implement(task, signal)
      case "stop":
        return this.stop(task)
      case "retry":
        if (task.phase !== "stuck" || !task.pending) return this.wrongPhase(task, "retry")
        task.attemptLimit = Math.max(task.attemptLimit, task.attempts + 1)
        task.pending = { ...task.pending, fresh: true }
        task.phase = "running"
        save(task)
        return this.step(task, signal)
      case "extend":
        if (task.phase !== "budget") return this.wrongPhase(task, "extend")
        task.attemptLimit += 10
        task.phase = "running"
        save(task)
        return this.step(task, signal)
    }
    return render(task)
  }

  // ---- task lookup and manager usage ----

  private task(managerSession: string): TaskState | undefined {
    let task = this.tasks.get(managerSession)
    if (!task) {
      task = findTask(this.root, managerSession)
      if (task) this.tasks.set(managerSession, task)
    }
    return task
  }

  private emptyManager(): AgentUsage {
    return { calls: 0, prompts: 0, tools: {}, input: 0, cacheRead: 0, output: 0, models: [], ms: 0 }
  }

  private async refreshManager(task: TaskState) {
    const info = await this.ctx.session.get({ sessionID: task.managerSession }).catch(() => undefined)
    const base = task.managerBaseline
    if (!info || !base) return
    const c = counter(task.managerSession)
    const t = info.tokens
    const tools: Partial<Record<ToolKind, number>> = {}
    for (const [k, v] of Object.entries(c.tools)) tools[k as ToolKind] = Math.max(0, (v ?? 0) - (base.tools[k] ?? 0))
    const prev = task.usage.manager ?? this.emptyManager()
    task.usage.manager = {
      calls: prev.calls,
      prompts: Math.max(0, c.prompts - base.prompts),
      tools,
      input: Math.max(0, t.input + t.cache.write - base.input),
      cacheRead: Math.max(0, t.cache.read - base.cacheRead),
      output: Math.max(0, t.output + t.reasoning - base.output - base.reasoning),
      models: info.model ? [modelLabel(info.model)] : modelsFor(this.config, "manager").slice(0, 1).map(modelLabel),
      ms: 0,
    }
  }

  private lastUserMessage = async (sessionID: string): Promise<{ text: string; time: number } | undefined> => {
    const messages = (await this.ctx.session.context({ sessionID }).catch(() => [])) as unknown as Array<{
      type?: string
      text?: string
      time?: { created?: number }
    }>
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.type === "user" && typeof m.text === "string") return { text: m.text, time: m.time?.created ?? 0 }
    }
    return undefined
  }

  /** The user's own words: their latest message if it came after the plugin asked, else the manager's text. */
  private async userWords(task: TaskState, text: string): Promise<string> {
    const last = await this.lastUserMessage(task.managerSession)
    return (last && last.time > (task.askedAt ?? 0) && last.text.trim() ? last.text : text).trim()
  }

  /** Everything the user typed since the plugin last asked them (their original words behind a polished reply). */
  private async userReplies(task: TaskState): Promise<string> {
    const messages = (await this.ctx.session.context({ sessionID: task.managerSession }).catch(() => [])) as unknown as Array<{
      type?: string
      text?: string
      time?: { created?: number }
    }>
    return messages
      .filter((m) => m.type === "user" && typeof m.text === "string" && (m.time?.created ?? 0) > (task.askedAt ?? 0))
      .map((m) => m.text!.trim())
      .filter(Boolean)
      .join("\n\n")
  }

  /** The polished reply, plus the user's original words when they differ. */
  private async withOriginal(task: TaskState, text: string, tag: string): Promise<{ polished: string; note: string }> {
    const original = await this.userReplies(task)
    const polished = text.trim() || original
    const same = original.replace(/\s+/g, " ") === polished.replace(/\s+/g, " ")
    const note = join(`<${tag}>\n${polished}\n</${tag}>`, original && !same ? `The user's original words:\n<original>\n${original}\n</original>` : "")
    return { polished, note }
  }

  /** The agent the task waits on: the one that asked, else the architect if it has a session, else lead. */
  private replier(task: TaskState): "lead" | "architect" | "principal" | undefined {
    if (task.phase === "questions" && task.questionsFrom === "lead" && task.sessions.lead) return "lead"
    if (task.phase === "questions" && task.questionsFrom === "principal_advice" && task.sessions.principal) return "principal"
    if (task.sessions.architect) return "architect"
    if (task.sessions.lead) return "lead"
    return undefined
  }

  // ---- actions ----

  /** `seed` prepares a task that doesn't start with Lead (implementing an approved plan). */
  private async start(managerSession: string, text: string, signal: AbortSignal, opts: Partial<TeamInput> = {}, seed?: (task: TaskState) => void): Promise<string> {
    const active = this.task(managerSession)
    // A confirmed message sent as "start" while the task waits on the user is the user's reply to it.
    if (active?.phase === "questions") return this.answer(active, text, signal)
    if (active?.phase === "approval" || active?.phase === "brief") return this.change(active, text, signal)
    if (active && active.phase !== "running" && !TERMINAL.includes(active.phase))
      return join("The task waits on the user's choice below; the message was not sent.", render(active))
    if (active && !TERMINAL.includes(active.phase))
      return [
        `A task is already active in this session: ${active.id} (${active.phase}). Only one task runs per session.`,
        `NEXT ACTION: ask the user [Stop task] [Wait]. Stop task → call team with action "stop", then "start" again. Wait → tell the user to send the new request again when this task ends.`,
      ].join("\n")
    if (!text.trim()) return 'start needs text: the confirmed request. NEXT ACTION: call team with action "start" and the request.'
    const task = newTask(this.root, managerSession, this.ctx.location.directory, text, this.config.limits.taskAttempts)
    if (opts.plan === true) task.forcePlan = true
    if (opts.review === true) task.reviewFirst = true
    const workflow = WORKFLOWS.includes(opts.workflow as Workflow) ? opts.workflow : "code"
    if (workflow !== "code") {
      task.workflow = workflow
      task.output = this.outputPath(task, opts.output)
      if (existsSync(task.output)) writeFile(task, "existing.md", readFileSync(task.output, "utf8"))
    }
    writeFile(task, "request.md", text)
    const original = await this.lastUserMessage(managerSession)
    writeFile(task, "request-original.md", original?.text ?? text)
    const info = await this.ctx.session.get({ sessionID: managerSession }).catch(() => undefined)
    const c = counter(managerSession)
    task.managerBaseline = {
      input: (info?.tokens.input ?? 0) + (info?.tokens.cache.write ?? 0),
      output: info?.tokens.output ?? 0,
      reasoning: info?.tokens.reasoning ?? 0,
      cacheRead: info?.tokens.cache.read ?? 0,
      prompts: Math.max(0, c.prompts - 1),
      tools: { ...c.tools } as Record<string, number>,
    }
    task.usage.manager = { ...this.emptyManager(), calls: 1 }
    task.pending = { mode: "lead" }
    seed?.(task)
    this.tasks.set(managerSession, task)
    this.sessionDirs?.set(managerSession, [...this.dirsOf(managerSession), task.dir])
    const { build, test, whenMissing } = this.config.checks
    const lines = [build.trim() && `- Build: \`${build.trim()}\``, test.trim() && `- Test: \`${test.trim()}\``].filter(Boolean)
    if (isDocWorkflow(task)) {
      // Nobody builds or tests in a plan or research task; a plan's how-document still names the configured checks.
      if (task.workflow === "plan" && lines.length) writeFile(task, "checks.md", checksText(lines.join("\n")))
    } else if (lines.length) {
      writeFile(task, "checks.md", checksText(lines.join("\n")))
    } else if (whenMissing === "skip") this.skipChecks(task)
    else {
      task.phase = "checks"
      task.askedAt = Date.now()
    }
    save(task)
    this.log(`task ${task.id} started`)
    return this.step(task, signal)
  }

  /** The document's path: the one the user named (relative to the project), else the workflow's default; a default never overwrites an existing file. */
  private outputPath(task: TaskState, given?: string): string {
    const wf = this.config.workflows[task.workflow as "plan" | "research"]
    if (given?.trim()) return path.resolve(task.workspace, expandHome(given.trim()))
    const name = task.id.replace(/^\d{8}-\d{6}-/, "")
    const file = path.resolve(task.workspace, expandHome(wf.output.replaceAll("{task}", name)))
    const ext = path.extname(file)
    let out = file
    for (let n = 2; existsSync(out); n++) out = `${file.slice(0, file.length - ext.length)}-${n}${ext}`
    return out
  }

  /** Saves the document to the project; on failure the copy in the task folder is still there. */
  private writeOutput(task: TaskState, file: string, content: string, copy: string): string | undefined {
    try {
      const before = existsSync(file) ? readFileSync(file, "utf8") : undefined
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, content.endsWith("\n") ? content : content + "\n")
      this.trackEdit(task.managerSession, file, before)
      return undefined
    } catch (e) {
      this.log(`task ${task.id}: cannot write ${file}: ${(e as Error).message}`)
      return `Could not write ${file} (${(e as Error).message}); the document is in ${path.join(task.dir, copy)}.`
    }
  }

  /** Shows a file the plugin wrote in the opencode-edited-files sidebar; does nothing when that plugin isn't installed. */
  private trackEdit(sessionID: string, file: string, before: string | undefined) {
    try {
      void this.ctx
        .rpc(EditedFilesTrack)
        .track({ sessionID, files: [{ path: file, ...(before === undefined ? {} : { before }) }] })
        .catch(() => undefined)
    } catch {
      // No RPC client (tests).
    }
  }

  private skipChecks(task: TaskState) {
    task.skipChecks = true
    writeFile(task, "checks.md", SKIP_CHECKS)
  }

  /** The user's build and test commands for this task, or "skip". */
  private async checks(task: TaskState, text: string, signal: AbortSignal): Promise<string> {
    const given = await this.userWords(task, text)
    if (!given) return 'answer needs text: the commands, or "skip". NEXT ACTION: call team with action "answer".'
    if (/^skip\b/i.test(given)) this.skipChecks(task)
    else writeFile(task, "checks.md", checksText(`The user gave:\n\n${given}`))
    task.phase = "running"
    save(task)
    return this.step(task, signal)
  }

  /** A user question while a task is open: the agent the task waits on answers in its own session. The task doesn't move. */
  private async reply(task: TaskState, text: string, signal: AbortSignal): Promise<string> {
    const role = this.replier(task)
    if (!role) return this.ask(task.managerSession, text, signal)
    const { polished, note } = await this.withOriginal(task, text, "question")
    if (!polished) return 'ask needs text: the question. NEXT ACTION: call team with action "ask" and the question.'
    const mode: Mode = `${role}_reply`
    const sessionID = task.sessions[role]
    this.log(`task ${task.id}: user question → ${role}`)
    const res = await runAgent(
      this.ctx,
      this.config,
      {
        role,
        mode,
        task,
        sessionID,
        parentID: task.managerSession,
        title: `team: ${role} (user question)`,
        prompt: buildPrompt(this.config, task, { mode, note }, !sessionID),
        signal,
      },
      this.log,
    )
    add(task.usage, role, res.usage)
    if (res.sessionID) task.sessions[role] = res.sessionID
    const answer = res.report?.content ?? `${role} couldn't answer: ${res.failure ?? res.end}.`
    appendFile(task, answersName(task), `## User question\n\n${note}\n\n## ${role} answered\n\n${answer}\n`)
    task.askedAt = Date.now()
    save(task)
    this.onChange(task.managerSession)
    return join(
      `ANSWER from ${role}:`,
      answer,
      "The task hasn't moved; it is still waiting on the user:",
      render(task),
      "NEXT ACTION: show the answer to the user, then continue with the waiting step above.",
    )
  }

  private async ask(managerSession: string, question: string, signal: AbortSignal): Promise<string> {
    if (!question.trim()) return 'ask needs text: the question. NEXT ACTION: call team with action "ask" and the question.'
    const role = "intern"
    const res = await runAgent(
      this.ctx,
      this.config,
      {
        role,
        mode: "intern",
        parentID: managerSession,
        title: `team: ${role} (question)`,
        prompt: join("MODE: user question. Answer the user's question about the code. Report FOUND with the answer in content (path:line references, short excerpts), or NOT_FOUND with what you searched.", `<question>\n${question}\n</question>`),
        signal,
      },
      this.log,
    )
    const usage: Partial<Record<string, AgentUsage>> = {}
    add(usage as never, role, res.usage)
    const asked = this.questionsIn(managerSession)
    appendUsage(this.root, { task: "ask", session: managerSession, time: Date.now(), outcome: res.report?.status ?? res.end, usage: usage as never })
    asked.count++
    if (usage[role]) add(asked.usage, role, usage[role]!)
    if (!res.report) return `The ${role} couldn't answer: ${res.failure}.\nNEXT ACTION: tell the user.`
    return join(
      `ANSWER (${res.report.status}):`,
      res.report.content,
      "```\n" + table(usage as never) + "\n```",
      "NEXT ACTION: show the answer to the user. No task was started.",
    )
  }

  private async stats(managerSession: string, last?: number): Promise<string> {
    if (last) {
      const { lines, total } = lastUsage(this.root, last)
      if (!lines.length) return "No finished tasks recorded yet."
      return join(`Usage over the last ${lines.length} task(s), with each agent's share of calls, prompts and tokens:`, "```\n" + table(total, true) + "\n```", "NEXT ACTION: show this to the user.")
    }
    const task = this.task(managerSession)
    if (!task) return 'No task in this session. Use last: N for earlier tasks. NEXT ACTION: tell the user.'
    await this.refreshManager(task)
    save(task)
    return join(`Usage for task ${task.id} (${task.phase}), attempts ${task.attempts}/${task.attemptLimit}:`, usageReport(task.usage, Math.max(1, task.planSteps)), "NEXT ACTION: show this to the user.")
  }

  private async answer(task: TaskState, text: string, signal: AbortSignal): Promise<string> {
    if (task.phase === "checks") return this.checks(task, text, signal)
    if (task.phase !== "questions" || !task.questionsFrom) return this.wrongPhase(task, "answer")
    const { polished, note: answer } = await this.withOriginal(task, text, "answer")
    if (!polished) return 'answer needs text: the user\'s answer. NEXT ACTION: call team with action "answer".'
    appendFile(task, answersName(task), `## Answer\n\n${answer}\n`)
    const note = `The user answered your questions:\n${answer}`
    const from = task.questionsFrom
    task.pending =
      from === "lead"
        ? { mode: "lead", note }
        : from === "principal_advice" && task.sessions.principal
          ? { mode: "principal_advice", note }
          : from === "principal_advice"
            ? { mode: "architect", note: `Principal asked the user questions. ${note}` }
            : { mode: "architect", note }
    task.phase = "running"
    task.questions = undefined
    save(task)
    return this.step(task, signal)
  }

  private async change(task: TaskState, text: string, signal: AbortSignal): Promise<string> {
    if (task.phase !== "approval" && task.phase !== "brief") return this.wrongPhase(task, "change")
    const { polished, note: comments } = await this.withOriginal(task, text, "comments")
    if (!polished) return 'change needs text: the user\'s comments. NEXT ACTION: call team with action "change".'
    if (task.phase === "brief") {
      const which = task.workflow === "research" ? "research" : "concept"
      appendFile(task, answersName(task), `## Comments on the ${which} brief\n\n${comments}\n`)
      task.pending = { mode: "lead", note: `The user adjusted the ${which} brief. Revise it and report ESCALATE again with the whole brief:\n${comments}` }
    } else {
      // Comments go through Lead, who briefs the Architect (it has no file access).
      appendFile(task, answersName(task), `## Comments on the ${docName(task)} (${draftFile(task)})\n\n${comments}\n`)
      if (!draftIsDoc(task)) task.skipPrincipalReview = true
      task.revising = true
      task.pending = { mode: "lead", note: comments, revision: true, files: task.infeasible ? [task.infeasible] : undefined }
      task.infeasible = undefined
    }
    task.phase = "running"
    save(task)
    return this.step(task, signal)
  }

  /** The user asks Principal to critically review the waiting plan or document. */
  private async review(task: TaskState, text: string, signal: AbortSignal): Promise<string> {
    if (task.phase !== "approval") return this.wrongPhase(task, "review")
    const limit = this.config.limits.principalReviews
    if ((task.reviews ?? 0) >= limit)
      return join(`Principal has already reviewed this task ${limit} time(s), the limit (limits.principalReviews).`, render(task))
    const focus = text.trim() ? (await this.withOriginal(task, text, "focus")).note : undefined
    if (focus) appendFile(task, answersName(task), `## Review requested\n\n${focus}\n`)
    task.reviews = (task.reviews ?? 0) + 1
    task.pending = { mode: "principal_doc_review", note: focus, fresh: true }
    task.phase = "running"
    save(task)
    return this.step(task, signal)
  }

  private async stop(task: TaskState): Promise<string> {
    if (TERMINAL.includes(task.phase)) return render(task)
    task.phase = "stopped"
    await this.finish(task, "stopped")
    return render(task)
  }

  /** The "Implement it" button: switches the session to build-manager and starts a code task from the approved plan document. */
  private async implement(task: TaskState, signal: AbortSignal): Promise<string> {
    if (task.workflow !== "plan" || !task.output) return this.wrongPhase(task, "implement")
    if (task.phase === "approval" && task.stage === "how") {
      this.done(task, task.planSummary ?? "")
      await this.finish(task, "done")
    }
    if (task.phase !== "done") return this.wrongPhase(task, "implement")
    let note = `Switched to ${FRONT_AGENTS.code}.`
    try {
      await this.ctx.session.switchAgent({ sessionID: task.managerSession, agent: FRONT_AGENTS.code })
    } catch (e) {
      this.log(`task ${task.id}: switch to ${FRONT_AGENTS.code} failed: ${(e as Error).message}`)
      note = `Could not switch the agent (${(e as Error).message}); the user can press Tab to switch to ${FRONT_AGENTS.code}.`
    }
    const request = readFileSync(path.join(task.dir, "request.md"), "utf8").trim()
    if (task.stage !== "how" || !task.plan) {
      // A plan document from before the what/how stages: the code task plans from it.
      const text = join(
        `Implement the plan in ${task.output}. The user approved that plan document; read it first and follow it.`,
        `The planning request was:\n${request}`,
      )
      return join(note, await this.start(task.managerSession, text, signal, { plan: true, workflow: "code" }))
    }
    // The approved how-document is the plan: Developer carries it out; the Architect steps in only if a step fails.
    const text = join(`Implement the approved plan (${howOutput(task.output)}) for the what-document ${task.output}.`, `The planning request was:\n${request}`)
    const seed = (code: TaskState) => {
      const copy = (from: string, to = from) => {
        if (existsSync(path.join(task.dir, from))) writeFile(code, to, readFileSync(path.join(task.dir, from), "utf8"))
      }
      if (task.doc) copy(`doc-${task.doc}.md`, "doc-1.md")
      copy(`plan-${task.plan}.md`, "plan-1.md")
      copy("how-brief.md")
      copy("how-answers.md")
      const kind = "how-brief-answer"
      for (let n = 1; n <= (task.seq[kind] ?? 0); n++) copy(`${kind}-${n}.md`)
      code.seq = { ...code.seq, plan: 1, ...(task.doc ? { doc: 1 } : {}), ...(task.seq[kind] ? { [kind]: task.seq[kind]! } : {}) }
      code.doc = task.doc ? 1 : undefined
      code.docSummary = task.docSummary
      code.stage = "how"
      code.stageRun = 1
      code.plan = 1
      code.planSteps = task.planSteps
      code.planRisk = task.planRisk
      code.planSummary = task.planSummary
      code.step = 1
      code.history.push({ n: 0, mode: "architect", role: "architect", status: "PLAN", summary: `approved in plan task ${task.id}`, file: "plan-1.md", plan: 1, stageRun: 1 })
      code.pending = { mode: "fix", fresh: true }
    }
    return join(note, await this.start(task.managerSession, text, signal, { workflow: "code" }, seed))
  }

  private wrongPhase(task: TaskState, action: string) {
    return `"${action}" doesn't apply now; the task is in phase ${task.phase}.\n\n${render(task)}`
  }

  // ---- running one agent ----

  private async step(task: TaskState, signal: AbortSignal): Promise<string> {
    if (task.phase !== "running" || !task.pending) return render(task)
    if (task.attempts >= task.attemptLimit) {
      task.phase = "budget"
      await this.refreshManager(task)
      save(task)
      return render(task)
    }
    const pending = task.pending
    const role = MODE_ROLE[pending.mode]
    const keep = SESSION_MODES[pending.mode]
    const sessionID = keep && !pending.fresh ? task.sessions[keep] : undefined
    if (pending.mode === "fix" && !sessionID) task.developerSeenPlan = false
    const prompt = buildPrompt(this.config, task, pending, !sessionID)
    task.attempts++
    save(task)
    this.onChange(task.managerSession)
    this.log(`task ${task.id}: attempt ${task.attempts} → ${role} (${pending.mode})`)
    const res = await runAgent(
      this.ctx,
      this.config,
      {
        role,
        mode: pending.mode,
        task,
        sessionID,
        parentID: task.managerSession,
        title: `team: ${role} (${pending.mode}${pending.mode === "fix" ? ` plan ${task.plan} step ${task.step}` : ""})`,
        prompt,
        signal,
      },
      this.log,
    )
    add(task.usage, role, res.usage)
    if (keep && res.sessionID) task.sessions[keep] = res.sessionID
    for (const file of res.run?.edited ?? []) {
      const rel = path.relative(task.workspace, file) || file
      if (!task.editedFiles.includes(rel)) task.editedFiles.push(rel)
    }
    if (res.end === "aborted") {
      task.phase = "stopped"
      await this.finish(task, "stopped")
    } else if (res.end !== "report" || !res.report) {
      this.stuck(task, `${role} (${pending.mode}): ${res.failure ?? res.end}`, { ...pending, fresh: true })
    } else {
      task.pending = undefined
      this.apply(task, pending, res.report, res)
    }
    const phase = task.phase as Phase
    if (phase === "stuck") await this.refreshManager(task)
    if (phase === "done") await this.finish(task, "done")
    save(task)
    this.onChange(task.managerSession)
    return render(task)
  }

  private async finish(task: TaskState, outcome: string) {
    await this.refreshManager(task)
    save(task)
    appendUsage(this.root, { task: task.id, time: Date.now(), outcome, usage: task.usage })
  }

  private stuck(task: TaskState, reason: string, retry: Pending) {
    task.phase = "stuck"
    task.stuckReason = reason
    task.pending = retry
  }

  private record(task: TaskState, mode: Mode, r: Report, file?: string) {
    task.history.push({
      n: task.attempts,
      mode,
      role: MODE_ROLE[mode],
      status: r.status,
      summary: r.summary,
      file,
      step: mode === "fix" || mode === "diagnose" || mode === "review" ? task.step : undefined,
      plan: task.plan || undefined,
      stageRun: task.stageRun,
    })
  }

  private reportFile(task: TaskState, kind: string, mode: Mode, r: Report): string {
    const where = task.plan && ["fix", "diagnose", "review"].includes(mode) ? ` (plan ${task.plan}, step ${task.step})` : ""
    return writeNumbered(task, kind, `# ${MODE_ROLE[mode]}: ${r.status}${where}\n\n${r.summary}\n\n${r.content}`)
  }

  private apply(task: TaskState, p: Pending, r: Report, res: RunResult) {
    switch (p.mode) {
      case "lead":
      case "lead_fail": {
        if (r.status === "QUESTIONS") return this.askUser(task, p.mode, r)
        if (r.status === "INFEASIBLE") return this.infeasible(task, p.mode, r)
        if (task.revising) {
          task.revising = false
          const file = writeNumbered(task, "revision", r.content)
          this.record(task, p.mode, r, file)
          task.architectUnseen.push(file)
          const doc = draftIsDoc(task)
          task.pending = {
            mode: "architect",
            note: `The user asked for changes to the ${docName(task)} (${draftFile(task)}); Lead's revision brief is ${file}. Revise it accordingly and report ${doc ? "DOC" : "PLAN"} with the whole revised ${doc ? "document" : "plan"}${task.workflow === "research" ? "; new questions get a `## Follow-up <date>: <topic>` section (use NEED_INFO first if they need new evidence)" : ""}.`,
          }
          return
        }
        if (r.status === "TRIVIAL") {
          writeFile(task, "brief.md", r.content)
          this.record(task, p.mode, r, "brief.md")
          task.pending = { mode: "fix_trivial", fresh: true }
          return
        }
        // Code: a failed trivial attempt, or behaviour the request already fixes, goes straight to the how stage.
        if (!task.workflow && !task.stage && (p.mode === "lead_fail" || r.what === "settled")) this.setStage(task, "how")
        else if (task.workflow !== "research" && !task.stage) this.setStage(task, "what")
        writeFile(task, briefName(task), r.content)
        this.record(task, p.mode, r, briefName(task))
        if (task.workflow === "research") task.depth = r.depth ?? task.depth ?? "breadth"
        const confirm =
          task.workflow === "research"
            ? this.config.workflows.research.confirmBrief && task.depth !== "quick"
            : task.stage === "what" && this.config.workflows[task.workflow === "plan" ? "plan" : "code"].confirmBrief
        if (confirm) {
          task.phase = "brief"
          task.askedAt = Date.now()
          return
        }
        task.pending = { mode: "architect", fresh: task.stage === "how" && !!task.doc }
        return
      }
      case "lead_answer": {
        const kind = `${briefName(task).slice(0, -3)}-answer`
        const file = writeNumbered(task, kind, `# Lead's answers (${(p.ids ?? []).join(", ")})\n\n${r.content}`)
        this.record(task, p.mode, r, file)
        const asker = p.asker ?? "architect"
        const note = `Lead answered your questions ${(p.ids ?? []).join(", ")} in ${file}.`
        if (asker === "architect") {
          task.architectUnseen.push(file)
          task.pending = { mode: "architect", note, afterReview: p.afterReview }
        } else task.pending = { mode: asker, note, files: [file], afterReview: p.afterReview }
        return
      }
      case "fix_trivial": {
        const file = this.reportFile(task, "report", p.mode, r)
        this.record(task, p.mode, r, file)
        if (r.status === "DONE") {
          if ((res.run?.edited.size ?? 0) <= 1) return this.done(task, r.summary)
          task.pending = { mode: "review_trivial" }
          return
        }
        task.trivialFailed = true
        task.pending = { mode: "lead_fail" }
        return
      }
      case "review_trivial": {
        const file = this.reportFile(task, "analysis", p.mode, r)
        this.record(task, p.mode, r, file)
        if (r.status === "PASS") return this.done(task, r.summary)
        task.trivialFailed = true
        task.pending = { mode: "lead_fail" }
        return
      }
      case "architect": {
        if (r.status === "QUESTIONS") return this.askUser(task, p.mode, r)
        if (r.status === "ASK") return this.askLead(task, p, r)
        if (r.status === "INFEASIBLE") return this.infeasible(task, p.mode, r)
        if (r.status === "NEED_INFO") {
          task.needInfo++
          this.record(task, p.mode, r)
          task.pending = { mode: "intern", note: r.content, afterReview: p.afterReview }
          return
        }
        if (r.status === "ESCALATE") {
          const file = writeNumbered(task, "escalation", r.content)
          this.record(task, p.mode, r, file)
          return this.toAdvice(task, `architect escalated (${file})`, { mode: "architect", note: `Retry: write the ${docName(task)}, or escalate again.` })
        }
        task.principalNote = p.afterReview
        if (r.status === "DOC") {
          const file = writeNumbered(task, "doc", r.content)
          this.record(task, p.mode, r, file)
          task.doc = task.seq.doc
          const failed = task.output ? this.writeOutput(task, task.output, r.content, file) : undefined
          task.docSummary = failed ? `${r.summary}\n\n${failed}` : r.summary
          return this.afterDraft(task)
        }
        const file = writeNumbered(task, "plan", r.content)
        this.record(task, p.mode, r, file)
        const failed = task.workflow === "plan" && task.output ? this.writeOutput(task, howOutput(task.output), r.content, file) : undefined
        task.plan = task.seq.plan
        task.planSteps = r.steps ?? 1
        task.planRisk = r.risk === "yes"
        task.planHadFailure = task.planFailures > 0
        task.step = 1
        task.rounds = 0
        task.planSummary = failed ? `${r.summary}\n\n${failed}` : r.summary
        const review = task.planRisk && !task.skipPrincipalReview
        task.skipPrincipalReview = false
        if (review) {
          task.pending = { mode: "principal_review", fresh: true }
        } else this.afterDraft(task)
        return
      }
      case "principal_doc_review": {
        if (r.status === "ASK") return this.askLead(task, p, r)
        const file = this.reportFile(task, "principal", p.mode, r)
        this.record(task, p.mode, r, file)
        task.principalNote = file
        if (r.status === "APPROVE") return this.toApproval(task)
        task.architectUnseen.push(file)
        const doc = draftIsDoc(task)
        task.pending = {
          mode: "architect",
          afterReview: file,
          note: `Principal critically reviewed the ${docName(task)} (${draftFile(task)}) at the user's request (${file}). Revise it: fix every must-fix item, or say in the ${doc ? "document" : "plan"} why not. Report ${doc ? "DOC" : "PLAN"} with the whole revised ${doc ? "document" : "plan"}.`,
        }
        return
      }
      case "intern": {
        const file = writeNumbered(task, "findings", `# Findings (${r.status})\n\n${r.content}`)
        this.record(task, p.mode, r, file)
        task.architectUnseen.push(file)
        task.pending = { mode: "architect", note: `Intern answered your queries (${r.status}).`, afterReview: p.afterReview }
        return
      }
      case "principal_review": {
        if (r.status === "ASK") return this.askLead(task, p, r)
        const file = this.reportFile(task, "principal", p.mode, r)
        this.record(task, p.mode, r, file)
        task.principalNote = file
        if (r.status === "APPROVE") return this.toApproval(task)
        task.architectUnseen.push(file)
        task.skipPrincipalReview = true
        task.pending = { mode: "architect", afterReview: file, note: `Principal requested changes to plan ${task.plan} (${file}). Revise the plan once.` }
        return
      }
      case "fix": {
        const file = this.reportFile(task, "report", p.mode, r)
        this.record(task, p.mode, r, file)
        task.architectUnseen.push(file)
        if (r.status === "BLOCKED") return this.planFailure(task, `Developer is blocked on step ${task.step}: ${r.summary}`)
        if (r.status === "DONE") {
          if (task.step < task.planSteps) {
            task.step++
            task.rounds = 0
            task.pending = { mode: "fix" }
            return
          }
          if (this.reviewRequired(task)) task.pending = { mode: "review" }
          else this.done(task, r.summary)
          return
        }
        task.planHadFailure = true
        task.pending = { mode: "diagnose" }
        return
      }
      case "diagnose": {
        const file = this.reportFile(task, "analysis", p.mode, r)
        this.record(task, p.mode, r, file)
        task.architectUnseen.push(file)
        if (r.status === "LOCAL") return this.round(task, file, r)
        if (r.status === "REPLAN") return this.planFailure(task, `the reviewer asked for a new plan (${file}): ${r.summary}`)
        return this.toAdvice(task, `the reviewer escalated (${file})`, { mode: "diagnose" })
      }
      case "review": {
        const file = this.reportFile(task, "analysis", p.mode, r)
        this.record(task, p.mode, r, file)
        task.architectUnseen.push(file)
        if (r.status === "PASS") return this.done(task, r.summary)
        task.step = task.planSteps
        return this.round(task, file, r)
      }
      case "principal_advice": {
        if (r.status === "ASK") return this.askLead(task, p, r)
        // Counted once advice is given: a question round before it is part of the same advice.
        if (r.status === "ADVICE") task.principalAdviceUsed++
        const file = this.reportFile(task, "principal", p.mode, r)
        this.record(task, p.mode, r, file)
        task.architectUnseen.push(file)
        if (r.status === "QUESTIONS") return this.askUser(task, p.mode, r)
        task.pending = { mode: "architect", note: `Principal's advice is in ${file}. Write the next plan following it.` }
        return
      }
    }
  }

  private reviewRequired(task: TaskState) {
    return task.planHadFailure || task.planRisk || task.editedFiles.length >= this.config.review.minFiles
  }

  private round(task: TaskState, file: string, r: Report) {
    task.rounds++
    if (task.rounds > this.config.limits.developerRounds)
      return this.planFailure(task, `${this.config.limits.developerRounds} developer rounds used on step ${task.step} without success`)
    task.pending = { mode: "fix", note: `Round ${task.rounds} on step ${task.step}. Instructions from the reviewer (${file}):\n<analysis>\n${r.content}\n</analysis>` }
  }

  private planFailure(task: TaskState, reason: string) {
    task.planFailures++
    const retry: Pending = { mode: "architect", note: `Plan ${task.plan} failed: ${reason}. Write the next plan.` }
    if (task.principalAdviceUsed >= this.config.limits.principalAdvice) return this.stuck(task, `plan ${task.plan} failed after Principal's advice: ${reason}`, retry)
    if (task.planFailures >= this.config.limits.planFailures) return this.toAdvice(task, `${task.planFailures} plans failed; last: ${reason}`, retry)
    task.pending = retry
  }

  private toAdvice(task: TaskState, reason: string, retry: Pending) {
    if (task.principalAdviceUsed >= this.config.limits.principalAdvice) return this.stuck(task, `${reason}, and Principal's advice was already used`, retry)
    task.pending = { mode: "principal_advice", note: reason, fresh: true }
  }

  /** A new plan or document: Principal's review first if the user asked for it in the request, else the user. */
  private afterDraft(task: TaskState) {
    if (task.reviewFirst && (task.reviews ?? 0) < this.config.limits.principalReviews) {
      task.reviewFirst = false
      task.reviews = (task.reviews ?? 0) + 1
      task.pending = { mode: "principal_doc_review", fresh: true }
      return
    }
    task.reviewFirst = false
    this.toApproval(task)
  }

  private toApproval(task: TaskState) {
    task.phase = "approval"
    task.askedAt = Date.now()
  }

  private setStage(task: TaskState, stage: "what" | "how") {
    task.stage = stage
    task.stageRun = (task.stageRun ?? 0) + 1
    task.needInfo = 0
    task.architectUnseen = []
  }

  /** The user approved the what-document: the how stage starts in fresh sessions with only that document. */
  private toHow(task: TaskState) {
    task.whatSessions = { lead: task.sessions.lead, architect: task.sessions.architect }
    task.sessions.lead = undefined
    task.sessions.architect = undefined
    task.sessions.principal = undefined
    task.principalNote = undefined
    task.skipPrincipalReview = false
    this.setStage(task, "how")
    const infeasible = task.infeasible
    task.infeasible = undefined
    task.phase = "running"
    task.pending = infeasible
      ? { mode: "lead", fresh: true, files: [infeasible], note: `An earlier how stage found a decision unworkable (${infeasible}); the user kept the what-document as it is. Find a way that keeps it, or report INFEASIBLE again with stronger evidence.` }
      : { mode: "lead", fresh: true }
  }

  /** The Architect or Principal asks Lead; Lead's continuing session answers in a numbered file. */
  private askLead(task: TaskState, p: Pending, r: Report) {
    task.needInfo++
    const start = task.askSeq ?? 0
    const ids = (r.questions ?? []).map((_, i) => `A${start + i + 1}`)
    task.askSeq = start + ids.length
    const text = (r.questions ?? []).map((q, i) => `- **${ids[i]}**: ${q}`).join("\n")
    this.record(task, p.mode, { ...r, summary: `asked Lead ${ids.join(", ")}` })
    task.pending = {
      mode: "lead_answer",
      ids,
      asker: p.mode,
      afterReview: p.afterReview,
      note: join(`Questions from ${MODE_ROLE[p.mode] === "architect" ? "the Architect" : "Principal"}:`, text, r.content.trim() && `Context:\n${r.content}`),
    }
  }

  /** The how stage found an approved what-decision unworkable: back to the what-document, and the user decides. */
  private infeasible(task: TaskState, mode: Mode, r: Report) {
    const file = writeNumbered(task, "infeasible", `# ${MODE_ROLE[mode]}: a decision can't work\n\n${r.summary}\n\n${r.content}`)
    this.record(task, mode, r, file)
    task.sessions = { ...task.sessions, ...(task.whatSessions ?? {}), principal: undefined }
    task.whatSessions = undefined
    task.principalNote = undefined
    this.setStage(task, "what")
    task.infeasible = file
    this.toApproval(task)
  }

  private askUser(task: TaskState, mode: Mode, r: Report) {
    task.questionRounds++
    this.record(task, mode, r)
    appendFile(task, answersName(task), `## Questions from ${MODE_ROLE[mode]}\n\n${r.content}\n\n${(r.questions ?? []).map((q, i) => `${i + 1}. ${q}`).join("\n")}\n`)
    task.phase = "questions"
    task.questions = r.questions
    task.questionsFrom = mode
    task.askedAt = Date.now()
  }

  private done(task: TaskState, summary: string) {
    task.phase = "done"
    task.doneSummary = summary
  }
}
