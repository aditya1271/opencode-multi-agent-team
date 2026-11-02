import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { squash } from "./quotes.ts"

/** Longest block the plugin writes for one piece of evidence. */
const MAX_LINES = 60
/** Lines without a letter or digit (a closing brace) that follow the last line and still belong to the code. */
const TAIL = 3
/** A line this short says too little to find it by. */
const MIN_ANCHOR = 4
/** How much of a line must show up in the Intern's tool output. */
const SEEN_KEY = 40
const CITABLE = /^[\w./~-]+\.\w+$/
const MARK = /^\s*\[(E\d+)\]\s*$/
const INLINE = /\[(E\d+)\]/g

/** Where the Intern says its evidence is: the first and last line of the code, copied from the file. */
export interface Evidence {
  id: string
  file: string
  first: string
  /** Omitted: the code is the first line alone. */
  last?: string
  /** About where the first line is; it settles a line that occurs several times. */
  line?: number
}

export interface EvidenceProblem {
  id: string
  /** Index of the line holding its [En] marker. */
  at: number
  ask: string
}

const hasWord = (s: string) => /[A-Za-z0-9]/.test(s)
const bare = (s: string) => s.replace(/^\s*\d+:\s/, "").trim()
const short = (s: string) => (s.length > 70 ? `${s.slice(0, 70)}…` : s)

/** A line as it can be found in tool output, which may show quotes and backslashes escaped. */
export const loose = (s: string) => s.replace(/[\s;,"'\\]+/g, "")

interface Found {
  file: string
  from: number
  to: number
  /** Lines of the range left out at the size cap. */
  more: number
  text: string[]
  /** Lines of the range that none of the Intern's tools showed it. */
  unseen?: number[]
}

/** Lines (indices) that hold the anchor from `from` on: the ones that are exactly it, else the ones that contain it. */
function matches(lines: string[], anchor: string, from = 0): number[] {
  const key = squash(anchor)
  const exact: number[] = []
  const within: number[] = []
  for (let i = from; i < lines.length; i++) {
    const l = squash(lines[i]!)
    if (l === key) exact.push(i)
    else if (l.includes(key)) within.push(i)
  }
  return exact.length ? exact : within
}

function anchorProblem(name: string, anchor: string | undefined): string | undefined {
  const a = bare(anchor ?? "")
  if (!a) return `the ${name} line is empty`
  if (!hasWord(a) || squash(a).length < MIN_ANCHOR) return `the ${name} line \`${a}\` is too short or has no name or value in it`
  return undefined
}

/** The code the item points at, taken from the file, or why it can't be found. `seen` is what the Intern's tools showed. */
export function findEvidence(item: Evidence, root: string, seen?: string): Found | string {
  if (!item.file || !CITABLE.test(item.file.replace(/^~(?=\/)/, ""))) return `\`${item.file}\` isn't a file name the plugin can cite as path:line`
  const where = path.resolve(root, item.file.replace(/^~(?=\/)/, process.env.HOME ?? "~"))
  let lines: string[]
  try {
    if (!existsSync(where)) return `there is no file ${item.file}`
    lines = readFileSync(where, "utf8").split("\n")
  } catch {
    return `${item.file} can't be read`
  }
  const bad = anchorProblem("first", item.first) ?? (item.last === undefined ? undefined : anchorProblem("last", item.last))
  if (bad) return `${bad}; use a line with a name or value in it`
  const first = bare(item.first)
  const starts = matches(lines, first)
  if (!starts.length) return `\`${short(first)}\` isn't a line of ${item.file}`
  const hint = Number(item.line)
  let from = starts[0]!
  if (starts.length > 1) {
    if (!Number.isFinite(hint))
      return `the first line occurs ${starts.length} times in ${item.file} (lines ${starts.slice(0, 6).map((n) => n + 1).join(", ")}${starts.length > 6 ? ", …" : ""}); send \`line\` with the one you mean, or a more distinctive line`
    from = starts.reduce((best, n) => (Math.abs(n - (hint - 1)) < Math.abs(best - (hint - 1)) ? n : best), starts[0]!)
  }
  let to = from
  const last = item.last === undefined ? undefined : bare(item.last)
  if (last && squash(last) !== squash(first)) {
    const ends = matches(lines, last, from)
    if (!ends.length) return `the last line \`${short(last)}\` doesn't occur in ${item.file} after the first one (line ${from + 1})`
    to = ends[0]!
  }
  for (let t = 0; t < TAIL && to + 1 < lines.length && lines[to + 1]!.trim() && !hasWord(lines[to + 1]!); t++) to++
  let more = 0
  if (to - from + 1 > MAX_LINES) {
    more = to - from + 1 - MAX_LINES
    to = from + MAX_LINES - 1
  }
  const text = lines.slice(from, to + 1)
  const found: Found = { file: item.file, from: from + 1, to: to + 1, more, text }
  if (seen) {
    const unseen = text.flatMap((l, i) => (hasWord(l) && !seen.includes(loose(l).slice(0, SEEN_KEY)) ? [from + i + 1] : []))
    if (unseen.length) found.unseen = unseen
  }
  return found
}

const cite = (f: Found) => `${f.file}:${f.from === f.to ? f.from : `${f.from}-${f.to}`}`

function block(f: Found): string[] {
  const fence = f.text.some((l) => l.includes("```")) ? "~~~~" : "```"
  return [`\`${cite(f)}\``, fence, ...f.text, fence, ...(f.more ? [`_(The plugin cut the code here: ${f.more} more lines follow in the range you gave.)_`] : [])]
}

/**
 * The content with each `[En]` marker replaced by the code its evidence points at, taken from the file: a marker on a
 * line of its own becomes a block with its citation, one inside a sentence just the citation. Evidence no marker
 * uses goes in at the end. Problems are what couldn't be found or wasn't shown to the Intern; with `final` the
 * content carries a note for the first kind (the second still gets its code, which is the file's own text).
 */
export function renderEvidence(content: string, items: Evidence[], root: string, seen: string | undefined, final: boolean): { content: string; problems: EvidenceProblem[] } {
  const byId = new Map(items.map((e) => [e.id, e]))
  const used = new Set([...content.matchAll(INLINE)].map((m) => m[1]!))
  const extra = items.filter((e) => !used.has(e.id))
  let text = content.split("\n")
  if (extra.length) text = [...text, "", "## Further evidence", ...extra.flatMap((e) => ["", `[${e.id}]`])]
  const found = new Map<string, Found | string>()
  const lookup = (id: string): Found | string => {
    if (!found.has(id)) {
      const item = byId.get(id)
      found.set(id, item ? findEvidence(item, root, seen) : `there is no item ${id} in evidence`)
    }
    return found.get(id)!
  }
  const problems: EvidenceProblem[] = []
  const out: string[] = []
  text.forEach((line, i) => {
    const whole = MARK.exec(line)
    for (const id of whole ? [whole[1]!] : [...line.matchAll(INLINE)].map((m) => m[1]!)) {
      const r = lookup(id)
      const why =
        typeof r === "string"
          ? r
          : r.unseen
            ? `lines ${r.unseen[0]}${r.unseen.length > 1 ? `-${r.unseen.at(-1)}` : ""} of the code aren't in anything your tools showed you (read them first, or choose a range you read)`
            : undefined
      if (why && !problems.some((p) => p.id === id))
        problems.push({ id, at: i, ask: `evidence ${id}${byId.has(id) ? ` (\`${byId.get(id)!.file}\`)` : ""}: ${why}; send it again in \`evidence\`, same id.` })
    }
    const only = whole ? lookup(whole[1]!) : undefined
    if (whole) out.push(...(typeof only === "string" ? [final ? `_(The plugin removed evidence ${whole[1]}: ${only}.)_` : line] : block(only!)))
    else out.push(line.replace(INLINE, (m, id: string) => {
      const r = lookup(id)
      return typeof r === "string" ? m : cite(r)
    }))
  })
  return { content: out.join("\n"), problems }
}
