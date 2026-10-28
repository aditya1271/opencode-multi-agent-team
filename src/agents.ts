import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { ASK_COMMANDS, expandHome, type Config, type Role, ROLES } from "./config.ts"
import { matches } from "./match.ts"

export interface Rule {
  action: string
  resource: string
  effect: "allow" | "deny" | "ask"
}

const PROMPT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "prompts")

export const DESCRIPTIONS: Record<Role, string> = {
  polisher: "Team front agent: polishes your request and runs the multi-agent team",
  triage: "Team: sorts a request, searches the code, writes the brief",
  senior: "Team: writes plans",
  explorer: "Team: searches the code and answers code questions",
  fixer: "Team: edits, builds and tests",
  analyser: "Team: diagnoses failures and reviews finished work",
  oracle: "Team: reviews destructive plans and advises when stuck",
}

export const agentId = (config: Config, role: Role) => (role === "polisher" ? "polisher" : config.agentPrefix + role)

export function roleOf(config: Config, agent: string | undefined): Role | undefined {
  if (!agent) return undefined
  return ROLES.find((r) => agentId(config, r) === agent)
}

const allow = (action: string, resource = "*"): Rule => ({ action, resource, effect: "allow" })
const deny = (action: string, resource = "*"): Rule => ({ action, resource, effect: "deny" })
const ask = (action: string, resource = "*"): Rule => ({ action, resource, effect: "ask" })

const mcpAction = (server: string) => `${server.replace(/[^A-Za-z0-9_-]/g, "_")}_*`

function addonRules(config: Config, role: Role): Rule[] {
  const a = config.agents[role] ?? {}
  const rules: Rule[] = []
  for (const skill of a.skills ?? []) rules.push(allow("skill", skill))
  if (a.mcps?.length) rules.push(allow("execute"))
  for (const server of a.mcps ?? []) rules.push(allow(mcpAction(server)))
  for (const tool of a.tools ?? []) rules.push(allow(tool))
  for (const command of a.commands ?? []) rules.push(allow("shell", command))
  return rules
}

/** Ordered rules; the last match wins. Everything not listed is denied. */
export function permissionsFor(config: Config, role: Role): Rule[] {
  const base: Rule[] = [deny("*"), allow("external_directory")]
  const readOnly = config.readOnlyCommands.map((c) => allow("shell", c))
  const readSearch = [allow("read"), allow("grep"), allow("glob")]
  const askList = [...ASK_COMMANDS, ...config.askCommands].map((c) => ask("shell", c))
  switch (role) {
    case "polisher":
      return [deny("*"), allow("team"), allow("question")]
    case "triage":
      return [...base, ...readSearch, ...readOnly, ...addonRules(config, role), allow("report")]
    case "senior":
      return [...base, allow("read"), ...addonRules(config, role), allow("report")]
    case "explorer":
      return [...base, ...readSearch, ...readOnly, ...addonRules(config, role), allow("report")]
    case "oracle":
      return [...base, ...readSearch, ...addonRules(config, role), allow("report")]
    case "analyser":
      return [...base, ...readSearch, ask("shell"), ...readOnly, ...addonRules(config, role), ...askList, allow("report")]
    case "fixer":
      return [
        ...base,
        ...readSearch,
        allow("edit"),
        allow("shell"),
        ...addonRules(config, role),
        ...askList,
        allow("report"),
      ]
  }
}

/** Last matching rule per resource; any deny denies, otherwise any ask asks. */
export function evaluate(rules: Rule[], action: string, resources: readonly string[]): Rule["effect"] {
  const effects = (resources.length ? resources : ["*"]).map((resource) => {
    let effect: Rule["effect"] = "ask"
    for (const r of rules)
      if (matches(r.action, action, false) && matches(r.resource, resource, action === "shell")) effect = r.effect
    return effect
  })
  return effects.includes("deny") ? "deny" : effects.includes("ask") ? "ask" : "allow"
}

const TOOL_ACTIONS: Record<string, string> = { write: "edit", patch: "edit" }

/** A tool stays visible when some rule may allow or ask for its action. */
export function toolVisible(rules: Rule[], tool: string): boolean {
  const action = TOOL_ACTIONS[tool] ?? tool
  return rules.some((r) => r.effect !== "deny" && matches(r.action, action, false))
}

function readPrompt(file: string): string {
  return existsSync(file) ? readFileSync(file, "utf8").trim() : ""
}

/** A config value that names an existing file is read from it; anything else is inline text. */
function textOrFile(value: string): string {
  const file = expandHome(value.trim())
  if (!file.includes("\n") && /\.(md|txt)$/.test(file) && existsSync(file)) return readPrompt(file)
  return value.trim()
}

/** The code-search tools configured for a role, listed for the prompt. */
function toolsNote(config: Config, role: Role): string {
  const a = config.agents[role] ?? {}
  const lines: string[] = []
  if (role === "polisher") return ""
  if (a.skills?.length) lines.push(`- Load these skills before you start working: ${a.skills.join(", ")}.`)
  if (a.mcps?.length) lines.push(`- MCP servers, through the execute tool: ${a.mcps.join(", ")}.`)
  if (a.tools?.length) lines.push(`- Tools: ${a.tools.join(", ")}.`)
  if (a.commands?.length) lines.push(`- Shell commands: ${a.commands.join(", ")}.`)
  return lines.length ? `## Your tools\n\n${lines.join("\n")}` : ""
}

/** Core prompt (fixed) with the role's instructions (editable) at {{instructions}}. */
export function systemPrompt(config: Config, role: Role): string {
  const a = config.agents[role] ?? {}
  const instructions = a.instructions
    ? textOrFile(a.instructions)
    : readPrompt(path.join(PROMPT_DIR, `${role}.instructions.md`))
  const core = readPrompt(path.join(PROMPT_DIR, `${role}.md`))
  const body = core.includes("{{instructions}}")
    ? core.replace("{{instructions}}", instructions)
    : [core, instructions].join("\n\n")
  const polishOff =
    role === "polisher" && config.polish === "off"
      ? "Polishing is OFF: send the user's requests and replies to the team as written, without rewriting them and without the [Send] [Edit] [Cancel] step. This overrides the polishing steps above."
      : ""
  const parts = [body, polishOff, toolsNote(config, role), a.append ? textOrFile(a.append) : ""]
  return parts.filter(Boolean).join("\n\n").replace(/\n{3,}/g, "\n\n")
}
