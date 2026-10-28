import { Rpc } from "@opencode/plugin/rpc"

const row = {
  type: "object",
  properties: {
    role: { type: "string" },
    calls: { type: "number" },
    prompts: { type: "number" },
    tools: { type: "number" },
    input: { type: "number" },
    cacheRead: { type: "number" },
    output: { type: "number" },
    running: { type: "boolean" },
    models: { type: "array", items: { type: "string" } },
  },
  required: ["role", "calls", "prompts", "tools", "input", "cacheRead", "output", "running", "models"],
  additionalProperties: false,
} as const

const total = {
  type: "object",
  properties: { calls: { type: "number" }, prompts: { type: "number" }, tools: { type: "number" }, tokens: { type: "number" } },
  required: ["calls", "prompts", "tools", "tokens"],
  additionalProperties: false,
} as const

/** Sidebar data: per-agent usage of the session's current task, and totals over the whole session. */
export const TeamStats = Rpc.define({
  id: "multi-agent-team",
  methods: {
    stats: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          task: {
            type: "object",
            properties: {
              id: { type: "string" },
              workflow: { type: "string" },
              phase: { type: "string" },
              attempts: { type: "number" },
              attemptLimit: { type: "number" },
              rows: { type: "array", items: row },
            },
            required: ["id", "workflow", "phase", "attempts", "attemptLimit", "rows"],
            additionalProperties: false,
          },
          models: {
            type: "array",
            items: {
              type: "object",
              properties: { role: { type: "string" }, models: { type: "array", items: { type: "string" } } },
              required: ["role", "models"],
              additionalProperties: false,
            },
          },
          session: {
            type: "object",
            properties: { tasks: { type: "number" }, questions: { type: "number" }, total },
            required: ["tasks", "questions", "total"],
            additionalProperties: false,
          },
        },
        required: ["session", "models"],
        additionalProperties: false,
      },
    },
  },
  events: {
    changed: {
      schema: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
    },
  },
})

export interface StatsRow {
  role: string
  calls: number
  prompts: number
  tools: number
  input: number
  cacheRead: number
  output: number
  /** This agent is running a call right now; its numbers include the call so far. */
  running: boolean
  /** Models this agent used in the task, in order (more than one: it switched to a backup). */
  models: string[]
}

/** "main → backup (backup)" when the agent switched models, else the one model. */
export const modelsText = (models: readonly string[]) =>
  models.length > 1 ? `${models.join(" → ")} (backup)` : (models[0] ?? "")

export const compact = (n: number) =>
  n < 1000 ? String(n) : n < 10_000 ? `${(n / 1000).toFixed(1)}k` : n < 1_000_000 ? `${Math.round(n / 1000)}k` : `${(n / 1_000_000).toFixed(1)}M`

/** One fixed-width sidebar line (35 columns): marker, name, calls, prompts, tools, tokens, percent. */
export const line = (mark: string, name: string, calls: number | string, prompts: number | string, tools: number | string, tokens: string, pct: string) =>
  mark + name.padEnd(9).slice(0, 9) + String(calls).padStart(4) + String(prompts).padStart(5) + String(tools).padStart(5) + tokens.padStart(6) + pct.padStart(5)

export interface SidebarStats {
  task?: { id: string; workflow: string; phase: string; attempts: number; attemptLimit: number; rows: StatsRow[] }
  /** Each role's configured models, main first. */
  models: { role: string; models: string[] }[]
  session: { tasks: number; questions: number; total: { calls: number; prompts: number; tools: number; tokens: number } }
}

/** The `track` method of the opencode-edited-files plugin, so saved documents show in its sidebar. */
export const EditedFilesTrack = Rpc.define({
  id: "edited-files",
  methods: {
    track: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          files: {
            type: "array",
            items: {
              type: "object",
              properties: { path: { type: "string" }, before: { type: "string" } },
              required: ["path"],
              additionalProperties: false,
            },
          },
        },
        required: ["sessionID", "files"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      },
    },
  },
  events: {},
})
