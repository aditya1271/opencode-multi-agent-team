import { Plugin } from "@opencode/plugin"
import { appendFileSync, mkdirSync } from "node:fs"
import path from "node:path"
import { agentId, DESCRIPTIONS, permissionsFor, systemPrompt } from "./agents.ts"
import { expandHome, loadConfig, modelsFor, ROLES } from "./config.ts"
import { registerFallback } from "./fallback.ts"
import { registerGuards } from "./guards.ts"
import { acceptReport, REPORT_DESCRIPTION, REPORT_INPUT } from "./report.ts"
import { stopAfterReport } from "./run.ts"
import { TeamStats } from "./rpc.ts"
import type { Report } from "./runtime.ts"
import { Team, TEAM_DESCRIPTION, TEAM_SCHEMA, type TeamInput } from "./team.ts"

export default Plugin.define({
  id: "opencode-multi-agent-team",
  async setup(ctx) {
    const config = loadConfig(ctx.location.directory, ctx.options)
    const root = expandHome(config.taskDir)
    mkdirSync(root, { recursive: true })
    const log = (msg: string) => {
      try {
        appendFileSync(path.join(root, "plugin.log"), `${new Date().toISOString()} ${msg}\n`)
      } catch {}
    }
    const missing = ROLES.filter((r) => modelsFor(config, r).length === 0)
    if (missing.length) log(`no model configured for: ${missing.join(", ")} (set agents.<role>.model)`)

    await ctx.agent.transform((editor) => {
      for (const role of ROLES) {
        const id = agentId(config, role)
        const models = modelsFor(config, role)
        editor.update(id, (a) => {
          a.id = id as never
          a.name = id as never
          a.mode = role === "manager" ? "primary" : "subagent"
          a.hidden = role !== "manager"
          a.description = DESCRIPTIONS[role]
          a.system = systemPrompt(config, role)
          if (models[0]) a.model = models[0] as never
          a.permissions = permissionsFor(config, role) as never
        })
      }
      if (config.defaultAgent) editor.default(agentId(config, "manager"))
    })

    const team = new Team(ctx, config, log)

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "team",
        description: TEAM_DESCRIPTION,
        input: TEAM_SCHEMA,
        options: { codemode: false },
        execute: async (input, context) => {
          try {
            return { content: await team.handle(input as TeamInput, context.sessionID, context.signal) }
          } catch (e) {
            log(`team error: ${(e as Error).stack ?? String(e)}`)
            return { content: `The team plugin hit an error: ${(e as Error).message}\nNEXT ACTION: tell the user.` }
          } finally {
            team.onChange(context.sessionID)
          }
        },
      })
      editor.add({
        name: "report",
        description: REPORT_DESCRIPTION,
        input: REPORT_INPUT,
        options: { codemode: false },
        execute: async (input, context) => {
          const reply = acceptReport(config, context.sessionID, input as Report)
          stopAfterReport(ctx, context.sessionID)
          return { content: reply }
        },
      })
    })

    const stats = await ctx.rpc.register(TeamStats, {
      stats: async (input) => team.sidebar((input as { sessionID: string }).sessionID),
    })
    team.onChange = (sessionID) => void stats.events.emit("changed", { sessionID }).catch(() => {})

    await registerGuards(ctx, config)
    await registerFallback(ctx, config, log)
    log(`loaded in ${ctx.location.directory}`)
  },
})
