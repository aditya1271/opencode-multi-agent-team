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
  },
  required: ["role", "calls", "prompts", "tools", "input", "cacheRead", "output", "running"],
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
              phase: { type: "string" },
              attempts: { type: "number" },
              attemptLimit: { type: "number" },
              rows: { type: "array", items: row },
            },
            required: ["id", "phase", "attempts", "attemptLimit", "rows"],
            additionalProperties: false,
          },
          session: {
            type: "object",
            properties: { tasks: { type: "number" }, questions: { type: "number" }, total },
            required: ["tasks", "questions", "total"],
            additionalProperties: false,
          },
        },
        required: ["session"],
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
}

export const compact = (n: number) =>
  n < 1000 ? String(n) : n < 10_000 ? `${(n / 1000).toFixed(1)}k` : n < 1_000_000 ? `${Math.round(n / 1000)}k` : `${(n / 1_000_000).toFixed(1)}M`

/** One fixed-width sidebar line (35 columns): marker, name, calls, prompts, tools, tokens, percent. */
export const line = (mark: string, name: string, calls: number | string, prompts: number | string, tools: number | string, tokens: string, pct: string) =>
  mark + name.padEnd(8).slice(0, 8) + String(calls).padStart(5) + String(prompts).padStart(5) + String(tools).padStart(5) + tokens.padStart(6) + pct.padStart(5)

export interface SidebarStats {
  task?: { id: string; phase: string; attempts: number; attemptLimit: number; rows: StatsRow[] }
  session: { tasks: number; questions: number; total: { calls: number; prompts: number; tools: number; tokens: number } }
}
