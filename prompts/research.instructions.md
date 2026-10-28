## The research report

Answer the research question with evidence. Every claim rests on a source the reader can open: `path:line` (with a short verbatim excerpt for key claims), a file the user named, or a URL. Mark what you infer as inference. When a source speculates ("could", "may", plans, predictions), say so instead of stating it as fact.

**Mode** (the brief states it):
- **descriptive** (the default): document what IS, not what SHOULD BE. Describe what exists, where it exists, how it works and how the parts interact. Don't suggest improvements, critique, look for root causes or recommend anything unless the user asked for it.
- **evaluative** (only when the user asked to compare, choose or recommend): weigh the options against the user's criteria and recommend one, with the reason.

**Which source wins**: live code > config, tests and build files > the user's notes and docs > the web. When sources conflict, report both with their sources and say which you trust and why; don't silently pick one.

### Sections

1. **Research question**: the question as the brief states it, with its sub-questions.
2. **Summary**: the direct answer in a few lines, covering each sub-question.
3. **Key findings**: the most important facts, each with its source and how sure it is (confirmed in code / stated in docs or notes / inferred).
4. **Detailed findings**: one subsection per component or sub-question: what exists, where (`path:line`), and how it connects to the rest.
5. **How it fits together**: the flow or structure across the findings.
6. **Conflicts**: where the user's notes, docs or sources disagree with the code or with each other.
7. **Options and recommendation** (evaluative mode only): each option with its trade-offs against the user's criteria, then the recommendation and why.
8. **Gaps**: what was searched and not found, and what is still unknown. "Not found" is a finding.
9. **References**: `path:line` - what is there. Number web sources [1], [2], … in order of first use, without gaps, and cite them inline.
10. **Open questions**: what further research would settle.

The structure can bend to the question: a question that asks for a list can be just the list; a comparison can be intro, option A, option B, comparison, conclusion. Always keep the Summary, Gaps, References and Open questions. Write plainly: no self-reference ("I searched…") and no commentary about the process in the report.

**Follow-ups**: when the report already exists and the user asks more, keep it and append a `## Follow-up <date>: <topic>` section with the new findings; update the Summary if the answer changed.

### Self-review before you report

- Each sub-question in the brief is answered, or listed under Gaps.
- Each claim has a source, and the key `path:line` references match the findings.
- Nothing goes beyond the evidence; in descriptive mode there are no recommendations.
