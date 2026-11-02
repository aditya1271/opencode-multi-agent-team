// The what-document as blocks: the Planner sends a layout (a tree of blocks, one line of intent each), then fills each
// block with typed fields. Code checks both and writes the markdown, so no layout is parsed from prose.

export const KINDS = ["group", "note", "process", "choice", "question"] as const
export type BlockKind = (typeof KINDS)[number]

export interface Block {
  kind: BlockKind
  title: string
  intent: string
  children?: Block[]
}

export interface Fill {
  in_short?: string
  details?: string
  steps?: string[]
  options?: { name: string; tradeoff: string }[]
  recommended?: string
  why?: string
  chose?: string[]
  risk?: string
}

export type FillMap = Record<string, Fill>

export interface BlockDraft {
  title?: string
  layout?: Block[]
  fill: FillMap
}

const MAX_DEPTH = 3
const MAX_CHILDREN = 12
const MAX_BLOCKS = 60
const SHORT_WORDS = [4, 45]

/** What the what-document may not name: files, identifiers, code words. Steps belong to the change plan. */
const CODE_NAME = /[\w/.-]+\.(?:ts|tsx|js|py|cxx|cpp|hxx|hpp|h|c|md|json|yaml|yml|sh)\b|\w+\(\)|`|\b[a-z]+_[a-z0-9_]+\b|\b[a-z]+[A-Z]\w*\b/
const CODE_WORD = /\b(?:database|schema|api|json|sql|class(?:es)?|functions?|methods?|variables?|librar(?:y|ies)|endpoints?)\b/i
const STEPLIKE = /\b(change plan|implementation|steps?)\b/i

const words = (s: string) => s.split(/\s+/).filter(Boolean).length
const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim()
const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0

export function paths(tree: Block[], prefix = ""): { path: string; block: Block }[] {
  return tree.flatMap((b, i) => {
    const path = `${prefix}${i + 1}`
    return [{ path, block: b }, ...paths(b.children ?? [], `${path}.`)]
  })
}

const codeIn = (s: string) => CODE_NAME.exec(s)?.[0] ?? CODE_WORD.exec(s)?.[0]

/** What is wrong with a layout, one line per problem, each naming the block by its path. */
export function layoutProblems(tree: unknown): string[] {
  if (!Array.isArray(tree) || !tree.length) return ["`layout` is an array of blocks: send at least one group."]
  const out: string[] = []
  let count = 0
  const walk = (blocks: unknown[], depth: number, prefix: string) => {
    if (depth > MAX_DEPTH) out.push(`${prefix || "top"}: groups nest at most ${MAX_DEPTH} levels deep.`)
    if (blocks.length > MAX_CHILDREN) out.push(`${prefix ? `${prefix.slice(0, -1)} holds` : "the top level holds"} ${blocks.length} blocks, at most ${MAX_CHILDREN}: group some.`)
    blocks.forEach((raw, i) => {
      const path = `${prefix}${i + 1}`
      count++
      const b = raw as Partial<Block> | null
      if (!b || typeof b !== "object") return void out.push(`${path}: not a block.`)
      if (!KINDS.includes(b.kind as BlockKind)) out.push(`${path}: kind "${b.kind}" is unknown; use ${KINDS.join(", ")}.`)
      if (!text(b.title)) out.push(`${path}: no title.`)
      if (!text(b.intent)) out.push(`${path}: no intent (one line on what the block will say).`)
      const said = `${b.title ?? ""} ${b.intent ?? ""}`
      const code = codeIn(said)
      if (code) out.push(`${path} "${b.title}": names code ("${code}"); the what-document says what happens, in the user's words.`)
      if (STEPLIKE.test(String(b.title ?? ""))) out.push(`${path} "${b.title}": steps and change plans belong to the how stage; describe the behaviour.`)
      if (depth === 1 && b.kind !== "group") out.push(`${path} "${b.title}": the top level holds groups; put this block inside one.`)
      if (b.kind === "group") {
        if (!Array.isArray(b.children) || !b.children.length) out.push(`${path} "${b.title}": a group holds blocks; it has none.`)
        else walk(b.children, depth + 1, `${path}.`)
      } else if (b.children?.length) out.push(`${path} "${b.title}": only a group has children.`)
    })
  }
  walk(tree, 1, "")
  if (count > MAX_BLOCKS) out.push(`The layout has ${count} blocks, at most ${MAX_BLOCKS}: scale it to the request.`)
  return out
}

const NEED: Record<BlockKind, string> = {
  group: "in_short",
  note: "in_short, details (chose and risk when there are any)",
  process: "in_short, steps (chose and risk when there are any)",
  choice: "in_short, options (each name and tradeoff), recommended (one option's name), why",
  question: "in_short, recommended (your answer), why",
}

export const FILL_HELP = [
  "Fields by kind:",
  ...KINDS.map((k) => `- ${k}: ${NEED[k]}`),
  "in_short: one sentence for the user, 4 to 45 words, saying more than the title. details: the full text. steps: what happens, one item each, at least 2. options: at least 2. chose: what the team picked that the request did not say. risk: only a risk of that block.",
].join("\n")

/** The layout as the fill call lists it: path, kind, title, intent. */
export const outline = (tree: Block[]) =>
  paths(tree)
    .map(({ path, block }) => `${path} ${block.kind} "${block.title}": ${block.intent}`)
    .join("\n")

const sameOption = (a: unknown, b: unknown) => norm(a) === norm(b)

/** What is wrong with the filled blocks: one line per problem, by path. */
export function fillProblems(tree: Block[], fill: FillMap): string[] {
  const out: string[] = []
  const known = new Set(paths(tree).map((p) => p.path))
  for (const path of Object.keys(fill)) if (!known.has(path)) out.push(`${path}: no such block in your layout.`)
  for (const { path, block: b } of paths(tree)) {
    const at = `${path} "${b.title}"`
    const v = fill[path] as Fill | undefined
    if (!v || typeof v !== "object") {
      out.push(`${at}: missing (${b.kind}: ${NEED[b.kind]}).`)
      continue
    }
    const bad = (why: string) => out.push(`${at}: ${why}.`)
    if (!text(v.in_short)) bad("in_short is empty")
    else {
      const n = words(v.in_short)
      if (n < SHORT_WORDS[0]! || n > SHORT_WORDS[1]!) bad(`in_short has ${n} words; the user reads one sentence of ${SHORT_WORDS[0]} to ${SHORT_WORDS[1]}`)
      else if (norm(v.in_short) === norm(b.title) || norm(v.in_short) === norm(b.intent)) bad("in_short only repeats the title or intent; say what the block says")
    }
    if (b.kind === "note") {
      if (!text(v.details)) bad("details is empty")
      else if (norm(v.details) === norm(b.intent) || (text(v.in_short) && v.details.length <= v.in_short.length)) bad("details adds nothing to in_short; write the full text")
    }
    if (b.kind === "process" && (!Array.isArray(v.steps) || v.steps.filter(text).length < 2)) bad("steps needs at least 2 items, one per thing that happens")
    if (b.kind === "choice") {
      const opts = Array.isArray(v.options) ? v.options : []
      if (opts.length < 2 || opts.some((o) => !o || !text(o.name) || !text(o.tradeoff))) bad("options needs at least 2 items, each with a name and its tradeoff")
      else if (!opts.some((o) => sameOption(o.name, v.recommended))) bad(`recommended "${v.recommended}" is not the name of one option`)
      if (!text(v.why)) bad("why is empty")
    }
    if (b.kind === "question" && !text(v.recommended)) bad("recommended is empty: give your answer")
    if (v.chose !== undefined && (!Array.isArray(v.chose) || v.chose.some((c) => !text(c)))) bad("chose is a list of sentences")
    if (v.risk !== undefined && !text(v.risk)) bad("risk is empty: leave the field out when there is none")
    const said = [v.in_short, v.details, v.recommended, v.why, v.risk, ...(v.steps ?? []), ...(v.chose ?? []), ...(v.options ?? []).flatMap((o) => [o?.name, o?.tradeoff])]
    const code = codeIn(said.filter((s): s is string => typeof s === "string").join("\n"))
    if (code) bad(`names code ("${code}"); the what-document says what happens, in the user's words`)
  }
  return out
}

const leaves = (b: Block, path: string): { path: string; block: Block }[] =>
  b.kind === "group" ? (b.children ?? []).flatMap((c, i) => leaves(c, `${path}.${i + 1}`)) : [{ path, block: b }]

const list = (items: string[], bullet = "-") => items.map((i) => `${bullet} ${i}`)
const pick = (v: Fill) => `${String(v.recommended ?? "").trim().replace(/[.:;\s]+$/, "")}${text(v.why) ? `: ${v.why!.trim()}` : ""}`

/** One block's text under its heading, nested groups as bold headings. */
function detail(b: Block, path: string, fill: FillMap, short = true): string[] {
  const v = fill[path] ?? {}
  const head = [`**${path} ${b.title}**`, ...(short ? [`In short: ${v.in_short ?? ""}`] : [])]
  if (b.kind === "group") return [...head, "", ...(b.children ?? []).flatMap((c, i) => [...detail(c, `${path}.${i + 1}`, fill), ""])]
  const body: string[] = []
  if (b.kind === "note" && v.details) body.push(v.details.trim())
  if (b.kind === "process") body.push(...(v.steps ?? []).map((s, i) => `${i + 1}. ${s.trim()}`))
  if (b.kind === "choice") {
    body.push(...list((v.options ?? []).map((o) => `${o.name}: ${o.tradeoff}`)))
    body.push(`**Recommended:** ${pick(v)}`)
  }
  if (b.kind === "question") body.push(`Recommended answer: ${pick(v)}`)
  return [...head, ...body]
}

const unique = (items: string[]) => [...new Set(items.map((i) => i.trim()))]

/** A top-level group as one reviewed section; the marker tells the review that it decides things. */
function section(g: Block, n: number, fill: FillMap): string[] {
  const path = String(n)
  const own = fill[path] ?? {}
  const below = leaves(g, path)
  const decide = below.length > 0 && below.every((l) => l.block.kind === "choice" || l.block.kind === "question")
  const out = [`## ${n}. ${g.title}`]
  if (decide) {
    out.push("<!-- decide -->", "", `**Summary:** ${own.in_short ?? ""}`, "")
    for (const { path: p, block: b } of below) {
      const v = fill[p] ?? {}
      out.push(`- **${b.title}**: ${v.in_short ?? ""} **Recommended:** ${pick(v)}`)
      if (b.kind === "choice") out.push(...list((v.options ?? []).map((o) => `${o.name}: ${o.tradeoff}`), "  -"))
    }
    return out
  }
  const kids = g.children ?? []
  const chose = unique(below.flatMap((l) => fill[l.path]?.chose ?? []))
  const risks = unique(below.flatMap((l) => (fill[l.path]?.risk ? [fill[l.path]!.risk!] : [])))
  out.push("", `**Summary:** ${own.in_short ?? ""}`)
  if (kids.length > 1)
    out.push(
      "",
      "**Covers:**",
      ...list(
        kids.map((c, i) => {
          const v = fill[`${path}.${i + 1}`] ?? {}
          return `${c.title}: ${v.in_short ?? ""}${c.kind === "choice" ? ` (recommended: ${v.recommended})` : ""}`
        }),
      ),
    )
  if (chose.length) out.push("", "**Team chose:**", ...list(chose))
  if (risks.length) out.push("", "**Risk:**", ...list(risks))
  out.push("")
  for (const [i, c] of kids.entries()) out.push(...detail(c, `${path}.${i + 1}`, fill, kids.length < 2), "")
  return out
}

/** The document as markdown, in the shape the review, the revisions and the later stages read. */
export function renderDoc(title: string, tree: Block[], fill: FillMap): string {
  return [`# ${title}`, "", ...tree.flatMap((g, i) => [...section(g, i + 1, fill), ""])].join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n"
}
