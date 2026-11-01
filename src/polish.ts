/**
 * Checks on the hand-offs that carry the user's request: the front agent's requirement list against the user's
 * words, the polished request against that list, and line-per-id verdicts (read-back, assumption checks, review).
 */

import { readFileSync } from "node:fs"
import path from "node:path"

export interface Requirement {
  /** The user's words this requirement rests on, exactly; "…" leaves words out. */
  quote: string
  /** What the user wants, as one line. */
  need: string
}

/** Words that carry no requirement on their own; any other word left unquoted counts. */
const FILLER = new Set(
  (
    "a an the and or but nor so if then than that this these those it its it's is are was were be been being am do does did done " +
    "to of in on at by for from with without into onto over under about as up out off i me my we us our you your he she they them " +
    "their there here what which who whom whose when where why how all also just very really please thanks thank hi hello hey ok okay " +
    "can could would should will shall may might must let lets let's get got make sure need want like some any each every both either " +
    "no not yes too more most such only own same other again once"
  ).split(" "),
)

const WORD = /[\p{L}\p{N}_]+/gu
const DOTS = /\.\.\.|…/
const FENCE = /^\s*(```|~~~)/

interface Token {
  w: string
  at: number
}

const tokens = (text: string): Token[] => [...text.matchAll(WORD)].map((m) => ({ w: m[0].toLowerCase(), at: m.index! }))

/** The user's text without fenced blocks (pasted logs and code are data, not wording to quote) and list markers. */
function prose(text: string): string {
  let inFence = false
  return text
    .split("\n")
    .map((line) => {
      if (FENCE.test(line)) {
        inFence = !inFence
        return ""
      }
      if (inFence) return " ".repeat(line.length)
      return line.replace(/^(\s*)(?:#+|\d+[.)]|[-*+>])(\s)/, (m, a: string, b: string) => a + " ".repeat(m.length - a.length - b.length) + b)
    })
    .join("\n")
}

/** Where a quote sits in the token list: from its first word to its last ("…" may leave words out between). */
function locate(source: Token[], quote: string): [number, number] | undefined {
  const parts = quote
    .split(DOTS)
    .map((p) => tokens(p).map((t) => t.w))
    .filter((p) => p.length)
  if (!parts.length) return undefined
  let from = -1
  let pos = 0
  for (const part of parts) {
    let hit = -1
    for (let i = pos; i + part.length <= source.length; i++) {
      if (part.every((w, k) => source[i + k]!.w === w)) {
        hit = i
        break
      }
    }
    if (hit < 0) return undefined
    if (from < 0) from = hit
    pos = hit + part.length
  }
  return [from, pos]
}

/** A quote in plain words, for messages. */
const clip = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

export interface CoverageResult {
  /** 1-based numbers of requirements whose quote isn't in the user's words. */
  badRequirements: number[]
  /** Skipped quotes that aren't in the user's words. */
  badSkipped: string[]
  /** Runs of the user's words that no quote covers and that hold more than filler. */
  uncovered: string[]
}

/**
 * Every quote must be in the user's words (`sources`: the latest message first, then earlier ones), and every part of
 * the latest message must be covered by a requirement or a skipped quote, unless it is only filler.
 */
export function checkCoverage(sources: string[], requirements: Requirement[], skipped: string[]): CoverageResult {
  const latest = prose(sources[0] ?? "")
  const own = tokens(latest)
  const others = sources.slice(1).map((s) => tokens(prose(s)))
  const covered = new Array<boolean>(own.length).fill(false)
  const place = (quote: string): boolean => {
    const at = locate(own, quote)
    if (at) {
      for (let i = at[0]; i < at[1]; i++) covered[i] = true
      return true
    }
    return others.some((t) => locate(t, quote))
  }
  const badRequirements = requirements.map((r, i) => (place(r.quote) ? 0 : i + 1)).filter(Boolean)
  const badSkipped = skipped.filter((q) => !place(q))
  const uncovered: string[] = []
  let i = 0
  while (i < own.length) {
    if (covered[i]) {
      i++
      continue
    }
    let j = i
    while (j < own.length && !covered[j]) j++
    // Reported without the filler at its ends.
    let a = i
    let b = j
    while (a < b && FILLER.has(own[a]!.w)) a++
    while (b > a && FILLER.has(own[b - 1]!.w)) b--
    if (a < b) {
      const end = own[b - 1]!
      uncovered.push(clip(latest.slice(own[a]!.at, end.at + end.w.length).replace(/\s+/g, " ").trim(), 160))
    }
    i = j
  }
  return { badRequirements, badSkipped, uncovered }
}

/** A sentence end or a semicolon inside a span; inline code, ellipses and "e.g."-style abbreviations don't count. */
const BREAK = /[.!?](?=\s+[^\s\p{Ll}])|;(?=\s)/u

/**
 * 1-based numbers of requirements whose words, as they stand in the user's latest message, run over a sentence end or a
 * semicolon: one requirement should hold one behaviour that can be checked on its own.
 */
export function multiSentence(sources: string[], requirements: Requirement[]): number[] {
  const latest = prose(sources[0] ?? "")
  const own = tokens(latest)
  return requirements
    .map((r, i) => {
      const at = locate(own, r.quote)
      if (!at) return 0
      const last = own[at[1] - 1]!
      const span = latest.slice(own[at[0]]!.at, last.at + last.w.length).replace(/`[^`]*`/g, "x").replace(/\.\.\.|…/g, " ")
      return BREAK.test(span) ? i + 1 : 0
    })
    .filter(Boolean)
}

/**
 * Requirements whose quote joins two parts with "and", each with at least three words that aren't filler: often two
 * behaviours in one. Short list items ("calls, input, output, and cost") don't count, since commas end a part too.
 */
export function joined(requirements: Requirement[]): { n: number; parts: [string, string] }[] {
  const found: { n: number; parts: [string, string] }[] = []
  requirements.forEach((r, i) => {
    const parts = r.quote.split(/\s+and\s+/i)
    for (let k = 1; k < parts.length; k++) {
      const left = parts[k - 1]!.split(/[,;:]/).pop()!.trim()
      const right = parts[k]!.split(/[,;:]/)[0]!.trim()
      const words = (s: string) => tokens(s).filter((t) => !FILLER.has(t.w)).length
      if (words(left) >= 3 && words(right) >= 3) {
        found.push({ n: i + 1, parts: [left, right] })
        return
      }
    }
  })
  return found
}

/** Words of a mode request ("Mode: safe auto", "just do it", "decide yourself"): an instruction to the plugin, not a requirement. */
const MODE = new Set("mode auto safe polished full off just do it decide yourself send without asking".split(" "))

/** True when the text holds nothing but mode words and filler. */
export const modeOnly = (text: string): boolean => {
  const t = tokens(text)
  return t.length > 0 && t.every((x) => MODE.has(x.w) || FILLER.has(x.w))
}

/** Drops requirements that are only a mode request, renumbering the [R1] tags in the text to match. */
export function dropModeOnly(requirements: Requirement[], text: string): { requirements: Requirement[]; text: string } {
  const keep = requirements.map((r) => !modeOnly(r.quote))
  if (keep.every(Boolean)) return { requirements, text }
  const map = new Map<number, number>()
  let next = 0
  keep.forEach((k, i) => k && map.set(i + 1, ++next))
  const out = text.replace(/\[R(\d+)\]/g, (m, n: string) => (map.has(Number(n)) ? `[R${map.get(Number(n))}]` : ""))
  return { requirements: requirements.filter((_, i) => keep[i]), text: out }
}

/** Requirement ids (R1, …) the polished request doesn't tag. */
export function untagged(text: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `R${i + 1}`).filter((id) => !new RegExp(`\\[${id}\\]`).test(text))
}

/** The task file Reviewer checks the work against: the user's requirements and the decisions on open points. */
export function requirementsText(requirements: Requirement[], decisions: { question: string; answer: string; by: string }[]): string {
  return [
    "# Requirements",
    "What the user asked for, each with their own words (R) and the decisions on open points (D). The work is done when every item holds.",
    ...requirements.map((r, i) => `- **R${i + 1}**: ${r.need.trim()} (the user: «${r.quote.trim()}»)`),
    ...decisions.map((d, i) => `- **D${i + 1}**: ${d.answer.trim()} (${d.by}; question: ${clip(d.question.replace(/\s+/g, " ").trim(), 200)})`),
  ].join("\n")
}

/** The ids listed in a requirements file. */
export const requirementIds = (text: string): string[] => [...text.matchAll(/^- \*\*([RD]\d+)\*\*/gm)].map((m) => m[1]!)

/** The decisions block added to the polished request. */
export function decisionsText(decisions: { question: string; answer: string; by: string }[]): string {
  if (!decisions.length) return ""
  return ["## Decisions", ...decisions.map((d, i) => `- [D${i + 1}] ${clip(d.question.split("\n")[0]!.trim(), 200)} → ${d.answer.trim()} (${d.by})`)].join("\n")
}

/** A question without its Recommended line, for the decisions list. */
export const questionOnly = (q: string) =>
  q
    .split("\n")
    .filter((l) => !/^\W*Recommended\W*:/i.test(l))
    .join("\n")
    .trim()

export interface VerdictSpec {
  ids: string[]
  /** The verdict words, in the order they are tried ("not met" before "met"). */
  words: string[]
  /** Verdicts that need a «quote» found in this text. */
  quoteIn?: { text: string; words: string[] }
  /** Verdicts that need a `path:line` reference. */
  evidence?: string[]
  /** Verdicts whose «quote» must be in the file they cite (paths relative to root). */
  quoteInFile?: { root: string; words: string[] }
  /** How a line looks, for the refusal. */
  format: string
  /** A status these verdicts rule out (PASS with a requirement not met). */
  notWith?: { status: string; words: string[] }
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")
const QUOTED = /«([^»]+)»|"([^"]+)"|“([^”]+)”|`([^`]+)`/g
const CITED = /[\w./~-]+\.\w+:\d+/

/** Each id's verdict, from lines `ID: verdict …` (list, bold and table markup allowed), with the line index. */
export function verdicts(content: string, spec: VerdictSpec): Map<string, { verdict: string; rest: string; at: number }> {
  const out = new Map<string, { verdict: string; rest: string; at: number }>()
  const words = spec.words.map(escape).join("|")
  const line = new RegExp(`^[\\s>*|#-]*\\**\\[?([A-Z]+\\d+)\\]?\\**\\s*[:|\\-–—]?\\s*\\**\\s*(${words})\\b\\**(.*)$`, "i")
  content.split("\n").forEach((text, at) => {
    const m = line.exec(text)
    const id = m?.[1]!.toUpperCase()
    if (!m || !id || !spec.ids.includes(id) || out.has(id)) return
    out.set(id, { verdict: m[2]!.toLowerCase(), rest: m[3] ?? "", at })
  })
  return out
}

const flat = (s: string) => tokens(s).map((t) => t.w).join(" ")

/** A line's «quote» must be in the file it cites (`path:line`, relative to `root`). */
function fileQuoteProblem(rest: string, root: string): string | undefined {
  const quotes = [...rest.matchAll(QUOTED)].map((m) => m[1] ?? m[2] ?? m[3] ?? m[4] ?? "").filter((q) => flat(q))
  if (!quotes.length) return "it quotes no code «like this»"
  const file = /([\w./~-]+\.\w+):\d+/.exec(rest)![1]!
  const full = path.resolve(root, file.replace(/^~(?=\/)/, process.env.HOME ?? "~"))
  let text: string
  try {
    text = flat(readFileSync(full, "utf8"))
  } catch {
    return `${file} isn't a file in the project`
  }
  return quotes.some((q) => text.includes(flat(q))) ? undefined : `«${clip(quotes[0]!)}» isn't in ${file} word for word`
}

/** A verdict line to send: `at` is the line it replaces; none: a missing line, added after the last verdict line (`after`). */
export interface VerdictProblem {
  id: string
  ask: string
  at?: number
  after: number
}

/** What is wrong with the verdict lines: missing ids, quotes not in the text, verdicts without evidence. */
export function verdictProblems(content: string, spec: VerdictSpec): VerdictProblem[] {
  const found = verdicts(content, spec)
  const after = Math.max(-1, ...[...found.values()].map((v) => v.at))
  const end = after >= 0 ? after : content.split("\n").length - 1
  const problems: VerdictProblem[] = spec.ids
    .filter((id) => !found.has(id))
    .map((id) => ({ id, after: end, ask: `there is no verdict line for ${id}: send it as ${spec.format}.` }))
  const text = spec.quoteIn ? flat(spec.quoteIn.text) : ""
  for (const [id, v] of found) {
    const again = `send the whole line again as ${spec.format}.`
    if (spec.quoteIn?.words.includes(v.verdict)) {
      const quotes = [...v.rest.matchAll(QUOTED)].map((m) => m[1] ?? m[2] ?? m[3] ?? m[4] ?? "").filter((q) => flat(q))
      if (!quotes.length) problems.push({ id, at: v.at, after: end, ask: `${id} says "${v.verdict}" without the words that carry it, quoted «like this»; ${again}` })
      else if (!quotes.some((q) => text.includes(flat(q))))
        problems.push({ id, at: v.at, after: end, ask: `${id}: «${clip(quotes[0]!)}» isn't in the text word for word; ${again}` })
    }
    if (spec.evidence?.includes(v.verdict) && !CITED.test(v.rest)) problems.push({ id, at: v.at, after: end, ask: `${id} says "${v.verdict}" without evidence as \`path:line\`; ${again}` })
    else if (spec.quoteInFile?.words.includes(v.verdict)) {
      const problem = fileQuoteProblem(v.rest, spec.quoteInFile.root)
      if (problem) problems.push({ id, at: v.at, after: end, ask: `${id}: ${problem}; ${again}` })
    }
  }
  return problems
}

/** The assumption ids a draft marks: `[A1] assumed: …`. */
export const claimIds = (text: string): string[] => [...new Set([...text.matchAll(/\[(A\d+)\]/g)].map((m) => m[1]!))]

/** The lines of a draft that hold each assumption. */
export const claimLines = (text: string, ids: string[]): string =>
  text
    .split("\n")
    .filter((l) => ids.some((id) => l.includes(`[${id}]`)))
    .map((l) => l.trim())
    .join("\n")
