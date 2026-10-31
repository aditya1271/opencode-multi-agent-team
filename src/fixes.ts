// A report refused for what code checks (a missing line, a misquoted block) is kept: the writer sends only the
// missing parts, by fix id, and the plugin puts each in its place. Nothing is written twice.

import { CITE, FENCE, type QuotedBlock } from "./quotes.ts"
import { RECOMMENDED_LINE, SUMMARY_LINE, titleOf, type Section } from "./sections.ts"

export interface Fix {
  id: string
  kind: "recommended" | "summary" | "purpose" | "block"
  /** What to send, as the refusal says it. */
  ask: string
  /** Line index the fix goes at: the section's last line, its heading, the step line, or the block's opening fence. */
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
        ? `\`${b.line}\` isn't in the file`
        : b.verdict === "shortened"
          ? `lines are left out with "..."`
          : b.verdict === "unchecked"
            ? b.cite
              ? "there is no such file"
              : "it has no `path:line` just above it (command output goes in an `output` block instead)"
            : undefined
    return why ? [{ kind: "block" as const, at: b.from, end: b.to, citeAt: b.citeAt, cite: b.cite, ask: `${where}: ${why}; ${again}.` }] : []
  })
}

/** Numbers the fixes F1, F2, … */
export const numbered = (fixes: Omit<Fix, "id">[]): Fix[] => fixes.map((f, i) => ({ ...f, id: `F${i + 1}` }))

/** The refusal: the report is kept, and only these parts are asked for. */
export function fixRequest(fixes: Fix[], intro: string): string {
  return [
    `${intro} The plugin keeps your report, so don't send it again. Call \`report\` with the same status and \`fixes\` only: one { id, text } for each item, and the plugin puts each text in its place.`,
    ...fixes.map((f) => `- ${f.id}: ${f.ask}`),
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
  const todo = given.filter((g) => byId.has(g.id)).sort((a, b) => rank(b) - rank(a))
  for (const g of todo) {
    const f = byId.get(g.id)!
    const text = g.text.trim()
    if (f.kind === "recommended") lines.splice(f.at + 1, 0, "", RECOMMENDED_LINE.test(text) ? text : `**Recommended:** ${text}`)
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
