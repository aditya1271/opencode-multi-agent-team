// What the agents and the manager are told: per-mode hand-off prompts and the team tool's results.
import path from "node:path"
import { workflowInstructions } from "./agents.ts"
import type { Config } from "./config.ts"
import { needInfoLimit } from "./report.ts"
import { isDocWorkflow, MODE_ROLE, readTaskFile, type Pending, type TaskState } from "./state.ts"
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

/** The "## Research brief" section of Lead's brief, else the whole brief. */
export const researchBrief = (brief: string): string => {
  const m = /^## Research brief\s*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(brief)
  return (m ? m[1]! : brief).trim()
}

export const docName = (task: TaskState) => (task.workflow === "research" ? "research report" : "plan document")

const LEAD_PLAN = [
  "Workflow: plan. The deliverable is a plan document, not code: nobody edits files in this task, and there is no build or test.",
  "Look before you ask: read every file the request names in full first, then the code or material it connects to, until you can explain how the relevant parts work today and what the plan would touch. Never ask what the project or the user's files already answer.",
  "Report ESCALATE with the brief for the Architect: findings with `path:line` or file references, the relevant excerpts, how things work today, and constraints you found (existing patterns, conflicts, a cheaper path). If you found something the user may not have considered that would change what they ask for, say so plainly.",
  "Report QUESTIONS only for decisions that belong to the user and change what gets built: at most 4, most important first. Each question gives the options, your recommended option, and why the answer matters. Anything with a sensible default is not a question: write it in the brief as an assumption.",
].join("\n\n")

const LEAD_REVISION = [
  "MODE: revision. The user commented on the {doc} below. Don't rewrite it; brief the Architect, who revises it.",
  "Where the comments give examples, treat them as examples: find every place in the document with the same problem, not only the ones named. Check the files the request names, and the code or material they connect to, where the comments need it.",
  "Report ESCALATE with the revision brief: each change, with the section it applies to, what is wrong and what it should become; the places you found beyond the ones named; and what must stay as it is.",
  "Report QUESTIONS only if a comment leaves open a decision that belongs to the user: at most 4, each with the options, your recommended option, and why the answer matters.",
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
  "Part 1, can it be built as written. Read the document and every file it references; check that each reference exists and says what the document claims. Simulate building 2-3 representative parts as a capable builder who cannot talk to the author: where would you have to guess, and would a wrong guess matter (more than about 10% guesswork)? Check that every requirement and constraint in the request maps to a decision and to a verification, that acceptance criteria are observable, and that names and interfaces are consistent. Skip anything the document explicitly leaves to the builder, anything a builder could reasonably decide alone, and wording nitpicks.",
  "Part 2, is it the right design. Were the strongest alternative and \"use what exists\" weighed? Is anything built that the request doesn't need (layers, options, future-proofing)? Are the risks named, and are the assumed decisions reasonable defaults? Here you may disagree with the approach: say concretely what you would do instead and why.",
].join("\n\n")

const REVIEW_RESEARCH = [
  "Part 1, the evidence. Spot-check the key references against the code or files: do they exist and say what is claimed? Every sub-question of the brief is answered or listed under Gaps; no claim goes beyond its source; conflicts are reported, not hidden; speculation is flagged; descriptive mode has no recommendations.",
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
  const capNote = (): string | false => {
    const notes: string[] = []
    if (task.needInfo >= needInfoLimit(config, task))
      notes.push(isDocWorkflow(task) ? "The search limit is reached: write the document with what you have, and list what is missing." : "The search limit is reached: plan with what you have, or ESCALATE.")
    if (task.questionRounds >= config.limits.questionsPerTask) notes.push("The question limit is reached: decide with what you have.")
    return notes.length ? notes.join(" ") : false
  }
  switch (p.mode) {
    case "lead":
      if (p.revision)
        return join(
          LEAD_REVISION.replaceAll("{doc}", `${docName(task)} (doc-${task.doc}.md)`),
          freshSession && join(f("request.md"), f("brief.md"), f("answers.md")),
          f(`doc-${task.doc}.md`),
          `The user's comments:\n${p.note ?? ""}`,
          capNote(),
        )
      if (!freshSession && p.note) return join(p.note, capNote())
      return join(
        `Task ${task.id}: sort this request and report.`,
        task.workflow === "plan" && LEAD_PLAN,
        task.workflow === "research" && LEAD_RESEARCH,
        !isDocWorkflow(task) && task.forcePlan && "The user asked for a plan: don't choose TRIVIAL. Write the brief and report ESCALATE (or QUESTIONS).",
        f("request.md"), f("checks.md"), f("answers.md"), p.note, capNote())
    case "lead_fail":
      return join(
        "MODE: failure. The trivial attempt did not finish. Write the full brief for the planner, with code findings only: findings with path:line, the relevant code excerpts with line ranges, the edits that were kept, and why it is not trivial. Don't restate the user's goal or constraints; the planner gets the request itself. Report ESCALATE.",
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
        const earlier = task.history.map((h) => h.file).filter((x): x is string => !!x && x !== "brief.md")
        const doc = isDocWorkflow(task) && task.workflow
        return join(
          doc ? `Task ${task.id}: write the ${docName(task)} for this request (workflow ${doc}).` : `Task ${task.id}: write a plan for this request.`,
          doc && docHandoff(config, task),
          f("request.md"),
          f("checks.md"),
          f("brief.md"),
          f("answers.md"),
          ...[...new Set([...earlier, ...unseen])].map(f),
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
      return join(
        "MODE: review of a destructive plan. Check that the destructive or irreversible steps are necessary and safe, and that nothing is lost. Report APPROVE (optional notes) or CHANGES (what must change and why).",
        f("request.md"),
        f("checks.md"),
        f("answers.md"),
        f("brief.md"),
        f(`plan-${task.plan}.md`),
      )
    case "principal_advice": {
      if (!freshSession && p.note) return join(p.note, "Now give your advice (ADVICE), or report QUESTIONS if a decision still belongs to the user.", capNote())
      const plans = Array.from({ length: task.seq.plan ?? 0 }, (_, i) => f(`plan-${i + 1}.md`))
      return join(
        `MODE: advice. The task is stuck: ${p.note ?? ""}. Say which approach the Architect should take (ADVICE), or, if the decision belongs to the user, report QUESTIONS.`,
        f("request.md"),
        f("checks.md"),
        f("brief.md"),
        f("answers.md"),
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
        f("answers.md"),
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
      return join(rules, f("request.md"), f("brief.md"), f("answers.md"), latest(isDocWorkflow(task) ? "doc" : "plan"), question)
    }
    case "principal_doc_review": {
      const research = task.workflow === "research"
      const file = isDocWorkflow(task) ? `doc-${task.doc}.md` : `plan-${task.plan}.md`
      const what = isDocWorkflow(task) ? `the ${docName(task)}` : `plan ${task.plan}`
      const standard = isDocWorkflow(task) ? workflowInstructions(config, task.workflow as "plan" | "research") : ""
      return join(
        `MODE: critical review of ${what} (${file}), asked for by the user (review ${task.reviews ?? 1} of at most ${config.limits.principalReviews}). Review it in two parts, and keep them apart in your report.`,
        research ? REVIEW_RESEARCH : REVIEW_PLAN,
        "Report APPROVE when it holds as written (content: optional notes for the user), or CHANGES: at most 5 must-fix items, most important first, each with where, the problem and the fix; then any should-consider items, marked as such. Don't rewrite the document.",
        p.note && `What the user asked the review to look at:\n${p.note}`,
        f("request.md"),
        f("answers.md"),
        f("brief.md"),
        standard && `<standard>\n${standard}\n</standard>`,
        ...task.history.filter((h) => h.mode === "principal_doc_review" && h.file).map((h) => f(h.file!)),
        f(file),
      )
    }
  }
}

/** What the Architect is told about writing a plan document or research report. */
function docHandoff(config: Config, task: TaskState): string {
  const wf = task.workflow as "plan" | "research"
  return join(
    wf === "plan"
      ? "Nobody changes code in this task: the document is the deliverable. When a fact is missing, report NEED_INFO with precise queries. When a decision belongs to the user and changes what gets built, report QUESTIONS, each with the options and your recommendation."
      : "Write only from evidence: the brief's findings, the Intern's findings and what you read yourself. When a sub-question lacks evidence, report NEED_INFO with precise queries for the Intern: for each, the objective, what to return, where to look and what is out of scope, with no overlap between queries. Stop searching when the last round added nothing new; list what is still missing under Gaps.",
    `Report DOC with the whole document in \`content\` (markdown); the plugin saves it to ${task.output}. \`summary\`: the first line says what the document gives the user ("Approving this gives you …").`,
    readTaskFile(task, "existing.md") &&
      "That file already exists (below): keep it and change only what the request asks for. For a research follow-up, append a `## Follow-up <date>: <topic>` section.",
    fileBlock(task, "existing.md"),
    `<standard>\n${workflowInstructions(config, wf)}\n</standard>`,
  )
}

// ---- what the manager gets back ----

const REPLY_ROUTES =
  'a clear approval ("approve", "go ahead") → team "approve"; a clear stop → team "stop"; feedback, requests for changes or more work → polish and confirm [Send] [Edit] [Cancel], then team "change"; a question → polish and confirm, then team "ask"; a request for a (critical) review → team "review", with what the review should look at as text if they said.'

/** Principal's review shown at approval, marked when the plan or document was revised after it. */
function principalBlock(task: TaskState): string {
  if (!task.principalNote) return ""
  const verdict = task.history.find((h) => h.file === task.principalNote)?.status
  const title = verdict === "CHANGES" ? "**Principal's review** (this version was revised to address it)" : "**Principal's notes**"
  return `${title}\n${readTaskFile(task, task.principalNote)}`
}

export function render(task: TaskState): string {
  const last = task.history[task.history.length - 1]
  const lastLine = last ? `${last.role} → ${last.status}: ${last.summary.split("\n")[0].replace(/[.\s]+$/, "")}` : "started"
  const files = task.editedFiles.length ? task.editedFiles.map((f) => `- ${f}`).join("\n") : "(none)"
  const attempts = `Attempts: ${task.attempts}/${task.attemptLimit}.`
  const usage = () => usageReport(task.usage, Math.max(1, task.planSteps))
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
    case "brief":
      return join(
        "RESEARCH BRIEF ready. Show this block to the user exactly as written:",
        `<show>\n**Research brief** (${task.depth ?? "?"} research)\n\n${researchBrief(readTaskFile(task, "brief.md"))}\n</show>`,
        `NEXT ACTION: show the block above and end with one line: "Reply to start the research, adjust the brief, or stop." No buttons. Then act on the reply: a clear go ("go", "looks good") → team "approve"; a clear stop → team "stop"; adjustments → polish and confirm [Send] [Edit] [Cancel], then team "change"; a question → polish and confirm, then team "ask".`,
      )
    case "approval": {
      if (isDocWorkflow(task)) {
        const doc = readTaskFile(task, `doc-${task.doc}.md`)
        const block = join(
          `**${docName(task)[0]!.toUpperCase()}${docName(task).slice(1)}** (version ${task.doc})`,
          `**What you get**\n${task.docSummary ?? "(no summary)"}`,
          `**Sections**\n${sectionTitles(doc).map((t) => `- ${t}`).join("\n") || "(none)"}`,
          principalBlock(task),
          `**File:** ${task.output}`,
        )
        return join(
          `${docName(task).toUpperCase()} ready for the user. Show this block to the user exactly as written, without rewording or shortening it:`,
          `<show>\n${block}\n</show>`,
          `NEXT ACTION: show the block above and end with one line: "Reply to approve, change or stop it, ask about it, or have Principal review it." No buttons. Then act on the user's reply: ${REPLY_ROUTES}`,
        )
      }
      const planFile = path.join(task.dir, `plan-${task.plan}.md`)
      const titles = stepTitles(readTaskFile(task, `plan-${task.plan}.md`))
      const block = join(
        `**Plan ${task.plan}**`,
        `**What you get**\n${task.planSummary ?? "(no summary)"}`,
        `**Steps**\n${titles.length ? titles.join("\n") : `${task.planSteps} step(s); see the plan file.`}`,
        `**Risk:** ${task.planRisk ? "yes (destructive or irreversible steps)" : "no"}`,
        principalBlock(task),
        `**Plan file:** ${planFile}`,
      )
      return join(
        `PLAN ${task.plan} ready for approval. Show this block to the user exactly as written, without rewording or shortening it:`,
        `<show>\n${block}\n</show>`,
        `NEXT ACTION: show the block above and end with one line: "Reply to approve, change or stop the plan, ask about it, or have Principal review it." No buttons. Then act on the user's reply: ${REPLY_ROUTES}`,
      )
    }
    case "stuck":
      return join(
        `STUCK: ${task.stuckReason}`,
        `What was tried: ${task.plan} plan(s), ${task.planFailures} plan failure(s), round ${task.rounds} on step ${task.step}.`,
        lastErrors(task),
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
        usage(),
        `NEXT ACTION: show this to the user and ask [Continue +10 attempts] [Stop]. Continue → team "extend". Stop → team "stop".`,
      )
    case "done":
      if (isDocWorkflow(task))
        return join(
          `DONE: the ${docName(task)} is approved: ${task.output}`,
          task.docSummary,
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
