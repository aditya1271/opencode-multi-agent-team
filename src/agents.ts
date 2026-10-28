import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { ASK_COMMANDS, expandHome, type Config, type Role, ROLES } from "./config.ts"

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
  const addons = config.addons[role] ?? {}
  const rules: Rule[] = []
  for (const skill of addons.skills ?? []) rules.push(allow("skill", skill))
  if (addons.mcps?.length) rules.push(allow("execute"))
  for (const server of addons.mcps ?? []) rules.push(allow(mcpAction(server)))
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
      return [...base, ...readSearch, ask("shell"), ...readOnly, ...askList, ...addonRules(config, role), allow("report")]
    case "fixer":
      return [
        ...base,
        ...readSearch,
        allow("edit"),
        allow("shell"),
        ...askList,
        ...addonRules(config, role),
        allow("report"),
      ]
  }
}

function patternRegExp(pattern: string): RegExp {
  const body = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[\\s\\S]*").replace(/\?/g, ".")
  return new RegExp(`^${body}$`)
}

function matches(pattern: string, value: string, shell: boolean): boolean {
  if (patternRegExp(pattern).test(value)) return true
  return shell && pattern.endsWith(" *") && patternRegExp(pattern.slice(0, -2)).test(value)
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

export function systemPrompt(config: Config, role: Role): string {
  const parts = [readPrompt(path.join(PROMPT_DIR, `${role}.md`))]
  const skills = config.addons[role]?.skills ?? []
  const mcps = config.addons[role]?.mcps ?? []
  if (skills.length) parts.push(`Load these skills before you start working: ${skills.join(", ")}.`)
  if (mcps.length)
    parts.push(
      `These MCP servers are available through the execute tool: ${mcps.join(", ")}. ` +
        `For code search, use them first (graph first), then grep and read.`,
    )
  const append = config.promptAppend[role]
  if (append) parts.push(readPrompt(expandHome(append)))
  return parts.filter(Boolean).join("\n\n")
}
