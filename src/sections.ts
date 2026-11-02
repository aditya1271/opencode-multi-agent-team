// Drafts in sections: each heading (and each numbered step under a "Steps" heading) starts one.
// Sections keep their id (S1, S2, …) across versions, so a revision can replace some and keep the rest byte for byte.

export interface Section {
  title: string
  text: string
  step: boolean
  /** Index of its first line in the text it was split from. */
  line?: number
  /** What it is for, set when split (see `kindOf`). */
  kind?: Kind
}

/** The section ids of the current draft, and the ones the user marked final. */
export interface SectionIndex {
  /** Which draft these ids belong to (kind and stage run); a new draft starts over. */
  key: string
  ids: string[]
  titles: string[]
  next: number
  final: string[]
}

/** One section a writer returns in a scoped revision. */
export interface SectionEdit {
  /** An existing id, or "new". */
  id: string
  /** The whole section from its heading line; empty removes it. */
  content: string
  /** Why a section outside the revision scope changed. */
  reason?: string
  /** For "new": the id it follows (default: the end). */
  after?: string
}

/** What a revision may touch: set from the user's comments. */
export interface Scope {
  draft: "brief" | "draft"
  revise: string[]
  /** Sections that get only the exact edit the user stated. */
  finetune: string[]
  add: string[]
  /** Revise sections may be left out (every section not final is open, not all must change). */
  open?: boolean
}

export interface SectionChange {
  revised: string[]
  tuned: string[]
  added: string[]
  removed: string[]
  also: { id: string; reason: string }[]
}

const HEADING = /^(#{1,6})\s+(.+?)\s*$/
const STEP = /^\d+\.\s+\*\*(.+?)\*\*/
const FENCE = /^\s*(```|~~~)/

/** A title without numbering, emphasis or id tag, for matching sections across versions. */
const plain = (title: string) =>
  title
    .replace(/\s*\[S\d+(?: ✅)?\]\s*$/, "")
    .replace(/^\d+\.\s*/, "")
    .replace(/\*\*/g, "")
    .trim()
    .toLowerCase()

export function split(text: string, inSteps = false): { head: string; sections: Section[] } {
  const head: string[] = []
  const parts: { title: string; lines: string[]; step: boolean; line: number }[] = []
  let fence = false
  let steps = inSteps
  text.split("\n").forEach((line, i) => {
    const h = !fence && HEADING.exec(line)
    const s = !fence && !h && steps && STEP.exec(line)
    if (FENCE.test(line)) fence = !fence
    if (h) {
      steps = /^steps\b/.test(plain(h[2]!))
      parts.push({ title: h[2]!, lines: [line], step: false, line: i })
    } else if (s) parts.push({ title: line.replace(/^(\d+\.\s+)\*\*(.+?)\*\*.*$/, "$1$2"), lines: [line], step: true, line: i })
    else (parts.at(-1)?.lines ?? head).push(line)
  })
  return { head: head.join("\n"), sections: withKinds(parts.map((p) => ({ title: p.title, text: p.lines.join("\n"), step: p.step, line: p.line }))) }
}

const assemble = (head: string, texts: string[]) => [...(head ? [head] : []), ...texts].join("\n")

/** Ids for a whole new version: a section with the title of an earlier one keeps its id (and final mark). */
export function indexOf(text: string, key: string, prev?: SectionIndex): SectionIndex {
  const { sections } = split(text)
  const old = new Map<string, string>()
  if (prev) prev.titles.forEach((t, i) => old.has(plain(t)) || old.set(plain(t), prev.ids[i]!))
  let next = prev?.next ?? 1
  const used = new Set<string>()
  const ids = sections.map((s) => {
    const id = old.get(plain(s.title))
    if (id && !used.has(id)) {
      used.add(id)
      return id
    }
    return `S${next++}`
  })
  return { key, ids, titles: sections.map((s) => s.title), next, final: (prev?.final ?? []).filter((id) => used.has(id)) }
}

/** The index for this text, reusing `prev` while it still matches the text's sections. */
export function ensureIndex(text: string, key: string, prev?: SectionIndex): SectionIndex {
  // State saved before "final" replaced "locked".
  if (prev && !prev.final) prev.final = (prev as { locked?: string[] }).locked ?? []
  const same = prev?.key === key ? prev : undefined
  if (same && split(text).sections.length === same.ids.length) return same
  return indexOf(text, key, same)
}

/** Problems with a scoped revision's sections; empty when it can be applied. */
export function checkEdits(index: SectionIndex, scope: Scope, edits: SectionEdit[] | undefined, text: string): string[] {
  const errors: string[] = []
  if (!edits?.length) return ["Report `sections` with the sections you revised (the scope lists them)."]
  const { sections } = split(text)
  const seen = new Set<string>()
  for (const e of edits) {
    if (e.id !== "new") {
      if (seen.has(e.id)) errors.push(`${e.id} is returned twice.`)
      seen.add(e.id)
    }
    const at = index.ids.indexOf(e.id)
    if (e.id !== "new" && at < 0) errors.push(`${e.id} is not a section of the draft.`)
    else if (index.final.includes(e.id)) errors.push(`${e.id} is final (the user signed it off); leave it out.`)
    else if (e.id !== "new" && !scope.revise.includes(e.id) && !scope.finetune.includes(e.id) && !e.reason?.trim())
      errors.push(`${e.id} is outside the revision scope: leave it out, or give a reason (the user sees it).`)
    if (e.id === "new" && e.after && !index.ids.includes(e.after)) errors.push(`after: ${e.after} is not a section of the draft.`)
    if (e.id === "new" && !e.content.trim()) errors.push(`A new section needs content.`)
    if (e.content.trim()) {
      const step = e.id === "new" ? !!(e.after && sections[index.ids.indexOf(e.after)]?.step) : !!sections[at]?.step
      const parsed = split(e.content.trim(), step)
      if (parsed.head.trim() || !parsed.sections.length)
        errors.push(`${e.id}: content must start with the section's ${step ? "numbered bold step line" : "heading line"}.`)
    }
  }
  const missing = [...(scope.open ? [] : scope.revise), ...scope.finetune].filter((id) => !seen.has(id))
  if (missing.length) errors.push(`Return every section in the revision scope (empty content removes one); missing: ${missing.join(", ")}.`)
  if (scope.add.length && !edits.some((e) => e.id === "new")) errors.push(`The user asked for new sections (${scope.add.join("; ")}): add them with id "new".`)
  return errors
}

/** Applies a checked scoped revision to the previous version. */
export function splice(text: string, index: SectionIndex, edits: SectionEdit[], finetune: string[] = []): { text: string; index: SectionIndex; change: SectionChange } {
  const { head, sections } = split(text)
  let next = index.next
  type Chunk = { id: string; text: string; step: boolean }
  const chunks: Chunk[] = sections.map((s, i) => ({ id: index.ids[i]!, text: s.text, step: s.step }))
  const change: SectionChange = { revised: [], tuned: [], added: [], removed: [], also: [] }
  const trailing = (t: string) => /\n*$/.exec(t)![0]
  const parts = (content: string, step: boolean, keepId: string | undefined, end: string): Chunk[] =>
    split(content.trim(), step).sections.map((s, i) => {
      const id = i === 0 && keepId ? keepId : `S${next++}`
      if (!keepId || i > 0) change.added.push(id)
      return { id, text: s.text.replace(/\n+$/, "") + end, step: s.step }
    })
  for (const e of edits.filter((x) => x.id !== "new")) {
    const at = chunks.findIndex((c) => c.id === e.id)
    if (at < 0) continue
    const old = chunks[at]!
    if (!e.content.trim()) {
      chunks.splice(at, 1)
      change.removed.push(e.id)
      continue
    }
    chunks.splice(at, 1, ...parts(e.content, old.step, e.id, trailing(old.text)))
    if (e.reason?.trim()) change.also.push({ id: e.id, reason: e.reason.trim() })
    else (finetune.includes(e.id) ? change.tuned : change.revised).push(e.id)
  }
  for (const e of edits.filter((x) => x.id === "new")) {
    const at = e.after ? chunks.findIndex((c) => c.id === e.after) : -1
    const step = at >= 0 && chunks[at]!.step
    const before = at >= 0 ? chunks[at] : chunks.at(-1)
    // A new step sits like its neighbours; a new heading gets a blank line before it.
    const added = parts(e.content, step, undefined, step ? trailing(before?.text ?? "") : "\n")
    if (!step && before && !/\n$/.test(before.text)) before.text += "\n"
    if (at >= 0) chunks.splice(at + 1, 0, ...added)
    else chunks.push(...added)
  }
  // Steps are renumbered in order; a heading starts a new count.
  let n = 0
  for (const c of chunks) {
    if (!c.step) n = 0
    else c.text = c.text.replace(/^\d+\./, `${++n}.`)
  }
  // A heading after a changed section gets a blank line before it.
  const touched = new Set([...change.revised, ...change.tuned, ...change.added, ...change.also.map((a) => a.id)])
  chunks.forEach((c, i) => {
    const prev = chunks[i - 1]
    if (i > 0 && !c.step && prev && touched.has(prev.id) && !/\n$/.test(prev.text)) prev.text += "\n"
  })
  const out = assemble(head, chunks.map((c) => c.text)).replace(/\n+$/, "") + "\n"
  const check = split(out).sections
  const ids = chunks.map((c) => c.id)
  const result: SectionIndex =
    check.length === ids.length
      ? { key: index.key, ids, titles: check.map((s) => s.title), next, final: index.final.filter((id) => ids.includes(id)) }
      : indexOf(out, index.key, { ...index, next })
  return { text: out, index: result, change }
}

/** The text with each section's id at the end of its first line ("[S5]", "[S5 ✅]" when final). */
export function annotate(text: string, index: SectionIndex): string {
  const { head, sections } = split(text)
  if (sections.length !== index.ids.length) return text
  return assemble(
    head,
    sections.map((s, i) => {
      const id = index.ids[i]!
      const [first, ...rest] = s.text.split("\n")
      return [`${first} [${id}${index.final.includes(id) ? " ✅" : ""}]`, ...rest].join("\n")
    }),
  )
}

/** "S1–S4, S7" for a list of ids. */
/** A section's title without numbering, emphasis or id tag, as written (for showing). */
export const shownTitle = (title: string) => title.replace(/\s*\[S\d+(?: ✅)?\]\s*$/, "").replace(/\*\*/g, "").trim()

/** A section the writer's tool wrote for decisions says so on a line of its own, whatever its title. */
const DECIDE_MARK = /^<!--\s*decide\s*-->\s*$/m

const body = (s: Section) => s.text.split("\n").slice(1).join("\n").replace(DECIDE_MARK, "").trim()

/**
 * The sections a user reviews (indices): those with text under their heading, and for a brief only those under its
 * top heading (`under`, e.g. "Concept brief"), so the supporting excerpts are left out. Undefined when `under` is missing.
 */
const level = (s: Section) => (s.step ? 99 : (/^(#+)/.exec(s.text)?.[1]?.length ?? 99))

function reviewed(sections: Section[], under?: string): number[] | undefined {
  let from = 0
  let to = sections.length
  if (under) {
    const top = sections.findIndex((s) => !s.step && plain(s.title).startsWith(under.toLowerCase()))
    if (top < 0) return undefined
    from = top
    const next = sections.findIndex((s, i) => i > top && level(s) <= level(sections[top]!))
    if (next > 0) to = next
  }
  return sections.map((_, i) => i).filter((i) => i >= from && i < to && body(sections[i]!))
}

/** The sections to go through one at a time: the reviewed ones not marked final. */
export function walkIds(text: string, index: SectionIndex, under?: string): string[] {
  const { sections } = split(text)
  const all = reviewed(sections, under) ?? reviewed(sections)!
  // Reference sections (evidence, step mechanics) sit under what they support and open on request; they are no stop of their own.
  return all
    .filter((i) => sections[i]!.step || kindOf(sections[i]!) !== "reference")
    .map((i) => index.ids[i]!)
    .filter((id) => !index.final.includes(id))
}

/** A section's closing line with the writer's pick: "**Recommended:** …". */
export const RECOMMENDED_LINE = /^[-*>\s]*\**\s*recommended\b/i

/** A labelled line, "**Recommended:** …" or "Summary: …", wherever it is in the section. */
const labelled = (name: string) => new RegExp(`^[-*>\\s]*\\**\\s*${name}\\s*\\**\\s*:`, "i")

/** A section's title as the writer sees it in messages. */
export const titleOf = (s: Section) => shownTitle(s.title).replace(/^#+\s*/, "")

/**
 * What a section is for, from its heading. Understand: what happens and what could go wrong (the user reads a summary).
 * Decide: choices, decisions, questions (the user reads each item with its recommended pick). Reference: step mechanics
 * and evidence (under its section, on request). A heading the table doesn't know is Understand.
 */
export type Kind = "understand" | "decide" | "reference"

const DECIDE = /\b(choices|decisions|feasibility|open questions|concerns|assumptions)\b/
const REFERENCE = /^(steps|excerpts|further evidence|evidence)\b/

const titleKind = (title: string): Kind | undefined => {
  const t = plain(title)
  return REFERENCE.test(t) ? "reference" : DECIDE.test(t) ? "decide" : undefined
}

/** A sub-section takes the type of the heading it sits under unless its own title says otherwise. */
export const kindOf = (s: Section): Kind => s.kind ?? (s.step ? "reference" : (titleKind(s.title) ?? "understand"))

function withKinds(sections: Section[]): Section[] {
  const stack: { depth: number; kind: Kind }[] = []
  for (const s of sections) {
    if (s.step) {
      s.kind = "reference"
      continue
    }
    const depth = /^(#+)/.exec(s.text)?.[1]?.length ?? 99
    while (stack.length && stack.at(-1)!.depth >= depth) stack.pop()
    const kind = (DECIDE_MARK.test(s.text) ? "decide" : undefined) ?? titleKind(s.title) ?? stack.at(-1)?.kind ?? "understand"
    s.kind = kind
    stack.push({ depth, kind })
  }
  return sections
}

/** The items of a decide section: its top-level list lines, each one decision with its pick. */
const ITEM = /^(?:[-*]|\d+\.)\s+\S/
const itemLines = (s: Section) => s.text.split("\n").flatMap((l, i) => (i > 0 && ITEM.test(l) ? [{ at: i, text: l }] : []))
const hasPick = (l: string) => /\brecommended\b/i.test(l)

/**
 * Decide sections with no Recommended line. One written as a list needs its pick on each item (see `lineProblems`),
 * and one followed by its own sub-sections gets its picks there: those sub-sections are checked themselves.
 */
export function unrecommended(text: string, under?: string): Section[] {
  const { sections } = split(text)
  const parent = (i: number) => !!sections[i + 1] && level(sections[i + 1]!) > level(sections[i]!)
  return (reviewed(sections, under) ?? [])
    .filter((i) => !parent(i))
    .map((i) => sections[i]!)
    .filter((s) => kindOf(s) === "decide" && !itemLines(s).length && !body(s).split("\n").some((l) => labelled("recommended").test(l)))
}

/** A section's opening line for the user: "**Summary:** …". */
export const SUMMARY_LINE = /^[-*>\s]*\**\s*summary\b\s*\**\s*:?\s*\**/i

/** A step's purpose: what follows its bold title on the first line. */
const stepPurpose = (s: Section) =>
  (s.text.split("\n")[0] ?? "")
    .replace(/\s*\[S\d+(?: ✅)?\]\s*$/, "")
    .replace(/^\d+\.\s+\*\*.+?\*\*\s*[:.—–-]?\s*/, "")
    .trim()

/** The section titled like a document summary needs no summary line of its own. */
const isSummary = (s: Section) => /^(summary|what you get)\b/.test(plain(s.title))

/**
 * What the user sees of a section by default (a step: its purpose; undefined without anything to show).
 * Understand: its Summary, then the Team chose and Risk lines when it has them. Decide: its items, each with its pick
 * (a section without items: Summary and Recommended lines). Reference: nothing.
 */
export function userView(s: Section): string | undefined {
  if (s.step) return stepPurpose(s) || undefined
  const kind = kindOf(s)
  if (kind === "reference") return undefined
  const lines = body(s).split("\n").filter((l) => l.trim())
  const summary = lines.find((l) => SUMMARY_LINE.test(l))
  if (kind === "decide") {
    const items = itemLines(s).map((i) => i.text)
    if (items.length) return [summary, items.join("\n")].filter(Boolean).join("\n\n")
    if (!summary) return undefined
    const pick = lines.findLast((l) => RECOMMENDED_LINE.test(l) && l !== summary)
    return pick ? `${summary}\n\n${pick}` : summary
  }
  if (!summary) return undefined
  const raw = body(s).split("\n")
  const parts = ["covers", "team chose", "risk"].map((name) => labelBlock(raw, name))
  // A fact about the code taken for true is shown wherever it sits: the user can't judge a plan on facts they never saw.
  const shown = parts.join("\n")
  const facts = raw.filter((l) => /\[A\d+\]/.test(l) && !shown.includes(l) && !l.includes(summary))
  return [summary, ...parts, facts.join("\n")].filter(Boolean).join("\n\n")
}

const LIST_LINE = /^\s*(?:[-*]|\d+\.)\s|^\s+\S/

/** A labelled line with the list lines that follow it ("**Team chose:**" and its bullets). */
function labelBlock(raw: string[], name: string): string {
  const at = raw.findIndex((l) => labelled(name).test(l))
  if (at < 0) return ""
  let end = at + 1
  while (end < raw.length && LIST_LINE.test(raw[end]!)) end++
  return raw.slice(at, end).join("\n")
}

/** A section's text under its heading line. */
export const sectionBody = (s: Section) => body(s)

/** The user view on one line, without the "Summary:" label; "" without a summary. */
export const oneLine = (s: Section) =>
  (userView(s) ?? "")
    .replace(SUMMARY_LINE, "")
    .replace(/\s*\n+\s*/g, " · ")
    .trim()

/** Reviewed sections with no Summary line (a decide section written as a list needs none), and plan steps with no purpose after the title. */
export function unsummarized(text: string, under?: string): Section[] {
  const { sections } = split(text)
  return (reviewed(sections, under) ?? [])
    .map((i) => sections[i]!)
    .filter((s) => {
      if (s.step) return !stepPurpose(s)
      const kind = kindOf(s)
      if (kind === "reference" || isSummary(s) || body(s).split("\n").some((l) => labelled("summary").test(l))) return false
      return kind === "understand" || !itemLines(s).length
    })
}

export const missingSummaries = (text: string, under?: string) => unsummarized(text, under).map(titleOf)

/** A line the section's type makes wrong; `at` is its index in the text, so only that line is sent again. */
export interface LineProblem {
  section: Section
  at: number
  ask: string
}

/** The most words a Summary, Team chose or Risk line has: the user reads it at a glance. */
const MAX_WORDS = 110
const VIEW_LABELS = ["summary", "team chose", "risk"]
const clip = (l: string) => {
  const t = l.replace(/\s+/g, " ").trim()
  return t.length > 60 ? `${t.slice(0, 60)}…` : t
}

/**
 * Lines to send again, by section type. Decide: an item with no pick, or "as written" for something assumed. Understand: a
 * Summary, Team chose or Risk line too long to read at a glance, and an "assumed" nobody checks (a fact about the code
 * is `[A1] assumed: …`, which the Intern checks; the team's own choice goes on the Team chose line).
 */
export function lineProblems(text: string, under?: string): LineProblem[] {
  const { sections } = split(text)
  const out: LineProblem[] = []
  for (const i of reviewed(sections, under) ?? []) {
    const s = sections[i]!
    const kind = kindOf(s)
    const where = `section "${titleOf(s)}"`
    if (kind === "decide") {
      for (const it of itemLines(s)) {
        if (!hasPick(it.text)) out.push({ section: s, at: s.line! + it.at, ask: `${where}, item "${clip(it.text)}" has no pick: send the whole item again, ending "**Recommended:** <option>: <short reason>".` })
        else if (/recommended\W*(as written|no change|as is)\b/i.test(it.text) && /\bassumed\b/i.test(it.text))
          out.push({ section: s, at: s.line! + it.at, ask: `${where}, item "${clip(it.text)}" is assumed, so "as written" is no pick: send the item again with the option you take and why.` })
      }
    } else if (kind === "understand") {
      let chose = false
      s.text.split("\n").forEach((l, j) => {
        if (!j) return
        const label = VIEW_LABELS.find((name) => labelled(name).test(l))
        const words = l.split(/\s+/).filter(Boolean).length
        if (label) chose = label === "team chose"
        else if (chose && !LIST_LINE.test(l)) chose = false
        if (label && words > MAX_WORDS)
          out.push({ section: s, at: s.line! + j, ask: `${where}: the ${label} line has ${words} words; the user reads it at a glance. Send it again in at most ${MAX_WORDS}, the rest stays in the section's details.` })
        else if (/\bassumed\b/i.test(l) && !/\[A\d+\]/.test(l) && !chose)
          out.push({ section: s, at: s.line! + j, ask: `${where}: "${clip(l)}" says assumed, and nothing checks it. Send the line again: a fact about the code as "[A1] assumed: <the fact>" (the Intern checks it), the team's own choice on the "**Team chose:**" line.` })
      })
    }
  }
  return out
}

/** The draft as the user sees it by default: each reviewed section's user view; other sections show only their heading. */
export function shortView(text: string, under?: string): string {
  const { head, sections } = split(text)
  const shown = new Set(reviewed(sections, under) ?? reviewed(sections)!)
  return assemble(
    head,
    sections.map((s, i) => {
      const first = s.text.split("\n")[0]!
      if (s.step) return first
      if (!body(s)) return s.text
      if (!shown.has(i) || kindOf(s) === "reference") return `${first}\n\n_(details on request)_\n`
      const view = userView(s)
      return view ? `${first}\n\n${view}\n` : s.text
    }),
  )
}

export function idRanges(ids: string[]): string {
  const nums = [...new Set(ids.map((id) => Number(id.slice(1))))].filter(Number.isFinite).sort((a, b) => a - b)
  const out: string[] = []
  for (let i = 0; i < nums.length; i++) {
    let j = i
    while (j + 1 < nums.length && nums[j + 1] === nums[j]! + 1) j++
    out.push(j > i + 1 ? `S${nums[i]}–S${nums[j]}` : j === i + 1 ? `S${nums[i]}, S${nums[j]}` : `S${nums[i]}`)
    i = j
  }
  return out.join(", ")
}
