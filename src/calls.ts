import type { WorkerRole } from "./config.ts"
import { MODE_ROLE, type Mode, type Pending, type TaskState } from "./state.ts"

/** One agent call of a task, as the team lived it. Plain facts the code saw: nothing here is written by a model. */
export interface CallRecord {
  n: number
  role: WorkerRole
  mode: Mode
  /** The call whose agent asked for this one (an Analyst's search round for the Intern). */
  parent?: number
  ask: string
  model?: string
  started: number
  ms?: number
  /** Unset while the call runs (or after a restart cut it off). */
  end?: string
  status?: string
  outcome?: string
  /** Things that went differently than planned: a denied tool, a model switch, a refused read. */
  notes: string[]
}

const KEEP = 60

/** What each kind of call is for, when its hand-off has no line of its own. */
const PURPOSE: Record<Mode, string> = {
  analyst: "reads the task and writes findings",
  analyst_fail: "explains why the task failed",
  analyst_reply: "answers a question",
  analyst_answer: "answers a question from the team",
  fix_trivial: "makes a small change",
  review_trivial: "checks the small change",
  planner: "writes the plan",
  planner_reply: "answers a question",
  planner_advice: "advises on a draft",
  planner_consult: "answers the developer's question",
  planner_stepfix: "repairs one plan step",
  intern: "looks up code",
  request_check: "checks the request against the code",
  architect_review: "reviews the plan",
  architect_advice: "advises on the plan",
  architect_reply: "answers a question",
  architect_doc_review: "reviews the document",
  architect_draft_advice: "advises on a draft",
  fix: "changes the code",
  diagnose: "finds why a check failed",
  review: "reviews the change",
  operator: "runs commands",
}

const oneLine = (text: string, max: number) => {
  const line = text.split("\n").find((l) => l.trim())?.replace(/\s+/g, " ").trim() ?? ""
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** The line a call is shown with: what it is for; an Intern's call counts its queries, a call right after an Intern's answer says so. */
export function askOf(pending: Pending, calls: CallRecord[] = []): string {
  if (pending.mode === "intern") {
    const queries = (pending.note ?? "").split("\n").filter((l) => /^\s*\d+[.)]/.test(l)).length
    return queries > 1 ? `${PURPOSE.intern} (${queries} queries)` : PURPOSE.intern
  }
  const last = calls.at(-1)
  const asked = last?.parent !== undefined ? calls.find((c) => c.n === last.parent) : undefined
  if (last?.mode === "intern" && asked && asked.role === MODE_ROLE[pending.mode]) return "continues with the Intern's answer"
  return PURPOSE[pending.mode]
}

/** Adds a call to the list as it starts. n 0: a call outside the task's numbering (a question, an errand). */
export function startCall(list: CallRecord[], call: { n?: number; role: WorkerRole; mode: Mode; ask: string; asker?: Mode; model?: string }): CallRecord {
  const parent = call.asker ? list.findLast((c) => c.mode === call.asker) : undefined
  const record: CallRecord = { n: call.n ?? 0, role: call.role, mode: call.mode, parent: parent?.n, ask: call.ask, model: call.model, started: Date.now(), notes: [] }
  list.push(record)
  if (list.length > KEEP) list.splice(0, list.length - KEEP)
  return record
}

export const purposeOf = (mode: Mode) => PURPOSE[mode]
export const lineOf = (text: string) => oneLine(text, 70)

/** The call as it ended: how, what came back, and what went differently on the way. */
export function endCall(record: CallRecord, done: { end: string; ms?: number; model?: string; status?: string; outcome?: string; notes: string[] }) {
  record.end = done.end
  record.ms = done.ms ?? Date.now() - record.started
  record.model = done.model ?? record.model
  record.status = done.status
  record.outcome = done.outcome ? oneLine(done.outcome, 160) : undefined
  record.notes = done.notes
}

export const failed = (c: CallRecord) => !!c.end && c.end !== "report"

const mins = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${Math.round(ms / 60_000)}m`)

/** The calls with their depth, a caller before the calls it asked for. */
export function callTree(calls: CallRecord[]): { call: CallRecord; depth: number }[] {
  const out: { call: CallRecord; depth: number }[] = []
  const place = (call: CallRecord, depth: number) => {
    out.push({ call, depth })
    for (const child of calls.filter((c) => c.parent === call.n)) place(child, depth + 1)
  }
  const seen = new Set(calls.map((c) => c.n))
  for (const call of calls) if (call.parent === undefined || !seen.has(call.parent)) place(call, 0)
  return out
}

export interface CallRow {
  role: WorkerRole
  depth: number
  ask: string
  state: "running" | "done" | "failed" | "cut"
  secs: number
  model?: string
  result?: string
  notes: string[]
}

/**
 * The sidebar's rows: the latest calls as a tree. `live` gives the notes of a call that is running right now;
 * a call with no end that isn't running was cut off (a restart).
 */
export function callRows(calls: CallRecord[], live: (call: CallRecord) => string[] | undefined, now = Date.now(), max = 12): CallRow[] {
  const sorted = [...calls].sort((a, b) => a.started - b.started)
  return callTree(sorted)
    .slice(-max)
    .map(({ call: c, depth }) => {
      const notes = live(c)
      const state = notes ? "running" : !c.end ? "cut" : failed(c) ? "failed" : "done"
      const result = c.end === "report" ? [c.status, c.outcome].filter(Boolean).join(": ") : c.outcome
      return {
        role: c.role,
        depth,
        ask: c.ask,
        state,
        secs: Math.round(((state === "running" ? now - c.started : c.ms) ?? 0) / 1000),
        ...(c.model && { model: c.model }),
        ...(result && state !== "running" && { result }),
        notes: notes ?? c.notes,
      }
    })
}

/** The record as plain text, for the manager to answer "what happened" and "why" from. */
export function callsText(calls: CallRecord[], task?: TaskState): string {
  if (!calls.length) return "The team has made no agent call yet."
  const lines = callTree([...calls].sort((a, b) => a.started - b.started).slice(-25)).flatMap(({ call: c, depth }) => {
    const pad = "  ".repeat(depth)
    const head = `${pad}${c.n ? `#${c.n} ` : ""}${c.role}${c.parent !== undefined ? ` (asked by #${c.parent})` : ""} · ${c.end ? mins(c.ms ?? 0) : "no end recorded"}${c.model ? ` · ${c.model}` : ""}`
    const result = c.end === "report" ? `${c.status ?? "reported"}${c.outcome ? `: ${c.outcome}` : ""}` : c.end ? `FAILED (${c.end})${c.outcome ? `: ${c.outcome}` : ""}` : "unfinished"
    return [head, `${pad}  asked: ${c.ask}`, `${pad}  result: ${result}`, ...c.notes.map((n) => `${pad}  note: ${n}`)]
  })
  const state = task ? [`Task phase: ${task.phase}.`, task.stuckReason ? `Stuck because: ${task.stuckReason}.` : "", task.pending ? `Next call: ${task.pending.mode}.` : ""].filter(Boolean).join(" ") : ""
  return [`The team's record, written by the code (not by a model):`, ...lines, state].filter(Boolean).join("\n")
}

/** Notes of the task's last call, for the progress line: what the user should know now. */
export function lastFlags(task: TaskState): string {
  const last = task.calls?.at(-1)
  if (!last?.notes.length && !(last && failed(last))) return ""
  const parts = [...(last && failed(last) ? [`${last.end}`] : []), ...(last?.notes ?? [])]
  return ` ⚠ ${last!.role}: ${parts.join("; ")}`
}
