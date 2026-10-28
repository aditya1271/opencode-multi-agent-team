import { Plugin } from "@opencode/plugin"
import { appendFileSync, mkdirSync } from "node:fs"
import path from "node:path"
import { agentId, DESCRIPTIONS, permissionsFor, systemPrompt } from "./agents.ts"
import { expandHome, loadConfig, modelsFor, ROLES } from "./config.ts"
import { registerFallback } from "./fallback.ts"
import { registerGuards } from "./guards.ts"
import { acceptReport, REPORT_DESCRIPTION, REPORT_INPUT } from "./report.ts"
import { stopAfterReport } from "./run.ts"
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
        let polisherSystem = systemPrompt(config, role)
        if (role === "polisher" && config.polish === "off")
          polisherSystem += "\n\nPolishing is OFF: send the user's message to team start as written, without the [Send] [Edit] [Cancel] step."
        editor.update(id, (a) => {
          a.id = id as never
          a.name = id as never
          a.mode = role === "polisher" ? "primary" : "subagent"
          a.hidden = role !== "polisher"
          a.description = DESCRIPTIONS[role]
          a.system = polisherSystem
          if (models[0]) a.model = models[0] as never
          a.permissions = permissionsFor(config, role) as never
        })
      }
      if (config.defaultAgent) editor.default(agentId(config, "polisher"))
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

    await registerGuards(ctx, config)
    await registerFallback(ctx, config, log)
    log(`loaded in ${ctx.location.directory}`)
  },
})
