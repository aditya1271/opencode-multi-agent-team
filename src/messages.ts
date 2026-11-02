// What the manager is told: the team tool results, the review screens and the shared text helpers.
import path from "node:path"
import { lastFlags } from "./calls.ts"
import { annotate, ensureIndex, idRanges, missingSummaries, oneLine, sectionBody, shortView, shownTitle, split, userView, walkIds, type Section, type SectionIndex } from "./sections.ts"
import { autoDecides, briefName, draftIsDoc, isDocWorkflow, MODE_ROLE, readTaskFile, type TaskState } from "./state.ts"
import { report as usageReport } from "./usage.ts"

export const fileBlock = (task: TaskState, name: string) => {
  const body = readTaskFile(task, name)
  return body ? `<file name="${name}">\n${body}\n</file>` : ""
}

export const join = (...parts: (string | undefined | false)[]) => parts.filter(Boolean).join("\n\n")

/** Titles of a plan's numbered steps: the bold lead of each top-level "N." line, else its first words. */
export const stepTitles = (plan: string): string[] =>
  plan
    .split("\n")
    .map((l) => /^(\d+)\.\s+(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .map(([, n, rest]) => {
      const bold = /^\*\*(.+?)\*\*/.exec(rest!)
      const title = bold ? bold[1]! : rest!.length > 90 ? `${rest!.slice(0, 87)}...` : rest!
      return `${n}. ${title}`
    })

/** Section titles of a document: its "## " headings, else its "# " headings. */
export const sectionTitles = (doc: string): string[] => {
  const heads = (level: string) => doc.split("\n").filter((l) => l.startsWith(level + " ")).map((l) => l.slice(level.length + 1).trim())
  const h2 = heads("##")
  return (h2.length ? h2 : heads("#")).slice(0, 20)
}

/** The body of a document's "## <title>" section (optionally numbered), or "" when it has none. */
export const section = (doc: string, title: string): string => {
  const esc = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const m = new RegExp(`^## (?:\\d+\\.\\s*)?(?:\\*\\*)?${esc}[^\\n]*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "mi").exec(doc)
  return m ? m[1]!.trim() : ""
}

/** The "## Research brief" section of Analyst's brief, else the whole brief. */
export const researchBrief = (brief: string): string => section(brief, "Research brief") || brief.trim()

/** At most `max` lines of a section shown in chat; the rest stays in the file. */
const clip = (text: string, max = 40) => {
  const lines = text.split("\n")
  return lines.length <= max ? text : `${lines.slice(0, max).join("\n")}\n… (${lines.length - max} more lines in the file)`
}

/** The Planner's current draft: research report, what-document or how-document / plan. */
export const docName = (task: TaskState) =>
  task.workflow === "research" ? "research report" : task.stage === "what" ? "what-document" : task.workflow === "plan" && !task.stage ? "plan document" : task.workflow === "plan" ? "how-document" : "plan"

/** The Planner's latest draft file in this task. */
export const draftFile = (task: TaskState) => (draftIsDoc(task) ? `doc-${task.doc}.md` : `plan-${task.plan}.md`)

/** Section ids of Analyst's brief or the Planner's latest draft, kept in the task (a new draft starts over). */
export function sectionIndex(task: TaskState, draft: "brief" | "draft"): SectionIndex | undefined {
  const kind = draft === "brief" ? "brief" : draftIsDoc(task) ? "doc" : "plan"
  if (kind !== "brief" && !(kind === "doc" ? task.doc : task.plan)) return undefined
  const text = readTaskFile(task, kind === "brief" ? briefName(task) : draftFile(task))
  if (!text) return undefined
  task.sections = ensureIndex(text, `${kind}:${task.stageRun ?? 0}`, task.sections)
  return task.sections
}

const WRITER_SCOPE = [
  "Report `sections`, not the whole draft: one entry per section you return, with `id` and `content` (the whole section, from its heading line, or for a plan step from its numbered bold line; the plugin renumbers steps). The plugin puts them into the previous version; every other section stays byte for byte.",
  "- {revise} Empty content removes a section. Several headings in one content split the section.",
  "- Return every FINE-TUNE section with only the edit the user's comments state for it; keep the rest of its text word for word.",
  '- A new section: id "new", `after` = the id it follows.',
  "- A section marked unchanged may change only when a revised section makes it wrong; give `reason` (the user sees it). FINAL sections are rejected.",
  "- `content` of the report: a few lines on what you changed.",
].join("\n")

/** The sections a revision may change, for the writer (and for Analyst's revision brief). */
export function scopeText(task: TaskState, writer: boolean): string {
  const idx = task.sections
  const s = task.scope
  if (!idx || !s) return ""
  const what = (id: string) =>
    idx.final.includes(id)
      ? "FINAL (signed off by the user; never change it)"
      : s.finetune.includes(id)
        ? "FINE-TUNE (only the exact edit the user stated)"
        : s.revise.includes(id)
          ? "REVISE (rework the substance)"
          : "unchanged this round"
  return join(
    "Scope of this revision (set from the user's comments; the plugin enforces it). Sections of the current draft:",
    idx.ids.map((id, i) => `- ${id} ${idx.titles[i]}: ${what(id)}`).join("\n"),
    s.add.length > 0 && `New sections the user asked for: ${s.add.join("; ")}.`,
    writer && WRITER_SCOPE.replace("{revise}", s.open ? "Return only the REVISE sections you change." : "Return every REVISE section."),
    writer && s.open && !idx.final.length && "Nothing is final: you may report the whole revised draft in `content` instead.",
  )
}

/** How a writer reports its revision: the whole draft, or only the sections in scope. */
export const reviseAs = (task: TaskState, status: string, what: string) =>
  task.scope && task.sections ? `report ${status} with the revised sections only (see the scope)` : `report ${status} with the whole revised ${what}`

/** The draft's sections (or only its plan steps) with their ids, one per line; "" when it has none. */
function idList(task: TaskState, text: string, steps: boolean): string {
  const idx = sectionIndex(task, "draft")
  if (!idx) return ""
  const lines = split(text)
    .sections.map((s, i) => ({ s, id: idx.ids[i]! }))
    .filter(({ s }) => s.step === steps)
    .map(({ s, id }) => {
      const line = oneLine(s)
      return `- ${id} ${s.title}${idx.final.includes(id) ? " ✅" : ""}${line ? `: ${line}` : ""}`
    })
  return clip(lines.join("\n"), 40)
}

/** What the last revision changed and which sections are final, with how to mark them, for the user. */
function changeLine(task: TaskState, hint = true): string {
  const c = task.sectionChange
  const final = task.sections?.final ?? []
  return join(
    c &&
      `**This version:** ${[
        c.revised.length && `revised ${idRanges(c.revised)}`,
        c.tuned?.length && `fine-tuned ${idRanges(c.tuned)}`,
        c.added.length && `new ${idRanges(c.added)}`,
        c.removed.length && `removed ${idRanges(c.removed)}`,
        ...c.also.map((a) => `also changed ${a.id} (${a.reason})`),
      ]
        .filter(Boolean)
        .join(" · ") || "no section changed"}`,
    final.length > 0 && `**Final:** ${idRanges(final)}`,
    hint &&
    !!task.sections?.ids.length &&
      `Mark sections you're happy with as **final** (e.g. "S3–S6 are final"). Final sections stay exactly as they are until you **reopen** them.`,
  )
}

const SCOPE_RULE = [
  'Every section shows its id (S5; ✅ = final). When you polish comments for "change", start with a scope line from those ids, deciding per section:',
  '**Fine-tune:** the user states the exact edit (reword, rename, add or drop a named point, fix a value); give the edit in brackets, e.g. "S4 (rename glossary to lexicon)" · **Revise:** they are unhappy with the substance (coverage, approach, "think more about this", a vague complaint) · **Final:** sections they call good, done or fine · **Reopen:** final sections they now want changed · **New:** sections they ask to add · **Unchanged this round:** the rest.',
  'When unsure whether a comment is a fine-tune, make it Revise. Comments on the whole draft: list every section that isn\'t final under Revise. Then call team "change" with the polished comments as text and finetune, revise, final, reopen (ids) and add (short titles).',
  'A reply that only marks sections final or reopens them (no other comments) needs no confirmation: call team "change" with only final and reopen.',
].join(" ")


/** Where a plan task's how-document goes: next to the what-document. */
export const howOutput = (output: string) => {
  const ext = path.extname(output)
  return `${output.slice(0, output.length - ext.length)}.how${ext || ".md"}`
}

// ---- what the manager gets back ----

const DETAILS_ROUTE =
  'a request for details, the full text or "more" (of the whole draft or of sections) → team "details", with ids = the section ids if they named some (no confirmation; no agent runs)'

const REPLY_ROUTES = `a clear approval ("approve", "go ahead") → team "approve"; a clear stop → team "stop"; feedback, requests for changes or more work → polish it, then team "change"; a question → polish it, then team "ask"; ${DETAILS_ROUTE}; a request for a (critical) review → team "review", with what the review should look at as text if they said.`

/** Architect's review shown at approval, marked when the plan or document was revised after it. */
function adviceLine(task: TaskState): string {
  return task.lastAdvice ? `**Revised following ${task.lastAdvice.role}'s advice** (${path.join(task.dir, task.lastAdvice.file)})` : ""
}

function architectBlock(task: TaskState): string {
  if (!task.architectNote) return ""
  const verdict = task.history.find((h) => h.file === task.architectNote)?.status
  const title = verdict === "CHANGES" ? "**Architect's review** (this version was revised to address it)" : "**Architect's notes**"
  return `${title}\n${readTaskFile(task, task.architectNote)}`
}

export function render(task: TaskState): string {
  const review = (task.phase === "brief" || task.phase === "approval") && !autoDecides(task)
  return review && task.phase === "approval" && task.stepFix?.waiting ? stepFixView(task, task.stepFix) : review ? reviewView(task) : renderPhase(task)
}

/** A step fix waiting on the user: one line, and the new step text when it is destructive or irreversible. */
function stepFixView(task: TaskState, sf: NonNullable<TaskState["stepFix"]>): string {
  const steps = split(readTaskFile(task, `plan-${task.plan}.md`)).sections.filter((s) => s.step)
  const changed = steps.slice(sf.from - 1, sf.to)
  const which = sf.to > sf.from ? `Steps ${sf.from}-${sf.to} replace step ${sf.from}` : `Step ${sf.from} changed`
  const block = join(
    `**${which}** (plan ${task.plan}): ${sf.summary}`,
    sf.risk && join("**Risk: yes** (destructive or irreversible). The new step text:", changed.map((s) => s.text.trim()).join("\n\n")),
    task.auto === "safe" && sf.risk && "**Safe auto stopped here:** the change is destructive or irreversible, so it needs your approval.",
    `**Plan file:** ${path.join(task.dir, `plan-${task.plan}.md`)}`,
  )
  return join(
    `STEP FIX ready for approval: Developer was blocked on step ${sf.from}, and the Planner changed that step instead of writing a new plan. Show this block to the user exactly as written, without rewording or shortening it:`,
    `<show>\n${block}\n</show>`,
    `NEXT ACTION: show the block above and end with one line: "Reply to approve (Developer carries on at step ${sf.from}), change or stop it, or ask about it or for details." No buttons. Then act on the user's reply: ${REPLY_ROUTES}`,
  )
}

const SECTION_ROUTES =
  'Then act on the reply: "ok", "fine", "looks good" → team "section" with verdict "ok" (no confirmation); "skip" → verdict "skip"; a comment → polish it, then team "section" with verdict "finetune" (the user states the exact edit; give it in text) or "revise" (unhappy with the substance; when unsure, revise) and text = the polished comment; a question → polish it, then team "ask" (the same section comes back after the answer); "details" or "more" → team "details" with ids = [the id of this section] (the same section stays open); "show the rest" or "all at once" → verdict "rest"; a clear stop → team "stop".'

/** The draft the user reviews now: the brief, or the latest document or plan. */
function reviewDraft(task: TaskState): { text: string; idx?: SectionIndex; under?: string } {
  const brief = task.phase === "brief"
  const text = readTaskFile(task, brief ? briefName(task) : draftFile(task))
  return { text, idx: sectionIndex(task, brief ? "brief" : "draft"), under: brief ? (task.workflow === "research" ? "Research brief" : "Concept brief") : undefined }
}

/** The sections a walk-through would go through now. */
export function walkable(task: TaskState): string[] {
  const { text, idx, under } = reviewDraft(task)
  return idx ? walkIds(text, idx, under) : []
}

/** A brief, document or plan waiting on the user: the walk-through, or the whole draft with the review style. */
function reviewView(task: TaskState): string {
  const w = task.walk?.key === task.sections?.key ? task.walk : undefined
  if (w?.dialog && !w.dialog.end) return dialogOpen(task)
  if (w?.dialog && w.dialog.end !== "rest") return dialogView(task, w)
  if (w && !w.rest && !w.done && w.at < w.ids.length) return walkSection(task, w)
  if (w?.done) {
    const { text, idx, under } = reviewDraft(task)
    // A brief's sections outside its top heading (the excerpts).
    const inBrief = under && idx ? walkIds(text, { ...idx, final: [] }, under) : []
    const extra = !under || !idx ? [] : split(text).sections
      .map((s, i) => ({ s, id: idx.ids[i]! }))
      .filter(({ s, id }) => !inBrief.includes(id) && s.text.split("\n").slice(1).join("\n").trim())
      .map(({ s, id }) => `${id} ${shownTitle(s.title)}`)
    return join(
      `ALL SECTIONS ACCEPTED: ${idRanges(w.ids)} ${w.ids.length > 1 ? "are" : "is"} marked final.`,
      extra.length ? `Not gone through (supporting material, shown on request): ${extra.join("; ")}.` : "",
      `NEXT ACTION: tell the user in one line, then ask with the question tool: [Approve] [Show it all at once]. Approve → team "approve". Show it all at once → team "section" with verdict "rest".`,
    )
  }
  const full = renderPhase(task)
  if (w?.rest) {
    const kept = w.replies.filter((r) => r.verdict === "finetune" || r.verdict === "revise").map((r) => `${r.id} (${r.verdict === "finetune" ? "fine-tune" : "revise"})`)
    const ok = w.replies.filter((r) => r.verdict === "ok").map((r) => r.id)
    const d = w.dialog
    return join(
      full,
      kept.length || ok.length
        ? `From the walk-through: ${[ok.length && `ok ${idRanges(ok)}`, kept.length && `comments on ${kept.join(", ")}`].filter(Boolean).join("; ")}. They are kept and sent with the user's next comments ("change"); approving drops the comments.`
        : "",
      d?.questions.length ? `The user's questions from the review dialog (as typed):\n${notesList(task, d.questions)}\nAfter showing the draft, call team "ask" once with all of them, each starting with its section id, and show the answers.` : "",
      d?.comments.length
        ? `The user's comments from the review dialog (as typed):\n${notesList(task, d.comments)}\nThey go with the user's next comments: polish both together into the one "change" (finetune = sections where the user states the exact edit, revise = the others). Approving drops them.`
        : "",
    )
  }
  return styleView(task) || full
}

/** The review-style question shown before a draft (or the direct start with reviewStyle "sections"); empty when the whole draft shows at once. */
export function styleView(task: TaskState): string {
  const style = task.reviewStyle ?? "ask"
  const n = walkable(task).length
  if (style === "all" || !n) return ""
  // The draft itself comes with the next call, so the review style is always chosen first.
  if (style === "sections") return 'REVIEW ONE SECTION AT A TIME (config reviewStyle). NEXT ACTION: call team "section" with verdict "start" right away.'
  return join(
    `${draftTitle(task)} ready: ${n} section${n > 1 ? "s" : ""} to review.`,
    'NEXT ACTION: tell the user in one line, then ask with the question tool how to review it: [All at once] [One section at a time]. All at once → team "section" with verdict "rest". One section at a time → team "section" with verdict "start". Follow the NEXT ACTION of that result.',
  )
}

/** The draft waits in the review dialog: the manager only points the user to it. */
export function dialogOpen(task: TaskState): string {
  const n = task.walk?.ids.length ?? 0
  return join(
    `REVIEW READY IN THE DIALOG: ${draftTitle(task)}, ${n} section${n === 1 ? "" : "s"}. It opens on its own in a terminal showing this session; the user opens or reopens it with "Review" in the Team sidebar or /team-review, and closing it keeps their progress. You are woken when they finish.`,
    'NEXT ACTION: tell the user in one line that the review is ready in the dialog ("Review" in the Team sidebar, or /team-review), then end your turn. Call no tool. Only if the user asks to review in the chat: team "section" with verdict "start"; to see it all at once: verdict "rest".',
  )
}

const notesList = (task: TaskState, notes: { id: string; text: string }[]) => {
  const idx = task.sections
  return notes.map((n) => `- ${n.id} ${idx ? shownTitle(idx.titles[idx.ids.indexOf(n.id)] ?? "").replace(/^#+\s*/, "") : ""}: ${n.text}`).join("\n")
}

/** What the manager does after the review dialog: answer the questions, then polish and send the comments. */
export function dialogView(task: TaskState, w: NonNullable<TaskState["walk"]>): string {
  const d = w.dialog!
  if (d.end === "stop") return 'The user chose Stop in the review dialog.\nNEXT ACTION: call team with action "stop".'
  if (d.end === "approve") return `The user went through every section of the ${draftTitle(task).toLowerCase()} and approved it in the review dialog.\nNEXT ACTION: call team with action "approve".`
  const ok = w.replies.filter((r) => r.verdict === "ok").map((r) => r.id)
  const skipped = w.replies.filter((r) => r.verdict === "skip").map((r) => r.id)
  const steps: string[] = []
  if (d.questions.length) steps.push('call team "ask" once with all the questions, each starting with its section id; show the answers')
  if (d.comments.length)
    steps.push(
      'polish the comments (one paragraph per section, keeping the user\'s meaning); then call team "change" with text = the polished comments, finetune = sections where the user states the exact edit, revise = the others (when unsure, revise). If the answers settle a comment, the user may drop it',
    )
  else
    steps.push(
      'ask the user with the question tool: [Approve] [Comment] [Show it all at once]. Approve → team "approve". Comment → take the comment as free text, polish it, then team "change". Show it all at once → team "section" with verdict "rest"',
    )
  return join(
    `REVIEW DIALOG FINISHED: ${draftTitle(task)}. ${[ok.length && `ok ${idRanges(ok)}`, skipped.length && `skipped ${idRanges(skipped)}`].filter(Boolean).join("; ") || "No section marked ok"}.`,
    d.questions.length ? `Questions (as typed):\n${notesList(task, d.questions)}` : "",
    d.comments.length ? `Comments (as typed):\n${notesList(task, d.comments)}` : "",
    `NEXT ACTION: ${steps.map((s, i) => (steps.length > 1 ? `${i + 1}. ${s}.` : `${s}.`)).join(" ")}`,
  )
}

/** The draft's sections for the review dialog, and what shows above the first one. */
export function dialogData(task: TaskState): { title: string; intro: string; ask: boolean; sections: { id: string; title: string; summary?: string; body: string }[] } {
  const { text, idx } = reviewDraft(task)
  const all = split(text).sections
  const sections = walkable(task).map((id) => {
    const s = all[idx?.ids.indexOf(id) ?? -1]
    if (!s) return { id, title: "?", body: "(section not found; see the file)" }
    const summary = userView(s)
    // The RPC output check rejects `summary: undefined`; leave the key out instead.
    return { id, title: shownTitle(s.title).replace(/^#+\s*/, ""), ...(summary !== undefined && { summary }), body: fullBody(s) }
  })
  const intro = join(
    task.phase === "approval" && !draftIsDoc(task) ? `**Risk:** ${task.planRisk ? "yes (destructive or irreversible steps)" : "no"}` : "",
    changeLine(task, false),
    architectBlock(task),
    adviceLine(task),
  )
  return { title: draftTitle(task), intro, ask: (task.reviewStyle ?? "ask") === "ask", sections }
}

/** A section's full text under its title (a step: its purpose, then the details). */
const fullBody = (s: Section) => (s.step ? join(userView(s), sectionBody(s)) : sectionBody(s))

/** The stored full text of the waiting draft, or of some of its sections: no agent runs. */
export function detailsView(task: TaskState, ids: string[] = []): string {
  if (task.phase !== "brief" && task.phase !== "approval") return join('"details" applies only while a brief, document or plan waits on the user.', render(task))
  const { text, idx } = reviewDraft(task)
  const want = [...new Set(ids.map((x) => x.trim().toUpperCase()).filter(Boolean))]
  const unknown = want.filter((id) => !idx?.ids.includes(id))
  if (unknown.length) return `No section ${unknown.join(", ")} in the waiting draft. Its sections: ${idx ? idRanges(idx.ids) : "(none)"}.\nNEXT ACTION: call team "details" again with ids from that list, or without ids for the whole draft.`
  const all = split(text).sections
  const shown = want.length
    ? want
        .map((id) => {
          const s = all[idx!.ids.indexOf(id)]!
          return join(`**${id} · ${shownTitle(s.title).replace(/^#+\s*/, "")}**`, fullBody(s))
        })
        .join("\n\n")
    : idx
      ? annotate(text, idx)
      : text
  return join(
    `FULL TEXT of the ${draftTitle(task).toLowerCase()}${want.length ? `, ${want.join(", ")}` : ""} (from the stored draft; no agent ran). Show this block to the user exactly as written:`,
    `<show>\n${shown}\n</show>`,
    "NEXT ACTION: show the block above. The draft still waits on the user: end with the same reply line as before (the section under review stays open) and act on their reply as the previous result said.",
  )
}

/** "Concept brief", "What-document (version 2)", "Plan (plan 3)". */
export function draftTitle(task: TaskState): string {
  if (task.phase === "brief") return `${task.workflow === "research" ? "Research" : "Concept"} brief`
  const name = docName(task)
  return `${name[0]!.toUpperCase()}${name.slice(1)}${draftIsDoc(task) ? ` (version ${task.doc})` : ` (plan ${task.plan})`}`
}

function walkSection(task: TaskState, w: NonNullable<TaskState["walk"]>): string {
  const { text, idx } = reviewDraft(task)
  const id = w.ids[w.at]!
  const s = split(text).sections[idx?.ids.indexOf(id) ?? -1]
  const first = w.at === 0 && !w.replies.length
  const head = first
    ? join(
        task.phase === "approval" && !draftIsDoc(task) ? `**Risk:** ${task.planRisk ? "yes (destructive or irreversible steps)" : "no"}` : "",
        changeLine(task, false),
        architectBlock(task),
        adviceLine(task),
      )
    : ""
  const short = s && userView(s)
  const body = s ? (short ?? sectionBody(s)) : "(section not found; see the file)"
  const block = join(head, `**${draftTitle(task)}, ${id} · ${s ? shownTitle(s.title).replace(/^#+\s*/, "") : "?"}** (${w.at + 1} of ${w.ids.length})`, body)
  return join(
    `SECTION ${w.at + 1} OF ${w.ids.length}. Show this block to the user exactly as written, without rewording or shortening it:`,
    `<show>\n${block}\n</show>`,
    `NEXT ACTION: show the block above and end with one line: "Reply ok, comment on it, ask about it${short ? ", ask for details" : ""}, skip it, or say show the rest." No buttons. ${SECTION_ROUTES}`,
  )
}

/** What a phase's message draws on besides the task: its last step, the changed files, the usage report. */
interface Progress {
  task: TaskState
  lastLine: string
  files: string
  attempts: string
  usage: () => string
  decided: string
}

function renderPhase(task: TaskState): string {
  const last = task.history[task.history.length - 1]
  const lastLine = `${last ? `${last.role} → ${last.status}: ${last.summary.split("\n")[0].replace(/[.\s]+$/, "")}` : "started"}${lastFlags(task)}`
  const files = task.editedFiles.length ? task.editedFiles.map((f) => `- ${f}`).join("\n") : "(none)"
  const attempts = `Failed attempts: ${task.attempts}/${task.attemptLimit}.`
  const usage = () => usageReport(task.usage, Math.max(1, task.planSteps))
  if (autoDecides(task)) {
    const next =
      task.phase === "checks"
        ? "skip build and test"
        : task.phase === "questions"
          ? `answer ${MODE_ROLE[task.questionsFrom ?? "analyst"]}'s questions with the recommended options`
          : task.phase === "brief"
            ? "approve the brief"
            : `approve the ${draftIsDoc(task) ? docName(task) : "plan"}`
    return `PROGRESS: ${lastLine}. Next, on ${task.auto} auto: ${next}. ${attempts}\nNEXT ACTION: show this progress line to the user in one line, then call team with action "continue".`
  }
  const decided = task.autoLog?.length ? `**Decided on auto:**\n${task.autoLog.map((l) => `- ${l}`).join("\n")}` : ""
  const h: Progress = { task, lastLine, files, attempts, usage, decided }
  switch (task.phase) {
    case "running":
      return runningView(h)
    case "checks":
      return checksView(h)
    case "questions":
      return questionsView(h)
    case "brief":
      return briefView(h)
    case "approval":
      return approvalView(h)
    case "stuck":
      return stuckView(h)
    case "budget":
      return budgetView(h)
    case "done":
      return doneView(h)
    case "stopped":
      return stoppedView(h)
  }
}

function runningView(h: Progress): string {
  const { task, lastLine, attempts } = h
  const progress =
    task.pending?.mode === "fix" ? ` Next: developer, step ${task.step} of ${task.planSteps}.` : task.pending ? ` Next: ${MODE_ROLE[task.pending.mode]} (${task.pending.mode}).` : ""
  return `PROGRESS: ${lastLine}.${progress} ${attempts}\nNEXT ACTION: show this progress line to the user in one line, then call team with action "continue".`
}

function checksView(_h: Progress): string {
  return join(
    "No build or test commands are configured for this project (checks.build / checks.test).",
    `NEXT ACTION: ask the user [Skip build/test] [Give commands] [Stop]. Skip → team "answer" with text "skip". Give commands → ask for the build and test commands as free text, then team "answer" with them word for word. Stop → team "stop".`,
  )
}

function questionsView(h: Progress): string {
  const { task } = h
  return join(
    `QUESTIONS from ${task.questionsFrom ? MODE_ROLE[task.questionsFrom] : "an agent"}:`,
    (task.questions ?? []).map((q, i) => `${i + 1}. ${q}`).join("\n"),
    `NEXT ACTION: ask the user these questions as free text (no fixed options). Polish their answer, then call team with action "answer" and the polished answer. If they ask something back instead, polish it, then call team with action "ask".`,
  )
}

function briefView(h: Progress): string {
  const { task } = h
  const research = task.workflow === "research"
  const raw = readTaskFile(task, "brief.md")
  const idx = sectionIndex(task, "brief")
  const brief = shortView(idx ? annotate(raw, idx) : raw, research ? "Research brief" : "Concept brief")
  const title = research ? `**Research brief** (${task.depth ?? "?"} research)` : "**Concept brief**"
  const shown = research ? researchBrief(brief) : section(brief, "Concept brief") || brief
  return join(
    `${research ? "RESEARCH" : "CONCEPT"} BRIEF ready. Show this block to the user exactly as written:`,
    `<show>\n${join(title, shown, changeLine(task), adviceLine(task))}\n</show>`,
    `NEXT ACTION: show the block above and end with one line: "${research ? "Reply to start the research" : "Reply to have the what-document written"}, adjust the brief, ask for details, or stop." No buttons. Then act on the reply: a clear go ("go", "looks good") → team "approve"; a clear stop → team "stop"; adjustments → polish it, then team "change"; a question → polish it, then team "ask"; ${DETAILS_ROUTE}.`,
    idx && SCOPE_RULE,
  )
}

function approvalView(h: Progress): string {
  const { task, decided } = h
  const name = docName(task)
  const Name = `${name[0]!.toUpperCase()}${name.slice(1)}`
  if (draftIsDoc(task)) {
    const doc = readTaskFile(task, `doc-${task.doc}.md`)
    const research = task.workflow === "research"
    // With summaries, the section list carries each section's direction; the details are on request.
    const long = missingSummaries(doc).length > 0
    const decisions = long && !research && section(doc, "Decisions")
    const findings = long && research && section(doc, "Key findings")
    const conflicts = long && research && section(doc, "Conflicts")
    const block = join(
      `**${Name}** (version ${task.doc})`,
      `**What you get**\n${task.docSummary ?? "(no summary)"}`,
      task.infeasible && `**The how stage found a decision that can't work** (${task.infeasible})\n${clip(readTaskFile(task, task.infeasible), 30)}`,
      decisions ? `**Decisions**\n${clip(decisions)}` : "",
      findings ? `**Key findings**\n${clip(findings)}` : "",
      conflicts ? `**Conflicts between sources**\n${clip(conflicts, 20)}` : "",
      `**Sections**\n${idList(task, doc, false) || sectionTitles(doc).map((t) => `- ${t}`).join("\n") || "(none)"}`,
      changeLine(task),
      architectBlock(task),
      adviceLine(task),
      `**File:** ${task.output ?? path.join(task.dir, `doc-${task.doc}.md`)}`,
    )
    const reply =
      task.stage === "what"
        ? task.infeasible
          ? "Reply with how to change the what-document, approve it as it is (the team plans again), stop, ask about it or for details, or have Architect review it."
          : "Reply to approve the behaviour (the team then plans the change), change or stop it, ask about it or for details, or have Architect review it."
        : "Reply to approve, change or stop it, ask about it or for details, or have Architect review it."
    return join(
      `${name.toUpperCase()} ready for the user. Show this block to the user exactly as written, without rewording or shortening it:`,
      `<show>\n${block}\n</show>`,
      `NEXT ACTION: show the block above and end with one line: "${reply}" No buttons. Then act on the user's reply: ${REPLY_ROUTES}`,
      task.sections && SCOPE_RULE,
    )
  }
  const planText = readTaskFile(task, `plan-${task.plan}.md`)
  const howDoc = task.workflow === "plan" && task.output ? howOutput(task.output) : undefined
  const steps = idList(task, planText, true)
  const titles = steps ? [steps] : stepTitles(planText)
  const others = idList(task, planText, false)
  const behaviour = (!others || missingSummaries(planText).length > 0) && section(planText, "Behaviour")
  const block = join(
    `**${howDoc ? `${Name} (plan ${task.plan})` : `Plan ${task.plan}`}**`,
    `**What you get**\n${task.planSummary ?? "(no summary)"}`,
    behaviour ? `**Behaviour**\n${clip(behaviour, 20)}` : "",
    `**Steps**\n${titles.length ? titles.join("\n") : `${task.planSteps} step(s); see the plan file.`}`,
    others && `**Other sections**\n${others}`,
    `**Risk:** ${task.planRisk ? "yes (destructive or irreversible steps)" : "no"}`,
    changeLine(task),
    architectBlock(task),
    task.auto === "safe" && task.planRisk && "**Safe auto stopped here:** this plan has destructive or irreversible steps, so it needs your approval.",
    decided,
    adviceLine(task),
    `**Plan file:** ${howDoc ?? path.join(task.dir, `plan-${task.plan}.md`)}`,
  )
  return join(
    `PLAN ${task.plan} ready for approval. Show this block to the user exactly as written, without rewording or shortening it:`,
    `<show>\n${block}\n</show>`,
    `NEXT ACTION: show the block above and end with one line: "${howDoc ? "Reply to approve (then you can implement it)" : "Reply to approve"}, change or stop the plan, ask about it or for details, or have Architect review it." No buttons. Then act on the user's reply: ${REPLY_ROUTES}`,
    task.sections && SCOPE_RULE,
  )
}

function stuckView(h: Progress): string {
  const { task, files, attempts, usage, decided } = h
  return join(
    `STUCK: ${task.stuckReason}`,
    `What was tried: ${task.plan} plan(s), ${task.planFailures} plan failure(s), round ${task.rounds} on step ${task.step}.`,
    lastErrors(task),
    decided,
    `Files changed so far (kept, not reverted):\n${files}`,
    usage(),
    attempts,
    `NEXT ACTION: show this to the user and ask [Retry] [Stop]. Retry → team "retry" (runs the agent once more in a fresh session). Stop → team "stop".`,
  )
}

function budgetView(h: Progress): string {
  const { task, lastLine, files, usage, decided } = h
  return join(
    task.budgetReason === "calls"
      ? `AGENT CALL LIMIT REACHED: ${task.agentCalls ?? 0} agent calls (runaway guard; failed attempts ${task.attempts}/${task.attemptLimit}). Last: ${lastLine}.`
      : `ATTEMPT BUDGET USED UP: ${task.attempts} failed attempts (failed steps, work sent back, broken agent calls). Last: ${lastLine}.`,
    task.pending ? `Left to do: ${task.pending.mode}${task.planSteps ? `, step ${task.step} of ${task.planSteps}` : ""}.` : "",
    `Files changed so far:\n${files}`,
    decided,
    usage(),
    `NEXT ACTION: show this to the user and ask [${task.budgetReason === "calls" ? "Continue +25 calls" : "Continue +5 attempts"}] [Stop]. Continue → team "extend". Stop → team "stop".`,
  )
}

function doneView(h: Progress): string {
  const { task, lastLine, files, usage, decided } = h
  if (isDocWorkflow(task))
    return join(
      task.workflow === "plan" && task.stage === "how" && task.output
        ? `DONE: the plan is approved. What-document: ${task.output}${task.plan ? `\nHow-document: ${howOutput(task.output)}` : ""}`
        : `DONE: the ${docName(task)} is approved: ${task.output}`,
      task.workflow === "plan" && task.stage === "how" ? task.planSummary : task.docSummary,
      decided,
      usage(),
      `Task folder: ${task.dir}`,
      task.workflow === "plan"
        ? `NEXT ACTION: tell the user the result, then ask with the question tool: [Implement it] [Done]. Implement it → team "implement" (it switches to build-manager and starts the code task; follow its NEXT ACTION). Done → stop. If the user later says "implement it", do the same.`
        : `NEXT ACTION: tell the user the result. A follow-up question on this report → polish it, then team "start" with output "${task.output}", so the answer is appended to the report.`,
    )
  return join(
    `DONE: ${task.doneSummary ?? lastLine}`,
    task.skipChecks ? "Not built or tested: build and test were skipped." : "",
    `Changed files:\n${files}`,
    decided,
    usage(),
    `Task folder: ${task.dir}`,
    "NEXT ACTION: tell the user the result. The task is finished.",
  )
}

function stoppedView(h: Progress): string {
  const { task, files, usage } = h
  return join(
    isDocWorkflow(task)
      ? `STOPPED: task ${task.id}.${task.doc ? ` The latest ${docName(task)} is at ${task.output}.` : ""}`
      : `STOPPED: task ${task.id}. Files already edited stay as they are; nothing was reverted.`,
    `Files changed:\n${files}`,
    usage(),
    "NEXT ACTION: tell the user. They can resume it later (team \"resume\").",
  )
}


function lastErrors(task: TaskState): string {
  const lastFail = [...task.history].reverse().find((h) => ["FAILED", "BLOCKED", "REPLAN", "ESCALATE", "ISSUES"].includes(h.status))
  return lastFail ? `Last problem (${lastFail.role}, ${lastFail.status}): ${lastFail.summary}` : ""
}
