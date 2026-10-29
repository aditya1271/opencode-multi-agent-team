// Drafts in sections: each heading (and each numbered step under a "Steps" heading) starts one.
// Sections keep their id (S1, S2, …) across versions, so a revision can replace some and keep the rest byte for byte.

export interface Section {
  title: string
  text: string
  step: boolean
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
  const parts: { title: string; lines: string[]; step: boolean }[] = []
  let fence = false
  let steps = inSteps
  for (const line of text.split("\n")) {
    const h = !fence && HEADING.exec(line)
    const s = !fence && !h && steps && STEP.exec(line)
    if (FENCE.test(line)) fence = !fence
    if (h) {
      steps = /^steps\b/.test(plain(h[2]!))
      parts.push({ title: h[2]!, lines: [line], step: false })
    } else if (s) parts.push({ title: line.replace(/^(\d+\.\s+)\*\*(.+?)\*\*.*$/, "$1$2"), lines: [line], step: true })
    else (parts.at(-1)?.lines ?? head).push(line)
  }
  return { head: head.join("\n"), sections: parts.map((p) => ({ title: p.title, text: p.lines.join("\n"), step: p.step })) }
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

const body = (s: Section) => s.text.split("\n").slice(1).join("\n").trim()

/**
 * The sections a user reviews (indices): those with text under their heading, and for a brief only those under its
 * top heading (`under`, e.g. "Concept brief"), so the supporting excerpts are left out. Undefined when `under` is missing.
 */
function reviewed(sections: Section[], under?: string): number[] | undefined {
  const level = (s: Section) => (s.step ? 99 : (/^(#+)/.exec(s.text)?.[1]?.length ?? 99))
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
  return all.map((i) => index.ids[i]!).filter((id) => !index.final.includes(id))
}

/** A section's closing line with the writer's pick: "**Recommended:** …". */
export const RECOMMENDED_LINE = /^[-*>\s]*\**\s*recommended\b/i

/** Reviewed sections (plan steps and their Steps heading aside) whose last line isn't a Recommended line, by title. */
export function missingRecommendations(text: string, under?: string): string[] {
  const { sections } = split(text)
  return (reviewed(sections, under) ?? [])
    .map((i) => sections[i]!)
    .filter((s) => !s.step && !/^steps\b/.test(plain(s.title)) && !RECOMMENDED_LINE.test(body(s).split("\n").pop() ?? ""))
    .map((s) => shownTitle(s.title).replace(/^#+\s*/, ""))
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
