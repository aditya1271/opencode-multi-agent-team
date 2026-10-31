import type { Plugin } from "@opencode/plugin"
type Context = Plugin.Context
import { roleOf } from "./agents.ts"
import { fallbackModels, modelLabel, type Config } from "./config.ts"
import { runs } from "./runtime.ts"

/**
 * Worker sessions: after the allowed short waits the request fails, and the runner
 * switches to the next model (run.ts). The manager switches here, since no runner
 * watches it.
 */
export async function registerFallback(ctx: Context, config: Config, log: (msg: string) => void) {
  // Per session, the models already tried, so each is tried once.
  const tried = new Map<string, Set<string>>()
  const key = (m: { providerID: string; id: string }) => `${m.providerID}/${m.id}`
  await ctx.session.hook("retry", async (event) => {
    if (event.attempt <= config.limits.modelRetryWaits) return
    if (runs.has(event.sessionID)) {
      event.decision = { retry: false }
      return
    }
    if (roleOf(config, event.agent) !== "manager") return
    const seen = tried.get(event.sessionID) ?? new Set([key(event.model)])
    tried.set(event.sessionID, seen)
    const backup = fallbackModels(config, "manager").find((m) => !seen.has(key(m)))
    if (!backup) return
    seen.add(key(backup))
    try {
      await ctx.session.switchModel({ sessionID: event.sessionID, model: backup })
      log(`manager switched to fallback model ${modelLabel(backup)}`)
      event.decision = { retry: true, delay: 1000 }
    } catch (e) {
      log(`manager model switch failed: ${String(e)}`)
    }
  })
}
