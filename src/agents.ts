import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { ASK_COMMANDS, expandHome, type Config, type FrontAgent, type Role, ROLES } from "./config.ts"
import { matches } from "./match.ts"
import { WORKFLOWS, type Workflow } from "./state.ts"

export interface Rule {
  action: string
  resource: string
  effect: "allow" | "deny" | "ask"
}

const PROMPT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "prompts")

export const DESCRIPTIONS: Record<Role, string> = {
  manager: "Team: changes code (plans, edits, builds and tests through the team)",
  analyst: "Team: sorts a request, searches the code, writes the brief",
  planner: "Team: writes plans and documents",
  intern: "Team: searches the code and answers code questions",
  developer: "Team: edits, builds and tests",
  reviewer: "Team: diagnoses failures and reviews finished work",
  architect: "Team: reviews destructive plans and advises when stuck",
  operator: "Team: runs commands, scripts and web requests for the user and returns the output",
}

/** The front agents, one per workflow; they share the manager role (model, permissions, engine). */
export const FRONT_AGENTS: Record<Workflow, FrontAgent> = { code: "build-manager", plan: "plan-manager", research: "research-manager" }

export const FRONT_DESCRIPTIONS: Record<Workflow, string> = {
  code: "Team: changes code (plans, edits, builds and tests through the team)",
  plan: "Team: writes a plan document for you to review; changes no code",
  research: "Team: researches the code and writes a findings report",
}

export const agentId = (config: Config, role: Role) => (role === "manager" ? FRONT_AGENTS.code : config.agentPrefix + role)

/** The workflow a front agent starts; "code" for anything else. */
export const workflowOf = (agent: string | undefined): Workflow =>
  WORKFLOWS.find((w) => FRONT_AGENTS[w] === agent) ?? "code"

export function roleOf(config: Config, agent: string | undefined): Role | undefined {
  if (!agent) return undefined
  // "manager" is the Build agent's name before the three front agents.
  if (agent === "manager" || WORKFLOWS.some((w) => FRONT_AGENTS[w] === agent)) return "manager"
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
    case "manager":
      return [deny("*"), allow("team"), allow("question")]
    case "analyst":
      // Read only: every search goes to the Intern (NEED_INFO), so search output never piles up in Analyst's long session.
      return [...base, allow("read"), ...addonRules(config, role), allow("report")]
    case "planner":
    case "architect":
      // No file or code access: they know only what Analyst's brief and answers tell them.
      return [deny("*"), ...(config.agents[role]?.skills ?? []).map((s) => allow("skill", s)), allow("report")]
    case "intern":
      return [...base, ...readSearch, ...readOnly, ...addonRules(config, role), allow("report")]
    case "reviewer":
      return [...base, ...readSearch, ask("shell"), ...readOnly, ...addonRules(config, role), ...askList, allow("report")]
    case "developer":
      return [
        ...base,
        ...readSearch,
        allow("edit"),
        allow("shell"),
        ...addonRules(config, role),
        ...askList,
        allow("report"),
      ]
    case "operator":
      // Runs things for the user (commands, scripts, API calls, web pages); changes no code, so no edit tool.
      return [...base, ...readSearch, allow("shell"), allow("webfetch"), allow("websearch"), ...addonRules(config, role), ...askList, allow("report")]
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

/** Roles with no file or code access. */
export const BRIEF_ONLY: Role[] = ["planner", "architect"]

/** Configured tools a brief-only role can't use; the plugin ignores them and logs a warning. */
export function ignoredTools(config: Config): string[] {
  return BRIEF_ONLY.flatMap((role) => {
    const a = config.agents[role] ?? {}
    const extra = [...(a.mcps ?? []), ...(a.tools ?? []), ...(a.commands ?? [])]
    return extra.length ? [`agents.${role}: ${extra.join(", ")} ignored (${role} has no tool access; Analyst answers its questions)`] : []
  })
}

/**
 * A document standard: the configured text or file, else the built-in prompt.
 * what: plan.instructions(.md); how: plan.howInstructions (how.instructions.md); research: research.instructions(.md).
 */
export function workflowInstructions(config: Config, kind: "what" | "how" | "research"): string {
  const configured = kind === "research" ? config.workflows.research.instructions : kind === "how" ? config.workflows.plan.howInstructions : config.workflows.plan.instructions
  const file = kind === "research" ? "research" : kind === "how" ? "how" : "plan"
  return configured?.trim() ? textOrFile(configured) : readPrompt(path.join(PROMPT_DIR, `${file}.instructions.md`))
}

/** The code-search tools configured for a role, listed for the prompt. */
function toolsNote(config: Config, role: Role): string {
  const a = config.agents[role] ?? {}
  const lines: string[] = []
  if (role === "manager") return ""
  const skills = `- Skills: ${a.skills?.join(", ")}. Their text is at the end of your instructions; don't load them again.`
  if (BRIEF_ONLY.includes(role)) return a.skills?.length ? `## Your tools\n\n${skills}` : ""
  if (a.skills?.length) lines.push(skills)
  if (a.mcps?.length) lines.push(`- MCP servers, through the execute tool: ${a.mcps.join(", ")}.`)
  if (a.tools?.length) lines.push(`- Tools: ${a.tools.join(", ")}.`)
  if (a.commands?.length) lines.push(`- Shell commands: ${a.commands.join(", ")}.`)
  return lines.length ? `## Your tools\n\n${lines.join("\n")}` : ""
}

/** Core prompt (fixed) with the role's instructions (editable) at {{instructions}}. */
export function systemPrompt(config: Config, role: Role): string {
  if (role === "manager") return managerPrompt(config, "code")
  const a = config.agents[role] ?? {}
  const instructions = a.instructions
    ? textOrFile(a.instructions)
    : readPrompt(path.join(PROMPT_DIR, `${role}.instructions.md`))
  const core = readPrompt(path.join(PROMPT_DIR, `${role}.md`))
  const body = core.includes("{{instructions}}")
    ? core.replace("{{instructions}}", instructions)
    : [core, instructions].join("\n\n")
  const parts = [body, approach(role), toolsNote(config, role), SECRETS, a.append ? textOrFile(a.append) : ""]
  return parts.filter(Boolean).join("\n\n").replace(/\n{3,}/g, "\n\n")
}

/** Every worker: how a good team member works. The first lines suit every role; the last one depends on how the role works with others. */
const APPROACH_BASE =
  'Before you act, work out what you need to know, why you need it, and the most direct way to find it out. Keep the goal and what "done" looks like in view: the request is what the user wants, and everything else serves it.'
const APPROACH_ROLE: Record<Exclude<Role, "manager">, string> = {
  // Askers: they depend on others for facts.
  analyst: "When you need others to find things for you, ask for all of it in one round and say why you need each piece, so they bring back the right depth. When you have enough to decide, decide, and say what you assumed.",
  planner: "When you need others to find things for you, ask for all of it in one round and say why you need each piece, so they bring back the right depth. When you have enough to decide, decide, and say what you assumed.",
  // Answerers: someone waits on them and acts on their answer alone.
  intern: "Someone is waiting on your answer and will act on it without checking: give them everything they asked for, with the evidence, so they don't have to come back.",
  operator: "Someone is waiting on your result and will act on it without checking: give them everything they asked for, exactly as it came out, so they don't have to come back.",
  // Doers: they iterate.
  developer: "When something fails twice the same way, stop and question the assumption behind it instead of trying another variation.",
  // Critics: they judge others' work.
  reviewer: "Look for what is wrong or missing, not for things to rewrite: every point you raise should change the outcome.",
  architect: "Look for what is wrong or missing, not for things to rewrite: every point you raise should change the outcome.",
}
const approach = (role: Exclude<Role, "manager">) => `## How to approach your work\n\n${APPROACH_BASE} ${APPROACH_ROLE[role]}`

/** Every worker: task files and reports are plain text on disk, so secrets stay out of them. */
const SECRETS =
  "Never copy a secret's value (API key, token, password, private key) into a report, brief, plan, answer or file you write, even when you read it in a file or command output: name the variable or file instead (e.g. `API_KEY` in `.env`). Pass secrets to commands by reference (`source .env`, `$API_KEY`), not by pasting them."

/**
 * A front agent's prompt: the shared manager core (fixed), its workflow's part (fixed) and its
 * polishing instructions (editable: agents.<front agent>.instructions, else the built-in file).
 * agents.manager.instructions/append still apply to build-manager, and append to all three.
 */
export function managerPrompt(config: Config, workflow: Workflow): string {
  const id = FRONT_AGENTS[workflow]
  const own = config.agents[id] ?? {}
  const shared = config.agents.manager ?? {}
  const configured = own.instructions ?? (workflow === "code" ? shared.instructions : undefined)
  const instructions = configured ? textOrFile(configured) : readPrompt(path.join(PROMPT_DIR, `${id}.instructions.md`))
  const body = readPrompt(path.join(PROMPT_DIR, "manager.md"))
    .replace("{{name}}", id)
    .replace("{{workflow}}", readPrompt(path.join(PROMPT_DIR, `manager.${workflow}.md`)))
    .replace("{{instructions}}", instructions)
  const polishOff =
    config.polish === "off"
      ? "Polishing is OFF: send the user's requests and replies to the team as written, without rewriting them. This overrides the polishing above."
      : ""
  const parts = [body, polishOff, shared.append ? textOrFile(shared.append) : "", own.append ? textOrFile(own.append) : ""]
  return parts.filter(Boolean).join("\n\n").replace(/\n{3,}/g, "\n\n")
}
