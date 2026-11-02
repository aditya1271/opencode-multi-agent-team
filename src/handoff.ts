// What each agent is told when it is called: one message per mode, built from the task's files and state.
import { workflowInstructions } from "./agents.ts"
import type { Config } from "./config.ts"
import { docName, draftFile, fileBlock, howOutput, join, scopeText } from "./messages.ts"
import { ADVICE_RULES, ANALYST_ANSWER, ANALYST_ASK, ANALYST_CODE, ANALYST_INFEASIBLE, ANALYST_RESEARCH, ANALYST_REVISION, ANALYST_WHAT, HOW_BRIEF, INTERN_RESEARCH, REVIEW_PLAN, REVIEW_RESEARCH } from "./notes.ts"
import { blocksActive, needInfoLimit } from "./report.ts"
import { answerFiles, answersName, briefName, draftIsDoc, MODE_ROLE, readTaskFile, type Mode, type Pending, type TaskState } from "./state.ts"
import { reportBlock } from "./statuses.ts"

/** The Operator's task message: the user's request (team action run), or what Analyst or Developer needs run mid-task. */
export const operatorPrompt = (request: string, asker?: string) =>
  join(
    asker
      ? `MODE: run for ${asker}, who needs this run to carry on with its task. Carry out the request below and report RESULT with the output ${asker} needs, or FAILED.`
      : "MODE: run. Carry out the user's request below and report RESULT with the output, or FAILED.",
    `<request>\n${request}\n</request>`,
  )

/** A review checks the work against each requirement and decision, one line each. */
export const REVIEW_VERDICT_FORMAT = "`R1: met «the code line that does it» path:line` or `R1: not met — what is missing or differs`"

function verdictAsk(task: TaskState): string {
  if (!readTaskFile(task, "requirements.md")) return ""
  return `requirements.md holds what the user asked for, in their own words, and what was decided; the plan is the team's reading of it and can drift. Start content with one line per id: ${REVIEW_VERDICT_FORMAT}. The plugin checks that each quoted line is in the file you cite, and takes PASS only when every line is met.`
}

/** On a re-review: the last review of this plan, so the reviewer starts from what it found. */
function lastReview(task: TaskState): string {
  const file = task.history.filter((h) => (h.mode === "review" || h.mode === "review_trivial") && h.plan === (task.plan || undefined) && h.file).at(-1)?.file
  if (!file) return ""
  return join(
    "This is a re-review. Your last review is below: check first that each issue it raised is fixed, then that the lines it found met still hold after the fixes.",
    fileBlock(task, file),
  )
}

/** The read-back: does the request a team will work from still carry each thing the user asked for? */
export const requestCheckPrompt = (reqs: { quote: string; need: string }[], text: string) =>
  join(
    "MODE: request check. A team will build from the request below and nothing else. Read it as they will, then go through the user's requirements: for each, is it in the request as fully and as firmly as the user said it? Use no tools; the request is all you judge.",
    reqs.map((r, i) => `- R${i + 1}: ${r.need} (the user: «${r.quote}»)`).join("\n"),
    `<request>\n${text}\n</request>`,
    "Report CHECKED with one line per requirement: `R1: kept «the words in the request that carry it»`; `R1: weakened «those words» — what is lost` when it is softer, narrower or vaguer than the user said; `R1: missing` when nothing carries it.",
  )

/** Assumptions a writer marked, checked against the code by the Intern before the draft goes to approval. */
export const assumptionCheckPrompt = (lines: string) =>
  join(
    "MODE: assumption check. The plan below rests on these assumptions about the code. Check each in the code and quote what settles it.",
    `<assumptions>\n${lines}\n</assumptions>`,
    "Report CHECKED with one line per id: `A1: confirmed «the code line that shows it» path:line`, or `A1: wrong «the code line that shows it» path:line — what is true instead`. Quote the code exactly as it is in the file.",
  )

const ANALYST_PLAN = join("Workflow: plan. Nobody edits files in this task, and there is no build or test. Report ESCALATE with the brief.", ANALYST_WHAT, ANALYST_ASK)

/** What every mode's message draws on: the task, the hand-off, and the files the task holds. */
interface H {
  config: Config
  task: TaskState
  p: Pending
  freshSession: boolean
  f: (name: string) => string
  latest: (kind: string) => string
  edited: string
  stageBrief: () => string
  answers: () => string
  whatDoc: () => string
  delivered: () => string[]
  capNote: () => string | false
}

function context(config: Config, task: TaskState, p: Pending, freshSession: boolean): H {
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
  return { config, task, p, freshSession, f, latest, edited, stageBrief, answers, whatDoc, delivered, capNote }
}

/** Every task message ends with the statuses allowed now (statuses.ts), and for a reviewed draft, its format. */
export function buildPrompt(config: Config, task: TaskState, p: Pending, freshSession: boolean): string {
  const body = MESSAGES[p.mode](context(config, task, p, freshSession))
  const reviewed =
    p.mode === "analyst" && !p.revision && task.stage !== "how" ? "brief" : p.mode === "planner" ? "draft" : undefined
  return join(body, reportBlock(config, task, p.mode, reviewed))
}

const MESSAGES: Record<Mode, (h: H) => string> = {
  analyst: analystMessage,
  analyst_fail: analystFailMessage,
  fix_trivial: fixTrivialMessage,
  review_trivial: reviewTrivialMessage,
  planner: plannerMessage,
  intern: internMessage,
  architect_review: architectReviewMessage,
  fix: fixMessage,
  diagnose: diagnoseMessage,
  review: reviewMessage,
  architect_advice: architectAdviceMessage,
  analyst_reply: replyMessage,
  planner_reply: replyMessage,
  architect_reply: replyMessage,
  architect_doc_review: architectDocReviewMessage,
  analyst_answer: analystAnswerMessage,
  planner_advice: adviceMessage,
  architect_draft_advice: adviceMessage,
  planner_consult: plannerConsultMessage,
  planner_stepfix: plannerStepfixMessage,
  operator: noteMessage,
  request_check: noteMessage,
}

function analystMessage(h: H): string {
  const { task, p, freshSession, f, stageBrief, answers, whatDoc, delivered, capNote } = h
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
}

function adviceMessage(h: H): string {
  const { task, p, freshSession, f, stageBrief, answers, whatDoc, delivered } = h
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

function plannerConsultMessage(h: H): string {
  const { task, p, freshSession, f, answers, whatDoc, delivered } = h
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

function analystAnswerMessage(h: H): string {
  const { p, freshSession, f, stageBrief, answers, whatDoc, delivered, capNote } = h
  const head = ANALYST_ANSWER.replace("{asker}", MODE_ROLE[p.asker ?? "planner"] === "planner" ? "The Planner" : "Architect")
  if (!freshSession) return join(head, p.note, ...delivered(), capNote())
  return join(head, f("request.md"), whatDoc(), stageBrief(), answers(), p.note, ...delivered(), capNote())
}

function analystFailMessage(h: H): string {
  const { f, latest, edited } = h
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
}

function fixTrivialMessage(h: H): string {
  const { task, f } = h
  return join(
    task.skipChecks
      ? "Make this trivial change. Build and test are skipped: don't run them."
      : "Make this trivial change, and iterate until its check command passes or you are stuck.",
    f("request.md"),
    f("checks.md"),
    f("brief.md"),
  )
}

function reviewTrivialMessage(h: H): string {
  const { task, f, latest } = h
  return join(
    `MODE: review. A trivial change touched more than one file. Check the changes against the request and the instruction. Changed files: ${task.editedFiles.join(", ")}. Use git diff or p4 diff to see them. Report PASS, or ISSUES with instructions for Developer.`,
    verdictAsk(task),
    f("request.md"),
    f("requirements.md"),
    lastReview(task),
    f("checks.md"),
    f("answers.md"),
    f("brief.md"),
    latest("report"),
  )
}

function plannerMessage(h: H): string {
  const { task, p, config, freshSession, f, stageBrief, answers, whatDoc, capNote } = h
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

function plannerStepfixMessage(h: H): string {
  const { task, p, freshSession, f, stageBrief, answers, whatDoc } = h
  const unseen = [...new Set(task.plannerUnseen)]
  task.plannerUnseen = []
  const report = task.history.filter((h) => h.mode === "fix" && h.plan === task.plan && h.step === task.step && h.file).at(-1)?.file
  const ask = join(
    `MODE: step fix. ${p.note ?? `Developer is blocked on step ${task.step}`}. Developer's report is ${report ?? "below"}. Fix that step instead of writing a new plan, if you can (STEP): the replacement starts with \`N. **Title**: <what the step achieves>\`, and the finished steps and the rest of the plan stay as they are. If the plan is wrong beyond this step, report REPLAN.`,
  )
  if (!freshSession) return join(unseen.length > 0 && join("New information since your last call:", ...unseen.map(f)), ask)
  return join(ask, f("request.md"), f("checks.md"), whatDoc(), stageBrief(), answers(), f(`plan-${task.plan}.md`), ...unseen.map(f))
}

function noteMessage(h: H): string {
  const { p } = h
  // Team builds these messages (operatorPrompt, requestCheckPrompt).
  return p.note ?? ""
}

function internMessage(h: H): string {
  const { task, p } = h
  if (task.workflow === "research") return join(INTERN_RESEARCH, `<queries>\n${p.note ?? ""}\n</queries>`)
  return join(
    `MODE: planner search. Answer these queries for ${p.asker === "analyst" ? "Analyst" : "the Planner"} with findings. End with what you searched (terms, paths, graph queries), so a missing result can be judged. Report FOUND, or NOT_FOUND.`,
    `<queries>\n${p.note ?? ""}\n</queries>`,
  )
}

function architectReviewMessage(h: H): string {
  const { task, p, freshSession, f, stageBrief, answers, whatDoc, delivered, capNote } = h
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
}

function architectAdviceMessage(h: H): string {
  const { task, p, freshSession, f, latest, stageBrief, answers, whatDoc, delivered, capNote } = h
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

function fixMessage(h: H): string {
  const { task, p, f } = h
  const head = `Plan ${task.plan}, step ${task.step} of ${task.planSteps}${task.step === task.planSteps ? " (the final check)" : ""}.`
  const rules = task.skipChecks
    ? "Do only this step. Build and test are skipped: don't run them."
    : "Do only this step, and iterate until its check command passes."
  if (!task.developerSeenPlan) {
    task.developerSeenPlan = true
    return join(`Carry out this plan one step at a time. ${head}`, rules, f(`plan-${task.plan}.md`), f("checks.md"), p.note)
  }
  return join(head, p.note, rules)
}

function diagnoseMessage(h: H): string {
  const { task, f } = h
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

function reviewMessage(h: H): string {
  const { task, f, answers, whatDoc } = h
  const reports = task.history.filter((h) => h.plan === task.plan && h.mode === "fix" && h.status !== "CONSULT" && h.status !== "RUN" && h.file).map((h) => f(h.file!))
  return join(
    `MODE: review. Plan ${task.plan} is finished${task.skipChecks ? " (build and test skipped by the user)" : " and its final check passed"}. Compare the changes with the plan and the request. The user's answers and comments settle the request's open points. Changed files: ${task.editedFiles.join(", ")}. Use git diff or p4 diff to see them. Report PASS, or ISSUES with instructions for Developer.`,
    verdictAsk(task),
    f("request.md"),
    f("requirements.md"),
    lastReview(task),
    f("checks.md"),
    answers(),
    whatDoc(),
    f(`plan-${task.plan}.md`),
    ...reports.slice(-4),
  )
}

function replyMessage(h: H): string {
  const { task, p, freshSession, f, stageBrief, answers, whatDoc } = h
  const rules =
    "MODE: user question. The task is waiting on the user, who asks you this before they answer or decide. Answer it in content: clear and specific, with pros, cons and impact when they ask about options. Don't revise the plan, ask questions or start new work. Report ANSWER."
  const question = p.note ?? ""
  if (!freshSession) return join(rules, question)
  const draft = (draftIsDoc(task) ? task.doc : task.plan) ? f(draftFile(task)) : ""
  return join(rules, f("request.md"), whatDoc(), stageBrief(), answers(), draft, question)
}

function architectDocReviewMessage(h: H): string {
  const { task, p, config, freshSession, f, stageBrief, answers, whatDoc, delivered, capNote } = h
  if (!freshSession && p.note && p.files?.length) return join(p.note, ...delivered(), "Report again.", capNote())
  const research = task.workflow === "research"
  const file = draftFile(task)
  const what = `the ${docName(task)}${draftIsDoc(task) ? "" : ` (plan ${task.plan})`}`
  const standard = workflowInstructions(config, research ? "research" : draftIsDoc(task) ? "what" : "how")
  return join(
    `MODE: critical review of ${what} (${file}), asked for by the user (review ${task.reviews ?? 1} of at most ${config.limits.architectReviews}). Review it in two parts, and keep them apart in your report.`,
    research ? REVIEW_RESEARCH : REVIEW_PLAN,
    "Check claims against the brief, Analyst's answers and the findings; when a claim matters and nothing quotes it, ask Analyst for the exact quote.",
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

/** What the Planner is told about its draft in this stage: the status to report and the standard. */
function plannerHandoff(config: Config, task: TaskState): string {
  if (task.workflow === "research")
    return join(
      "Write only from evidence: the brief's findings and the Intern's findings. When a sub-question lacks evidence, have the Intern search (NEED_INFO).",
      `The plugin saves the document to ${task.output}. \`summary\`: the first line says what the document gives the user ("Approving this gives you …").`,
      readTaskFile(task, "existing.md") && "That file already exists (below): keep it and append a `## Follow-up <date>: <topic>` section for the new question.",
      fileBlock(task, "existing.md"),
      `<standard>\n${workflowInstructions(config, "research")}\n</standard>`,
    )
  if (draftIsDoc(task))
    return join(
      "Stage: WHAT. Write the what-document: what the feature does, as a process, independent of code. The change plan comes after the user approves it.",
      `${task.output ? `The plugin saves the document to ${task.output}. ` : ""}\`summary\`: the first line says what the user decides by approving ("Approving this settles …").`,
      readTaskFile(task, "existing.md") && "That file already exists (below): keep it and change only what the request asks for.",
      fileBlock(task, "existing.md"),
      `<standard>\n${workflowInstructions(config, blocksActive(config, "planner", task) ? "blocks" : "what")}\n</standard>`,
    )
  const plan = task.workflow === "plan"
  return join(
    `Stage: HOW. Write the change plan${task.doc ? " for the approved what-document" : ""}. Developer carries it out step by step${plan ? " once the user chooses [Implement it]; nobody edits files before that" : " once the user approves it"}.`,
    !task.doc && "There is no what-document: Analyst found that the request fixes the behaviour (see the brief). Start the plan with a short `## Behaviour` section: what the change does, as the user will see it, in a few lines.",
    !!task.doc && "Follow every decision of the what-document.",
    plan && !readTaskFile(task, "checks.md") && "No build or test commands are known yet: give each step's check as what it must prove, plus the command when the brief names one.",
    plan && !!task.output && `The plugin saves the plan to ${howOutput(task.output)}.`,
    `<standard>\n${workflowInstructions(config, "how")}\n</standard>`,
  )
}
