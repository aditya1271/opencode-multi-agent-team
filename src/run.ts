import type { Plugin } from "@opencode/plugin"
type Context = Plugin.Context
import { agentId } from "./agents.ts"
import { modelLabel, modelsFor, type Config, type WorkerRole } from "./config.ts"
import { beginRun, runs, type Report, type SessionRun } from "./runtime.ts"
import type { Mode, TaskState } from "./state.ts"
import type { UsageDelta } from "./usage.ts"

export type RunEnd = "report" | "no_report" | "timeout" | "stall" | "aborted" | "model" | "config"

export interface RunInput {
  role: WorkerRole
  mode: Mode
  task?: TaskState
  sessionID?: string
  parentID: string
  title: string
  prompt: string
  signal: AbortSignal
}

export interface RunResult {
  end: RunEnd
  sessionID?: string
  report?: Report
  failure?: string
  usage: UsageDelta
  run?: SessionRun
}

const CHECK_MS = 5000
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type Tokens = { input: number; output: number; reasoning: number; cache: { read: number; write: number } }

/** A session's token counts as the usage table counts them: input incl. cache writes, output incl. reasoning. */
export const tokenCounts = (t: Tokens) => ({
  input: t.input + (t.cache.write ?? 0),
  cacheRead: t.cache.read,
  output: t.output + t.reasoning,
})

export async function runAgent(ctx: Context, config: Config, input: RunInput, log: (msg: string) => void): Promise<RunResult> {
  const zero: UsageDelta = { prompts: 0, tools: {}, input: 0, cacheRead: 0, output: 0 }
  const models = modelsFor(config, input.role)
  if (!models.length)
    return { end: "config", failure: `No model configured for the "${input.role}" role. Set agents.${input.role}.model in opencode-multi-agent-team.json.`, usage: zero }

  let sessionID = input.sessionID
  if (!sessionID) {
    const created = await ctx.session.create({
      parentID: input.parentID,
      title: input.title,
      agent: agentId(config, input.role),
      model: models[0],
    })
    sessionID = created.id
  }
  const sid = sessionID
  const before = await ctx.session.get({ sessionID: sid })
  const run = beginRun(sid, {
    role: input.role,
    mode: input.mode,
    task: input.task,
    toolLimit: config.limits.toolCalls[input.role],
  })
  run.base = tokenCounts(before.tokens as Tokens)
  const start = Date.now()
  const callMs = (input.role === "developer" ? config.limits.callMinutes.developer : config.limits.callMinutes.default) * 60_000
  const stallMs = config.limits.stallMinutes * 60_000
  let modelIndex = Math.max(0, models.findIndex((m) => m.providerID === before.model?.providerID && m.id === before.model?.id))

  const watch = async (): Promise<"idle" | "timeout" | "stall" | "aborted"> => {
    let timer: ReturnType<typeof setInterval> | undefined
    let onAbort: (() => void) | undefined
    const watchdog = new Promise<"timeout" | "stall" | "aborted">((resolve) => {
      onAbort = () => resolve("aborted")
      if (input.signal.aborted) return resolve("aborted")
      input.signal.addEventListener("abort", onAbort)
      timer = setInterval(() => {
        const now = Date.now()
        if (now - start > callMs) resolve("timeout")
        else if (run.inFlight === 0 && now - run.lastActivity > stallMs) resolve("stall")
      }, CHECK_MS)
    })
    try {
      return await Promise.race([ctx.session.wait({ sessionID: sid }).then(() => "idle" as const), watchdog])
    } finally {
      clearInterval(timer)
      if (onAbort) input.signal.removeEventListener("abort", onAbort)
    }
  }

  let end: RunEnd = "no_report"
  let failure: string | undefined
  let text = input.prompt
  let reprompted = false
  try {
    for (;;) {
      run.lastActivity = Date.now()
      await ctx.session.prompt({ sessionID: sid, text })
      const result = await watch()
      if (result !== "idle") {
        await ctx.session.interrupt({ sessionID: sid, resume: false }).catch(() => undefined)
        end = result
        failure =
          result === "aborted"
            ? "stopped by the user"
            : result === "timeout"
              ? `no result after ${Math.round(callMs / 60_000)} min (hang protection)`
              : `no activity for ${config.limits.stallMinutes} min (stall protection)`
        break
      }
      if (run.report) {
        end = "report"
        break
      }
      const info = await ctx.session.get({ sessionID: sid })
      if (info.outcome === "failed") {
        if (modelIndex + 1 < models.length) {
          modelIndex++
          const next = models[modelIndex]
          log(`${input.role}: model failed, switching to ${modelLabel(next)}`)
          await ctx.session.switchModel({ sessionID: sid, model: next })
          await sleep(500)
          text = "The previous model request failed. Continue the task where it stopped, and finish by calling `report`."
          continue
        }
        end = "model"
        failure = `all models for ${input.role} failed (${models.map(modelLabel).join(", ")})`
        break
      }
      if (!reprompted) {
        reprompted = true
        text = "Finish by calling `report`."
        continue
      }
      end = "no_report"
      failure = `${input.role} ended twice without calling report`
      break
    }
  } finally {
    runs.delete(sid)
  }

  const after = await ctx.session.get({ sessionID: sid }).catch(() => undefined)
  const b = run.base ?? tokenCounts(before.tokens as Tokens)
  const a = tokenCounts((after?.tokens ?? before.tokens) as Tokens)
  const usage: UsageDelta = {
    calls: 1,
    prompts: run.prompts,
    tools: run.tools,
    input: a.input - b.input,
    cacheRead: a.cacheRead - b.cacheRead,
    output: a.output - b.output,
    model: modelLabel(models[modelIndex]),
    ms: Date.now() - start,
  }
  return { end, sessionID: sid, report: run.report, failure, usage, run }
}
