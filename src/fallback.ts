import type { Plugin } from "@opencode/plugin"
type Context = Plugin.Context
import { roleOf } from "./agents.ts"
import { modelLabel, modelsFor, type Config } from "./config.ts"
import { runs } from "./runtime.ts"

/**
 * Worker sessions: after the allowed short waits the request fails, and the runner
 * switches to the next model (run.ts). The polisher switches here, since no runner
 * watches it.
 */
export async function registerFallback(ctx: Context, config: Config, log: (msg: string) => void) {
  const switched = new Set<string>()
  await ctx.session.hook("retry", async (event) => {
    if (event.attempt <= config.limits.modelRetryWaits) return
    if (runs.has(event.sessionID)) {
      event.decision = { retry: false }
      return
    }
    if (roleOf(config, event.agent) !== "polisher" || switched.has(event.sessionID)) return
    const backup = modelsFor(config, "polisher").find(
      (m) => m.providerID !== event.model.providerID || m.id !== event.model.id,
    )
    if (!backup) return
    switched.add(event.sessionID)
    try {
      await ctx.session.switchModel({ sessionID: event.sessionID, model: backup })
      log(`polisher switched to backup model ${modelLabel(backup)}`)
      event.decision = { retry: true, delay: 1000 }
    } catch (e) {
      log(`polisher model switch failed: ${String(e)}`)
    }
  })
}
