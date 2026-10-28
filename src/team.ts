import path from "node:path"
import type { Plugin } from "@opencode/plugin"
type Context = Plugin.Context
import { expandHome, modelLabel, modelsFor, type Config, type WorkerRole } from "./config.ts"
import { buildPrompt, checksText, join, render, SKIP_CHECKS } from "./messages.ts"
import { runAgent, type RunResult } from "./run.ts"
import { counter, type Report, type ToolKind } from "./runtime.ts"
import {
  appendFile,
  findTask,
  MODE_ROLE,
  newTask,
  save,
  TERMINAL,
  writeFile,
  writeNumbered,
  type Mode,
  type Pending,
  type Phase,
  type TaskState,
} from "./state.ts"
import { add, appendUsage, lastUsage, report as usageReport, table, type AgentUsage } from "./usage.ts"

export const TEAM_ACTIONS = ["start", "ask", "continue", "answer", "approve", "change", "stop", "resume", "retry", "extend", "stats", "status"] as const
export type TeamAction = (typeof TEAM_ACTIONS)[number]

export interface TeamInput {
  action: TeamAction
  text?: string
  last?: number
}

export const TEAM_DESCRIPTION = [
  "Runs the multi-agent team. One call runs at most one agent and returns what to do next.",
  "Actions: start (text = the confirmed request), ask (text = a code question), continue, answer (text = the user's answer),",
  "approve, change (text = the user's comments), stop, resume, retry, extend, stats (last = N tasks), status.",
  "Always follow the NEXT ACTION line of the result.",
].join(" ")

export const TEAM_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: [...TEAM_ACTIONS] },
    text: { type: "string", description: "Request, question, answer or comments, word for word." },
    last: { type: "integer", minimum: 1, description: "stats only: totals over the last N tasks." },
  },
  required: ["action"],
  additionalProperties: false,
}

const SESSION_MODES: Partial<Record<Mode, WorkerRole>> = { triage: "triage", triage_fail: "triage", senior: "senior", fix: "fixer" }

export class Team {
  readonly root: string
  private tasks = new Map<string, TaskState>()

  constructor(
    private ctx: Context,
    private config: Config,
    private log: (msg: string) => void,
  ) {
    this.root = expandHome(config.taskDir)
  }

  async handle(input: TeamInput, polisherSession: string, signal: AbortSignal): Promise<string> {
    const task = this.task(polisherSession)
    if (task) task.usage.polisher = { ...(task.usage.polisher ?? this.emptyPolisher()), calls: (task.usage.polisher?.calls ?? 0) + 1 }
    switch (input.action) {
      case "start":
        return this.start(polisherSession, input.text ?? "", signal)
      case "ask":
        return this.ask(polisherSession, input.text ?? "", signal)
      case "stats":
        return this.stats(polisherSession, input.last)
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
        if (task.phase !== "approval") return this.wrongPhase(task, "approve")
        task.phase = "running"
        task.step = 1
        task.rounds = 0
        task.fixerSeenPlan = false
        task.pending = { mode: "fix", fresh: true }
        save(task)
        return this.step(task, signal)
      case "change":
        return this.change(task, input.text ?? "", signal)
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

  // ---- task lookup and polisher usage ----

  private task(polisherSession: string): TaskState | undefined {
    let task = this.tasks.get(polisherSession)
    if (!task) {
      task = findTask(this.root, polisherSession)
      if (task) this.tasks.set(polisherSession, task)
    }
    return task
  }

  private emptyPolisher(): AgentUsage {
    return { calls: 0, prompts: 0, tools: {}, input: 0, cacheRead: 0, output: 0, models: [], ms: 0 }
  }

  private async refreshPolisher(task: TaskState) {
    const info = await this.ctx.session.get({ sessionID: task.polisherSession }).catch(() => undefined)
    const base = task.polisherBaseline
    if (!info || !base) return
    const c = counter(task.polisherSession)
    const t = info.tokens
    const tools: Partial<Record<ToolKind, number>> = {}
    for (const [k, v] of Object.entries(c.tools)) tools[k as ToolKind] = Math.max(0, (v ?? 0) - (base.tools[k] ?? 0))
    const prev = task.usage.polisher ?? this.emptyPolisher()
    task.usage.polisher = {
      calls: prev.calls,
      prompts: Math.max(0, c.prompts - base.prompts),
      tools,
      input: Math.max(0, t.input + t.cache.write - base.input),
      cacheRead: Math.max(0, t.cache.read - base.cacheRead),
      output: Math.max(0, t.output + t.reasoning - base.output - base.reasoning),
      models: info.model ? [modelLabel(info.model)] : modelsFor(this.config, "polisher").slice(0, 1).map(modelLabel),
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

  /** The user's own words: their latest message if it came after the plugin asked, else the polisher's text. */
  private async userWords(task: TaskState, text: string): Promise<string> {
    const last = await this.lastUserMessage(task.polisherSession)
    return (last && last.time > (task.askedAt ?? 0) && last.text.trim() ? last.text : text).trim()
  }

  // ---- actions ----

  private async start(polisherSession: string, text: string, signal: AbortSignal): Promise<string> {
    const active = this.task(polisherSession)
    if (active && !TERMINAL.includes(active.phase))
      return [
        `A task is already active in this session: ${active.id} (${active.phase}). Only one task runs per session.`,
        `NEXT ACTION: ask the user [Stop task] [Wait]. Stop task → call team with action "stop", then "start" again. Wait → tell the user to send the new request again when this task ends.`,
      ].join("\n")
    if (!text.trim()) return 'start needs text: the confirmed request. NEXT ACTION: call team with action "start" and the request.'
    const task = newTask(this.root, polisherSession, this.ctx.location.directory, text, this.config.limits.taskAttempts)
    writeFile(task, "request.md", text)
    const original = await this.lastUserMessage(polisherSession)
    writeFile(task, "request-original.md", original?.text ?? text)
    const info = await this.ctx.session.get({ sessionID: polisherSession }).catch(() => undefined)
    const c = counter(polisherSession)
    task.polisherBaseline = {
      input: (info?.tokens.input ?? 0) + (info?.tokens.cache.write ?? 0),
      output: info?.tokens.output ?? 0,
      reasoning: info?.tokens.reasoning ?? 0,
      cacheRead: info?.tokens.cache.read ?? 0,
      prompts: Math.max(0, c.prompts - 1),
      tools: { ...c.tools } as Record<string, number>,
    }
    task.usage.polisher = { ...this.emptyPolisher(), calls: 1 }
    task.pending = { mode: "triage" }
    this.tasks.set(polisherSession, task)
    const { build, test, whenMissing } = this.config.checks
    if (build.trim() || test.trim()) {
      const lines = [build.trim() && `- Build: \`${build.trim()}\``, test.trim() && `- Test: \`${test.trim()}\``].filter(Boolean)
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

  private async ask(polisherSession: string, question: string, signal: AbortSignal): Promise<string> {
    if (!question.trim()) return 'ask needs text: the question. NEXT ACTION: call team with action "ask" and the question.'
    const res = await runAgent(
      this.ctx,
      this.config,
      {
        role: "explorer",
        mode: "explorer",
        parentID: polisherSession,
        title: "team: explorer (question)",
        prompt: join("MODE: user question. Answer the user's question about the code. Report FOUND with the answer in content (path:line references, short excerpts), or NOT_FOUND with what you searched.", `<question>\n${question}\n</question>`),
        signal,
      },
      this.log,
    )
    const usage: Partial<Record<string, AgentUsage>> = {}
    add(usage as never, "explorer", res.usage)
    appendUsage(this.root, { task: "ask", time: Date.now(), outcome: res.report?.status ?? res.end, usage: usage as never })
    if (!res.report) return `The explorer couldn't answer: ${res.failure}.\nNEXT ACTION: tell the user.`
    return join(
      `ANSWER (${res.report.status}):`,
      res.report.content,
      "```\n" + table(usage as never) + "\n```",
      "NEXT ACTION: show the answer to the user. No task was started.",
    )
  }

  private async stats(polisherSession: string, last?: number): Promise<string> {
    if (last) {
      const { lines, total } = lastUsage(this.root, last)
      if (!lines.length) return "No finished tasks recorded yet."
      return join(`Usage over the last ${lines.length} task(s), with each agent's share of calls, prompts and tokens:`, "```\n" + table(total, true) + "\n```", "NEXT ACTION: show this to the user.")
    }
    const task = this.task(polisherSession)
    if (!task) return 'No task in this session. Use last: N for earlier tasks. NEXT ACTION: tell the user.'
    await this.refreshPolisher(task)
    save(task)
    return join(`Usage for task ${task.id} (${task.phase}), attempts ${task.attempts}/${task.attemptLimit}:`, usageReport(task.usage, Math.max(1, task.planSteps)), "NEXT ACTION: show this to the user.")
  }

  private async answer(task: TaskState, text: string, signal: AbortSignal): Promise<string> {
    if (task.phase === "checks") return this.checks(task, text, signal)
    if (task.phase !== "questions" || !task.questionsFrom) return this.wrongPhase(task, "answer")
    const answer = await this.userWords(task, text)
    appendFile(task, "answers.md", `## Answer\n\n${answer}\n`)
    const note = `The user answered your questions:\n<answer>\n${answer}\n</answer>`
    const from = task.questionsFrom
    task.pending =
      from === "triage" ? { mode: "triage", note } : from === "senior" ? { mode: "senior", note } : { mode: "senior", note: `Oracle asked the user questions. ${note}` }
    task.phase = "running"
    task.questions = undefined
    save(task)
    return this.step(task, signal)
  }

  private async change(task: TaskState, text: string, signal: AbortSignal): Promise<string> {
    if (task.phase !== "approval") return this.wrongPhase(task, "change")
    const comments = await this.userWords(task, text)
    appendFile(task, "answers.md", `## Comments on plan ${task.plan}\n\n${comments}\n`)
    task.skipOracleReview = true
    task.pending = { mode: "senior", note: `The user asked for changes to plan ${task.plan}. Revise it:\n<comments>\n${comments}\n</comments>` }
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

  private wrongPhase(task: TaskState, action: string) {
    return `"${action}" doesn't apply now; the task is in phase ${task.phase}.\n\n${render(task)}`
  }

  // ---- running one agent ----

  private async step(task: TaskState, signal: AbortSignal): Promise<string> {
    if (task.phase !== "running" || !task.pending) return render(task)
    if (task.attempts >= task.attemptLimit) {
      task.phase = "budget"
      await this.refreshPolisher(task)
      save(task)
      return render(task)
    }
    const pending = task.pending
    const role = MODE_ROLE[pending.mode]
    const keep = SESSION_MODES[pending.mode]
    const sessionID = keep && !pending.fresh ? task.sessions[keep] : undefined
    if (pending.mode === "fix" && !sessionID) task.fixerSeenPlan = false
    const prompt = buildPrompt(this.config, task, pending, !sessionID)
    task.attempts++
    save(task)
    this.log(`task ${task.id}: attempt ${task.attempts} → ${role} (${pending.mode})`)
    const res = await runAgent(
      this.ctx,
      this.config,
      {
        role,
        mode: pending.mode,
        task,
        sessionID,
        parentID: task.polisherSession,
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
    if (phase === "stuck") await this.refreshPolisher(task)
    if (phase === "done") await this.finish(task, "done")
    save(task)
    return render(task)
  }

  private async finish(task: TaskState, outcome: string) {
    await this.refreshPolisher(task)
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
    })
  }

  private reportFile(task: TaskState, kind: string, mode: Mode, r: Report): string {
    const where = task.plan && ["fix", "diagnose", "review"].includes(mode) ? ` (plan ${task.plan}, step ${task.step})` : ""
    return writeNumbered(task, kind, `# ${MODE_ROLE[mode]}: ${r.status}${where}\n\n${r.summary}\n\n${r.content}`)
  }

  private apply(task: TaskState, p: Pending, r: Report, res: RunResult) {
    switch (p.mode) {
      case "triage":
      case "triage_fail": {
        if (r.status === "QUESTIONS") return this.askUser(task, p.mode, r)
        writeFile(task, "brief.md", r.content)
        this.record(task, p.mode, r, "brief.md")
        task.pending = r.status === "TRIVIAL" ? { mode: "fix_trivial", fresh: true } : { mode: "senior" }
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
        task.pending = { mode: "triage_fail" }
        return
      }
      case "review_trivial": {
        const file = this.reportFile(task, "analysis", p.mode, r)
        this.record(task, p.mode, r, file)
        if (r.status === "PASS") return this.done(task, r.summary)
        task.trivialFailed = true
        task.pending = { mode: "triage_fail" }
        return
      }
      case "senior": {
        if (r.status === "QUESTIONS") return this.askUser(task, p.mode, r)
        if (r.status === "NEED_INFO") {
          task.needInfo++
          this.record(task, p.mode, r)
          task.pending = { mode: "explorer", note: r.content }
          return
        }
        if (r.status === "ESCALATE") {
          const file = writeNumbered(task, "escalation", r.content)
          this.record(task, p.mode, r, file)
          return this.toAdvice(task, `senior escalated (${file})`, { mode: "senior", note: "Retry: write a plan, or escalate again." })
        }
        const file = writeNumbered(task, "plan", r.content)
        this.record(task, p.mode, r, file)
        task.plan = task.seq.plan
        task.planSteps = r.steps ?? 1
        task.planRisk = r.risk === "yes"
        task.planHadFailure = task.planFailures > 0
        task.step = 1
        task.rounds = 0
        task.planSummary = r.summary
        const review = task.planRisk && !task.skipOracleReview
        task.skipOracleReview = false
        task.oracleNote = undefined
        if (review) {
          task.pending = { mode: "oracle_review" }
        } else this.toApproval(task)
        return
      }
      case "explorer": {
        const file = writeNumbered(task, "findings", `# Findings (${r.status})\n\n${r.content}`)
        this.record(task, p.mode, r, file)
        task.seniorUnseen.push(file)
        task.pending = { mode: "senior", note: `Explorer answered your queries (${r.status}).` }
        return
      }
      case "oracle_review": {
        const file = this.reportFile(task, "oracle", p.mode, r)
        this.record(task, p.mode, r, file)
        task.oracleNote = file
        if (r.status === "APPROVE") return this.toApproval(task)
        task.seniorUnseen.push(file)
        task.skipOracleReview = true
        task.pending = { mode: "senior", note: `Oracle requested changes to plan ${task.plan} (${file}). Revise the plan once.` }
        return
      }
      case "fix": {
        const file = this.reportFile(task, "report", p.mode, r)
        this.record(task, p.mode, r, file)
        task.seniorUnseen.push(file)
        if (r.status === "BLOCKED") return this.planFailure(task, `Fixer is blocked on step ${task.step}: ${r.summary}`)
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
        task.seniorUnseen.push(file)
        if (r.status === "LOCAL") return this.round(task, file, r)
        if (r.status === "REPLAN") return this.planFailure(task, `the analyser asked for a new plan (${file}): ${r.summary}`)
        return this.toAdvice(task, `the analyser escalated (${file})`, { mode: "diagnose" })
      }
      case "review": {
        const file = this.reportFile(task, "analysis", p.mode, r)
        this.record(task, p.mode, r, file)
        task.seniorUnseen.push(file)
        if (r.status === "PASS") return this.done(task, r.summary)
        task.step = task.planSteps
        return this.round(task, file, r)
      }
      case "oracle_advice": {
        task.oracleAdviceUsed++
        const file = this.reportFile(task, "oracle", p.mode, r)
        this.record(task, p.mode, r, file)
        task.seniorUnseen.push(file)
        if (r.status === "QUESTIONS") return this.askUser(task, p.mode, r)
        task.pending = { mode: "senior", note: `Oracle's advice is in ${file}. Write the next plan following it.` }
        return
      }
    }
  }

  private reviewRequired(task: TaskState) {
    return task.planHadFailure || task.planRisk || task.editedFiles.length >= this.config.review.minFiles
  }

  private round(task: TaskState, file: string, r: Report) {
    task.rounds++
    if (task.rounds > this.config.limits.fixerRounds)
      return this.planFailure(task, `${this.config.limits.fixerRounds} fixer rounds used on step ${task.step} without success`)
    task.pending = { mode: "fix", note: `Round ${task.rounds} on step ${task.step}. Instructions from the analyser (${file}):\n<analysis>\n${r.content}\n</analysis>` }
  }

  private planFailure(task: TaskState, reason: string) {
    task.planFailures++
    const retry: Pending = { mode: "senior", note: `Plan ${task.plan} failed: ${reason}. Write the next plan.` }
    if (task.oracleAdviceUsed >= this.config.limits.oracleAdvice) return this.stuck(task, `plan ${task.plan} failed after Oracle's advice: ${reason}`, retry)
    if (task.planFailures >= this.config.limits.planFailures) return this.toAdvice(task, `${task.planFailures} plans failed; last: ${reason}`, retry)
    task.pending = retry
  }

  private toAdvice(task: TaskState, reason: string, retry: Pending) {
    if (task.oracleAdviceUsed >= this.config.limits.oracleAdvice) return this.stuck(task, `${reason}, and Oracle's advice was already used`, retry)
    task.pending = { mode: "oracle_advice", note: reason }
  }

  private toApproval(task: TaskState) {
    task.phase = "approval"
    task.askedAt = Date.now()
  }

  private askUser(task: TaskState, mode: Mode, r: Report) {
    task.questionRounds++
    this.record(task, mode, r)
    appendFile(task, "answers.md", `## Questions from ${MODE_ROLE[mode]}\n\n${r.content}\n\n${(r.questions ?? []).map((q, i) => `${i + 1}. ${q}`).join("\n")}\n`)
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
