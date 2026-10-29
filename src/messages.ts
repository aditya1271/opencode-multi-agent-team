// What the agents and the manager are told: per-mode hand-off prompts and the team tool's results.
import path from "node:path"
import { workflowInstructions } from "./agents.ts"
import type { Config } from "./config.ts"
import { needInfoLimit } from "./report.ts"
import { annotate, ensureIndex, idRanges, split, type SectionIndex } from "./sections.ts"
import { answerFiles, answersName, autoDecides, briefName, draftIsDoc, isDocWorkflow, MODE_ROLE, readTaskFile, type Pending, type TaskState } from "./state.ts"
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

/** The "## Research brief" section of Lead's brief, else the whole brief. */
export const researchBrief = (brief: string): string => section(brief, "Research brief") || brief.trim()

/** At most `max` lines of a section shown in chat; the rest stays in the file. */
const clip = (text: string, max = 40) => {
  const lines = text.split("\n")
  return lines.length <= max ? text : `${lines.slice(0, max).join("\n")}\n… (${lines.length - max} more lines in the file)`
}

/** The Architect's current draft: research report, what-document or how-document / plan. */
export const docName = (task: TaskState) =>
  task.workflow === "research" ? "research report" : task.stage === "what" ? "what-document" : task.workflow === "plan" && !task.stage ? "plan document" : task.workflow === "plan" ? "how-document" : "plan"

/** The Architect's latest draft file in this task. */
export const draftFile = (task: TaskState) => (draftIsDoc(task) ? `doc-${task.doc}.md` : `plan-${task.plan}.md`)

/** Section ids of Lead's brief or the Architect's latest draft, kept in the task (a new draft starts over). */
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

/** The sections a revision may change, for the writer (and for Lead's revision brief). */
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
    .map(({ s, id }) => `- ${id} ${s.title}${idx.final.includes(id) ? " ✅" : ""}`)
  return clip(lines.join("\n"), 40)
}

/** What the last revision changed and which sections are final, with how to mark them, for the user. */
function changeLine(task: TaskState): string {
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

const FEASIBILITY =
  "Feasibility: note it only for a concept that could kill the idea or force a different one, and that isn't plainly known (work nobody here has done before, an assumption about how parts fit, a solution assumed to exist). Swappable mechanics (how a model or service is connected, which parser or file format, storage, configuration) get no feasibility note and no options: one line, \"left to the how stage\". In a code project, code facts count: what language, standard, build system, interface or platform the code where the feature goes supports, quoted with `path:line`."

const LEAD_WHAT = [
  "Stage: WHAT. This stage decides what to build and how it behaves as a process, independent of code: no files, functions, interfaces, storage, flags or tests. The implementation plan comes later, after the user approves the what-document.",
  "Read every file the request names in full first, then what they connect to (material, code). Read to understand the problem; code matters here only where it rules a behaviour in or out.",
  "The Architect has no file access: your brief and your later answers are all it knows. Quote, don't paraphrase.",
  [
    "Write `content` in two parts. First `## Concept brief` (the user may read it before the Architect writes):",
    "- **Concerns**: the concepts that decide whether the result is good. The ones the user named or stressed first, in their framing; then ones they didn't mention but should consider. The user's material is a starting point, not the boundary: think beyond it. For each: why it matters (with the source when the user's material says so), and 2-3 approaches with what each trades off. No pick unless the material settles it.",
    `- ${FEASIBILITY}`,
    "- **Assumptions**: defaults you'd take where nothing settles a point, each marked as assumed.",
    "Then `## Excerpts`: the verbatim passages (with `path:line` or file and heading) the Architect needs, grouped by concern. Nothing else: don't restate the request, the Architect gets it.",
  ].join("\n"),
].join("\n\n")

const ADVICE_RULES = [
  "Read the user's comments across all rounds: what do they keep asking for that the draft still doesn't give? Think independently: the user's material and examples are a starting point, not the boundary. Look for concerns, approaches, edge cases and failure modes nobody has named yet.",
  "Report ADVICE: `items` holds one concrete instruction per entry (what to add, explore, change or drop, and why), most important first; the plugin numbers them ADV1, ADV2, …. `content`: your diagnosis in a few lines (why the draft keeps missing).",
  "You have no file access. When you need a fact from the code or the user's files, report ASK with your questions for Lead first.",
].join("\n\n")

const LEAD_ASK =
  "Report QUESTIONS only for decisions that belong to the user and change what gets built: at most 4, most important first, each with the options, your recommended option, and why the answer matters. Anything with a sensible default is not a question: put it in the brief as an assumption."

const LEAD_PLAN = join("Workflow: plan. Nobody edits files in this task, and there is no build or test. Report ESCALATE with the brief.", LEAD_WHAT, LEAD_ASK)

const LEAD_CODE = [
  "Workflow: code. Decide TRIVIAL or ESCALATE (see your instructions). For ESCALATE, set `what`:",
  "- **settled**: the request already fixes the behaviour (\"add a --upper flag that uppercases the output\"); only the implementation is open. Write the how brief below, starting with `## Why the behaviour is settled` (one or two lines). The plan will start with a short Behaviour section instead of a separate what-document.",
  "- **open**: what the feature should do, as a process, is still to decide (a new feature, several valid behaviours). Write the what brief below. The user approves the behaviour before anyone plans code.",
  "When unsure, it is open.",
].join("\n")

const HOW_BRIEF = [
  "Stage: HOW. Brief the Architect for the change plan. The Architect has no file access: your brief and your later answers are all it knows, so search the code until every place the change touches can be shown.",
  [
    "Write `content` with:",
    "- `## Code`: each location that will change, as `path:start-end` with the current code excerpt (exact lines), and the patterns or analogous features the change should follow.",
    "- `## Impact`: for each location, what depends on it: callers, users of the interface, build files, tests, other modules, found with your code-search tools or grep and listed with `path:line`. Say \"no other users\" only after you searched.",
    "- `## Constraints`: code facts that limit the change (language and standard, build system, platform, public interfaces).",
    "Don't restate the request or the what-document; the Architect gets both.",
  ].join("\n"),
].join("\n\n")

const LEAD_INFEASIBLE =
  "If a decision of the what-document can't work in this code, report INFEASIBLE: which decision, the evidence (`path:line`, excerpt), and what would work instead. Don't quietly plan around it."

const LEAD_REVISION = [
  "MODE: revision. The user commented on the {doc} below. Don't rewrite it; brief the Architect, who revises it.",
  "Where the comments give examples, treat them as examples: find every place in the document with the same problem, not only the ones named. Check the files the request names, and the code or material they connect to, where the comments need it.",
  "The Architect has no file access: quote what it needs (`path:line`, excerpt). Don't repeat what your earlier brief and answers already hold; point to them.",
  "Report ESCALATE with the revision brief: each change, with the section it applies to, what is wrong and what it should become; the places you found beyond the ones named; and what must stay as it is.",
  "Report QUESTIONS only if a comment leaves open a decision that belongs to the user: at most 4, each with the options, your recommended option, and why the answer matters.",
].join("\n\n")

const LEAD_ANSWER = [
  "MODE: answer. {asker} has no file access and asks you the questions below. Look up what you need.",
  "Report ANSWER. `content` answers each question under its id (\"### A3\"), with only new facts: exact quotes with `path:line`, or what you searched when something isn't there. Where your brief or an earlier answer already holds it, point to it (\"see brief.md, Excerpts: glossary\") instead of repeating it. When a question is a decision for the user, say so under its id.",
].join("\n\n")

const LEAD_RESEARCH = [
  "Workflow: research. The deliverable is a findings report, not code: nobody edits files in this task, and there is no build or test.",
  "Read every file the request names in full first, then run a few searches to see where the answer lives.",
  "Size the research (`depth`):\n- **quick**: one focused question with one direct path to the answer.\n- **breadth**: splits into distinct, independent sub-questions.\n- **depth**: one question that needs several angles or sources.",
  [
    "Write `content` in two parts. First `## Research brief`, phrased from the user's point of view:",
    "- the question, and the sub-questions that together answer it",
    "- every detail and preference the user gave; dimensions they didn't state are open-ended, not invented",
    "- mode: **descriptive** (document what exists; the default) or **evaluative** (compare and recommend; only when the user asked to compare, choose or recommend)",
    "- where to look (paths, the user's files; the web only if you have web tools) and what is out of scope",
    "Then `## Findings so far`: what you found, with `path:line` and short verbatim excerpts.",
  ].join("\n"),
  "Report ESCALATE with `depth`. Report QUESTIONS (one round at most) only when the question itself is unclear: unknown terms or acronyms, or a choice only the user can make. Don't ask for what the user already gave.",
].join("\n\n")

const INTERN_RESEARCH =
  "MODE: research search for the Architect. Return evidence, not prose. For each query, a list of records: **claim** (one fact), **source** (`path:line`, the file, or the URL), **excerpt** (the few lines, verbatim; don't paraphrase or summarize them). \"Not found\" is a finding: say what you searched. When sources conflict, give both. When a source speculates (\"could\", \"may\", plans), say so. Stop a query when your last two searches added nothing new. Report FOUND, or NOT_FOUND with what you searched."

const REVIEW_PLAN = [
  "Part 1, can it be built as written. Check that each reference the document makes is backed by the brief, Lead's answers or the user's words, and says what the document claims. Simulate building 2-3 representative parts as a capable builder who cannot talk to the author: where would you have to guess, and would a wrong guess matter (more than about 10% guesswork)? Check that every requirement and constraint in the request maps to a decision and to a verification, that acceptance criteria are observable, and that names and interfaces are consistent. Skip anything the document explicitly leaves to the builder, anything a builder could reasonably decide alone, and wording nitpicks.",
  "Part 2, is it the right design. Were the strongest alternative and \"use what exists\" weighed? Is anything built that the request doesn't need (layers, options, future-proofing)? Are the risks named, and are the assumed decisions reasonable defaults? Here you may disagree with the approach: say concretely what you would do instead and why.",
].join("\n\n")

const REVIEW_RESEARCH = [
  "Part 1, the evidence. Spot-check the key references against the findings and the brief: are they there, and do they say what is claimed? Every sub-question of the brief is answered or listed under Gaps; no claim goes beyond its source; conflicts are reported, not hidden; speculation is flagged; descriptive mode has no recommendations.",
  "Part 2, is it the right answer. Are there sources or angles it missed that would change the conclusion? In evaluative mode, does the recommendation follow from the evidence?",
].join("\n\n")

export const checksText = (commands: string) =>
  [
    "# Build and test commands",
    "Only Developer runs them; the other agents don't build or test, they put these commands into the instruction or plan as check commands. Use only these; don't look for other ways to build or test. If they don't cover what is needed, the planner asks the user (QUESTIONS) and Developer reports BLOCKED.",
    commands,
  ].join("\n\n")

export const SKIP_CHECKS = [
  "# Build and test: skipped",
  "The user chose to skip build and test for this task. Don't build, don't run tests, and don't look for how to.",
  "Plans and the trivial instruction give `none` as the check. Developer reports DONE once the edits are made (checkCommand `none`).",
].join("\n\n")


export function buildPrompt(config: Config, task: TaskState, p: Pending, freshSession: boolean): string {
  const f = (name: string) => fileBlock(task, name)
  const latest = (kind: string) => (task.seq[kind] ? f(`${kind}-${task.seq[kind]}.md`) : "")
  const edited = task.editedFiles.length ? `Files changed so far (kept): ${task.editedFiles.join(", ")}` : "No files changed so far."
  /** Lead's brief for the stage and its answers to questions so far. */
  const stageBrief = () => join(f(briefName(task)), ...answerFiles(task).map(f))
  const answers = () => f(answersName(task))
  /** The how stage starts from the approved what-document only, not the research behind it. */
  const whatDoc = () => (task.stage === "how" && task.doc ? join("The approved what-document:", f(`doc-${task.doc}.md`)) : "")
  const delivered = () => (p.files ?? []).map(f)
  const capNote = (): string | false => {
    const notes: string[] = []
    if (task.needInfo >= needInfoLimit(config, task))
      notes.push(
        task.workflow === "research"
          ? "The search limit is reached: write the document with what you have, and list what is missing."
          : "The limit for questions to Lead is reached: work with what you have, and list what is missing.",
      )
    if (task.questionRounds >= config.limits.questionsPerTask) notes.push("The question limit is reached: decide with what you have.")
    return notes.length ? notes.join(" ") : false
  }
  switch (p.mode) {
    case "lead":
      if (p.revision)
        return join(
          LEAD_REVISION.replaceAll("{doc}", `${docName(task)} (${draftFile(task)})`),
          freshSession && join(f("request.md"), whatDoc(), stageBrief(), answers()),
          f(draftFile(task)),
          ...delivered(),
          `The user's comments:\n${p.note ?? ""}`,
          task.scope && join(scopeText(task, false), "Brief only the REVISE, FINE-TUNE and new sections; the Architect returns only those. For FINE-TUNE, pass on the user's exact edit and nothing more."),
          capNote(),
        )
      if (!freshSession && p.note) return join(p.note, ...delivered(), capNote())
      if (task.stage === "how")
        return join(
          `Task ${task.id}: ${task.doc ? "the user approved the what-document below. " : ""}Brief the Architect for the change plan. Report ESCALATE with the brief.`,
          HOW_BRIEF,
          !!task.doc && LEAD_INFEASIBLE,
          f("request.md"),
          f("checks.md"),
          whatDoc(),
          answers(),
          ...delivered(),
          p.note,
          capNote(),
        )
      return join(
        `Task ${task.id}: sort this request and report.`,
        task.workflow === "plan" && LEAD_PLAN,
        task.workflow === "research" && LEAD_RESEARCH,
        !task.workflow && task.stage === "what" && join("Workflow: code. Report ESCALATE with the what brief.", LEAD_WHAT, LEAD_ASK),
        !task.workflow &&
          !task.stage &&
          join(
            LEAD_CODE,
            task.forcePlan && "The user asked for a plan: don't choose TRIVIAL.",
            `### The what brief (what: open)\n\n${LEAD_WHAT}`,
            `### The how brief (what: settled)\n\n${HOW_BRIEF}`,
            LEAD_ASK,
          ),
        f("request.md"), f("checks.md"), answers(), p.note, capNote())
    case "architect_advice":
    case "principal_draft_advice": {
      if (!freshSession && p.note) return join(p.note, ...delivered(), "Now report ADVICE.")
      const writer = p.advise === "architect" ? "the Architect" : "Lead"
      const draft = p.advise === "architect" ? `${docName(task)} (${draftFile(task)})` : `${task.workflow === "research" ? "research" : "concept"} brief (${briefName(task)})`
      const earlier = (task.adviceFiles ?? []).map(f)
      return join(
        `MODE: advice. ${writer} wrote the ${draft} below, and the user has sent it back ${task.commentRounds ?? 0} time(s). Don't rewrite it. Find why it keeps missing what the user wants, and tell ${writer} what to do differently; ${writer} revises it.`,
        ADVICE_RULES,
        earlier.length > 0 && "Earlier advice on this draft is below: say why it wasn't enough, and don't repeat it.",
        f("request.md"),
        whatDoc(),
        stageBrief(),
        answers(),
        p.advise === "architect" && f(draftFile(task)),
        ...earlier,
        ...delivered(),
        p.note && `Latest:\n${p.note}`,
        task.scope && join(scopeText(task, false), "Advise on the REVISE and new sections; final ones stay as they are."),
      )
    }
    case "lead_answer": {
      const head = LEAD_ANSWER.replace("{asker}", MODE_ROLE[p.asker ?? "architect"] === "architect" ? "The Architect" : "Principal")
      if (!freshSession) return join(head, p.note)
      return join(head, f("request.md"), whatDoc(), stageBrief(), answers(), p.note)
    }
    case "lead_fail":
      return join(
        "MODE: failure. The trivial attempt did not finish. The request fixes the behaviour; brief the Architect for the change plan, and say why it is not trivial and which edits were kept. Report ESCALATE.",
        HOW_BRIEF,
        edited,
        f("request.md"),
        f("checks.md"),
        f("answers.md"),
        f("brief.md"),
        latest("report"),
        latest("analysis"),
      )
    case "fix_trivial":
      return join(
        task.skipChecks
          ? "Make this trivial change. Build and test are skipped: don't run them. Report DONE when the edit is made, or FAILED / BLOCKED."
          : "Make this trivial change. Run the check command, and iterate until it passes or you are stuck. Report DONE with checkCommand, or FAILED / BLOCKED.",
        f("request.md"),
        f("checks.md"),
        f("brief.md"),
      )
    case "review_trivial":
      return join(
        `MODE: review. A trivial change touched more than one file. Check the changes against the request and the instruction. Changed files: ${task.editedFiles.join(", ")}. Use git diff or p4 diff to see them. Report PASS, or ISSUES with instructions for Developer.`,
        f("request.md"),
        f("checks.md"),
        f("answers.md"),
        f("brief.md"),
        latest("report"),
      )
    case "architect": {
      const unseen = [...new Set(task.architectUnseen)]
      task.architectUnseen = []
      if (freshSession) {
        // A fresh session gets each file of this stage once, and only the latest draft.
        const given = new Set([briefName(task), ...answerFiles(task), answersName(task)])
        const stageFiles = task.history.filter((h) => h.stageRun === task.stageRun && h.file).map((h) => h.file!)
        const isDraft = (x: string) => /^(doc|plan)-\d+\.md$/.test(x)
        const draft = stageFiles.filter(isDraft).at(-1)
        // Advice and stuck notes on an earlier document (the brief) are already worked into it.
        const stale = (x: string) => /^(advice|stuck)-\d+\.md$/.test(x) && !(task.adviceFiles ?? []).includes(x) && !unseen.includes(x)
        const others = [...new Set([...stageFiles, ...unseen])].filter((x) => !given.has(x) && !isDraft(x) && !stale(x))
        return join(
          `Task ${task.id}: write the ${docName(task)} for this request.`,
          architectHandoff(config, task),
          f("request.md"),
          task.stage !== "what" && f("checks.md"),
          whatDoc(),
          stageBrief(),
          answers(),
          ...others.map(f),
          draft && join(`Your latest draft (${draft}):`, f(draft)),
          p.note,
          capNote(),
        )
      }
      return join("New information since your last call:", ...unseen.map(f), p.note, capNote(), "Report again.")
    }
    case "intern":
      if (task.workflow === "research") return join(INTERN_RESEARCH, `<queries>\n${p.note ?? ""}\n</queries>`)
      return join(
        "MODE: planner search. Answer these queries for the Architect with path:line findings and short code excerpts. Report FOUND, or NOT_FOUND with what you searched.",
        `<queries>\n${p.note ?? ""}\n</queries>`,
      )
    case "principal_review":
      if (!freshSession && p.note) return join(p.note, ...delivered(), "Report again.", capNote())
      return join(
        "MODE: review of a destructive plan. Check that the destructive or irreversible steps are necessary and safe, and that nothing is lost. Report APPROVE (optional notes) or CHANGES (what must change and why), or ASK Lead for a fact you need.",
        f("request.md"),
        f("checks.md"),
        answers(),
        whatDoc(),
        stageBrief(),
        f(`plan-${task.plan}.md`),
      )
    case "principal_advice": {
      if (!freshSession && p.note) return join(p.note, ...delivered(), "Now give your advice (ADVICE), or report QUESTIONS if a decision still belongs to the user.", capNote())
      const plans = Array.from({ length: task.seq.plan ?? 0 }, (_, i) => f(`plan-${i + 1}.md`))
      return join(
        `MODE: advice. The task is stuck: ${p.note ?? ""}. Say which approach the Architect should take (ADVICE), or, if the decision belongs to the user, report QUESTIONS. ASK Lead for a fact you need.`,
        f("request.md"),
        f("checks.md"),
        whatDoc(),
        stageBrief(),
        answers(),
        ...plans,
        latest("report"),
        latest("analysis"),
        latest("escalation"),
        capNote(),
      )
    }
    case "fix": {
      const head = `Plan ${task.plan}, step ${task.step} of ${task.planSteps}${task.step === task.planSteps ? " (the final check)" : ""}.`
      const rules = task.skipChecks
        ? "Do only this step. Build and test are skipped: don't run them. Report DONE when the step's edits are made, FAILED when stuck, or BLOCKED when the step can't work as written."
        : "Do only this step. Iterate freely until its check command passes. Report DONE with checkCommand, FAILED when stuck, or BLOCKED when the step can't work as written."
      if (!task.developerSeenPlan) {
        task.developerSeenPlan = true
        return join(`Carry out this plan one step at a time. ${head}`, rules, f(`plan-${task.plan}.md`), f("checks.md"), p.note)
      }
      return join(head, p.note, rules)
    }
    case "diagnose": {
      const stepFiles = task.history.filter((h) => h.plan === task.plan && h.step === task.step && h.file).map((h) => f(h.file!))
      return join(
        `MODE: diagnosis. Developer is stuck on step ${task.step} of plan ${task.plan}. Below is the step's whole attempt history.`,
        task.latestLog ? `The latest full build/test log: ${task.latestLog} (read it as needed).` : "",
        "Decide: LOCAL (Developer can fix it; give exact instructions), REPLAN (the plan is wrong, or the step is going in circles), or ESCALATE (cause unclear). If the same error came back or a fix undid an earlier one, do not answer LOCAL.",
        f(`plan-${task.plan}.md`),
        f("checks.md"),
        ...stepFiles,
      )
    }
    case "review": {
      const reports = task.history.filter((h) => h.plan === task.plan && h.mode === "fix" && h.file).map((h) => f(h.file!))
      return join(
        `MODE: review. Plan ${task.plan} is finished${task.skipChecks ? " (build and test skipped by the user)" : " and its final check passed"}. Compare the changes with the plan and the request. The user's answers and comments settle the request's open points. Changed files: ${task.editedFiles.join(", ")}. Use git diff or p4 diff to see them. Report PASS, or ISSUES with instructions for Developer.`,
        f("request.md"),
        f("checks.md"),
        answers(),
        whatDoc(),
        f(`plan-${task.plan}.md`),
        ...reports.slice(-4),
      )
    }
    case "lead_reply":
    case "architect_reply":
    case "principal_reply": {
      const rules =
        "MODE: user question. The task is waiting on the user, who asks you this before they answer or decide. Answer it in content: clear and specific, with pros, cons and impact when they ask about options. Don't revise the plan, ask questions or start new work. Report ANSWER."
      const question = p.note ?? ""
      if (!freshSession) return join(rules, question)
      const draft = (draftIsDoc(task) ? task.doc : task.plan) ? f(draftFile(task)) : ""
      return join(rules, f("request.md"), whatDoc(), stageBrief(), answers(), draft, question)
    }
    case "principal_doc_review": {
      if (!freshSession && p.note && p.files?.length) return join(p.note, ...delivered(), "Report again.", capNote())
      const research = task.workflow === "research"
      const file = draftFile(task)
      const what = `the ${docName(task)}${draftIsDoc(task) ? "" : ` (plan ${task.plan})`}`
      const standard = workflowInstructions(config, research ? "research" : draftIsDoc(task) ? "what" : "how")
      return join(
        `MODE: critical review of ${what} (${file}), asked for by the user (review ${task.reviews ?? 1} of at most ${config.limits.principalReviews}). Review it in two parts, and keep them apart in your report.`,
        research ? REVIEW_RESEARCH : REVIEW_PLAN,
        "Report APPROVE when it holds as written (content: optional notes for the user), or CHANGES: at most 5 must-fix items, most important first, each with where, the problem and the fix; then any should-consider items, marked as such. Don't rewrite the document.",
        "You have no file access: check claims against the brief, Lead's answers and the findings. When a claim matters and nothing quotes it, ASK Lead for the exact quote.",
        p.note && `What the user asked the review to look at:\n${p.note}`,
        f("request.md"),
        answers(),
        whatDoc(),
        stageBrief(),
        standard && `<standard>\n${standard}\n</standard>`,
        ...task.history.filter((h) => h.mode === "principal_doc_review" && h.file).map((h) => f(h.file!)),
        f(file),
      )
    }
  }
}

/** What the Architect is told about its draft in this stage: the status to report and the standard. */
function architectHandoff(config: Config, task: TaskState): string {
  const ask =
    "When a fact is missing, report ASK with your questions for Lead in `questions` (one per item, unnumbered; the plugin numbers them A1, A2, …); Lead answers in a new file. When a decision belongs to the user and changes what gets built, report QUESTIONS, each with the options and your recommendation."
  if (task.workflow === "research")
    return join(
      "Write only from evidence: the brief's findings and the Intern's findings. When a sub-question lacks evidence, report NEED_INFO with precise queries for the Intern: for each, the objective, what to return, where to look and what is out of scope, with no overlap between queries. Stop searching when the last round added nothing new; list what is still missing under Gaps.",
      `Report DOC with the whole document in \`content\` (markdown); the plugin saves it to ${task.output}. \`summary\`: the first line says what the document gives the user ("Approving this gives you …").`,
      readTaskFile(task, "existing.md") && "That file already exists (below): keep it and append a `## Follow-up <date>: <topic>` section for the new question.",
      fileBlock(task, "existing.md"),
      `<standard>\n${workflowInstructions(config, "research")}\n</standard>`,
    )
  if (draftIsDoc(task))
    return join(
      "Stage: WHAT. Write the what-document: what the feature does, as a process, independent of code. The change plan comes after the user approves it.",
      ask,
      `Report DOC with the whole document in \`content\` (markdown)${task.output ? `; the plugin saves it to ${task.output}` : ""}. \`summary\`: the first line says what the user decides by approving ("Approving this settles …").`,
      readTaskFile(task, "existing.md") && "That file already exists (below): keep it and change only what the request asks for.",
      fileBlock(task, "existing.md"),
      `<standard>\n${workflowInstructions(config, "what")}\n</standard>`,
    )
  const plan = task.workflow === "plan"
  return join(
    `Stage: HOW. Write the change plan${task.doc ? " for the approved what-document" : ""}. Developer carries it out step by step${plan ? " once the user chooses [Implement it]; nobody edits files before that" : " once the user approves it"}.`,
    !task.doc && "There is no what-document: Lead found that the request fixes the behaviour (see the brief). Start the plan with a short `## Behaviour` section: what the change does, as the user will see it, in a few lines.",
    !!task.doc && "Follow every decision of the what-document. If one can't work in this code, report INFEASIBLE: which decision, the evidence from the brief or Lead's answers, and what would work instead. Never quietly change a decision.",
    ask,
    plan && !readTaskFile(task, "checks.md") && "No build or test commands are known yet: give each step's check as what it must prove, plus the command when the brief names one.",
    `Report PLAN with the whole plan in \`content\`${plan && task.output ? `; the plugin saves it to ${howOutput(task.output)}` : ""}.`,
    `<standard>\n${workflowInstructions(config, "how")}\n</standard>`,
  )
}

/** Where a plan task's how-document goes: next to the what-document. */
export const howOutput = (output: string) => {
  const ext = path.extname(output)
  return `${output.slice(0, output.length - ext.length)}.how${ext || ".md"}`
}

// ---- what the manager gets back ----

const REPLY_ROUTES =
  'a clear approval ("approve", "go ahead") → team "approve"; a clear stop → team "stop"; feedback, requests for changes or more work → polish and confirm [Send] [Edit] [Cancel], then team "change"; a question → polish and confirm, then team "ask"; a request for a (critical) review → team "review", with what the review should look at as text if they said.'

/** Principal's review shown at approval, marked when the plan or document was revised after it. */
function adviceLine(task: TaskState): string {
  return task.lastAdvice ? `**Revised following ${task.lastAdvice.role}'s advice** (${path.join(task.dir, task.lastAdvice.file)})` : ""
}

function principalBlock(task: TaskState): string {
  if (!task.principalNote) return ""
  const verdict = task.history.find((h) => h.file === task.principalNote)?.status
  const title = verdict === "CHANGES" ? "**Principal's review** (this version was revised to address it)" : "**Principal's notes**"
  return `${title}\n${readTaskFile(task, task.principalNote)}`
}

const AUTO_SEND = (level: string) =>
  `AUTO-SEND (${level} auto): wherever this says to polish and confirm [Send] [Edit] [Cancel], polish the user's text as usual, show it in one block as sent, and send it right away without asking. Build and test commands are still sent as typed.`

export function render(task: TaskState): string {
  const out = renderPhase(task)
  return task.auto ? join(out, AUTO_SEND(task.auto)) : out
}

function renderPhase(task: TaskState): string {
  const last = task.history[task.history.length - 1]
  const lastLine = last ? `${last.role} → ${last.status}: ${last.summary.split("\n")[0].replace(/[.\s]+$/, "")}` : "started"
  const files = task.editedFiles.length ? task.editedFiles.map((f) => `- ${f}`).join("\n") : "(none)"
  const attempts = `Attempts: ${task.attempts}/${task.attemptLimit}.`
  const usage = () => usageReport(task.usage, Math.max(1, task.planSteps))
  if (autoDecides(task)) {
    const next =
      task.phase === "checks"
        ? "skip build and test"
        : task.phase === "questions"
          ? `answer ${MODE_ROLE[task.questionsFrom ?? "lead"]}'s questions with the recommended options`
          : task.phase === "brief"
            ? "approve the brief"
            : `approve the ${draftIsDoc(task) ? docName(task) : "plan"}`
    return `PROGRESS: ${lastLine}. Next, on ${task.auto} auto: ${next}. ${attempts}\nNEXT ACTION: show this progress line to the user in one line, then call team with action "continue".`
  }
  const decided = task.autoLog?.length ? `**Decided on auto:**\n${task.autoLog.map((l) => `- ${l}`).join("\n")}` : ""
  switch (task.phase) {
    case "running": {
      const progress =
        task.pending?.mode === "fix" ? ` Next: developer, step ${task.step} of ${task.planSteps}.` : task.pending ? ` Next: ${MODE_ROLE[task.pending.mode]} (${task.pending.mode}).` : ""
      return `PROGRESS: ${lastLine}.${progress} ${attempts}\nNEXT ACTION: show this progress line to the user in one line, then call team with action "continue".`
    }
    case "checks":
      return join(
        "No build or test commands are configured for this project (checks.build / checks.test).",
        `NEXT ACTION: ask the user [Skip build/test] [Give commands] [Stop]. Skip → team "answer" with text "skip". Give commands → ask for the build and test commands as free text, then team "answer" with them word for word. Stop → team "stop".`,
      )
    case "questions":
      return join(
        `QUESTIONS from ${task.questionsFrom ? MODE_ROLE[task.questionsFrom] : "an agent"}:`,
        (task.questions ?? []).map((q, i) => `${i + 1}. ${q}`).join("\n"),
        `NEXT ACTION: ask the user these questions as free text (no fixed options). Polish their answer and confirm it [Send] [Edit] [Cancel], then call team with action "answer" and the confirmed answer. If they ask something back instead, polish and confirm it, then call team with action "ask".`,
      )
    case "brief": {
      const research = task.workflow === "research"
      const raw = readTaskFile(task, "brief.md")
      const idx = sectionIndex(task, "brief")
      const brief = idx ? annotate(raw, idx) : raw
      const title = research ? `**Research brief** (${task.depth ?? "?"} research)` : "**Concept brief**"
      const shown = research ? researchBrief(brief) : section(brief, "Concept brief") || brief
      return join(
        `${research ? "RESEARCH" : "CONCEPT"} BRIEF ready. Show this block to the user exactly as written:`,
        `<show>\n${join(title, shown, changeLine(task), adviceLine(task))}\n</show>`,
        `NEXT ACTION: show the block above and end with one line: "${research ? "Reply to start the research" : "Reply to have the what-document written"}, adjust the brief, or stop." No buttons. Then act on the reply: a clear go ("go", "looks good") → team "approve"; a clear stop → team "stop"; adjustments → polish and confirm [Send] [Edit] [Cancel], then team "change"; a question → polish and confirm, then team "ask".`,
        idx && SCOPE_RULE,
      )
    }
    case "approval": {
      const name = docName(task)
      const Name = `${name[0]!.toUpperCase()}${name.slice(1)}`
      if (draftIsDoc(task)) {
        const doc = readTaskFile(task, `doc-${task.doc}.md`)
        const research = task.workflow === "research"
        const decisions = !research && section(doc, "Decisions")
        const findings = research && section(doc, "Key findings")
        const conflicts = research && section(doc, "Conflicts")
        const block = join(
          `**${Name}** (version ${task.doc})`,
          `**What you get**\n${task.docSummary ?? "(no summary)"}`,
          task.infeasible && `**The how stage found a decision that can't work** (${task.infeasible})\n${clip(readTaskFile(task, task.infeasible), 30)}`,
          decisions ? `**Decisions**\n${clip(decisions)}` : "",
          findings ? `**Key findings**\n${clip(findings)}` : "",
          conflicts ? `**Conflicts between sources**\n${clip(conflicts, 20)}` : "",
          `**Sections**\n${idList(task, doc, false) || sectionTitles(doc).map((t) => `- ${t}`).join("\n") || "(none)"}`,
          changeLine(task),
          principalBlock(task),
          adviceLine(task),
          `**File:** ${task.output ?? path.join(task.dir, `doc-${task.doc}.md`)}`,
        )
        const reply =
          task.stage === "what"
            ? task.infeasible
              ? "Reply with how to change the what-document, approve it as it is (the team plans again), stop, ask about it, or have Principal review it."
              : "Reply to approve the behaviour (the team then plans the change), change or stop it, ask about it, or have Principal review it."
            : "Reply to approve, change or stop it, ask about it, or have Principal review it."
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
      const behaviour = section(planText, "Behaviour")
      const block = join(
        `**${howDoc ? `${Name} (plan ${task.plan})` : `Plan ${task.plan}`}**`,
        `**What you get**\n${task.planSummary ?? "(no summary)"}`,
        behaviour ? `**Behaviour**\n${clip(behaviour, 20)}` : "",
        `**Steps**\n${titles.length ? titles.join("\n") : `${task.planSteps} step(s); see the plan file.`}`,
        others && `**Other sections**\n${others}`,
        `**Risk:** ${task.planRisk ? "yes (destructive or irreversible steps)" : "no"}`,
        changeLine(task),
        principalBlock(task),
        task.auto === "safe" && task.planRisk && "**Safe auto stopped here:** this plan has destructive or irreversible steps, so it needs your approval.",
        decided,
        adviceLine(task),
        `**Plan file:** ${howDoc ?? path.join(task.dir, `plan-${task.plan}.md`)}`,
      )
      return join(
        `PLAN ${task.plan} ready for approval. Show this block to the user exactly as written, without rewording or shortening it:`,
        `<show>\n${block}\n</show>`,
        `NEXT ACTION: show the block above and end with one line: "${howDoc ? "Reply to approve (then you can implement it)" : "Reply to approve"}, change or stop the plan, ask about it, or have Principal review it." No buttons. Then act on the user's reply: ${REPLY_ROUTES}`,
        task.sections && SCOPE_RULE,
      )
    }
    case "stuck":
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
    case "budget":
      return join(
        `ATTEMPT BUDGET USED UP: ${task.attempts} agent calls. Last: ${lastLine}.`,
        task.pending ? `Left to do: ${task.pending.mode}${task.planSteps ? `, step ${task.step} of ${task.planSteps}` : ""}.` : "",
        `Files changed so far:\n${files}`,
        decided,
        usage(),
        `NEXT ACTION: show this to the user and ask [Continue +10 attempts] [Stop]. Continue → team "extend". Stop → team "stop".`,
      )
    case "done":
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
            : `NEXT ACTION: tell the user the result. A follow-up question on this report → polish and confirm it, then team "start" with output "${task.output}", so the answer is appended to the report.`,
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
    case "stopped":
      return join(
        isDocWorkflow(task)
          ? `STOPPED: task ${task.id}.${task.doc ? ` The latest ${docName(task)} is at ${task.output}.` : ""}`
          : `STOPPED: task ${task.id}. Files already edited stay as they are; nothing was reverted.`,
        `Files changed:\n${files}`,
        usage(),
        "NEXT ACTION: tell the user. They can resume it later (team \"resume\").",
      )
  }
}

function lastErrors(task: TaskState): string {
  const lastFail = [...task.history].reverse().find((h) => ["FAILED", "BLOCKED", "REPLAN", "ESCALATE", "ISSUES"].includes(h.status))
  return lastFail ? `Last problem (${lastFail.role}, ${lastFail.status}): ${lastFail.summary}` : ""
}
