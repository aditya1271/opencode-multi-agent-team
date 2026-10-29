import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { Plugin } from "@opencode/plugin"
type Context = Plugin.Context
import { FRONT_AGENTS } from "./agents.ts"
import { expandHome, modelLabel, modelsFor, ROLES, type Config, type Role, type WorkerRole } from "./config.ts"
import { buildPrompt, checksText, detailsView, dialogData, dialogOpen, docName, draftFile, draftTitle, howOutput, join, render, reviseAs, scopeText, sectionIndex, SKIP_CHECKS, styleView, walkable } from "./messages.ts"
import { idRanges, indexOf, shownTitle, splice, split, type Scope } from "./sections.ts"
import { EditedFilesTrack, type ReviewProgress, type SidebarStats } from "./rpc.ts"
import { runAgent, tokenCounts, type RunResult } from "./run.ts"
import { counter, runs, type Report, type ToolKind } from "./runtime.ts"
import {
  answersName,
  appendFile,
  autoDecides,
  type AutoLevel,
  briefName,
  consultKey,
  consultSide,
  consultsUsed,
  draftIsDoc,
  findTask,
  isDocWorkflow,
  LADDER,
  loadTask,
  MODE_ROLE,
  newTask,
  pairKey,
  readTaskFile,
  save,
  setOnWrite,
  TERMINAL,
  writeFile,
  writeNumbered,
  WORKFLOWS,
  type Mode,
  type Workflow,
  type Pending,
  type Phase,
  type TaskState,
  type DialogEnd,
  type Walk,
} from "./state.ts"

/** What the TUI review dialog sends back when the user leaves it. */
export interface DialogReply {
  key: string
  end: DialogEnd
  replies: Walk["replies"]
  comments: { id: string; text: string }[]
  questions: { id: string; text: string }[]
}
/** A NEED_INFO report's queries: content plus any questions list (models put queries in either). */
const queries = (r: Report) => join(r.content, (r.questions ?? []).map((q, i) => `${i + 1}. ${q}`).join("\n"))

import { add, appendUsage, lastUsage, report as usageReport, table, toolTotal, type AgentUsage, type UsageDelta } from "./usage.ts"

export const TEAM_ACTIONS = ["start", "ask", "continue", "answer", "approve", "change", "section", "review", "implement", "stop", "resume", "retry", "extend", "auto", "stats", "status", "details"] as const
export type TeamAction = (typeof TEAM_ACTIONS)[number]

export type TeamMode = "off" | AutoLevel

/** The /team-mode-* slash commands: pick a mode without remembering what to say. */
export const MODE_COMMANDS: { name: string; mode: TeamMode; description: string }[] = [
  { name: "team-mode-default", mode: "off", description: "Team mode: confirm every polished message and make every decision yourself" },
  { name: "team-mode-polished", mode: "polished", description: "Team mode: polished messages are sent without [Send] [Edit] [Cancel]; you still decide" },
  { name: "team-mode-safe", mode: "safe", description: "Team mode: the team also answers questions and approves; stops at destructive plans and before implementing" },
  { name: "team-mode-full", mode: "full", description: "Team mode: the team decides everything, approves destructive plans and implements; stops only when stuck" },
]

export const modeName = (mode: TeamMode) => (mode === "off" ? "default" : `${mode} auto`)

export interface TeamInput {
  action: TeamAction
  text?: string
  last?: number
  plan?: boolean
  /** Set by the plugin from the calling front agent, not by the model. */
  workflow?: Workflow
  output?: string
  review?: boolean
  /** start and auto: auto mode (off = interactive). */
  auto?: TeamMode
  /** change only: the revision scope, by section id (add: titles of new sections). */
  finetune?: string[]
  revise?: string[]
  final?: string[]
  reopen?: string[]
  add?: string[]
  /** section only: the user's reply to the section shown (start begins the walk-through). */
  verdict?: "start" | "ok" | "skip" | "finetune" | "revise" | "rest"
  /** details only: the sections to show in full (none: the whole draft). */
  ids?: string[]
}

export const TEAM_DESCRIPTION = [
  "Runs the multi-agent team. One call runs at most one agent and returns what to do next.",
  "Actions: start (text = the confirmed request; plan = true when a code request should get a plan, not a quick fix; output = where the plan or research document goes, if the user named a path; review = true when the user asked Principal to review the plan or document; auto = polished, safe or full when the user asked for an auto mode),",
  "ask (text = a question; while a task is open, the agent it waits on answers),",
  "continue, answer (text = the user's confirmed answer), approve, change (text = the user's confirmed comments; finetune, revise, final, reopen = section ids, add = titles of new sections), section (going through the waiting brief, document or plan one section at a time: verdict = start, ok, skip, finetune or revise with text = the confirmed comment, or rest to show the remaining sections at once), review (Principal critically reviews the waiting plan or document; text = what to look at),",
  "implement (after an approved plan document: switches to build-manager and starts a code task that carries it out), stop, resume,",
  "retry, extend, auto (auto = off, polished, safe or full: switch the mode of the open task), stats (last = N tasks), status,",
  "details (the stored full text of the waiting brief, document or plan; ids = sections, none = all; no agent runs).",
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
    auto: {
      type: "string",
      enum: ["off", "polished", "safe", "full"],
      description:
        "start and auto: off = the user confirms every polished reply and makes every decision; polished = polished replies are sent without confirmation; safe = also take the recommended choice at every question and approval, but stop at destructive plans and before implementing a finished plan; full = also those.",
    },
    finetune: { type: "array", items: { type: "string" }, description: "change only: ids of sections that get only an exact edit the user stated (the edit is in text)." },
    revise: { type: "array", items: { type: "string" }, description: "change only: ids of sections whose substance the user wants reworked (S5). Empty with no finetune or add: every section that isn't final." },
    final: { type: "array", items: { type: "string" }, description: "change only: ids of sections the user calls good or done; they stay as they are until reopened." },
    reopen: { type: "array", items: { type: "string" }, description: "change only: ids of final sections the user now wants changed." },
    add: { type: "array", items: { type: "string" }, description: "change only: short titles of new sections the user asks for." },
    verdict: {
      type: "string",
      enum: ["start", "ok", "skip", "finetune", "revise", "rest"],
      description: "section only: start the walk-through; ok, skip, finetune or revise (with text) the section shown; rest shows the remaining sections at once.",
    },
    ids: { type: "array", items: { type: "string" }, description: "details only: ids of the sections to show in full (S3); none: the whole draft." },
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
  architect_advice: "architect",
  principal_draft_advice: "principal",
}

export class Team {
  readonly root: string
  private tasks = new Map<string, TaskState>()
  /** The mode chosen with a /team-mode-* command, per chat session: used by the session's next tasks. */
  private sessionModes = new Map<string, TeamMode>()
  /** Task folders per manager session, built on first use. */
  private sessionDirs?: Map<string, string[]>
  /** Code questions per manager session (they have no task folder). */
  private questions = new Map<string, { count: number; usage: Partial<Record<Role, AgentUsage>> }>()
  /** Called when a session's numbers change (the sidebar refreshes). */
  onChange: (managerSession: string) => void = () => {}
  /** Tells the TUIs a review waits in this session; one showing it opens the dialog. Unset: chat only. */
  offerDialog?: (managerSession: string) => void

  constructor(
    private ctx: Context,
    private config: Config,
    private log: (msg: string) => void,
  ) {
    this.root = expandHome(config.taskDir)
    setOnWrite((task, file, before) => this.trackEdit(task.managerSession, [{ path: file, before }]))
  }

  // ---- review dialog (TUI) ----

  /**
   * When a result asks for the review style, the review goes to the TUI dialog instead: it opens on its own in a
   * TUI showing the session, and the user opens or reopens it from the sidebar or /team-review. The chat
   * walk-through runs only when the user asks for it.
   */
  async withDialog(managerSession: string, content: string): Promise<string> {
    const task = this.task(managerSession)
    if (!task || !this.offerDialog || !task.sections || (task.phase !== "brief" && task.phase !== "approval") || autoDecides(task)) return content
    if (task.walk?.key === task.sections.key) return content
    const style = styleView(task)
    if (!style || !content.includes(style)) return content
    task.walk = { key: task.sections.key, ids: walkable(task), at: 0, replies: [], dialog: { comments: [], questions: [] } }
    task.askedAt = Date.now()
    save(task)
    this.offerDialog(managerSession)
    return content.replace(style, dialogOpen(task))
  }

  /** The walk waiting in the dialog, if any. */
  private openDialog(task: TaskState | undefined) {
    const w = task?.walk
    return task && w?.dialog && !w.dialog.end && w.key === task.sections?.key ? w : undefined
  }

  /** The draft for the dialog, with the progress kept from an earlier open. */
  dialog(managerSession: string): ({ key: string } & ReturnType<typeof dialogData> & { progress: ReviewProgress }) | undefined {
    const task = this.task(managerSession)
    const w = this.openDialog(task)
    if (!task || !w?.dialog) return undefined
    const replies = w.replies.flatMap((r) => (r.verdict === "ok" || r.verdict === "skip" ? [{ id: r.id, verdict: r.verdict }] : []))
    const progress = { at: w.at, replies, comments: w.dialog.comments, questions: w.dialog.questions }
    const data = dialogData(task)
    return { key: w.key, ...data, ask: data.ask && !w.at && !replies.length && !progress.comments.length && !progress.questions.length, progress }
  }

  /** The user closed the dialog partway: keeps where they are; the manager isn't woken. */
  dialogSave(managerSession: string, input: { key: string; progress: ReviewProgress }): boolean {
    const task = this.task(managerSession)
    const w = this.openDialog(task)
    if (!task || !w?.dialog || w.key !== input.key) return false
    const known = new Set(w.ids)
    const keep = <T extends { id: string }>(list: T[]) => list.filter((r) => known.has(r.id))
    const p = input.progress
    w.replies = keep(p.replies)
    w.dialog.comments = keep(p.comments).filter((c) => c.text.trim())
    w.dialog.questions = keep(p.questions).filter((q) => q.text.trim())
    w.at = Math.max(0, Math.min(w.ids.length, Math.floor(p.at)))
    save(task)
    this.onChange(managerSession)
    return true
  }

  /** The user's replies from the dialog: stored on the walk, then the manager is woken once to act on them. */
  dialogDone(managerSession: string, input: DialogReply): string | undefined {
    const task = this.task(managerSession)
    const w = task?.walk
    if (!task || !w?.dialog || w.dialog.end || w.key !== input.key || w.key !== task.sections?.key) return undefined
    const known = new Set(w.ids)
    const keep = <T extends { id: string }>(list: T[]) => list.filter((r) => known.has(r.id))
    w.replies = keep(input.replies)
    w.dialog = { comments: keep(input.comments).filter((c) => c.text.trim()), questions: keep(input.questions).filter((q) => q.text.trim()), end: input.end }
    w.at = w.replies.length
    if (input.end === "rest") w.rest = true
    task.askedAt = Date.now()
    save(task)
    this.onChange(managerSession)
    return render(task)
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
        session.total.tokens += u.input + u.output
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
    const w = this.openDialog(task)
    // The RPC output check rejects `task: undefined`; leave the keys out instead.
    return {
      ...(current && { task: current }),
      ...(w && { review: { title: draftTitle(task!), done: w.at, total: w.ids.length } }),
      models,
      session,
    }
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
      case "details":
        return detailsView(task, input.ids)
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
        return this.approve(task, signal)
      case "auto": {
        const level = input.auto ?? "safe"
        task.auto = level === "off" ? undefined : level
        save(task)
        const line = task.auto ? `This task now runs on ${task.auto} auto.` : "Auto mode is off: you confirm every reply and make every decision again."
        return join(line, TERMINAL.includes(task.phase) ? render(task) : await this.step(task, signal))
      }
      case "change":
        return this.change(task, input, signal)
      case "section":
        return this.section(task, input, signal)
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
        if (task.budgetReason === "calls") task.agentCallLimit = (task.agentCallLimit ?? this.config.limits.taskAgentCalls) + 25
        else task.attemptLimit += 5
        task.budgetReason = undefined
        task.phase = "running"
        save(task)
        return this.step(task, signal)
    }
    return render(task)
  }

  /**
   * A /team-mode-* command: sets the mode for the chat session's new tasks and for its open task.
   * resume: the open task waits on the user at a stop the new mode decides, so the manager should continue it.
   */
  async setMode(sessionID: string, mode: TeamMode): Promise<{ text: string; resume: boolean }> {
    this.sessionModes.set(sessionID, mode)
    try {
      // Tells the manager, so it polishes (or sends) the next request in this mode and passes it to start.
      await this.ctx.session.instructions.entry.put({
        sessionID,
        key: "team-mode" as never,
        value: {
          mode: modeName(mode),
          rule: `The user chose ${modeName(mode)} with /team-${mode === "off" ? "mode-default" : `mode-${mode}`} for this chat. It overrides the project's default mode: call start with auto = "${mode}" unless the request names another mode. See **Modes**.`,
        },
      })
    } catch (e) {
      this.log(`team-mode: could not set the session instruction: ${(e as Error).message}`)
    }
    const task = this.task(sessionID)
    if (!task || TERMINAL.includes(task.phase)) return { text: `Team mode: **${modeName(mode)}** for new tasks in this chat.`, resume: false }
    task.auto = mode === "off" ? undefined : mode
    save(task)
    this.onChange(sessionID)
    this.log(`task ${task.id}: mode ${modeName(mode)} (command)`)
    return { text: `Team mode: **${modeName(mode)}** for the open task and new tasks in this chat.`, resume: autoDecides(task) }
  }

  private async approve(task: TaskState, signal: AbortSignal): Promise<string> {
    if (task.phase === "brief") {
      task.phase = "running"
      // The approved brief starts a new document: its own comment rounds, advisers and sessions.
      this.resetLadder(task)
      task.sessions.architect = undefined
      task.sessions.principal = undefined
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
  }

  /**
   * Auto mode at a stop where the team would wait on the user: takes the recommended choice and goes on.
   * Undefined when auto mode doesn't decide this stop (the user is asked as usual).
   */
  private async autoStep(task: TaskState, signal: AbortSignal): Promise<string | undefined> {
    if (!autoDecides(task)) return undefined
    const decided = (line: string) => {
      task.autoLog = [...(task.autoLog ?? []), line]
      appendFile(task, answersName(task), `## Decided on ${task.auto} auto\n\n${line}\n`)
      this.log(`task ${task.id}: auto: ${line}`)
      return line
    }
    const tell = async (line: string, next: Promise<string>) => `AUTO (${task.auto}): ${decided(line)}. Tell the user this in one line.\n\n${await next}`
    switch (task.phase) {
      case "checks":
        this.skipChecks(task)
        task.phase = "running"
        save(task)
        return tell("skipped build and test (no commands configured)", this.step(task, signal))
      case "questions": {
        const n = task.questions?.length ?? 0
        const from = task.questionsFrom ? MODE_ROLE[task.questionsFrom] : "an agent"
        const answer =
          "The user runs this task on auto mode and isn't asked: take your recommended option for each question (where you gave none, the option you'd recommend), and note each choice as an assumption."
        appendFile(task, answersName(task), `## Answer (auto)\n\n${answer}\n`)
        this.answered(task, answer)
        save(task)
        return tell(`took the recommended answer${n === 1 ? "" : "s"} to ${n} question${n === 1 ? "" : "s"} from ${from}`, this.step(task, signal))
      }
      case "brief":
        return tell(`approved the ${task.workflow === "research" ? "research" : "concept"} brief`, this.approve(task, signal))
      case "approval": {
        const what = draftIsDoc(task) ? docName(task) : `plan ${task.plan}${task.planRisk ? " (destructive or irreversible steps)" : ""}`
        if (task.auto === "full" && task.workflow === "plan" && task.stage === "how")
          return tell(`approved the ${what} and started implementing it`, this.implement(task, signal))
        return tell(`approved the ${what}`, this.approve(task, signal))
      }
    }
    return undefined
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
    if (active?.phase === "approval" || active?.phase === "brief") return this.change(active, { action: "change", text }, signal)
    if (active && active.phase !== "running" && !TERMINAL.includes(active.phase))
      return join("The task waits on the user's choice below; the message was not sent.", render(active))
    if (active && !TERMINAL.includes(active.phase))
      return [
        `A task is already active in this session: ${active.id} (${active.phase}). Only one task runs per session.`,
        `NEXT ACTION: ask the user [Stop task] [Wait]. Stop task → call team with action "stop", then "start" again. Wait → tell the user to send the new request again when this task ends.`,
      ].join("\n")
    if (!text.trim()) return 'start needs text: the confirmed request. NEXT ACTION: call team with action "start" and the request.'
    const task = newTask(this.root, managerSession, this.ctx.location.directory, text, this.config.limits.taskAttempts, this.config.limits.taskAgentCalls)
    if (opts.plan === true) task.forcePlan = true
    if (opts.review === true) task.reviewFirst = true
    const auto = opts.auto ?? this.sessionModes.get(managerSession) ?? this.config.auto
    if (auto === "polished" || auto === "safe" || auto === "full") task.auto = auto
    task.reviewStyle = this.config.reviewStyle
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
      this.trackEdit(task.managerSession, [{ path: file, before }])
      return undefined
    } catch (e) {
      this.log(`task ${task.id}: cannot write ${file}: ${(e as Error).message}`)
      return `Could not write ${file} (${(e as Error).message}); the document is in ${path.join(task.dir, copy)}.`
    }
  }

  /** Shows files the team wrote in the opencode-edited-files sidebar; does nothing when that plugin isn't installed. */
  private trackEdit(sessionID: string, files: { path: string; before: string | undefined }[]) {
    if (!files.length) return
    try {
      void this.ctx
        .rpc(EditedFilesTrack)
        .track({ sessionID, files: files.map(({ path, before }) => (before === undefined ? { path } : { path, before })) })
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
    // The review dialog's questions were asked together in this call.
    if (task.walk?.dialog?.end) task.walk.dialog.questions = []
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
    this.answered(task, answer)
    save(task)
    return this.step(task, signal)
  }

  /** Sends the answer to the agent that asked. */
  private answered(task: TaskState, answer: string) {
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
  }

  private async change(task: TaskState, input: TeamInput, signal: AbortSignal): Promise<string> {
    if (task.phase !== "approval" && task.phase !== "brief") return this.wrongPhase(task, "change")
    // Replies kept from a walk-through the user left with "show the rest" go with these comments.
    const walk = task.walk?.key === task.sections?.key ? task.walk?.replies ?? [] : []
    const of = (v: string) => walk.filter((r) => r.verdict === v).map((r) => r.id)
    if (walk.length)
      input = {
        ...input,
        finetune: [...(input.finetune ?? []), ...of("finetune")],
        revise: [...(input.revise ?? []), ...of("revise")],
        final: [...(input.final ?? []), ...of("ok")],
      }
    const scope = this.scopeOf(task, input)
    if (typeof scope === "string") return scope
    if (scope?.marksOnly) {
      task.walk = undefined
      // Only final/reopen marks: nothing to revise, show the draft again.
      task.sections!.final = scope.final
      save(task)
      return join(`Saved: final ${idRanges(scope.final) || "none"}.`, render(task))
    }
    const { polished, note } = await this.withOriginal(task, input.text ?? "", "comments")
    const earlier = this.walkComments(task)
    if (!polished && !earlier) return 'change needs text: the user\'s comments. NEXT ACTION: call team with action "change".'
    task.walk = undefined
    return this.applyChange(task, scope, join(earlier, polished ? note : ""), signal)
  }

  /** The comments confirmed in a walk-through, one block per section. */
  private walkComments(task: TaskState): string {
    const w = task.walk?.key === task.sections?.key ? task.walk : undefined
    const idx = task.sections
    return (w?.replies ?? [])
      .filter((r) => r.note)
      .map((r) => `**${r.id} ${idx ? shownTitle(idx.titles[idx.ids.indexOf(r.id)] ?? "") : ""}** (${r.verdict === "finetune" ? "fine-tune" : "revise"}):\n${r.note}`)
      .join("\n\n")
  }

  /** Going through the waiting draft one section at a time; the replies go to the team together at the end. */
  private async section(task: TaskState, input: TeamInput, signal: AbortSignal): Promise<string> {
    if (task.phase !== "approval" && task.phase !== "brief") return this.wrongPhase(task, "section")
    const verdict = input.verdict ?? "start"
    let w = task.walk?.key === task.sections?.key ? task.walk : undefined
    if (verdict === "rest" && task.sections) {
      // "All at once", chosen up front or partway: replies already given are kept for the next change.
      task.walk = w = w ?? { key: task.sections.key, ids: walkable(task), at: 0, replies: [] }
      w.rest = true
      w.done = false
      save(task)
      return render(task)
    }
    if (verdict === "start" || !w) {
      const ids = walkable(task)
      if (!ids.length) return join("This draft has no sections to go through one at a time.", render(task))
      task.walk = { key: task.sections!.key, ids, at: 0, replies: [] }
      task.askedAt = Date.now()
      save(task)
      return render(task)
    }
    if (w.done || w.rest || w.at >= w.ids.length) return render(task)
    const id = w.ids[w.at]!
    if (verdict === "finetune" || verdict === "revise") {
      const { polished, note } = await this.withOriginal(task, input.text ?? "", "comments")
      if (!polished) return `section with verdict ${verdict} needs text: the user's confirmed comment on ${id}. NEXT ACTION: call team "section" again with it.`
      w.replies.push({ id, verdict, note })
    } else w.replies.push({ id, verdict: verdict === "ok" ? "ok" : "skip" })
    task.askedAt = Date.now()
    w.at++
    if (w.at < w.ids.length) {
      save(task)
      return render(task)
    }
    const ok = w.replies.filter((r) => r.verdict === "ok").map((r) => r.id)
    task.sections!.final = [...new Set([...task.sections!.final, ...ok])]
    const comments = w.replies.filter((r) => r.note)
    if (!comments.length) {
      w.done = true
      save(task)
      return render(task)
    }
    const scope = this.scopeOf(task, {
      action: "change",
      finetune: comments.filter((r) => r.verdict === "finetune").map((r) => r.id),
      revise: comments.filter((r) => r.verdict === "revise").map((r) => r.id),
    })
    if (typeof scope === "string") return scope
    const text = this.walkComments(task)
    task.walk = undefined
    return join(`All ${w.ids.length} sections gone through: comments on ${idRanges(comments.map((r) => r.id))} sent to the team.`, await this.applyChange(task, scope, text, signal))
  }

  /** Sends the user's comments on the waiting brief, document or plan to the team, within the scope. */
  private async applyChange(task: TaskState, scope: ReturnType<Team["scopeOf"]> & object | undefined, comments: string, signal: AbortSignal): Promise<string> {
    // Exact edits alone aren't the team failing: no comment round (ladder), no advice, no revision brief.
    const tuneOnly = !!scope && scope.finetune.length > 0 && !scope.revise.length && !scope.add.length
    if (!tuneOnly) task.commentRounds = (task.commentRounds ?? 0) + 1
    task.lastAdvice = undefined
    if (scope) {
      task.sections!.final = scope.final
      task.scope = { draft: scope.draft, revise: scope.revise, finetune: scope.finetune, add: scope.add, open: scope.open }
    } else task.scope = undefined
    const scopeLine = scope
      ? `\n\nScope: ${[
          scope.finetune.length && `fine-tune ${idRanges(scope.finetune)}`,
          `revise ${idRanges(scope.revise) || "none"}`,
          scope.add.length && `new: ${scope.add.join("; ")}`,
          scope.final.length && `final: ${idRanges(scope.final)}`,
        ]
          .filter(Boolean)
          .join("; ")}`
      : ""
    const adjust = (what: string, status: string) =>
      tuneOnly ? `The user fine-tuned the ${what}: make exactly the edits their comments state and ${reviseAs(task, status, what)}.` : `Revise it and ${reviseAs(task, status, what)}.`
    if (task.phase === "brief") {
      const which = task.workflow === "research" ? "research" : "concept"
      appendFile(task, answersName(task), `## Comments on the ${which} brief (${tuneOnly ? "fine-tune" : `round ${task.commentRounds}`})\n\n${comments}${scopeLine}\n`)
      const revise: Pending = {
        mode: "lead",
        note: join(tuneOnly ? adjust(`${which} brief`, "ESCALATE") : `The user adjusted the ${which} brief. ${adjust("brief", "ESCALATE")}`, scopeText(task, true), `The user's comments:\n${comments}`),
      }
      task.pending = tuneOnly ? revise : this.withAdvice(task, "lead", revise, comments)
    } else if (tuneOnly && !task.infeasible) {
      // Exact edits go straight to the Architect.
      appendFile(task, answersName(task), `## Fine-tuning the ${docName(task)} (${draftFile(task)})\n\n${comments}${scopeLine}\n`)
      if (!draftIsDoc(task)) task.skipPrincipalReview = true
      const doc = draftIsDoc(task)
      task.pending = {
        mode: "architect",
        note: join(adjust(`${docName(task)} (${draftFile(task)})`, doc ? "DOC" : "PLAN"), scopeText(task, true), `The user's comments:\n${comments}`),
      }
    } else {
      // Comments go through Lead, who briefs the Architect (it has no file access).
      appendFile(task, answersName(task), `## Comments on the ${docName(task)} (${draftFile(task)})\n\n${comments}${scopeLine}\n`)
      if (!draftIsDoc(task)) task.skipPrincipalReview = true
      task.revising = true
      task.pending = { mode: "lead", note: comments, revision: true, files: task.infeasible ? [task.infeasible] : undefined }
      task.infeasible = undefined
    }
    task.phase = "running"
    save(task)
    return this.step(task, signal)
  }

  /**
   * The sections the user's comments may change, from the manager's finetune/revise/final/reopen/add.
   * Undefined when the draft has no sections; a message for the manager when an id is wrong.
   */
  private scopeOf(task: TaskState, input: TeamInput): (Scope & { final: string[]; marksOnly: boolean }) | string | undefined {
    const draft = task.phase === "brief" ? "brief" : "draft"
    const idx = sectionIndex(task, draft)
    if (!idx?.ids.length) return undefined
    const ids = (xs?: string[]) => [...new Set((xs ?? []).map((x) => x.trim().toUpperCase()).filter(Boolean))]
    const revise = ids(input.revise)
    const finetune = ids(input.finetune).filter((id) => !revise.includes(id))
    const mark = ids(input.final)
    const reopen = ids(input.reopen)
    const list = idx.ids.map((id, i) => `${id} ${idx.titles[i]}`).join("; ")
    const unknown = [...finetune, ...revise, ...mark, ...reopen].filter((id) => !idx.ids.includes(id))
    if (unknown.length) return `Not section ids of this draft: ${unknown.join(", ")}. The sections: ${list}. NEXT ACTION: fix the ids and call team "change" again with the same text.`
    const final = new Set(idx.final)
    for (const id of reopen) final.delete(id)
    for (const id of mark) final.add(id)
    const both = [...finetune, ...revise].filter((id) => final.has(id))
    if (both.length) {
      const [are, them] = both.length > 1 ? ["are", "them"] : ["is", "it"]
      return `${both.join(", ")} ${are} final. If the user wants ${them} changed, add ${them} to reopen; otherwise drop ${them} from finetune and revise. NEXT ACTION: call team "change" again with the same text.`
    }
    const add = (input.add ?? []).map((x) => x.trim()).filter(Boolean)
    const open = !revise.length && !finetune.length && !add.length
    const scoped = open ? idx.ids.filter((id) => !final.has(id)) : revise
    return { draft, revise: scoped, finetune, add, open, final: idx.ids.filter((id) => final.has(id)), marksOnly: open && !!(mark.length || reopen.length) }
  }

  /** The text of a new brief, document or plan: a scoped revision put into the previous version, or the whole report. */
  private draftText(task: TaskState, kind: "brief" | "doc" | "plan", r: Report): string {
    const key = `${kind}:${task.stageRun ?? 0}`
    const scope = task.scope
    task.scope = undefined
    task.sectionChange = undefined
    const prevFile = kind === "brief" ? briefName(task) : kind === "doc" ? task.doc && `doc-${task.doc}.md` : task.plan && `plan-${task.plan}.md`
    task.walk = undefined
    if (scope && r.sections?.length && prevFile && task.sections?.key === key) {
      const out = splice(readTaskFile(task, prevFile), task.sections, r.sections, scope.finetune ?? [])
      task.sections = out.index
      task.sectionChange = out.change
      return out.text
    }
    task.sections = indexOf(r.content, key, task.sections?.key === key ? task.sections : undefined)
    return r.content
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
      return join(note, await this.start(task.managerSession, text, signal, { plan: true, workflow: "code", auto: task.auto ?? "off" }))
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
    return join(note, await this.start(task.managerSession, text, signal, { workflow: "code", auto: task.auto ?? "off" }, seed))
  }

  private wrongPhase(task: TaskState, action: string) {
    return `"${action}" doesn't apply now; the task is in phase ${task.phase}.\n\n${render(task)}`
  }

  // ---- running one agent ----

  private async step(task: TaskState, signal: AbortSignal): Promise<string> {
    const auto = await this.autoStep(task, signal)
    if (auto !== undefined) return auto
    if (task.phase !== "running" || !task.pending) return render(task)
    const calls = task.agentCalls ?? 0
    const over = task.attempts >= task.attemptLimit ? "attempts" : calls >= (task.agentCallLimit ?? this.config.limits.taskAgentCalls) ? "calls" : undefined
    if (over) {
      task.phase = "budget"
      task.budgetReason = over
      await this.refreshManager(task)
      save(task)
      return render(task)
    }
    const pending = task.pending
    const role = MODE_ROLE[pending.mode]
    const keep = SESSION_MODES[pending.mode]
    const pair = pending.mode === "architect_consult" ? this.pairSession(task, pending) : undefined
    const sessionID = pair ? pair.session : keep && !pending.fresh ? task.sessions[keep] : undefined
    if (pending.mode === "fix" && !sessionID) task.developerSeenPlan = false
    const prompt = buildPrompt(this.config, task, pending, !sessionID)
    task.agentCalls = calls + 1
    save(task)
    this.onChange(task.managerSession)
    this.log(`task ${task.id}: call ${task.agentCalls} → ${role} (${pending.mode}), failed attempts ${task.attempts}/${task.attemptLimit}`)
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
    if (pair && res.sessionID) pair.session = res.sessionID
    for (const file of res.run?.edited ?? []) {
      const rel = path.relative(task.workspace, file) || file
      if (!task.editedFiles.includes(rel)) task.editedFiles.push(rel)
    }
    // Agents edit in their own sessions; show their changes in the user's session too.
    this.trackEdit(task.managerSession, [...(res.run?.edited ?? [])].map((file) => ({ path: file, before: res.run?.before.get(file) })))
    if (res.end === "aborted") {
      task.phase = "stopped"
      await this.finish(task, "stopped")
    } else if (res.end !== "report" || !res.report) {
      task.attempts++
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
      n: task.agentCalls ?? 0,
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
    if (p.adviceIds?.length && r.addressed && task.lastAdvice) appendFile(task, task.lastAdvice.file, `\n## How ${MODE_ROLE[p.mode]} handled it\n\n${r.addressed}\n`)
    switch (p.mode) {
      case "architect_advice":
      case "principal_draft_advice": {
        if (r.status === "ASK") return this.askLead(task, p, r)
        const start = task.adviceSeq ?? 0
        const ids = (r.items ?? []).map((_, i) => `ADV${start + i + 1}`)
        task.adviceSeq = start + ids.length
        const role = MODE_ROLE[p.mode] === "architect" ? "Architect" : "Principal"
        const file = writeNumbered(task, "advice", join(`# ${role}'s advice`, r.content, (r.items ?? []).map((x, i) => `- **${ids[i]}**: ${x}`).join("\n")))
        this.record(task, p.mode, r, file)
        task.advisors = [...(task.advisors ?? []), p.mode]
        task.adviceFiles = [...(task.adviceFiles ?? []), file]
        task.lastAdvice = { role, file }
        const then = p.then ?? { mode: p.advise === "architect" ? "architect" : "lead" }
        const follow = `${role} reviewed the draft and the user's comments and gave advice (${file}, items ${ids.join(", ")}). Address every item: follow it, or say why not. Treat the user's material as a starting point, not the boundary. In \`addressed\`, say for each id what you changed.`
        if (then.mode === "architect") task.architectUnseen.push(file)
        task.pending = { ...then, adviceIds: ids, note: join(then.note, follow), files: then.mode === "architect" ? then.files : [...(then.files ?? []), file] }
        return
      }
      case "architect_consult": {
        const asker = p.asker === "fix" ? "Developer" : "Lead"
        const file = writeNumbered(task, "consult-answer", `# The Architect's answer to ${asker} (${(p.files ?? []).join(", ")})\n\n${r.content}`)
        this.record(task, p.mode, r, file)
        const back = p.then ?? { mode: p.asker ?? "fix" }
        task.pending = {
          ...back,
          note: join(`The Architect answered your question (${file}):`, `<answer>\n${r.content}\n</answer>`, "Carry on with your work; report as usual when done."),
        }
        return
      }
      case "lead":
      case "lead_fail": {
        if (r.status === "CONSULT") return this.consult(task, p, r)
        if (r.status === "NEED_INFO") {
          task.leadSearches = (task.leadSearches ?? 0) + 1
          this.record(task, p.mode, r)
          task.pending = { mode: "intern", note: queries(r), asker: "lead" }
          return
        }
        task.leadSearches = 0
        if (r.status === "QUESTIONS") return this.askUser(task, p.mode, r)
        if (r.status === "INFEASIBLE") return this.infeasible(task, p.mode, r)
        if (task.revising) {
          task.revising = false
          const file = writeNumbered(task, "revision", r.content)
          this.record(task, p.mode, r, file)
          task.architectUnseen.push(file)
          const doc = draftIsDoc(task)
          const revise: Pending = {
            mode: "architect",
            note: join(
              `The user asked for changes to the ${docName(task)} (${draftFile(task)}); Lead's revision brief is ${file}. Revise it accordingly and ${reviseAs(task, doc ? "DOC" : "PLAN", doc ? "document" : "plan")}${task.workflow === "research" ? "; new questions get a `## Follow-up <date>: <topic>` section (use NEED_INFO first if they need new evidence)" : ""}.`,
              scopeText(task, true),
            ),
          }
          task.pending = this.withAdvice(task, "architect", revise, `Lead's revision brief for the user's latest comments is ${file}.`, [file])
          return
        }
        if (r.status === "STUCK") return this.writerStuck(task, "lead", p, r)
        if (r.status === "TRIVIAL") {
          writeFile(task, "brief.md", r.content)
          this.record(task, p.mode, r, "brief.md")
          task.pending = { mode: "fix_trivial", fresh: true }
          return
        }
        // Code: a failed trivial attempt, or behaviour the request already fixes, goes straight to the how stage.
        if (!task.workflow && !task.stage && (p.mode === "lead_fail" || r.what === "settled")) this.setStage(task, "how")
        else if (task.workflow !== "research" && !task.stage) this.setStage(task, "what")
        writeFile(task, briefName(task), this.draftText(task, "brief", r))
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
        if (r.status === "NEED_INFO") {
          task.leadSearches = (task.leadSearches ?? 0) + 1
          this.record(task, p.mode, r)
          task.pending = { mode: "intern", note: queries(r), asker: "lead", then: p }
          return
        }
        task.leadSearches = 0
        const kind = `${briefName(task).slice(0, -3)}-answer`
        const file = writeNumbered(task, kind, `# Lead's answers (${(p.ids ?? []).join(", ")})\n\n${r.content}`)
        this.record(task, p.mode, r, file)
        const asker = p.asker ?? "architect"
        const note = `Lead answered your questions ${(p.ids ?? []).join(", ")} in ${file}.`
        if (asker === "architect") {
          task.architectUnseen.push(file)
          task.pending = { mode: "architect", note, afterReview: p.afterReview, adviceIds: p.adviceIds }
        } else task.pending = { mode: asker, note, files: [file], afterReview: p.afterReview, advise: p.advise, then: p.then }
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
        task.attempts++
        task.trivialFailed = true
        task.pending = { mode: "lead_fail" }
        return
      }
      case "review_trivial": {
        const file = this.reportFile(task, "analysis", p.mode, r)
        this.record(task, p.mode, r, file)
        if (r.status === "PASS") return this.done(task, r.summary)
        task.attempts++
        task.trivialFailed = true
        task.pending = { mode: "lead_fail" }
        return
      }
      case "architect": {
        if (r.status === "QUESTIONS") return this.askUser(task, p.mode, r)
        if (r.status === "ASK") return this.askLead(task, p, r)
        if (r.status === "INFEASIBLE") return this.infeasible(task, p.mode, r)
        if (r.status === "STUCK") return this.writerStuck(task, "architect", p, r)
        if (r.status === "NEED_INFO") {
          task.needInfo++
          this.record(task, p.mode, r)
          task.pending = { mode: "intern", note: queries(r), afterReview: p.afterReview }
          return
        }
        if (r.status === "ESCALATE") {
          const file = writeNumbered(task, "escalation", r.content)
          this.record(task, p.mode, r, file)
          return this.toAdvice(task, `architect escalated (${file})`, { mode: "architect", note: `Retry: write the ${docName(task)}, or escalate again.` })
        }
        task.principalNote = p.afterReview
        if (r.status === "DOC") {
          const text = this.draftText(task, "doc", r)
          const file = writeNumbered(task, "doc", text)
          this.record(task, p.mode, r, file)
          task.doc = task.seq.doc
          const failed = task.output ? this.writeOutput(task, task.output, text, file) : undefined
          task.docSummary = failed ? `${r.summary}\n\n${failed}` : r.summary
          return this.afterDraft(task)
        }
        const scoped = !!(task.scope && r.sections?.length)
        const text = this.draftText(task, "plan", r)
        const file = writeNumbered(task, "plan", text)
        this.record(task, p.mode, r, file)
        const failed = task.workflow === "plan" && task.output ? this.writeOutput(task, howOutput(task.output), text, file) : undefined
        task.plan = task.seq.plan
        task.planSteps = (scoped && split(text).sections.filter((s) => s.step).length) || r.steps || 1
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
        // Principal's review doesn't override the user's final sections: every other section is open.
        const idx = sectionIndex(task, "draft")
        task.scope = idx?.ids.length ? { draft: "draft", revise: idx.ids.filter((id) => !idx.final.includes(id)), finetune: [], add: [], open: true } : undefined
        const ask = reviseAs(task, doc ? "DOC" : "PLAN", doc ? "document" : "plan")
        task.pending = {
          mode: "architect",
          afterReview: file,
          note: join(
            `Principal critically reviewed the ${docName(task)} (${draftFile(task)}) at the user's request (${file}). Revise it: fix every must-fix item, or say in the ${doc ? "document" : "plan"} why not. ${ask[0]!.toUpperCase()}${ask.slice(1)}.`,
            scopeText(task, true),
          ),
        }
        return
      }
      case "intern": {
        const file = writeNumbered(task, "findings", `# Findings (${r.status})\n\n${r.content}`)
        this.record(task, p.mode, r, file)
        if (p.asker === "lead") {
          const left = this.config.limits.leadSearchRounds - (task.leadSearches ?? 0)
          const more = left > 0 ? `You may send ${left} more round${left === 1 ? "" : "s"} of queries (NEED_INFO).` : "No more search rounds: report with what you have."
          const note = `The Intern answered your queries (${r.status}), below. Spot-check what you rely on by reading the cited lines, then report. ${more}`
          task.pending = p.then?.mode === "lead_answer" ? { ...p.then, note: join(note, p.then.note), files: [file] } : { mode: "lead", note, files: [file] }
          return
        }
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
        task.attempts++
        task.skipPrincipalReview = true
        task.pending = { mode: "architect", afterReview: file, note: `Principal requested changes to plan ${task.plan} (${file}). Revise the plan once.` }
        return
      }
      case "fix": {
        if (r.status === "CONSULT") return this.consult(task, p, r)
        const file = this.reportFile(task, "report", p.mode, r)
        this.record(task, p.mode, r, file)
        task.architectUnseen.push(file)
        if (r.status !== "DONE") task.attempts++
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
        task.attempts++
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
    this.resetLadder(task)
  }

  private resetLadder(task: TaskState) {
    task.commentRounds = 0
    task.advisors = []
    task.adviceFiles = []
    task.lastAdvice = undefined
  }

  /**
   * The user keeps sending a draft back: at the configured comment rounds the next adviser up
   * (Architect, then Principal) advises the writer before it revises. Otherwise the writer revises alone.
   */
  private withAdvice(task: TaskState, writer: "lead" | "architect", revise: Pending, note: string, files?: string[]): Pending {
    const rounds = task.commentRounds ?? 0
    const used = task.advisors ?? []
    const due = LADDER[writer].find((mode, i) => !used.includes(mode) && rounds >= (this.config.limits.escalateAfterComments[i] ?? Infinity))
    if (!due) return revise
    this.log(`task ${task.id}: comment round ${rounds} on ${writer}'s draft → ${MODE_ROLE[due]} advises`)
    return { mode: due, fresh: true, advise: writer, then: revise, files, note }
  }

  /** The writer can't resolve the user's comments: the next unused adviser steps in now, else the user decides. */
  private writerStuck(task: TaskState, writer: "lead" | "architect", p: Pending, r: Report) {
    const file = writeNumbered(task, "stuck", `# ${MODE_ROLE[p.mode]} is stuck\n\n${r.summary}\n\n${r.content}`)
    this.record(task, p.mode, r, file)
    const retry: Pending = { ...p, fresh: false, adviceIds: undefined }
    const next = LADDER[writer].find((mode) => !(task.advisors ?? []).includes(mode))
    if (!next) return this.stuck(task, `${MODE_ROLE[p.mode]} can't resolve the user's comments (${file})`, retry)
    task.pending = { mode: next, fresh: true, advise: writer, then: retry, files: [file], note: `${MODE_ROLE[p.mode]} reports it is stuck on the user's comments (${file}).` }
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
      advise: p.advise,
      then: p.then,
      adviceIds: p.adviceIds,
      note: join(`Questions from ${MODE_ROLE[p.mode] === "architect" ? "the Architect" : "Principal"}:`, text, r.content.trim() && `Context:\n${r.content}`),
    }
  }

  /** Developer or Lead asks the Architect mid-work: not a failed attempt; the answer comes back to the same session. */
  private consult(task: TaskState, p: Pending, r: Report) {
    const side = consultSide(p.mode)!
    const key = consultKey(task, side)
    task.consults = { ...task.consults, [side]: { key, n: consultsUsed(task, side) + 1 } }
    const asker = side === "developer" ? `Developer (plan ${task.plan}, step ${task.step})` : "Lead"
    const questions = (r.questions ?? []).map((q, i) => `- **Q${i + 1}**: ${q}`).join("\n")
    const file = writeNumbered(task, "consult", join(`# ${asker} asks the Architect`, questions, `## Evidence\n\n${r.content}`))
    this.record(task, p.mode, r, file)
    const back: Pending = side === "developer" ? { mode: "fix" } : { mode: p.mode, adviceIds: p.adviceIds }
    task.pending = { mode: "architect_consult", asker: p.mode, files: [file], then: back }
  }

  /** The pair session for a question: kept while its key holds and it has room, else a fresh one. */
  private pairSession(task: TaskState, p: Pending) {
    const side = consultSide(p.asker ?? "fix")!
    const key = pairKey(task, side)
    let pair = task.pairs?.[side]
    if (!pair || pair.key !== key || pair.asked >= this.config.limits.consultsPerSession) pair = { key, asked: 0 }
    pair.asked++
    task.pairs = { ...task.pairs, [side]: pair }
    return pair
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
