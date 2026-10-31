import { existsSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

/** How far quoted lines may sit from the cited range before the citation counts as wrong. */
const SLACK = 30
const CITE = /([\w./~-]+\.[\w]+):(\d+(?:\s*[-–]\s*\d+)?(?:\s*,\s*\d+(?:\s*[-–]\s*\d+)?)*)/g
const FENCE = /^\s*(```|~~~)/
const OUTPUT = /^\s*(```|~~~)\s*output\b/i
const DOTS = /\.\.\.|…/
const LINK = /\[(Q\d+)\]/g
const LINK_LINE = /^\s*\[(Q\d+)\]\s*$/

/** Told to whoever reads the Intern's findings. */
export const QUOTES_CHECKED = "The plugin has checked every code block against the file it cites (`output` blocks are command output): quote them as they are."

/** One code block of the findings and how it compares with the file cited just above it. */
export interface QuotedBlock {
  /** Line indices of its opening and closing fence. */
  from: number
  to: number
  cite?: string
  /** Index of the line holding the citation. */
  citeAt?: number
  file?: string
  /**
   * ok; shortened: in the file, with lines left out ("..."); bad: a line isn't in the file; moved: the code is in the
   * file, away from the cited lines; unchecked: no file to compare; output: a command's output (an `output` block).
   */
  verdict: "ok" | "shortened" | "bad" | "moved" | "unchecked" | "output"
  /** bad: the first line not in the file. */
  line?: string
  /** moved: where the code is. */
  at?: number
  end?: number
}

/** Without whitespace, semicolons and commas, so code re-wrapped onto fewer lines still matches. */
const squash = (s: string) => s.replace(/[\s;,]+/g, "")

/** The kept parts of a line shortened with "...". */
const parts = (line: string) => line.split(DOTS).map(squash).filter((p) => p.length >= 4)

function judge(block: string[], cite: RegExpMatchArray | undefined, root: string): Omit<QuotedBlock, "from" | "to"> {
  if (!cite) return { verdict: "unchecked" }
  const file = path.resolve(root, cite[1]!.replace(/^~(?=\/)/, process.env.HOME ?? "~"))
  const named = { cite: cite[0], file: cite[1] }
  let source: string
  try {
    if (!existsSync(file)) return { ...named, verdict: "unchecked" }
    source = readFileSync(file, "utf8")
  } catch {
    return { ...named, verdict: "unchecked" }
  }
  const flat = squash(source)
  const quoted = block.map((l) => l.replace(/^\s*\d+:\s/, "").trim()).filter(Boolean)
  // A line is either in the file as it is (code like `...args` included), or stands for left-out code.
  let shortened = false
  for (const l of quoted) {
    if (flat.includes(squash(l))) continue
    if (DOTS.test(l) && parts(l).every((p) => flat.includes(p))) {
      shortened = true
      continue
    }
    return { ...named, verdict: "bad", line: l.length > 80 ? `${l.slice(0, 80)}…` : l }
  }
  // The longest quoted line places the block; a citation far from it is wrong.
  const keys = quoted.map((l) => (DOTS.test(l) && !flat.includes(squash(l)) ? (parts(l)[0] ?? "") : squash(l)))
  const k = keys.reduce((best, s, i) => (s.length > keys[best]!.length ? i : best), 0)
  const key = keys[k]
  const at = key && key.length >= 12 ? source.split("\n").findIndex((l) => squash(l).includes(key)) + 1 : 0
  const near =
    !at ||
    cite[2]!.split(",").some((r) => {
      const [a, b = a] = r.split(/[-–]/).map((n) => Number(n.trim()))
      return at >= a! - SLACK && at <= b! + SLACK
    })
  if (!near) return { ...named, verdict: "moved", at: Math.max(1, at - k), end: Math.max(1, at - k) + quoted.length - 1 }
  return { ...named, verdict: shortened ? "shortened" : "ok" }
}

/** Compares each code block in findings with the file cited just before it. Whitespace is ignored. */
export function checkQuotes(content: string, root: string): QuotedBlock[] {
  const blocks: QuotedBlock[] = []
  const text = content.split("\n")
  let since = 0
  for (let i = 0; i < text.length; i++) {
    if (!FENCE.test(text[i]!)) continue
    const from = i
    const output = OUTPUT.test(text[i]!)
    // The citation is the last one between the previous block and this one.
    let citeAt: number | undefined
    let cite: RegExpMatchArray | undefined
    for (let j = from - 1; j >= since && !cite; j--) {
      cite = [...text[j]!.matchAll(CITE)].at(-1)
      if (cite) citeAt = j
    }
    const block: string[] = []
    for (i++; i < text.length && !FENCE.test(text[i]!); i++) block.push(text[i]!)
    blocks.push({ from, to: i, ...(output ? { verdict: "output" as const } : { citeAt, ...judge(block, cite, root) }) })
    since = i + 1
  }
  return blocks
}

/** Citations that point away from their code, corrected to where the code is: no need to ask the writer. */
export function fixCites(content: string, blocks: QuotedBlock[]): string {
  const text = content.split("\n")
  for (const b of blocks)
    if (b.verdict === "moved" && b.citeAt !== undefined) text[b.citeAt] = text[b.citeAt]!.replace(b.cite!, `${b.file}:${b.at === b.end ? b.at : `${b.at}-${b.end}`}`)
  return text.join("\n")
}

export { CITE, FENCE }

/** The findings with only true blocks: the others are replaced by a note. Shortened and moved code is true, so it stays. */
export function keepChecked(content: string, blocks: QuotedBlock[]): string {
  const text = content.split("\n")
  for (const b of [...blocks].reverse()) {
    if (b.verdict === "bad" || b.verdict === "unchecked")
      text.splice(b.from, b.to - b.from + 1, `_(The plugin removed a code block here: ${b.verdict === "bad" ? `it doesn't match ${b.cite}` : b.cite ? `${b.cite} doesn't exist` : "it cites no file"}.)_`)
    else if (b.verdict === "moved") text.splice(b.from, 0, `_(The plugin found this code at line ${b.at}, not ${b.cite}.)_`)
  }
  return text.join("\n")
}

const QUOTES_FILE = "quotes.json"

export function loadQuotes(dir: string): Record<string, string> {
  try {
    return JSON.parse(readFileSync(path.join(dir, QUOTES_FILE), "utf8"))
  } catch {
    return {}
  }
}

/**
 * Labels each true code block of the findings `[Qn]`, numbered on from `start`, and keeps the block with its citation
 * in the task's quotes, so the Analyst can link a block instead of copying it.
 */
export function numberQuotes(dir: string, content: string, root: string, start: number): { content: string; next: number } {
  const quotes = loadQuotes(dir)
  const text = content.split("\n")
  const labels: [number, string][] = []
  let n = start
  for (const b of checkQuotes(content, root)) {
    if (b.verdict !== "ok" && b.verdict !== "shortened" && b.verdict !== "moved") continue
    const id = `Q${++n}`
    const cite = b.verdict === "moved" ? `${b.file}:${b.at}` : b.cite
    quotes[id] = [`\`${cite}\``, ...text.slice(b.from, b.to + 1)].join("\n")
    labels.push([b.from, `[${id}]`])
  }
  if (!labels.length) return { content, next: n }
  for (const [at, label] of labels.reverse()) text.splice(at, 0, label)
  writeFileSync(path.join(dir, QUOTES_FILE), JSON.stringify(quotes, null, 2))
  return { content: text.join("\n"), next: n }
}

/** Replaces each `[Qn]` with the block: a line of its own becomes the whole block, one in a sentence its citation. */
export function expandQuotes(text: string, quotes: Record<string, string>): string {
  const unknown = [...new Set([...text.matchAll(LINK)].map((m) => m[1]!).filter((id) => !quotes[id]))]
  if (unknown.length) throw new Error(`No code block ${unknown.join(", ")} in the findings: link only the [Qn] labels they show.`)
  return text
    .split("\n")
    .map((l) => {
      const whole = LINK_LINE.exec(l)
      return whole ? quotes[whole[1]!]! : l.replace(LINK, (_, id: string) => quotes[id]!.split("\n")[0]!)
    })
    .join("\n")
}
