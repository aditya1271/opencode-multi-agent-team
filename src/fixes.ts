// A report refused for what code checks (a missing line, a misquoted block) is kept: the writer sends only the
// missing parts, by fix id, and the plugin puts each in its place. Nothing is written twice.

import { CITE, FENCE, type QuotedBlock } from "./quotes.ts"
import { RECOMMENDED_LINE, SUMMARY_LINE, titleOf, type Section } from "./sections.ts"

export interface Fix {
  id: string
  kind: "recommended" | "summary" | "purpose" | "block" | "line" | "append" | "evidence"
  /** What to send, as the refusal says it. */
  ask: string
  /**
   * Line index the fix goes at: the section's last line, its heading, the step line, the block's opening fence, the
   * line it replaces (line), or the line it goes after (append).
   */
  at: number
  /** block: its closing fence, and the line with its citation. */
  end?: number
  citeAt?: number
  cite?: string
}

export interface GivenFix {
  id: string
  text: string
}

/** The section's last line with text. */
const lastLine = (s: Section) => s.line! + s.text.replace(/\s+$/, "").split("\n").length - 1

/** Fixes for sections the user reviews: a missing Recommended or Summary line, a step with no purpose. */
export function sectionFixes(unrecommended: Section[], unsummarized: Section[]): Omit<Fix, "id">[] {
  return [
    ...unsummarized.map((s) =>
      s.step
        ? { kind: "purpose" as const, at: s.line!, ask: `step "${titleOf(s)}" has no purpose after its title: send one sentence on what the step achieves.` }
        : { kind: "summary" as const, at: s.line!, ask: `section "${titleOf(s)}" has no Summary line: send "**Summary:** <1-3 plain sentences: the direction and why, not the mechanics>".` },
    ),
    ...unrecommended.map((s) => ({
      kind: "recommended" as const,
      at: lastLine(s),
      ask: `section "${titleOf(s)}" has no Recommended line: send "**Recommended:** <option>: <short reason>" (several choices: the pick for each; nothing to decide: "**Recommended:** as written").`,
    })),
  ].sort((a, b) => a.at - b.at)
}

/** Fixes for the Intern's code blocks that don't match the files they cite. */
export function blockFixes(blocks: QuotedBlock[]): Omit<Fix, "id">[] {
  const again = "send the `path:line` and the code block again, copied complete and exact from the file (one unbroken line range, no \"...\")"
  return blocks.flatMap((b, i) => {
    const where = b.cite ? `block ${i + 1} (\`${b.cite}\`)` : `block ${i + 1}`
    const why =
      b.verdict === "bad"
        ? b.cite
          ? `\`${b.line}\` isn't in the file`
          : `\`${b.line}\` isn't in anything your tools showed you`
        : b.verdict === "shortened"
          ? `lines are left out with "..."`
          : b.verdict === "unchecked"
            ? b.cite
              ? "there is no such file"
              : "it has no `path:line` just above it (command output goes in an `output` block instead)"
            : undefined
    const resend = b.verdict === "bad" && !b.cite ? "send it again as the command printed it, or an empty text to drop it" : again
    return why ? [{ kind: "block" as const, at: b.from, end: b.to, citeAt: b.citeAt, cite: b.cite, ask: `${where}: ${why}; ${resend}.` }] : []
  })
}

/** Fixes for verdict lines (one per id): a wrong line is sent again whole, a missing one is added after the others. */
export function lineFixes(problems: { ask: string; at?: number; after: number }[]): Omit<Fix, "id">[] {
  const seen = new Set<number>()
  return problems.flatMap((p): Omit<Fix, "id">[] => {
    if (p.at === undefined) return [{ kind: "append" as const, at: p.after, ask: p.ask }]
    if (seen.has(p.at)) return []
    seen.add(p.at)
    return [{ kind: "line" as const, at: p.at, ask: p.ask }]
  })
}

/** Numbers the fixes F1, F2, … */
export const numbered = (fixes: Omit<Fix, "id">[]): Fix[] => fixes.map((f, i) => ({ ...f, id: `F${i + 1}` }))

/** The refusal: the report is kept, and only these parts are asked for. */
export function fixRequest(fixes: Fix[], intro: string): string {
  const sends = [fixes.some((f) => f.kind !== "evidence") && "`fixes` (one { id, text } for each F item)", fixes.some((f) => f.kind === "evidence") && "`evidence` (a list of { id, file, first, last, line } for each evidence item below)"].filter(Boolean)
  return [
    `${intro} The plugin keeps your report, so don't send it again. Call \`report\` with the same status and only ${sends.join(" and ")}; the plugin puts each in its place.`,
    ...fixes.map((f) => (f.kind === "evidence" ? `- evidence ${f.ask}` : `- ${f.id}: ${f.ask}`)),
  ].join("\n")
}

/** The kept report's content with the given fixes in place; ids not asked for are returned as unknown. */
export function applyFixes(content: string, fixes: Fix[], given: GivenFix[]): { content: string; unknown: string[] } {
  const byId = new Map(fixes.map((f) => [f.id, f]))
  const unknown = given.filter((g) => !byId.has(g.id)).map((g) => g.id)
  const lines = content.split("\n")
  // From the bottom up, so each fix's line index still holds.
  // At the same line a Recommended line goes in first, so a Summary added there lands above it.
  const rank = (g: GivenFix) => byId.get(g.id)!.at * 2 + (byId.get(g.id)!.kind === "recommended" ? 1 : 0)
  const todo = given.filter((g) => byId.has(g.id) && byId.get(g.id)!.kind !== "evidence").sort((a, b) => rank(b) - rank(a))
  // Added lines go in together, in the order given.
  const appends = given.filter((g) => byId.get(g.id)?.kind === "append")
  let appended = false
  for (const g of todo) {
    const f = byId.get(g.id)!
    const text = g.text.trim()
    if (f.kind === "append") {
      if (!appended) lines.splice(f.at + 1, 0, ...appends.map((a) => a.text.trim()))
      appended = true
    } else if (f.kind === "line") lines[f.at] = text
    else if (f.kind === "recommended") lines.splice(f.at + 1, 0, "", RECOMMENDED_LINE.test(text) ? text : `**Recommended:** ${text}`)
    else if (f.kind === "summary") lines.splice(f.at + 1, 0, "", SUMMARY_LINE.test(text) ? text : `**Summary:** ${text}`)
    else if (f.kind === "purpose") {
      const title = /^\d+\.\s+\*\*.+?\*\*/.exec(lines[f.at]!)?.[0] ?? lines[f.at]!
      lines[f.at] = `${title}: ${text.replace(/^\d+\.\s+\*\*.+?\*\*\s*[:.—–-]?\s*/, "")}`
    } else replaceBlock(lines, f, text)
  }
  return { content: lines.join("\n"), unknown }
}

/** A block sent again: its code replaces the old block, and its citation the old one. */
function replaceBlock(lines: string[], f: Fix, text: string) {
  const given = text.split("\n")
  const open = given.findIndex((l) => FENCE.test(l))
  const close = open < 0 ? -1 : given.findIndex((l, i) => i > open && FENCE.test(l))
  if (open < 0 || close < 0) {
    lines.splice(f.at, f.end! - f.at + 1, ...given)
    return
  }
  const cite = [...given.slice(0, open).join("\n").matchAll(CITE)].at(-1)?.[0]
  lines.splice(f.at, f.end! - f.at + 1, ...given.slice(open, close + 1))
  if (cite && f.citeAt !== undefined && f.cite) lines[f.citeAt] = lines[f.citeAt]!.replace(f.cite, cite)
  else if (cite) lines.splice(f.at, 0, `\`${cite}\``)
}
