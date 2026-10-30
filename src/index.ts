import { Plugin } from "@opencode/plugin"
import { appendFileSync, mkdirSync } from "node:fs"
import path from "node:path"
import { agentId, DESCRIPTIONS, FRONT_AGENTS, FRONT_DESCRIPTIONS, ignoredTools, managerPrompt, permissionsFor, systemPrompt, workflowOf } from "./agents.ts"
import { WORKFLOWS } from "./state.ts"
import { expandHome, loadConfig, modelsFor, ROLES, tierOf, TIERS } from "./config.ts"
import { registerFallback } from "./fallback.ts"
import { registerGuards } from "./guards.ts"
import { acceptReport, REPORT_DESCRIPTION, REPORT_INPUT } from "./report.ts"
import { TeamStats, type ReviewReply, type ReviewSave } from "./rpc.ts"
import type { Report } from "./runtime.ts"
import { MODE_COMMANDS, Team, TEAM_DESCRIPTION, TEAM_SCHEMA, type TeamInput } from "./team.ts"

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
    if (missing.length) log(`no model configured for: ${missing.map((r) => `${r} (tier ${tierOf(config, r)})`).join(", ")} (set tiers.<tier>.model or agents.<role>.model)`)
    for (const [role, a] of Object.entries(config.agents)) if (a && "tier" in a && a.tier && !TIERS.includes(a.tier)) log(`warning: agents.${role}.tier "${a.tier}" is not one of ${TIERS.join(", ")}`)
    for (const warning of ignoredTools(config)) log(`warning: ${warning}`)

    await ctx.agent.transform((editor) => {
      for (const role of ROLES) {
        const models = modelsFor(config, role)
        const ids = role === "manager" ? WORKFLOWS.map((w) => FRONT_AGENTS[w]) : [agentId(config, role)]
        for (const id of ids) {
          const workflow = workflowOf(id)
          editor.update(id, (a) => {
            a.id = id as never
            a.name = id as never
            a.mode = role === "manager" ? "primary" : "subagent"
            a.hidden = role !== "manager"
            a.description = role === "manager" ? FRONT_DESCRIPTIONS[workflow] : DESCRIPTIONS[role]
            a.system = role === "manager" ? managerPrompt(config, workflow) : systemPrompt(config, role)
            if (models[0]) a.model = models[0] as never
            a.permissions = permissionsFor(config, role) as never
          })
        }
      }
      if (config.defaultAgent) editor.default(FRONT_AGENTS.code)
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
            const workflow = workflowOf(context.agent)
            const content = await team.handle({ ...(input as TeamInput), workflow }, context.sessionID, context.signal)
            return { content: await team.withDialog(context.sessionID, content) }
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
          return { content: reply }
        },
      })
    })

    await ctx.command.transform((editor) => {
      for (const { name, mode, description } of MODE_COMMANDS)
        editor.add({
          name,
          description,
          execute: async ({ sessionID }) => {
            try {
              const { text, resume } = await team.setMode(sessionID, mode)
              if (resume)
                await ctx.session.prompt({
                  sessionID,
                  text: `[team-mode] ${text} The team waits at a stop this mode decides: call team with action "continue".`,
                })
              else await ctx.session.synthetic({ sessionID, text: `[team-mode] ${text}` })
            } catch (e) {
              log(`team-mode error: ${(e as Error).stack ?? String(e)}`)
            }
          },
        })
    })

    // Manager sessions whose review dialog is open in a TUI: opening on its own skips them; the button reopens anyway.
    const opened = new Set<string>()
    const rpc = await ctx.rpc.register(TeamStats, {
      stats: async (input) => team.sidebar((input as { sessionID: string }).sessionID),
      reviewClaim: async (input) => {
        const { sessionID, force } = input as { sessionID: string; force?: boolean }
        if (opened.has(sessionID) && !force) return {}
        const draft = team.dialog(sessionID)
        if (!draft) return {}
        opened.add(sessionID)
        return { draft }
      },
      reviewSave: async (input) => {
        const { sessionID, key, progress } = input as ReviewSave
        opened.delete(sessionID)
        return { ok: team.dialogSave(sessionID, { key, progress }) }
      },
      reviewDone: async (input) => {
        const reply = input as ReviewReply
        opened.delete(reply.sessionID)
        const text = team.dialogDone(reply.sessionID, reply)
        if (!text) return { ok: false }
        void ctx.session.prompt({ sessionID: reply.sessionID, text: `[team-review] ${text}` }).catch((e) => log(`review wake error: ${(e as Error).message}`))
        return { ok: true }
      },
    })
    team.onChange = (sessionID) => void rpc.events.emit("changed", { sessionID }).catch(() => {})
    team.offerDialog = (sessionID) => {
      opened.delete(sessionID)
      void rpc.events.emit("review", { sessionID }).catch(() => {})
    }

    await registerGuards(ctx, config)
    await registerFallback(ctx, config, log)
    log(`loaded in ${ctx.location.directory}`)
  },
})
