// What the agents and the manager are told: per-mode hand-off prompts and the team tool's results.
import path from "node:path"
import { workflowInstructions } from "./agents.ts"
import type { Config } from "./config.ts"
import { allowedStatuses, needInfoLimit } from "./report.ts"
import { annotate, ensureIndex, idRanges, missingSummaries, oneLine, sectionBody, shortView, shownTitle, split, userView, walkIds, type Section, type SectionIndex } from "./sections.ts"
import { answerFiles, answersName, autoDecides, briefName, consultsUsed, draftIsDoc, isDocWorkflow, MODE_ROLE, readTaskFile, type Pending, type TaskState } from "./state.ts"
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

/** The "## Research brief" section of Analyst's brief, else the whole brief. */
export const researchBrief = (brief: string): string => section(brief, "Research brief") || brief.trim()

/** At most `max` lines of a section shown in chat; the rest stays in the file. */
const clip = (text: string, max = 40) => {
  const lines = text.split("\n")
  return lines.length <= max ? text : `${lines.slice(0, max).join("\n")}\n… (${lines.length - max} more lines in the file)`
}

/** The Planner's current draft: research report, what-document or how-document / plan. */
export const docName = (task: TaskState) =>
  task.workflow === "research" ? "research report" : task.stage === "what" ? "what-document" : task.workflow === "plan" && !task.stage ? "plan document" : task.workflow === "plan" ? "how-document" : "plan"

/** The Planner's latest draft file in this task. */
export const draftFile = (task: TaskState) => (draftIsDoc(task) ? `doc-${task.doc}.md` : `plan-${task.plan}.md`)

/** Section ids of Analyst's brief or the Planner's latest draft, kept in the task (a new draft starts over). */
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

/** The sections a revision may change, for the writer (and for Analyst's revision brief). */
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
    .map(({ s, id }) => {
      const line = oneLine(s)
      return `- ${id} ${s.title}${idx.final.includes(id) ? " ✅" : ""}${line ? `: ${line}` : ""}`
    })
  return clip(lines.join("\n"), 40)
}

/** What the last revision changed and which sections are final, with how to mark them, for the user. */
function changeLine(task: TaskState, hint = true): string {
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
    hint &&
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

const ANALYST_WHAT = [
  "Stage: WHAT. This stage decides what to build and how it behaves as a process, independent of code: no files, functions, interfaces, storage, flags or tests. The implementation plan comes later, after the user approves the what-document.",
  "Read every file the request names in full first, then what they connect to (material, code). Read to understand the problem; code matters here only where it rules a behaviour in or out.",
  "The Planner has no file access: your brief and your later answers are all it knows. Quote, don't paraphrase.",
  [
    "Write `content` in two parts. First `## Concept brief` (the user may read it before the Planner writes):",
    "- **Concerns**: the concepts that decide whether the result is good. The ones the user named or stressed first, in their framing; then ones they didn't mention but should consider. The user's material is a starting point, not the boundary: think beyond it. For each: why it matters (with the source when the user's material says so), and 2-3 approaches with what each trades off; your pick goes in the section's closing Recommended line.",
    `- ${FEASIBILITY}`,
    "- **Assumptions**: defaults you'd take where nothing settles a point, each marked as assumed.",
    "Then `## Excerpts`: the verbatim passages (with `path:line` or file and heading) the Planner needs, grouped by concern. Nothing else: don't restate the request, the Planner gets it.",
  ].join("\n"),
].join("\n\n")

const ADVICE_RULES = [
  "Read the user's comments across all rounds: what do they keep asking for that the draft still doesn't give? Think independently: the user's material and examples are a starting point, not the boundary. Look for concerns, approaches, edge cases and failure modes nobody has named yet.",
  "Report ADVICE: `items` holds one concrete instruction per entry (what to add, explore, change or drop, and why), most important first; the plugin numbers them ADV1, ADV2, …. `content`: your diagnosis in a few lines (why the draft keeps missing).",
  "You have no file access. When you need a fact from the code or the user's files, report ASK with your questions for Analyst first.",
].join("\n\n")

const ANALYST_ASK =
  "Report QUESTIONS only for decisions that belong to the user and change what gets built: at most 4, most important first, each with the options, your recommended option, and why the answer matters. Anything with a sensible default is not a question: put it in the brief as an assumption."

const ANALYST_PLAN = join("Workflow: plan. Nobody edits files in this task, and there is no build or test. Report ESCALATE with the brief.", ANALYST_WHAT, ANALYST_ASK)

const ANALYST_CODE = [
  "Workflow: code. Decide TRIVIAL or ESCALATE (see your instructions). For ESCALATE, set `what`:",
  "- **settled**: the request already fixes the behaviour (\"add a --upper flag that uppercases the output\"); only the implementation is open. Write the how brief below, starting with `## Why the behaviour is settled` (one or two lines). The plan will start with a short Behaviour section instead of a separate what-document.",
  "- **open**: what the feature should do, as a process, is still to decide (a new feature, several valid behaviours). Write the what brief below. The user approves the behaviour before anyone plans code.",
  "When unsure, it is open.",
].join("\n")

const HOW_BRIEF = [
  "Stage: HOW. Brief the Planner for the change plan. The Planner has no file access: your brief and your later answers are all it knows, so have the Intern search (NEED_INFO) until every place the change touches can be shown.",
  [
    "Write `content` with:",
    "- `## Code`: each location that will change, as `path:start-end` with the current code excerpt (exact lines), and the patterns or analogous features the change should follow.",
    "- `## Impact`: for each location, what depends on it: callers, users of the interface, build files, tests, other modules, found by the Intern's searches and listed with `path:line`. Say \"no other users\" only after the Intern searched for them.",
    "- `## Constraints`: code facts that limit the change (language and standard, build system, platform, public interfaces).",
    "Don't restate the request or the what-document; the Planner gets both.",
  ].join("\n"),
].join("\n\n")

const ANALYST_INFEASIBLE =
  "If a decision of the what-document can't work in this code, report INFEASIBLE: which decision, the evidence (`path:line`, excerpt), and what would work instead. Don't quietly plan around it."

const ANALYST_REVISION = [
  "MODE: revision. The user commented on the {doc} below. Don't rewrite it; brief the Planner, who revises it.",
  "Where the comments give examples, treat them as examples: find every place in the document with the same problem, not only the ones named. Check the files the request names, and the code or material they connect to, where the comments need it.",
  "The Planner has no file access: quote what it needs (`path:line`, excerpt). Don't repeat what your earlier brief and answers already hold; point to them.",
  "Report ESCALATE with the revision brief: each change, with the section it applies to, what is wrong and what it should become; the places you found beyond the ones named; and what must stay as it is.",
  "Report QUESTIONS only if a comment leaves open a decision that belongs to the user: at most 4, each with the options, your recommended option, and why the answer matters.",
].join("\n\n")

const ANALYST_ANSWER = [
  "MODE: answer. {asker} has no file access and asks you the questions below. Look up what you need.",
  "Report ANSWER. `content` answers each question under its id (\"### A3\"), with only new facts: exact quotes with `path:line`, or what was searched when something isn't there (send the Intern queries with NEED_INFO first if you need new facts). Where your brief or an earlier answer already holds it, point to it (\"see brief.md, Excerpts: glossary\") instead of repeating it. When a question is a decision for the user, say so under its id.",
].join("\n\n")

const ANALYST_RESEARCH = [
  "Workflow: research. The deliverable is a findings report, not code: nobody edits files in this task, and there is no build or test.",
  "Read every file the request names in full first, then have the Intern search (NEED_INFO) to see where the answer lives.",
  "Size the research (`depth`):\n- **quick**: one focused question with one direct path to the answer.\n- **breadth**: splits into distinct, independent sub-questions.\n- **depth**: one question that needs several angles or sources.",
  [
    "Write `content` in two parts. First `## Research brief`, phrased from the user's point of view:",
    "- the question, and the sub-questions that together answer it",
    "- every detail and preference the user gave; dimensions they didn't state are open-ended, not invented",
    "- mode: **descriptive** (document what exists; the default) or **evaluative** (compare and recommend; only when the user asked to compare, choose or recommend)",
    "- where to look (paths, the user's files, the web) and what is out of scope",
    "Then `## Findings so far`: what you found, with `path:line` or the URL and short verbatim excerpts.",
  ].join("\n"),
  "When the question reaches beyond the code (libraries, APIs, standards, other projects, anything on the web), have the Operator search the web and open the pages (RUN, when offered) and put what you use in Findings so far, with the URL and a verbatim excerpt: the agents after you search only the code.",
  "Report ESCALATE with `depth`. Report QUESTIONS (one round at most) only when the question itself is unclear: unknown terms or acronyms, or a choice only the user can make. Don't ask for what the user already gave.",
].join("\n\n")

const INTERN_RESEARCH =
  "MODE: research search for the Planner. Return evidence, not prose. For each query, a list of records: **claim** (one fact), **source** (`path:line`, the file, or the URL), **excerpt** (the few lines, verbatim; don't paraphrase or summarize them). \"Not found\" is a finding: say what you searched. When sources conflict, give both. When a source speculates (\"could\", \"may\", plans), say so. Stop a query when your last two searches added nothing new. Report FOUND, or NOT_FOUND with what you searched."

const REVIEW_PLAN = [
  "Part 1, can it be built as written. Check that each reference the document makes is backed by the brief, Analyst's answers or the user's words, and says what the document claims. Simulate building 2-3 representative parts as a capable builder who cannot talk to the author: where would you have to guess, and would a wrong guess matter (more than about 10% guesswork)? Check that every requirement and constraint in the request maps to a decision and to a verification, that acceptance criteria are observable, and that names and interfaces are consistent. Skip anything the document explicitly leaves to the builder, anything a builder could reasonably decide alone, and wording nitpicks.",
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


/** The Operator's task message: the user's request (team action run), or what Analyst or Developer needs run mid-task. */
export const operatorPrompt = (request: string, asker?: string) =>
  join(
    asker
      ? `MODE: run for ${asker}, who needs this run to carry on with its task. Carry out the request below and report RESULT with the output ${asker} needs, or FAILED.`
      : "MODE: run. Carry out the user's request below and report RESULT with the output, or FAILED.",
    `<request>\n${request}\n</request>`,
  )

export function buildPrompt(config: Config, task: TaskState, p: Pending, freshSession: boolean): string {
  const f = (name: string) => fileBlock(task, name)
  const latest = (kind: string) => (task.seq[kind] ? f(`${kind}-${task.seq[kind]}.md`) : "")
  const edited = task.editedFiles.length ? `Files changed so far (kept): ${task.editedFiles.join(", ")}` : "No files changed so far."
  /** Analyst's brief for the stage and its answers to questions so far. */
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
          : "The limit for questions to Analyst is reached: work with what you have, and list what is missing.",
      )
    if (task.questionRounds >= config.limits.questionsPerTask) notes.push("The question limit is reached: decide with what you have.")
    return notes.length ? notes.join(" ") : false
  }
  switch (p.mode) {
    case "analyst":
      if (p.revision)
        return join(
          ANALYST_REVISION.replaceAll("{doc}", `${docName(task)} (${draftFile(task)})`),
          freshSession && join(f("request.md"), whatDoc(), stageBrief(), answers()),
          f(draftFile(task)),
          ...delivered(),
          `The user's comments:\n${p.note ?? ""}`,
          task.scope && join(scopeText(task, false), "Brief only the REVISE, FINE-TUNE and new sections; the Planner returns only those. For FINE-TUNE, pass on the user's exact edit and nothing more."),
          capNote(),
        )
      if (!freshSession && p.note) return join(p.note, ...delivered(), capNote())
      if (task.stage === "how")
        return join(
          `Task ${task.id}: ${task.doc ? "the user approved the what-document below. " : ""}Brief the Planner for the change plan. Report ESCALATE with the brief.`,
          HOW_BRIEF,
          !!task.doc && ANALYST_INFEASIBLE,
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
        task.workflow === "plan" && ANALYST_PLAN,
        task.workflow === "research" && ANALYST_RESEARCH,
        !task.workflow && task.stage === "what" && join("Workflow: code. Report ESCALATE with the what brief.", ANALYST_WHAT, ANALYST_ASK),
        !task.workflow &&
          !task.stage &&
          join(
            ANALYST_CODE,
            task.forcePlan && "The user asked for a plan: don't choose TRIVIAL.",
            `### The what brief (what: open)\n\n${ANALYST_WHAT}`,
            `### The how brief (what: settled)\n\n${HOW_BRIEF}`,
            ANALYST_ASK,
          ),
        f("request.md"), f("checks.md"), answers(), p.note, capNote())
    case "planner_advice":
    case "architect_draft_advice": {
      if (!freshSession && p.note) return join(p.note, ...delivered(), "Now report ADVICE.")
      const writer = p.advise === "planner" ? "the Planner" : "Analyst"
      const draft = p.advise === "planner" ? `${docName(task)} (${draftFile(task)})` : `${task.workflow === "research" ? "research" : "concept"} brief (${briefName(task)})`
      const earlier = (task.adviceFiles ?? []).map(f)
      return join(
        `MODE: advice. ${writer} wrote the ${draft} below, and the user has sent it back ${task.commentRounds ?? 0} time(s). Don't rewrite it. Find why it keeps missing what the user wants, and tell ${writer} what to do differently; ${writer} revises it.`,
        ADVICE_RULES,
        earlier.length > 0 && "Earlier advice on this draft is below: say why it wasn't enough, and don't repeat it.",
        f("request.md"),
        whatDoc(),
        stageBrief(),
        answers(),
        p.advise === "planner" && f(draftFile(task)),
        ...earlier,
        ...delivered(),
        p.note && `Latest:\n${p.note}`,
        task.scope && join(scopeText(task, false), "Advise on the REVISE and new sections; final ones stay as they are."),
      )
    }
    case "planner_consult": {
      const dev = p.asker === "fix"
      const question = join(...delivered(), "Report ANSWER.")
      const where = dev ? `Developer is on step ${task.step} of ${task.planSteps} of plan ${task.plan}` : `Analyst is writing the ${briefName(task) === "how-brief.md" ? "how brief" : "brief"}`
      if (!freshSession) return join(`Another question. ${where}.`, question)
      return join(
        `MODE: consult. ${where} and asks you a question mid-work, below. Answer it so they can carry on: the decision, why, and what to watch for, in a few lines. Don't rewrite the ${dev ? "plan" : "brief"} and don't start new work.`,
        "You have no file access: rely on the evidence in the question, and on the files below. If they don't settle it, say which fact is missing and what to do meanwhile.",
        dev ? "The plan's intent is binding: if the step can't work as written, say so plainly; Developer then reports BLOCKED." : "Facts about the code come from Analyst's evidence and the Intern's findings; decisions that belong to the user stay with the user (Analyst asks them as QUESTIONS).",
        f("request.md"),
        dev && f("checks.md"),
        whatDoc(),
        dev ? f(`plan-${task.plan}.md`) : answers(),
        question,
      )
    }
    case "analyst_answer": {
      const head = ANALYST_ANSWER.replace("{asker}", MODE_ROLE[p.asker ?? "planner"] === "planner" ? "The Planner" : "Architect")
      if (!freshSession) return join(head, p.note, ...delivered(), capNote())
      return join(head, f("request.md"), whatDoc(), stageBrief(), answers(), p.note, ...delivered(), capNote())
    }
    case "analyst_fail":
      return join(
        "MODE: failure. The trivial attempt did not finish. The request fixes the behaviour; brief the Planner for the change plan, and say why it is not trivial and which edits were kept. Report ESCALATE.",
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
    case "planner": {
      const unseen = [...new Set(task.plannerUnseen)]
      task.plannerUnseen = []
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
          plannerHandoff(config, task),
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
    case "planner_stepfix": {
      const unseen = [...new Set(task.plannerUnseen)]
      task.plannerUnseen = []
      const report = task.history.filter((h) => h.mode === "fix" && h.plan === task.plan && h.step === task.step && h.file).at(-1)?.file
      const ask = join(
        `MODE: step fix. ${p.note ?? `Developer is blocked on step ${task.step}`}. Developer's report is ${report ?? "below"}. Fix that step instead of writing a new plan, if you can:`,
        `- **STEP**: \`content\` holds only the step(s) that replace step ${task.step}, in the plan's step format: one step, or two when a new step must come first. Each starts with \`N. **Title**: <what the step achieves>\`, the details on the next lines. The finished steps and the rest of the plan stay as they are. \`summary\`: one line for the user on what changed and why. \`risk\`: yes only if the new step(s) are destructive or irreversible.`,
        "- **REPLAN**: the plan is wrong beyond this step, so patching it won't do. `content`: why. You then write the next plan as usual.",
      )
      if (!freshSession) return join(unseen.length > 0 && join("New information since your last call:", ...unseen.map(f)), ask)
      return join(ask, f("request.md"), f("checks.md"), whatDoc(), stageBrief(), answers(), f(`plan-${task.plan}.md`), ...unseen.map(f))
    }
    case "operator":
      // Team.run and Team.runFor build the message (operatorPrompt).
      return p.note ?? ""
    case "intern":
      if (task.workflow === "research") return join(INTERN_RESEARCH, `<queries>\n${p.note ?? ""}\n</queries>`)
      return join(
        `MODE: planner search. Answer these queries for ${p.asker === "analyst" ? "Analyst" : "the Planner"} with path:line findings and short code excerpts. End with what you searched (terms, paths, graph queries), so a missing result can be judged. Report FOUND, or NOT_FOUND.`,
        `<queries>\n${p.note ?? ""}\n</queries>`,
      )
    case "architect_review":
      if (!freshSession && p.note) return join(p.note, ...delivered(), "Report again.", capNote())
      return join(
        "MODE: review of a destructive plan. Check that the destructive or irreversible steps are necessary and safe, and that nothing is lost. Report APPROVE (optional notes) or CHANGES (what must change and why), or ASK Analyst for a fact you need.",
        f("request.md"),
        f("checks.md"),
        answers(),
        whatDoc(),
        stageBrief(),
        f(`plan-${task.plan}.md`),
      )
    case "architect_advice": {
      if (!freshSession && p.note) return join(p.note, ...delivered(), "Now give your advice (ADVICE), or report QUESTIONS if a decision still belongs to the user.", capNote())
      const plans = Array.from({ length: task.seq.plan ?? 0 }, (_, i) => f(`plan-${i + 1}.md`))
      return join(
        `MODE: advice. The task is stuck: ${p.note ?? ""}. Say which approach the Planner should take (ADVICE), or, if the decision belongs to the user, report QUESTIONS. ASK Analyst for a fact you need.`,
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
      const consult = allowedStatuses(config, "fix", task).includes("CONSULT")
        ? ` Unsure which way fits the plan? Report CONSULT with your question and the evidence before you fail or block (${config.limits.consultsPerStep - consultsUsed(task, "developer")} left for this step).`
        : ""
      if (!task.developerSeenPlan) {
        task.developerSeenPlan = true
        return join(`Carry out this plan one step at a time. ${head}`, rules + consult, f(`plan-${task.plan}.md`), f("checks.md"), p.note)
      }
      return join(head, p.note, rules + consult)
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
      const reports = task.history.filter((h) => h.plan === task.plan && h.mode === "fix" && h.status !== "CONSULT" && h.status !== "RUN" && h.file).map((h) => f(h.file!))
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
    case "analyst_reply":
    case "planner_reply":
    case "architect_reply": {
      const rules =
        "MODE: user question. The task is waiting on the user, who asks you this before they answer or decide. Answer it in content: clear and specific, with pros, cons and impact when they ask about options. Don't revise the plan, ask questions or start new work. Report ANSWER."
      const question = p.note ?? ""
      if (!freshSession) return join(rules, question)
      const draft = (draftIsDoc(task) ? task.doc : task.plan) ? f(draftFile(task)) : ""
      return join(rules, f("request.md"), whatDoc(), stageBrief(), answers(), draft, question)
    }
    case "architect_doc_review": {
      if (!freshSession && p.note && p.files?.length) return join(p.note, ...delivered(), "Report again.", capNote())
      const research = task.workflow === "research"
      const file = draftFile(task)
      const what = `the ${docName(task)}${draftIsDoc(task) ? "" : ` (plan ${task.plan})`}`
      const standard = workflowInstructions(config, research ? "research" : draftIsDoc(task) ? "what" : "how")
      return join(
        `MODE: critical review of ${what} (${file}), asked for by the user (review ${task.reviews ?? 1} of at most ${config.limits.architectReviews}). Review it in two parts, and keep them apart in your report.`,
        research ? REVIEW_RESEARCH : REVIEW_PLAN,
        "Report APPROVE when it holds as written (content: optional notes for the user), or CHANGES: at most 5 must-fix items, most important first, each with where, the problem and the fix; then any should-consider items, marked as such. Don't rewrite the document.",
        "You have no file access: check claims against the brief, Analyst's answers and the findings. When a claim matters and nothing quotes it, ASK Analyst for the exact quote.",
        p.note && `What the user asked the review to look at:\n${p.note}`,
        f("request.md"),
        answers(),
        whatDoc(),
        stageBrief(),
        standard && `<standard>\n${standard}\n</standard>`,
        ...task.history.filter((h) => h.mode === "architect_doc_review" && h.file).map((h) => f(h.file!)),
        f(file),
      )
    }
  }
}

/** What the Planner is told about its draft in this stage: the status to report and the standard. */
function plannerHandoff(config: Config, task: TaskState): string {
  const ask =
    "When a fact is missing, report ASK with your questions for Analyst in `questions` (one per item, unnumbered; the plugin numbers them A1, A2, …); Analyst answers in a new file. When a decision belongs to the user and changes what gets built, report QUESTIONS, each with the options and your recommendation."
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
    !task.doc && "There is no what-document: Analyst found that the request fixes the behaviour (see the brief). Start the plan with a short `## Behaviour` section: what the change does, as the user will see it, in a few lines.",
    !!task.doc && "Follow every decision of the what-document. If one can't work in this code, report INFEASIBLE: which decision, the evidence from the brief or Analyst's answers, and what would work instead. Never quietly change a decision.",
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

const DETAILS_ROUTE =
  'a request for details, the full text or "more" (of the whole draft or of sections) → team "details", with ids = the section ids if they named some (no confirmation; no agent runs)'

const REPLY_ROUTES = `a clear approval ("approve", "go ahead") → team "approve"; a clear stop → team "stop"; feedback, requests for changes or more work → polish and confirm [Send] [Edit] [Cancel], then team "change"; a question → polish and confirm, then team "ask"; ${DETAILS_ROUTE}; a request for a (critical) review → team "review", with what the review should look at as text if they said.`

/** Architect's review shown at approval, marked when the plan or document was revised after it. */
function adviceLine(task: TaskState): string {
  return task.lastAdvice ? `**Revised following ${task.lastAdvice.role}'s advice** (${path.join(task.dir, task.lastAdvice.file)})` : ""
}

function architectBlock(task: TaskState): string {
  if (!task.architectNote) return ""
  const verdict = task.history.find((h) => h.file === task.architectNote)?.status
  const title = verdict === "CHANGES" ? "**Architect's review** (this version was revised to address it)" : "**Architect's notes**"
  return `${title}\n${readTaskFile(task, task.architectNote)}`
}

const AUTO_SEND = (level: string) =>
  `AUTO-SEND (${level} auto): wherever this says to polish and confirm [Send] [Edit] [Cancel], polish the user's text as usual, show it in one block as sent, and send it right away without asking. Build and test commands are still sent as typed.`

export function render(task: TaskState): string {
  const review = (task.phase === "brief" || task.phase === "approval") && !autoDecides(task)
  const out = review && task.phase === "approval" && task.stepFix?.waiting ? stepFixView(task, task.stepFix) : review ? reviewView(task) : renderPhase(task)
  return task.auto ? join(out, AUTO_SEND(task.auto)) : out
}

/** A step fix waiting on the user: one line, and the new step text when it is destructive or irreversible. */
function stepFixView(task: TaskState, sf: NonNullable<TaskState["stepFix"]>): string {
  const steps = split(readTaskFile(task, `plan-${task.plan}.md`)).sections.filter((s) => s.step)
  const changed = steps.slice(sf.from - 1, sf.to)
  const which = sf.to > sf.from ? `Steps ${sf.from}-${sf.to} replace step ${sf.from}` : `Step ${sf.from} changed`
  const block = join(
    `**${which}** (plan ${task.plan}): ${sf.summary}`,
    sf.risk && join("**Risk: yes** (destructive or irreversible). The new step text:", changed.map((s) => s.text.trim()).join("\n\n")),
    task.auto === "safe" && sf.risk && "**Safe auto stopped here:** the change is destructive or irreversible, so it needs your approval.",
    `**Plan file:** ${path.join(task.dir, `plan-${task.plan}.md`)}`,
  )
  return join(
    `STEP FIX ready for approval: Developer was blocked on step ${sf.from}, and the Planner changed that step instead of writing a new plan. Show this block to the user exactly as written, without rewording or shortening it:`,
    `<show>\n${block}\n</show>`,
    `NEXT ACTION: show the block above and end with one line: "Reply to approve (Developer carries on at step ${sf.from}), change or stop it, or ask about it or for details." No buttons. Then act on the user's reply: ${REPLY_ROUTES}`,
  )
}

const SECTION_ROUTES =
  'Then act on the reply: "ok", "fine", "looks good" → team "section" with verdict "ok" (no confirmation); "skip" → verdict "skip"; a comment → polish it and confirm [Send] [Edit] [Cancel], then team "section" with verdict "finetune" (the user states the exact edit; give it in text) or "revise" (unhappy with the substance; when unsure, revise) and text = the confirmed comment; a question → polish and confirm, then team "ask" (the same section comes back after the answer); "details" or "more" → team "details" with ids = [the id of this section] (the same section stays open); "show the rest" or "all at once" → verdict "rest"; a clear stop → team "stop".'

/** The draft the user reviews now: the brief, or the latest document or plan. */
function reviewDraft(task: TaskState): { text: string; idx?: SectionIndex; under?: string } {
  const brief = task.phase === "brief"
  const text = readTaskFile(task, brief ? briefName(task) : draftFile(task))
  return { text, idx: sectionIndex(task, brief ? "brief" : "draft"), under: brief ? (task.workflow === "research" ? "Research brief" : "Concept brief") : undefined }
}

/** The sections a walk-through would go through now. */
export function walkable(task: TaskState): string[] {
  const { text, idx, under } = reviewDraft(task)
  return idx ? walkIds(text, idx, under) : []
}

/** A brief, document or plan waiting on the user: the walk-through, or the whole draft with the review style. */
function reviewView(task: TaskState): string {
  const w = task.walk?.key === task.sections?.key ? task.walk : undefined
  if (w?.dialog && !w.dialog.end) return dialogOpen(task)
  if (w?.dialog && w.dialog.end !== "rest") return dialogView(task, w)
  if (w && !w.rest && !w.done && w.at < w.ids.length) return walkSection(task, w)
  if (w?.done) {
    const { text, idx, under } = reviewDraft(task)
    // A brief's sections outside its top heading (the excerpts).
    const inBrief = under && idx ? walkIds(text, { ...idx, final: [] }, under) : []
    const extra = !under || !idx ? [] : split(text).sections
      .map((s, i) => ({ s, id: idx.ids[i]! }))
      .filter(({ s, id }) => !inBrief.includes(id) && s.text.split("\n").slice(1).join("\n").trim())
      .map(({ s, id }) => `${id} ${shownTitle(s.title)}`)
    return join(
      `ALL SECTIONS ACCEPTED: ${idRanges(w.ids)} ${w.ids.length > 1 ? "are" : "is"} marked final.`,
      extra.length ? `Not gone through (supporting material, shown on request): ${extra.join("; ")}.` : "",
      `NEXT ACTION: tell the user in one line, then ask with the question tool: [Approve] [Show it all at once]. Approve → team "approve". Show it all at once → team "section" with verdict "rest".`,
    )
  }
  const full = renderPhase(task)
  if (w?.rest) {
    const kept = w.replies.filter((r) => r.verdict === "finetune" || r.verdict === "revise").map((r) => `${r.id} (${r.verdict === "finetune" ? "fine-tune" : "revise"})`)
    const ok = w.replies.filter((r) => r.verdict === "ok").map((r) => r.id)
    const d = w.dialog
    return join(
      full,
      kept.length || ok.length
        ? `From the walk-through: ${[ok.length && `ok ${idRanges(ok)}`, kept.length && `comments on ${kept.join(", ")}`].filter(Boolean).join("; ")}. They are kept and sent with the user's next comments ("change"); approving drops the comments.`
        : "",
      d?.questions.length ? `The user's questions from the review dialog (as typed):\n${notesList(task, d.questions)}\nAfter showing the draft, call team "ask" once with all of them, each starting with its section id, and show the answers.` : "",
      d?.comments.length
        ? `The user's comments from the review dialog (as typed):\n${notesList(task, d.comments)}\nThey go with the user's next comments: polish both together into the one "change" (finetune = sections where the user states the exact edit, revise = the others). Approving drops them.`
        : "",
    )
  }
  return styleView(task) || full
}

/** The review-style question shown before a draft (or the direct start with reviewStyle "sections"); empty when the whole draft shows at once. */
export function styleView(task: TaskState): string {
  const style = task.reviewStyle ?? "ask"
  const n = walkable(task).length
  if (style === "all" || !n) return ""
  // The draft itself comes with the next call, so the review style is always chosen first.
  if (style === "sections") return 'REVIEW ONE SECTION AT A TIME (config reviewStyle). NEXT ACTION: call team "section" with verdict "start" right away.'
  return join(
    `${draftTitle(task)} ready: ${n} section${n > 1 ? "s" : ""} to review.`,
    'NEXT ACTION: tell the user in one line, then ask with the question tool how to review it: [All at once] [One section at a time]. All at once → team "section" with verdict "rest". One section at a time → team "section" with verdict "start". Follow the NEXT ACTION of that result.',
  )
}

/** The draft waits in the review dialog: the manager only points the user to it. */
export function dialogOpen(task: TaskState): string {
  const n = task.walk?.ids.length ?? 0
  return join(
    `REVIEW READY IN THE DIALOG: ${draftTitle(task)}, ${n} section${n === 1 ? "" : "s"}. It opens on its own in a terminal showing this session; the user opens or reopens it with "Review" in the Team sidebar or /team-review, and closing it keeps their progress. You are woken when they finish.`,
    'NEXT ACTION: tell the user in one line that the review is ready in the dialog ("Review" in the Team sidebar, or /team-review), then end your turn. Call no tool. Only if the user asks to review in the chat: team "section" with verdict "start"; to see it all at once: verdict "rest".',
  )
}

const notesList = (task: TaskState, notes: { id: string; text: string }[]) => {
  const idx = task.sections
  return notes.map((n) => `- ${n.id} ${idx ? shownTitle(idx.titles[idx.ids.indexOf(n.id)] ?? "").replace(/^#+\s*/, "") : ""}: ${n.text}`).join("\n")
}

/** What the manager does after the review dialog: answer the questions, then polish and send the comments. */
export function dialogView(task: TaskState, w: NonNullable<TaskState["walk"]>): string {
  const d = w.dialog!
  if (d.end === "stop") return 'The user chose Stop in the review dialog.\nNEXT ACTION: call team with action "stop".'
  if (d.end === "approve") return `The user went through every section of the ${draftTitle(task).toLowerCase()} and approved it in the review dialog.\nNEXT ACTION: call team with action "approve".`
  const ok = w.replies.filter((r) => r.verdict === "ok").map((r) => r.id)
  const skipped = w.replies.filter((r) => r.verdict === "skip").map((r) => r.id)
  const steps: string[] = []
  if (d.questions.length) steps.push('call team "ask" once with all the questions, each starting with its section id; show the answers')
  if (d.comments.length)
    steps.push(
      'polish the comments (one paragraph per section, keeping the user\'s meaning) and confirm them [Send] [Edit] [Cancel]; then call team "change" with text = the confirmed comments, finetune = sections where the user states the exact edit, revise = the others (when unsure, revise). If the answers settle a comment, the user may drop it at [Edit]',
    )
  else
    steps.push(
      'ask the user with the question tool: [Approve] [Comment] [Show it all at once]. Approve → team "approve". Comment → take the comment as free text, polish and confirm [Send] [Edit] [Cancel], then team "change". Show it all at once → team "section" with verdict "rest"',
    )
  return join(
    `REVIEW DIALOG FINISHED: ${draftTitle(task)}. ${[ok.length && `ok ${idRanges(ok)}`, skipped.length && `skipped ${idRanges(skipped)}`].filter(Boolean).join("; ") || "No section marked ok"}.`,
    d.questions.length ? `Questions (as typed):\n${notesList(task, d.questions)}` : "",
    d.comments.length ? `Comments (as typed):\n${notesList(task, d.comments)}` : "",
    `NEXT ACTION: ${steps.map((s, i) => (steps.length > 1 ? `${i + 1}. ${s}.` : `${s}.`)).join(" ")}`,
  )
}

/** The draft's sections for the review dialog, and what shows above the first one. */
export function dialogData(task: TaskState): { title: string; intro: string; ask: boolean; sections: { id: string; title: string; summary?: string; body: string }[] } {
  const { text, idx } = reviewDraft(task)
  const all = split(text).sections
  const sections = walkable(task).map((id) => {
    const s = all[idx?.ids.indexOf(id) ?? -1]
    if (!s) return { id, title: "?", body: "(section not found; see the file)" }
    const summary = userView(s)
    // The RPC output check rejects `summary: undefined`; leave the key out instead.
    return { id, title: shownTitle(s.title).replace(/^#+\s*/, ""), ...(summary !== undefined && { summary }), body: fullBody(s) }
  })
  const intro = join(
    task.phase === "approval" && !draftIsDoc(task) ? `**Risk:** ${task.planRisk ? "yes (destructive or irreversible steps)" : "no"}` : "",
    changeLine(task, false),
    architectBlock(task),
    adviceLine(task),
  )
  return { title: draftTitle(task), intro, ask: (task.reviewStyle ?? "ask") === "ask", sections }
}

/** A section's full text under its title (a step: its purpose, then the details). */
const fullBody = (s: Section) => (s.step ? join(userView(s), sectionBody(s)) : sectionBody(s))

/** The stored full text of the waiting draft, or of some of its sections: no agent runs. */
export function detailsView(task: TaskState, ids: string[] = []): string {
  if (task.phase !== "brief" && task.phase !== "approval") return join('"details" applies only while a brief, document or plan waits on the user.', render(task))
  const { text, idx } = reviewDraft(task)
  const want = [...new Set(ids.map((x) => x.trim().toUpperCase()).filter(Boolean))]
  const unknown = want.filter((id) => !idx?.ids.includes(id))
  if (unknown.length) return `No section ${unknown.join(", ")} in the waiting draft. Its sections: ${idx ? idRanges(idx.ids) : "(none)"}.\nNEXT ACTION: call team "details" again with ids from that list, or without ids for the whole draft.`
  const all = split(text).sections
  const shown = want.length
    ? want
        .map((id) => {
          const s = all[idx!.ids.indexOf(id)]!
          return join(`**${id} · ${shownTitle(s.title).replace(/^#+\s*/, "")}**`, fullBody(s))
        })
        .join("\n\n")
    : idx
      ? annotate(text, idx)
      : text
  return join(
    `FULL TEXT of the ${draftTitle(task).toLowerCase()}${want.length ? `, ${want.join(", ")}` : ""} (from the stored draft; no agent ran). Show this block to the user exactly as written:`,
    `<show>\n${shown}\n</show>`,
    "NEXT ACTION: show the block above. The draft still waits on the user: end with the same reply line as before (the section under review stays open) and act on their reply as the previous result said.",
  )
}

/** "Concept brief", "What-document (version 2)", "Plan (plan 3)". */
export function draftTitle(task: TaskState): string {
  if (task.phase === "brief") return `${task.workflow === "research" ? "Research" : "Concept"} brief`
  const name = docName(task)
  return `${name[0]!.toUpperCase()}${name.slice(1)}${draftIsDoc(task) ? ` (version ${task.doc})` : ` (plan ${task.plan})`}`
}

function walkSection(task: TaskState, w: NonNullable<TaskState["walk"]>): string {
  const { text, idx } = reviewDraft(task)
  const id = w.ids[w.at]!
  const s = split(text).sections[idx?.ids.indexOf(id) ?? -1]
  const first = w.at === 0 && !w.replies.length
  const head = first
    ? join(
        task.phase === "approval" && !draftIsDoc(task) ? `**Risk:** ${task.planRisk ? "yes (destructive or irreversible steps)" : "no"}` : "",
        changeLine(task, false),
        architectBlock(task),
        adviceLine(task),
      )
    : ""
  const short = s && userView(s)
  const body = s ? (short ?? sectionBody(s)) : "(section not found; see the file)"
  const block = join(head, `**${draftTitle(task)}, ${id} · ${s ? shownTitle(s.title).replace(/^#+\s*/, "") : "?"}** (${w.at + 1} of ${w.ids.length})`, body)
  return join(
    `SECTION ${w.at + 1} OF ${w.ids.length}. Show this block to the user exactly as written, without rewording or shortening it:`,
    `<show>\n${block}\n</show>`,
    `NEXT ACTION: show the block above and end with one line: "Reply ok, comment on it, ask about it${short ? ", ask for details" : ""}, skip it, or say show the rest." No buttons. ${SECTION_ROUTES}`,
  )
}

function renderPhase(task: TaskState): string {
  const last = task.history[task.history.length - 1]
  const lastLine = last ? `${last.role} → ${last.status}: ${last.summary.split("\n")[0].replace(/[.\s]+$/, "")}` : "started"
  const files = task.editedFiles.length ? task.editedFiles.map((f) => `- ${f}`).join("\n") : "(none)"
  const attempts = `Failed attempts: ${task.attempts}/${task.attemptLimit}.`
  const usage = () => usageReport(task.usage, Math.max(1, task.planSteps))
  if (autoDecides(task)) {
    const next =
      task.phase === "checks"
        ? "skip build and test"
        : task.phase === "questions"
          ? `answer ${MODE_ROLE[task.questionsFrom ?? "analyst"]}'s questions with the recommended options`
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
      const brief = shortView(idx ? annotate(raw, idx) : raw, research ? "Research brief" : "Concept brief")
      const title = research ? `**Research brief** (${task.depth ?? "?"} research)` : "**Concept brief**"
      const shown = research ? researchBrief(brief) : section(brief, "Concept brief") || brief
      return join(
        `${research ? "RESEARCH" : "CONCEPT"} BRIEF ready. Show this block to the user exactly as written:`,
        `<show>\n${join(title, shown, changeLine(task), adviceLine(task))}\n</show>`,
        `NEXT ACTION: show the block above and end with one line: "${research ? "Reply to start the research" : "Reply to have the what-document written"}, adjust the brief, ask for details, or stop." No buttons. Then act on the reply: a clear go ("go", "looks good") → team "approve"; a clear stop → team "stop"; adjustments → polish and confirm [Send] [Edit] [Cancel], then team "change"; a question → polish and confirm, then team "ask"; ${DETAILS_ROUTE}.`,
        idx && SCOPE_RULE,
      )
    }
    case "approval": {
      const name = docName(task)
      const Name = `${name[0]!.toUpperCase()}${name.slice(1)}`
      if (draftIsDoc(task)) {
        const doc = readTaskFile(task, `doc-${task.doc}.md`)
        const research = task.workflow === "research"
        // With summaries, the section list carries each section's direction; the details are on request.
        const long = missingSummaries(doc).length > 0
        const decisions = long && !research && section(doc, "Decisions")
        const findings = long && research && section(doc, "Key findings")
        const conflicts = long && research && section(doc, "Conflicts")
        const block = join(
          `**${Name}** (version ${task.doc})`,
          `**What you get**\n${task.docSummary ?? "(no summary)"}`,
          task.infeasible && `**The how stage found a decision that can't work** (${task.infeasible})\n${clip(readTaskFile(task, task.infeasible), 30)}`,
          decisions ? `**Decisions**\n${clip(decisions)}` : "",
          findings ? `**Key findings**\n${clip(findings)}` : "",
          conflicts ? `**Conflicts between sources**\n${clip(conflicts, 20)}` : "",
          `**Sections**\n${idList(task, doc, false) || sectionTitles(doc).map((t) => `- ${t}`).join("\n") || "(none)"}`,
          changeLine(task),
          architectBlock(task),
          adviceLine(task),
          `**File:** ${task.output ?? path.join(task.dir, `doc-${task.doc}.md`)}`,
        )
        const reply =
          task.stage === "what"
            ? task.infeasible
              ? "Reply with how to change the what-document, approve it as it is (the team plans again), stop, ask about it or for details, or have Architect review it."
              : "Reply to approve the behaviour (the team then plans the change), change or stop it, ask about it or for details, or have Architect review it."
            : "Reply to approve, change or stop it, ask about it or for details, or have Architect review it."
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
      const behaviour = (!others || missingSummaries(planText).length > 0) && section(planText, "Behaviour")
      const block = join(
        `**${howDoc ? `${Name} (plan ${task.plan})` : `Plan ${task.plan}`}**`,
        `**What you get**\n${task.planSummary ?? "(no summary)"}`,
        behaviour ? `**Behaviour**\n${clip(behaviour, 20)}` : "",
        `**Steps**\n${titles.length ? titles.join("\n") : `${task.planSteps} step(s); see the plan file.`}`,
        others && `**Other sections**\n${others}`,
        `**Risk:** ${task.planRisk ? "yes (destructive or irreversible steps)" : "no"}`,
        changeLine(task),
        architectBlock(task),
        task.auto === "safe" && task.planRisk && "**Safe auto stopped here:** this plan has destructive or irreversible steps, so it needs your approval.",
        decided,
        adviceLine(task),
        `**Plan file:** ${howDoc ?? path.join(task.dir, `plan-${task.plan}.md`)}`,
      )
      return join(
        `PLAN ${task.plan} ready for approval. Show this block to the user exactly as written, without rewording or shortening it:`,
        `<show>\n${block}\n</show>`,
        `NEXT ACTION: show the block above and end with one line: "${howDoc ? "Reply to approve (then you can implement it)" : "Reply to approve"}, change or stop the plan, ask about it or for details, or have Architect review it." No buttons. Then act on the user's reply: ${REPLY_ROUTES}`,
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
        task.budgetReason === "calls"
          ? `AGENT CALL LIMIT REACHED: ${task.agentCalls ?? 0} agent calls (runaway guard; failed attempts ${task.attempts}/${task.attemptLimit}). Last: ${lastLine}.`
          : `ATTEMPT BUDGET USED UP: ${task.attempts} failed attempts (failed steps, work sent back, broken agent calls). Last: ${lastLine}.`,
        task.pending ? `Left to do: ${task.pending.mode}${task.planSteps ? `, step ${task.step} of ${task.planSteps}` : ""}.` : "",
        `Files changed so far:\n${files}`,
        decided,
        usage(),
        `NEXT ACTION: show this to the user and ask [${task.budgetReason === "calls" ? "Continue +25 calls" : "Continue +5 attempts"}] [Stop]. Continue → team "extend". Stop → team "stop".`,
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
