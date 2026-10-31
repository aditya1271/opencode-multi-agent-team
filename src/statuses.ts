import type { Config } from "./config.ts"
import { allowedStatuses, needInfoLimit } from "./report.ts"
import { consultsUsed, MODE_ROLE, type Mode, type TaskState } from "./state.ts"

const RUN_HELP = "the Operator runs something for you that isn't code search: a web search or page, an API call, a command or script whose output you need. `content`: what to run, in which folder, and what output you need. The result comes back to you here; cite the URL or command you use."
const QUESTIONS_HELP = "decisions only the user can make (intent, a choice between valid options) that change what gets built. Each item: the question, the options, a line `Recommended: <option>` and why the answer matters. `content`: at most a few lines of context the user needs, not your draft (you write that after the answers). Anything with a sensible default is an assumption, not a question."
const ASK_HELP = "questions for Analyst, who looks the facts up and answers by id (A1, A2, …). `questions`: one per item, each saying what you need and why. Ask everything in one round."
const STUCK_HELP = "you can't see how to give the user what they keep asking for. `content`: what they ask, what you tried, where you are stuck. An adviser steps in, and you revise again."
const INFEASIBLE_HELP = "a decision of the approved what-document can't work in this code. `content`: which decision, the evidence (`path:line` and the lines), and what would work instead. Never quietly change a decision."
const USER_ANSWER = "answer the user's question in `content`: clear and specific, with pros, cons and impact when they ask about options."

/** What each status needs, by role; MODE overrides where a mode uses a status differently. */
const ROLE: Record<string, Record<string, string>> = {
  analyst: {
    TRIVIAL: "`content` is Developer's instruction: the file, the exact location (`path:line` range), the current lines, the change, and the check command.",
    ESCALATE: "`content` is the brief described above. Don't restate the request or the user's constraints; the Planner gets them.",
    QUESTIONS: QUESTIONS_HELP,
    NEED_INFO: "the Intern searches for you. `content`: one query per unknown: what to find, why you need it, what to return (`path:line` and the lines that matter, never whole files) and where to look. Ask for everything in one round; the findings come back to you here.",
    CONSULT: "a design question for the Planner while you write the brief (which approach fits, whether an option is sound). `questions`: one per item. `content`: the evidence (`path:line` and the lines, in a code block); the Planner sees no files. The answer comes back to you here.",
    RUN: RUN_HELP,
    INFEASIBLE: INFEASIBLE_HELP,
    STUCK: STUCK_HELP,
    ANSWER: "answer each question under its id (`### A3`) with new facts only: exact quotes with `path:line`, or what was searched when something isn't there. Point to your brief or earlier answers instead of repeating them. Say so when a question is a decision for the user.",
  },
  planner: {
    PLAN: "the whole plan in `content`, to the standard above; set `risk` and `steps`.",
    DOC: "the whole document in `content`, to the standard above.",
    ASK: ASK_HELP,
    NEED_INFO: "the Intern searches the code for you. `content`: one query per gap: the objective, why you need it, what to return and where to look, with no overlap. Stop when a round adds nothing new; list what is still missing under Gaps.",
    QUESTIONS: QUESTIONS_HELP,
    INFEASIBLE: INFEASIBLE_HELP,
    ESCALATE: "you are stuck, or the options are too close to call. `content`: what was tried, why it failed, and the question for the expert.",
    STUCK: STUCK_HELP,
    ADVICE: "`items`: one concrete instruction per entry for Analyst (what to add, explore, change or drop, and why), most important first; the plugin numbers them ADV1, ADV2, …. `content`: your diagnosis in a few lines: why the brief keeps missing.",
    ANSWER: "the decision, why, and what to watch for, in a few lines. Don't rewrite the plan or brief. If the evidence doesn't settle it, say which fact is missing and what to do meanwhile.",
    STEP: "`content`: only the step(s) that replace the blocked step, in the plan's step format (one step, or two when a new one must come first). `summary`: one line on what changed and why. `risk`: yes only if the new steps are destructive or irreversible.",
    REPLAN: "the plan is wrong beyond this step. `content`: why. You then write the next plan as usual.",
  },
  intern: {
    FOUND: "`content` answers each query under its own heading: `path:line` and the lines that prove it, quoted exactly in a code block. End with what you searched. The plugin refuses findings without quoted lines.",
    NOT_FOUND: "only after you searched the files directly too. `content`: what you searched (terms, paths, tools) and where.",
  },
  developer: {
    DONE: "the check command passed in this call (run it again even if it passed before), run exactly as written: no pipe, no `|| true`, nothing appended. `checkCommand`: that command; the plugin checks its real exit code. `content`: the changed files and the command.",
    FAILED: "only when stuck: the same error keeps coming back, or you're out of ideas. `content`: the key error lines, what you tried, the likely cause.",
    BLOCKED: "the instruction or step can't work as written, the cause is outside the step, or the user denied a command it needs. `content`: why.",
    CONSULT: "ask the Planner before you fail or block: which of two ways fits the plan, whether the step's assumption still holds. `questions`: one per item. `content`: the evidence (`path:line` and the lines, the exact output, what you tried); the Planner sees no files. Not a failed attempt; the answer comes back to you here.",
    RUN: `${RUN_HELP} Run the build, tests and check command yourself.`,
  },
  reviewer: {
    LOCAL: "Developer can fix it within the step. `content`: exact instructions (file, location, change).",
    REPLAN: "the plan is wrong, or the step is going in circles. `content`: the root cause, the evidence, and what the new plan must do differently.",
    ESCALATE: "the cause is unclear or needs expert judgement. `content`: what is known, the candidate causes, and the question for the expert.",
    PASS: "done as requested.",
    ISSUES: "gaps or mistakes. `content`: one instruction per issue for Developer (file, location, change).",
  },
  architect: {
    APPROVE: "it holds as written. `content`: optional notes for the user.",
    CHANGES: "`content`: what must change and why, most important first.",
    ASK: ASK_HELP,
    ADVICE: "`content`: the approach the Planner should take, concretely, and what to avoid.",
    QUESTIONS: QUESTIONS_HELP,
  },
  operator: {
    RESULT: "`content`: the output the asker needs, as produced (for long output, the part that matters and how much was left out), and the commands you ran.",
    FAILED: "`content`: what you ran, the error, and what the asker could try.",
  },
}

const MODE: Partial<Record<Mode, Record<string, string>>> = {
  analyst_fail: { ESCALATE: "`content` is the how brief described above, with why the change is not trivial and which edits were kept." },
  analyst_reply: { ANSWER: USER_ANSWER },
  planner_reply: { ANSWER: USER_ANSWER },
  architect_reply: { ANSWER: USER_ANSWER },
  architect_draft_advice: {
    ADVICE: "`items`: one concrete instruction per entry for the writer (what to add, explore, change or drop, and why), most important first; the plugin numbers them ADV1, ADV2, …. `content`: your diagnosis in a few lines: why the draft keeps missing.",
  },
  architect_doc_review: {
    CHANGES: "`content`: at most 5 must-fix items, most important first, each with where, the problem and the fix; then any should-consider items, marked as such. Don't rewrite the document.",
  },
}

/** Limits left, shown next to the status they cap. */
function left(config: Config, task: TaskState, mode: Mode, status: string): string {
  const n = (limit: number, used: number, what: string) => ` (${Math.max(0, limit - used)} ${what} left)`
  if (status === "NEED_INFO" && (mode === "analyst" || mode === "analyst_answer")) return n(config.limits.analystSearchRounds, task.analystSearches ?? 0, "rounds")
  if (mode === "planner" && task.workflow !== "research" && (status === "NEED_INFO" || status === "ASK"))
    return ` (${Math.min(needInfoLimit(config, task) - task.needInfo, config.limits.askRoundsPerDraft - (task.draftAsks ?? 0))} rounds left before this draft)`
  if (status === "NEED_INFO" || status === "ASK") return n(needInfoLimit(config, task), task.needInfo, "rounds")
  if (status === "QUESTIONS") return n(config.limits.questionsPerTask, task.questionRounds, "rounds")
  if (status === "RUN") return n(config.limits.runsPerTask, task.runs ?? 0, "runs")
  if (status === "CONSULT")
    return mode === "fix"
      ? n(config.limits.consultsPerStep, consultsUsed(task, "developer"), "questions")
      : n(config.limits.consultsPerBrief, consultsUsed(task, "analyst"), "questions")
  return ""
}

/** How the user reads a reviewed draft: only the Summary and Recommended lines of each section, and each step's first line. */
export function reviewedFormat(kind: "brief" | "draft"): string {
  const which =
    kind === "brief"
      ? "The user reviews the brief's sections (those under its Concept or Research brief heading)"
      : "The user reviews every section of the draft except the plan steps"
  return [
    `${which} and usually reads only two lines of each: open each with \`**Summary:** <1-3 plain sentences: the direction and why>\` (no paths, commands or mechanics; a section titled Summary or What you get needs none) and close it with \`**Recommended:** <option>: <short reason>\` (several choices: the pick for each; nothing open: \`as written\`). The rest of the section is for the agents and keeps its full detail.`,
    kind === "draft" ? "A plan step's first line is `N. **Title**: <one sentence on what the step achieves>`, the details on the next lines; the user sees only that line." : "",
    "The plugin refuses a draft without these lines.",
  ]
    .filter(Boolean)
    .join(" ")
}

/** The closing block of a task message: the statuses allowed now and what each needs. */
export function reportBlock(config: Config, task: TaskState, mode: Mode, reviewed?: "brief" | "draft"): string {
  const help = { ...ROLE[MODE_ROLE[mode]], ...MODE[mode] }
  if (task.skipChecks && help.DONE) help.DONE = "the edits are made (build and test are skipped). `checkCommand`: `none`. `content`: the changed files."
  const lines = allowedStatuses(config, mode, task)
    .filter((s) => help[s])
    .map((s) => `- **${s}**${left(config, task, mode, s)}: ${help[s]}`)
  if (!lines.length) return ""
  const block = ["## Report now (call `report` once, then stop)", ...lines].join("\n")
  return reviewed ? `${block}\n\n${reviewedFormat(reviewed)}` : block
}
