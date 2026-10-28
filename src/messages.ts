// What the agents and the polisher are told: per-mode hand-off prompts and the team tool's results.
import path from "node:path"
import type { Config } from "./config.ts"
import { MODE_ROLE, readTaskFile, type Pending, type TaskState } from "./state.ts"
import { report as usageReport } from "./usage.ts"

export const fileBlock = (task: TaskState, name: string) => {
  const body = readTaskFile(task, name)
  return body ? `<file name="${name}">\n${body}\n</file>` : ""
}

export const join = (...parts: (string | undefined | false)[]) => parts.filter(Boolean).join("\n\n")

export const checksText = (commands: string) =>
  [
    "# Build and test commands",
    "Only Fixer runs them; the other agents don't build or test, they put these commands into the instruction or plan as check commands. Use only these; don't look for other ways to build or test. If they don't cover what is needed, the planner asks the user (QUESTIONS) and Fixer reports BLOCKED.",
    commands,
  ].join("\n\n")

export const SKIP_CHECKS = [
  "# Build and test: skipped",
  "The user chose to skip build and test for this task. Don't build, don't run tests, and don't look for how to.",
  "Plans and the trivial instruction give `none` as the check. Fixer reports DONE once the edits are made (checkCommand `none`).",
].join("\n\n")


export function buildPrompt(config: Config, task: TaskState, p: Pending, freshSession: boolean): string {
  const f = (name: string) => fileBlock(task, name)
  const latest = (kind: string) => (task.seq[kind] ? f(`${kind}-${task.seq[kind]}.md`) : "")
  const edited = task.editedFiles.length ? `Files changed so far (kept): ${task.editedFiles.join(", ")}` : "No files changed so far."
  const capNote = (): string | false => {
    const notes: string[] = []
    if (task.needInfo >= config.limits.needInfoPerTask) notes.push("The search limit is reached: plan with what you have, or ESCALATE.")
    if (task.questionRounds >= config.limits.questionsPerTask) notes.push("The question limit is reached: decide with what you have.")
    return notes.length ? notes.join(" ") : false
  }
  switch (p.mode) {
    case "triage":
      if (!freshSession && p.note) return join(p.note, capNote())
      return join(`Task ${task.id}: sort this request and report.`, f("request.md"), f("checks.md"), f("answers.md"), p.note, capNote())
    case "triage_fail":
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
        `MODE: review. A trivial change touched more than one file. Check the changes against the request and the instruction. Changed files: ${task.editedFiles.join(", ")}. Use git diff or p4 diff to see them. Report PASS, or ISSUES with instructions for Fixer.`,
        f("request.md"),
        f("checks.md"),
        f("answers.md"),
        f("brief.md"),
        latest("report"),
      )
    case "senior": {
      const unseen = [...new Set(task.seniorUnseen)]
      task.seniorUnseen = []
      if (freshSession) {
        const earlier = task.history.map((h) => h.file).filter((x): x is string => !!x && x !== "brief.md")
        return join(
          `Task ${task.id}: write a plan for this request.`,
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
    case "explorer":
      return join(
        "MODE: planner search. Answer these queries for the senior planner with path:line findings and short code excerpts. Report FOUND, or NOT_FOUND with what you searched.",
        `<queries>\n${p.note ?? ""}\n</queries>`,
      )
    case "oracle_review":
      return join(
        "MODE: review of a destructive plan. Check that the destructive or irreversible steps are necessary and safe, and that nothing is lost. Report APPROVE (optional notes) or CHANGES (what must change and why).",
        f("request.md"),
        f("checks.md"),
        f("answers.md"),
        f("brief.md"),
        f(`plan-${task.plan}.md`),
      )
    case "oracle_advice": {
      const plans = Array.from({ length: task.seq.plan ?? 0 }, (_, i) => f(`plan-${i + 1}.md`))
      return join(
        `MODE: advice. The task is stuck: ${p.note ?? ""}. Say which approach the senior planner should take (ADVICE), or, if the decision belongs to the user, report QUESTIONS.`,
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
      if (!task.fixerSeenPlan) {
        task.fixerSeenPlan = true
        return join(`Carry out this plan one step at a time. ${head}`, rules, f(`plan-${task.plan}.md`), f("checks.md"), p.note)
      }
      return join(head, p.note, rules)
    }
    case "diagnose": {
      const stepFiles = task.history.filter((h) => h.plan === task.plan && h.step === task.step && h.file).map((h) => f(h.file!))
      return join(
        `MODE: diagnosis. Fixer is stuck on step ${task.step} of plan ${task.plan}. Below is the step's whole attempt history.`,
        task.latestLog ? `The latest full build/test log: ${task.latestLog} (read it as needed).` : "",
        "Decide: LOCAL (Fixer can fix it; give exact instructions), REPLAN (the plan is wrong, or the step is going in circles), or ESCALATE (cause unclear). If the same error came back or a fix undid an earlier one, do not answer LOCAL.",
        f(`plan-${task.plan}.md`),
        f("checks.md"),
        ...stepFiles,
      )
    }
    case "review": {
      const reports = task.history.filter((h) => h.plan === task.plan && h.mode === "fix" && h.file).map((h) => f(h.file!))
      return join(
        `MODE: review. Plan ${task.plan} is finished${task.skipChecks ? " (build and test skipped by the user)" : " and its final check passed"}. Compare the changes with the plan and the request. The user's answers and comments settle the request's open points. Changed files: ${task.editedFiles.join(", ")}. Use git diff or p4 diff to see them. Report PASS, or ISSUES with instructions for Fixer.`,
        f("request.md"),
        f("checks.md"),
        f("answers.md"),
        f(`plan-${task.plan}.md`),
        ...reports.slice(-4),
      )
    }
    case "triage_reply":
    case "senior_reply": {
      const rules =
        "MODE: user question. The task is waiting on the user, who asks you this before they answer or decide. Answer it in content: clear and specific, with pros, cons and impact when they ask about options. Don't revise the plan, ask questions or start new work. Report ANSWER."
      const question = `<question>\n${p.note ?? ""}\n</question>`
      if (!freshSession) return join(rules, question)
      return join(rules, f("request.md"), f("brief.md"), f("answers.md"), latest("plan"), question)
    }
  }
}

// ---- what the polisher gets back ----

export function render(task: TaskState): string {
  const last = task.history[task.history.length - 1]
  const lastLine = last ? `${last.role} → ${last.status}: ${last.summary.split("\n")[0].replace(/[.\s]+$/, "")}` : "started"
  const files = task.editedFiles.length ? task.editedFiles.map((f) => `- ${f}`).join("\n") : "(none)"
  const attempts = `Attempts: ${task.attempts}/${task.attemptLimit}.`
  const usage = () => usageReport(task.usage, Math.max(1, task.planSteps))
  switch (task.phase) {
    case "running": {
      const progress =
        task.pending?.mode === "fix" ? ` Next: fixer, step ${task.step} of ${task.planSteps}.` : task.pending ? ` Next: ${MODE_ROLE[task.pending.mode]} (${task.pending.mode}).` : ""
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
    case "approval":
      return join(
        `PLAN ${task.plan} ready for approval. Risk: ${task.planRisk ? "yes (destructive or irreversible steps)" : "no"}. Steps: ${task.planSteps}.`,
        task.planSummary ?? "",
        task.oracleNote ? `Oracle's notes:\n${readTaskFile(task, task.oracleNote)}` : "",
        `Full plan: ${path.join(task.dir, `plan-${task.plan}.md`)}`,
        `NEXT ACTION: show the summary, the risk, Oracle's notes (if any) and the full plan path to the user and ask [Approve] [Change] [Stop]. Approve → team "approve". Change, or any feedback on the plan → polish the comments and confirm them [Send] [Edit] [Cancel], then team "change" with the confirmed comments. A question about the plan → polish and confirm it, then team "ask". Stop → team "stop".`,
      )
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
        `STOPPED: task ${task.id}. Files already edited stay as they are; nothing was reverted.`,
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
