import { describe, expect, test } from "bun:test"
import { evaluate, FRONT_AGENTS, ignoredTools, managerPrompt, permissionsFor, roleOf, systemPrompt, toolVisible, workflowOf } from "../src/agents.ts"
import { buildPatterns, DEFAULTS, merge, modelLabel, modelsFor, parseModel, stripJsonc, tierOf, type Role } from "../src/config.ts"
import { analystReadProblem, toolKind, trimLog } from "../src/guards.ts"
import { commandParts, matchesAny } from "../src/match.ts"
import { acceptReport, allowedStatuses, checkProblem } from "../src/report.ts"
import { beginRun, runs } from "../src/runtime.ts"
import { appendFile, loadTask, migrateNames, newTask, save, taskId, WORKFLOWS } from "../src/state.ts"
import { MODE_COMMANDS, Team } from "../src/team.ts"
import { compact, line, modelsText } from "../src/rpc.ts"
import { buildPrompt, join, render, stepTitles } from "../src/messages.ts"
import { annotate, checkEdits, idRanges, indexOf, missingSummaries, shortView, splice, split, userView } from "../src/sections.ts"
import { add, hints, table } from "../src/usage.ts"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { detectVcs, vcsLine } from "../src/vcs.ts"
import path from "node:path"

describe("config", () => {
  test("stripJsonc keeps strings and drops comments and trailing commas", () => {
    const text = `{ // c\n "a": "x // y", /* b */ "b": [1, 2,], }`
    expect(JSON.parse(stripJsonc(text))).toEqual({ a: "x // y", b: [1, 2] })
  })
  test("parseModel", () => {
    expect(parseModel("fuse/kimi-k2.6")).toEqual({ providerID: "fuse", id: "kimi-k2.6" })
    expect(parseModel("a/b#high")).toEqual({ providerID: "a", id: "b", variant: "high" })
    expect(parseModel("a/b/c", "low")).toEqual({ providerID: "a", id: "b/c", variant: "low" })
    expect(() => parseModel("nope")).toThrow()
  })
  test("merge is deep and keeps defaults", () => {
    const c = merge(DEFAULTS, { limits: { taskAttempts: 10 } })
    expect(c.limits.taskAttempts).toBe(10)
    expect(c.limits.developerRounds).toBe(2)
  })
})

describe("guards", () => {
  test("commandParts unwraps bash -c", () => {
    expect(commandParts(`bash -c 'cd build && make -j8 all'`)).toContain("make -j8 all")
  })
  test("matchesAny", () => {
    expect(matchesAny("make", ["make *"])).toBe(true)
    expect(matchesAny("cd x && ninja -C out", ["ninja *"])).toBe(true)
    expect(matchesAny("cmaker", ["make *"])).toBe(false)
  })
  test("toolKind", () => {
    expect(toolKind("grep", {}, DEFAULTS)).toBe("search")
    expect(toolKind("shell", { command: "make all" }, DEFAULTS)).toBe("build")
    expect(toolKind("shell", { command: "ls" }, DEFAULTS)).toBe("shell")
    expect(toolKind("codebase-memory_search_graph", {}, DEFAULTS)).toBe("index")
  })
  test("trimLog keeps error lines and the tail", () => {
    const lines = Array.from({ length: 200 }, (_, i) => (i === 50 ? "foo.cpp:3: error: bad" : `line ${i}`))
    const out = trimLog(lines.join("\n"), 2, "/tmp/log")
    expect(out).toContain("foo.cpp:3: error: bad")
    expect(out).toContain("line 199")
    expect(out).not.toContain("line 100\n")
  })
})

describe("report statuses", () => {
  const task = newTask("/tmp/opencode/omat-test", "ses_x", "/tmp", "Goal\nfix the thing", 40)
  test("caps remove statuses", () => {
    expect(allowedStatuses(DEFAULTS, "planner", task)).toEqual(["PLAN", "ASK", "QUESTIONS", "ESCALATE"])
    task.needInfo = 6
    task.questionRounds = 4
    expect(allowedStatuses(DEFAULTS, "planner", task)).toEqual(["PLAN", "ESCALATE"])
    task.needInfo = 0
    task.questionRounds = 0
  })
  test("stages pick the Planner's statuses; only the how stage after a what-document may report INFEASIBLE", () => {
    const t = newTask("/tmp/opencode/omat-test", "ses_s", "/tmp", "Goal\nadd a feature", 40)
    expect(allowedStatuses(DEFAULTS, "analyst", t)).toEqual(["TRIVIAL", "ESCALATE", "QUESTIONS", "NEED_INFO", "CONSULT", "RUN"])
    t.stage = "what"
    expect(allowedStatuses(DEFAULTS, "planner", t)).toEqual(["DOC", "ASK", "QUESTIONS", "ESCALATE"])
    expect(allowedStatuses(DEFAULTS, "analyst", t)).toEqual(["ESCALATE", "QUESTIONS", "NEED_INFO", "CONSULT", "RUN"])
    t.stage = "how"
    expect(allowedStatuses(DEFAULTS, "planner", t)).toEqual(["PLAN", "ASK", "QUESTIONS", "ESCALATE"])
    t.doc = 1
    expect(allowedStatuses(DEFAULTS, "planner", t)).toContain("INFEASIBLE")
    expect(allowedStatuses(DEFAULTS, "analyst", t)).toContain("INFEASIBLE")
    const r = newTask("/tmp/opencode/omat-test", "ses_rs", "/tmp", "Goal\nresearch", 40)
    r.workflow = "research"
    expect(allowedStatuses(DEFAULTS, "planner", r)).toEqual(["DOC", "NEED_INFO", "QUESTIONS", "ESCALATE"])
  })
  test("Analyst's first ESCALATE in a code task must say whether the behaviour is settled", () => {
    const t = newTask("/tmp/opencode/omat-test", "ses_ws", "/tmp", "Goal\nadd --upper", 40)
    beginRun("ses_analyst", { role: "analyst", mode: "analyst", task: t, toolLimit: 10 })
    const esc = { status: "ESCALATE", summary: "s", content: "## Code\n\nx" }
    expect(() => acceptReport(DEFAULTS, "ses_analyst", esc)).toThrow("what")
    expect(() => acceptReport(DEFAULTS, "ses_analyst", { ...esc, what: "settled" })).toThrow("Why the behaviour is settled")
    expect(acceptReport(DEFAULTS, "ses_analyst", { ...esc, what: "settled", content: "## Why the behaviour is settled\n\nThe flag is named.\n\n## Code\n\nx" })).toContain("Report received")
    runs.delete("ses_analyst")
  })
  test("Analyst's answer must cite every question id", () => {
    const t = newTask("/tmp/opencode/omat-test", "ses_la", "/tmp", "Goal\nx", 40)
    t.pending = { mode: "analyst_answer", ids: ["A1", "A2"] }
    beginRun("ses_ans", { role: "analyst", mode: "analyst_answer", task: t, toolLimit: 10 })
    expect(() => acceptReport(DEFAULTS, "ses_ans", { status: "ANSWER", summary: "s", content: "### A1\nyes" })).toThrow("missing: A2")
    expect(acceptReport(DEFAULTS, "ses_ans", { status: "ANSWER", summary: "s", content: "### A1\nyes\n### A2\nno" })).toContain("Report received")
    runs.delete("ses_ans")
  })
  test("CONSULT needs questions and the evidence, since the Planner can't read files", () => {
    const t = newTask("/tmp/opencode/omat-test", "ses_cs", "/tmp", "Goal\nx", 40)
    Object.assign(t, { plan: 1, planSteps: 2, step: 1 })
    beginRun("ses_dev", { role: "developer", mode: "fix", task: t, toolLimit: 10 })
    const ask = { status: "CONSULT", summary: "s", content: "The files may not be in the depot." }
    expect(() => acceptReport(DEFAULTS, "ses_dev", ask)).toThrow("non-empty questions")
    expect(() => acceptReport(DEFAULTS, "ses_dev", { ...ask, questions: ["rm or p4 delete?"] })).toThrow("evidence")
    expect(acceptReport(DEFAULTS, "ses_dev", { ...ask, questions: ["rm or p4 delete?"], content: "src/a.c:3 is new:\n```\n$ p4 files src/a.c\nno such file\n```" })).toContain("Report received")
    runs.delete("ses_dev")
  })
  test("STEP holds only the replacement step(s), with risk", () => {
    const t = newTask("/tmp/opencode/omat-test", "ses_sf", "/tmp", "Goal\nx", 40)
    beginRun("ses_arch", { role: "planner", mode: "planner_stepfix", task: t, toolLimit: 10 })
    const step = { status: "STEP", summary: "s", content: "2. **Delete**: remove the files\n   rm old.c" }
    expect(() => acceptReport(DEFAULTS, "ses_arch", step)).toThrow("risk")
    expect(() => acceptReport(DEFAULTS, "ses_arch", { ...step, risk: "no", content: "Use rm instead.\n\n2. **Delete**: x" })).toThrow("Nothing before the first step")
    expect(() => acceptReport(DEFAULTS, "ses_arch", { ...step, risk: "no", content: "2. **Delete**\n   rm old.c" })).toThrow("N. **Title**")
    expect(() => acceptReport(DEFAULTS, "ses_arch", { ...step, risk: "no", content: "1. **A**: a\n2. **B**: b\n3. **C**: c" })).toThrow("one step, or two")
    expect(acceptReport(DEFAULTS, "ses_arch", { ...step, risk: "no" })).toContain("Report received")
    runs.delete("ses_arch")
  })
  test("analyst after a failed trivial attempt may only escalate", () => {
    task.trivialFailed = true
    expect(allowedStatuses(DEFAULTS, "analyst", task)).toEqual(["ESCALATE"])
  })
  test("checkProblem needs the check run in this call with exit 0", () => {
    expect(checkProblem("make test", [])).toContain("was not run")
    expect(checkProblem("make test", [{ command: "make test", exit: 2 }])).toContain("exited with 2")
    expect(checkProblem("make test", [{ command: "cd x && make  test", exit: 0 }])).toBeUndefined()
    expect(checkProblem("make test", [{ command: "make test 2>&1 | tail -50", exit: 0 }])).toContain("piped")
    expect(checkProblem("make test", [{ command: "make test || true", exit: 0 }])).toContain("piped")
    expect(checkProblem("make test", [{ command: "make test > log 2>&1", exit: 0 }])).toBeUndefined()
    expect(checkProblem("make test", [{ command: "make", exit: 0 }])).toContain("was not run")
    expect(checkProblem("cd build && make test", [{ command: "make test", exit: 0 }])).toBeUndefined()
  })
  test("DONE needs a passing check, unless the user skipped build and test", () => {
    const t = newTask("/tmp/opencode/omat-test", "ses_y", "/tmp", "Goal\nedit", 40)
    const done = { status: "DONE", summary: "s", content: "c" }
    beginRun("ses_fix", { role: "developer", mode: "fix", task: t, toolLimit: 10 })
    expect(() => acceptReport(DEFAULTS, "ses_fix", done)).toThrow("checkCommand")
    expect(() => acceptReport(DEFAULTS, "ses_fix", { ...done, checkCommand: "make" })).toThrow("was not run")
    t.skipChecks = true
    expect(acceptReport(DEFAULTS, "ses_fix", done)).toContain("Report received")
    runs.delete("ses_fix")
  })
  test("buildPatterns adds the configured build and test commands", () => {
    const c = merge(DEFAULTS, { checks: { build: "ssh host qftcmake", test: "" } })
    expect(buildPatterns(c)).toContain("ssh host qftcmake *")
    expect(toolKind("shell", { command: "ssh host qftcmake -j8" }, c)).toBe("build")
    expect(toolKind("shell", { command: "ssh host qftcmake" }, c)).toBe("build")
    const ssh = merge(DEFAULTS, { checks: { build: `ssh h "cd /v3 && qftcmake"` } })
    expect(toolKind("shell", { command: `ssh h "cd /v3 && qftcmake" -j8` }, ssh)).toBe("build")
  })
  test("taskId skips a Goal heading", () => {
    expect(taskId("**Goal**\nFix the parser", new Date(2026, 0, 2, 3, 4, 5))).toBe("20260102-030405-fix-the-parser")
  })
})

describe("permissions", () => {
  test("manager can only use team and question", () => {
    const rules = permissionsFor(DEFAULTS, "manager")
    expect(rules[0]).toEqual({ action: "*", resource: "*", effect: "deny" })
    expect(rules.filter((r) => r.effect === "allow").map((r) => r.action)).toEqual(["team", "question"])
  })
  test("planner and architect can only report (and load their skills)", () => {
    const config = merge(DEFAULTS, { agents: { architect: { skills: ["csh-terminal"] } } })
    expect(permissionsFor(config, "planner").filter((r) => r.effect === "allow").map((r) => r.action)).toEqual(["report"])
    const architect = permissionsFor(config, "architect")
    expect(architect.filter((r) => r.effect === "allow").map((r) => r.action)).toEqual(["skill", "report"])
    expect(evaluate(architect, "read", ["a.ts"])).toBe("deny")
  })
  test("evaluate: last match wins, team rules decide", () => {
    const analyst = permissionsFor(DEFAULTS, "analyst")
    expect(evaluate(analyst, "read", ["src/a.ts"])).toBe("allow")
    expect(evaluate(analyst, "edit", ["src/a.ts"])).toBe("deny")
    // Analyst reads only: searching (grep, glob, shell grep) goes to the Intern.
    for (const tool of ["grep", "glob"]) expect(evaluate(analyst, tool, ["*"])).toBe("deny")
    expect(evaluate(analyst, "shell", ["grep -rn foo ."])).toBe("deny")
    expect(evaluate(permissionsFor(DEFAULTS, "intern"), "grep", ["*"])).toBe("allow")
    const developer = permissionsFor(DEFAULTS, "developer")
    expect(evaluate(developer, "edit", ["a.ts", "b.ts"])).toBe("allow")
    expect(evaluate(developer, "shell", ["git reset --hard"])).toBe("ask")
    expect(evaluate(permissionsFor(DEFAULTS, "manager"), "read", ["a.ts"])).toBe("deny")
  })
  test("toolVisible", () => {
    const manager = permissionsFor(DEFAULTS, "manager")
    expect(["team", "question", "read", "shell", "edit"].filter((t) => toolVisible(manager, t))).toEqual(["team", "question"])
    expect(toolVisible(permissionsFor(DEFAULTS, "analyst"), "shell")).toBe(false)
    expect(toolVisible(permissionsFor(DEFAULTS, "intern"), "shell")).toBe(true)
    expect(toolVisible(permissionsFor(DEFAULTS, "analyst"), "write")).toBe(false)
    expect(toolVisible(permissionsFor(DEFAULTS, "developer"), "write")).toBe(true)
  })
  test("operator runs commands and fetches, can't edit, and asks before destructive commands", async () => {
    const operator = permissionsFor(DEFAULTS, "operator")
    expect(evaluate(operator, "shell", ["curl -s https://example.com/v1/models"])).toBe("allow")
    expect(evaluate(operator, "shell", ["bash scripts/list-models"])).toBe("allow")
    expect(evaluate(operator, "shell", ["git reset --hard"])).toBe("ask")
    expect(evaluate(operator, "webfetch", ["https://example.com"])).toBe("allow")
    expect(evaluate(operator, "edit", ["a.ts"])).toBe("deny")
    expect(toolVisible(operator, "write")).toBe(false)
    const team = new Team({} as never, merge(DEFAULTS, { taskDir: mkdtempSync(path.join(tmpdir(), "omat-run-")) }), () => {}) as any
    expect(await team.handle({ action: "run", text: " " }, "ses_r", new AbortController().signal)).toContain("run needs text")
    expect(await team.handle({ action: "run", text: "curl x" }, "ses_r", new AbortController().signal)).toContain('No model configured for the "operator" role')
  })
  test("model tiers: own model, then the role's tier, then its default tier; the agent's variant wins", () => {
    const tiers = {
      cheap: { model: ["fuse/luna", "copilot/luna"], variant: "low" },
      normal: { model: "fuse/kimi" },
      good: { model: "fuse/terra", variant: "high" },
      expensive: { model: ["siemens/opus", "copilot/opus"] },
    }
    const config = merge(DEFAULTS, { tiers, agents: { planner: { tier: "good" }, developer: { model: "fuse/glm" }, reviewer: { variant: "max" } } })
    const ids = (role: Role) => modelsFor(config, role).map(modelLabel)
    expect(ids("operator")).toEqual(["fuse/luna#low", "copilot/luna#low"])
    expect(ids("intern")).toEqual(["fuse/luna#low", "copilot/luna#low"])
    expect(ids("manager")).toEqual(["fuse/luna#low", "copilot/luna#low"])
    expect(ids("analyst")).toEqual(["fuse/kimi"])
    expect(ids("planner")).toEqual(["fuse/terra#high"])
    expect(ids("developer")).toEqual(["fuse/glm"])
    expect(ids("reviewer")).toEqual(["fuse/terra#max"])
    expect(ids("architect")).toEqual(["siemens/opus", "copilot/opus"])
    expect(tierOf(config, "planner")).toBe("good")
    // A tier with no models leaves its roles unconfigured.
    expect(modelsFor(merge(DEFAULTS, { tiers: { normal: { model: "fuse/kimi" } } }), "architect")).toEqual([])
  })
  test("every worker is told to keep secrets out of what it writes", () => {
    for (const role of ["analyst", "planner", "intern", "developer", "reviewer", "architect", "operator"] as const)
      expect(systemPrompt(DEFAULTS, role)).toContain("Never copy a secret's value")
    expect(managerPrompt(DEFAULTS, "code")).toContain("action `run`")
  })
  test("developer asks before destructive commands", () => {
    const rules = permissionsFor(DEFAULTS, "developer")
    expect(rules.some((r) => r.action === "shell" && r.resource === "git reset *" && r.effect === "ask")).toBe(true)
  })
  test("per-agent search tools, commands and mcps", () => {
    const config = merge(DEFAULTS, {
      agents: {
        analyst: { mcps: ["codebase-memory"], tools: ["docs_search"], commands: ["graphify *"] },
        planner: { mcps: ["codebase-memory"] },
        developer: { commands: ["rm -rf *"] },
      },
    })
    const analyst = permissionsFor(config, "analyst")
    expect(evaluate(analyst, "codebase-memory_search_graph", ["*"])).toBe("allow")
    expect(evaluate(analyst, "docs_search", ["*"])).toBe("allow")
    expect(evaluate(analyst, "shell", ["graphify query foo"])).toBe("allow")
    expect(evaluate(analyst, "shell", ["rm foo"])).toBe("deny")
    expect(evaluate(permissionsFor(config, "planner"), "codebase-memory_search_graph", ["*"])).toBe("deny")
    expect(ignoredTools(config)).toEqual(["agents.planner: codebase-memory ignored (planner has no tool access; Analyst answers its questions)"])
    expect(evaluate(permissionsFor(config, "developer"), "shell", ["rm -rf /"])).toBe("ask")
    expect(toolKind("docs_search", {}, config)).toBe("index")
    expect(toolKind("shell", { command: "graphify query foo" }, config)).toBe("index")
  })
})

describe("prompts", () => {
  test("default instructions fill the core prompt", () => {
    const p = systemPrompt(DEFAULTS, "intern")
    expect(p).toContain("You are the Intern")
    expect(p).toContain("## How to search")
    expect(p).not.toContain("{{instructions}}")
    expect(p).not.toContain("## Your tools\n\n-")
  })
  test("instructions replace the default; append and tools are added", () => {
    const config = merge(DEFAULTS, {
      agents: { intern: { instructions: "Use the RAG docs first.", append: "Answer in English.", tools: ["docs_search"] } },
    })
    const p = systemPrompt(config, "intern")
    expect(p).toContain("Use the RAG docs first.")
    expect(p).not.toContain("## How to search")
    expect(p).toContain("Report **FOUND**")
    expect(p).toContain("- Tools: docs_search.")
    expect(p.trimEnd().endsWith("Answer in English.")).toBe(true)
  })
})

describe("front agents", () => {
  test("three managers share the core; each has its workflow part and its own instructions", () => {
    const [build, plan, research] = WORKFLOWS.map((w) => managerPrompt(DEFAULTS, w))
    expect(build).toContain("You are build-manager")
    expect(build).toContain("`start` with `plan: true`")
    expect(plan).toContain("You are plan-manager")
    expect(plan).toContain("`implement`")
    expect(research).toContain("A follow-up question on a finished report")
    for (const p of [build, plan, research]) {
      expect(p).toContain("## You only polish and forward")
      expect(p).not.toMatch(/\{\{\w+\}\}/)
    }
    expect(plan).toContain("think critically")
    expect(systemPrompt(DEFAULTS, "manager")).toBe(build!)
    const config = merge(DEFAULTS, { agents: { manager: { append: "Be brief." }, "plan-manager": { instructions: "Plans are verbose." } } })
    expect(managerPrompt(config, "plan")).toContain("Plans are verbose.")
    expect(managerPrompt(config, "plan")).not.toContain("think critically")
    expect(managerPrompt(config, "research").trimEnd().endsWith("Be brief.")).toBe(true)
  })
  test("the calling agent decides the workflow and the role", () => {
    expect(WORKFLOWS.map((w) => workflowOf(FRONT_AGENTS[w]))).toEqual(["code", "plan", "research"])
    expect(workflowOf("team-analyst")).toBe("code")
    expect(roleOf(DEFAULTS, "plan-manager")).toBe("manager")
    expect(roleOf(DEFAULTS, "manager")).toBe("manager")
    expect(roleOf(DEFAULTS, "team-analyst")).toBe("analyst")
  })
})

describe("sections", () => {
  const doc = "# T\n\nintro\n\n## A\n\na body\n\n```\n# not a heading\n```\n\n## Steps\n\n1. **One** — x\n   detail\n2. **Two** — y\n\n## After\n\nz"
  test("split: headings and plan steps start sections; code blocks don't; nothing is lost", () => {
    const { head, sections } = split(doc)
    expect(head).toBe("")
    expect(sections.map((s) => [s.title, s.step])).toEqual([["T", false], ["A", false], ["Steps", false], ["1. One", true], ["2. Two", true], ["After", false]])
    const idx = indexOf(doc, "doc:1")
    expect(idx.ids).toEqual(["S1", "S2", "S3", "S4", "S5", "S6"])
    expect(splice(doc, idx, []).text).toBe(doc + "\n")
  })
  test("splice keeps every other section byte for byte, renumbers steps and reports the change", () => {
    const idx = { ...indexOf(doc, "doc:1"), final: ["S6"] }
    const out = splice(doc, idx, [
      { id: "S2", content: "## A\n\nnew body" },
      { id: "S5", content: "", reason: "merged into One" },
      { id: "new", after: "S4", content: "1. **Half** — h" },
      { id: "new", content: "## Risks\n\nr" },
    ])
    expect(out.text).toBe("# T\n\nintro\n\n## A\n\nnew body\n\n## Steps\n\n1. **One** — x\n   detail\n2. **Half** — h\n\n## After\n\nz\n\n## Risks\n\nr\n")
    expect(out.index.ids).toEqual(["S1", "S2", "S3", "S4", "S7", "S6", "S8"])
    expect(out.index.final).toEqual(["S6"])
    expect(out.change).toEqual({ revised: ["S2"], tuned: [], added: ["S7", "S8"], removed: ["S5"], also: [] })
    expect(annotate(out.text, out.index)).toContain("## After [S6 ✅]")
  })
  test("checkEdits enforces the scope", () => {
    const idx = { ...indexOf(doc, "doc:1"), final: ["S6"] }
    const scope = { draft: "draft" as const, revise: ["S2"], finetune: [], add: [] }
    expect(checkEdits(idx, scope, [{ id: "S2", content: "## A\n\nok" }], doc)).toEqual([])
    const errors = checkEdits(idx, scope, [{ id: "S6", content: "## After\n\nx" }, { id: "S1", content: "# T\n\ny" }, { id: "S4", content: "no step line" }], doc).join("\n")
    expect(errors).toContain("S6 is final")
    expect(errors).toContain("S1 is outside the revision scope")
    expect(errors).toContain("S4: content must start with the section's numbered bold step line")
    expect(errors).toContain("missing: S2")
    expect(checkEdits(idx, { ...scope, open: true }, [{ id: "S1", content: "# T\n\ny", reason: "title" }], doc)).toEqual([])
  })
  test("a whole new version keeps ids by title; idRanges", () => {
    const idx = { ...indexOf(doc, "doc:1"), final: ["S2"] }
    const next = indexOf("## A\n\nx\n\n## New\n\ny\n\n## After\n\nz", "doc:1", idx)
    expect([next.ids, next.final]).toEqual([["S2", "S7", "S6"], ["S2"]])
    expect(idRanges(["S1", "S2", "S3", "S5", "S7", "S8"])).toBe("S1–S3, S5, S7, S8")
  })
  test("the user view: Summary and Recommended lines, a step's purpose; the details stay for the agents", () => {
    const plan = [
      "# Plan",
      "## Summary\n\nApproving this moves the files.",
      "## Approach\n\n**Summary:** Move the files with history kept.\n\nUse p4 move for each file, then p4 delete the stubs.\n\n**Recommended:** p4 move: keeps history",
      "## Steps\n\n1. **Move the sources**: they live under lib/\n\np4 move src/a.cpp lib/a.cpp\n\n2. **Fix the build**\n\nedit CMakeLists.txt:12",
    ].join("\n\n")
    const { sections } = split(plan)
    expect(userView(sections[2]!)).toBe("**Summary:** Move the files with history kept.\n\n**Recommended:** p4 move: keeps history")
    expect(userView(sections[4]!)).toBe("they live under lib/")
    expect(missingSummaries(plan)).toEqual(["2. Fix the build"])
    expect(missingSummaries(plan.replace("**Summary:** Move", "Move"))).toEqual(["Approach", "2. Fix the build"])
    const short = shortView(plan)
    expect(short).toContain("Approving this moves the files.")
    expect(short).toContain("## Approach\n\n**Summary:** Move the files with history kept.\n\n**Recommended:** p4 move: keeps history")
    expect(short).toContain("1. **Move the sources**: they live under lib/")
    expect(short).not.toContain("p4 move src")
    expect(short).not.toContain("p4 delete")
  })
})

describe("plan and research workflows", () => {
  const signal = new AbortController().signal
  const setup = (switched: string[] = []) => {
    const root = mkdtempSync(path.join(tmpdir(), "omat-wf-"))
    const workspace = mkdtempSync(path.join(tmpdir(), "omat-ws-"))
    const ctx = {
      location: { directory: workspace },
      session: { context: async () => [], get: async () => undefined, switchAgent: async (i: { agent: string }) => void switched.push(i.agent) },
    }
    // Drafts shown whole; the section-by-section test sets its own review style.
    const team = new Team(ctx as never, merge(DEFAULTS, { taskDir: root, reviewStyle: "all" }), () => {}) as any
    team.step = async (t: any) => t.pending
    const cleanup = () => {
      rmSync(root, { recursive: true, force: true })
      rmSync(workspace, { recursive: true, force: true })
    }
    return { team, workspace, cleanup }
  }
  const report = (status: string, extra: object = {}) => ({ status, summary: "Approving this gives you a design.", content: "# Design\n\n## Options\n\nA or B", ...extra })

  test("polished auto: replies are sent without confirmation, the user still decides", async () => {
    const { team, cleanup } = setup()
    try {
      await team.handle({ action: "start", text: "design the cache", workflow: "plan", auto: "polished" }, "ses_p", signal)
      const t = team.task("ses_p")
      team.apply(t, { mode: "analyst" }, report("QUESTIONS", { questions: ["LRU or LFU?"] }), {})
      expect(await team.autoStep(t, signal)).toBeUndefined()
      const shown = render(t)
      expect(shown).toContain("QUESTIONS from analyst")
      expect(shown).toContain("AUTO-SEND (polished auto)")
      await team.handle({ action: "auto", auto: "off" }, "ses_p", signal)
      expect(render(t)).not.toContain("AUTO-SEND")
      expect(managerPrompt(merge(DEFAULTS, { auto: "polished" }), "code")).toContain("default mode is **polished auto**")
      expect(managerPrompt(DEFAULTS, "code")).not.toContain("default mode is")
    } finally {
      cleanup()
    }
  })

  test("Analyst hands searches to the Intern, gets the findings back, and the rounds are capped per report", async () => {
    const { team, cleanup } = setup()
    try {
      await team.handle({ action: "start", text: "design the cache", workflow: "plan" }, "ses_l", signal)
      const t = team.task("ses_l")
      for (const round of [1, 2, 3]) {
        t.pending = undefined
        team.apply(t, { mode: "analyst" }, report("NEED_INFO", { content: "1. Where is LWT traversal implemented?" }), {})
        expect([t.pending.mode, t.pending.asker, t.analystSearches]).toEqual(["intern", "analyst", round])
        expect(buildPrompt(DEFAULTS, t, t.pending, true)).toContain("Answer these queries for Analyst")
        t.pending = undefined
        team.apply(t, { mode: "intern", asker: "analyst" }, report("FOUND", { content: "`lwt.cpp:10` nextLevel()" }), {})
        expect(t.pending.mode).toBe("analyst")
        expect(t.pending.note).toContain(round === 1 ? "2 more rounds" : round === 2 ? "1 more round" : "No more search rounds")
        expect(buildPrompt(DEFAULTS, t, t.pending, false)).toContain("lwt.cpp:10")
        expect(t.plannerUnseen).toEqual([])
      }
      expect(allowedStatuses(DEFAULTS, "analyst", t)).not.toContain("NEED_INFO")
      t.pending = undefined
      team.apply(t, { mode: "analyst" }, report("ESCALATE", { content: "## Concept brief\n\n**Concerns**: speed" }), {})
      expect(t.analystSearches).toBe(0)
      expect(allowedStatuses(DEFAULTS, "analyst", t)).toContain("NEED_INFO")
      // While answering the Planner's questions: the findings return to the same answer.
      const answer = { mode: "analyst_answer", ids: ["Q1"], asker: "planner", note: "Q1: who calls nextLevel?" }
      team.apply(t, answer, report("NEED_INFO", { content: "Queries:", questions: ["Callers of nextLevel"] }), {})
      expect([t.pending.mode, t.pending.then.mode]).toEqual(["intern", "analyst_answer"])
      // Queries put in the questions list reach the Intern.
      expect(t.pending.note).toBe("Queries:\n\n1. Callers of nextLevel")
      team.apply(t, t.pending, report("FOUND", { content: "`a.cpp:3`" }), {})
      expect([t.pending.mode, t.pending.ids, t.pending.files.length]).toEqual(["analyst_answer", ["Q1"], 1])
      expect(t.pending.note).toContain("Q1: who calls nextLevel?")
      expect(buildPrompt(DEFAULTS, t, t.pending, false)).toContain("a.cpp:3")
    } finally {
      cleanup()
    }
  })

  test("Analyst reads only files named in the task folder; folders and other files are refused", async () => {
    const { team, workspace, cleanup } = setup()
    try {
      await team.handle({ action: "start", text: "extend the bindings in `nl.i`", workflow: "plan" }, "ses_r", signal)
      const t = team.task("ses_r")
      mkdirSync(path.join(workspace, "src/lwt"), { recursive: true })
      for (const f of ["src/nl.i", "src/lwt/traverse.cpp", "src/other.cpp"]) writeFileSync(path.join(workspace, f), "x")
      expect(analystReadProblem(t, { filePath: "src/nl.i" })).toBeUndefined()
      expect(analystReadProblem(t, { filePath: "src" })).toContain("Listing folders is searching")
      expect(analystReadProblem(t, { filePath: "src/lwt/traverse.cpp" })).toContain("isn't named")
      expect(analystReadProblem(t, { filePath: "request.md" })).toBe("request.md is a task file: its content is already in your prompt.")
      expect(analystReadProblem(t, { filePath: path.join(t.dir, "request.md") })).toBeUndefined()
      writeFileSync(path.join(t.dir, "findings-1.md"), "# Findings\n\n- `src/lwt/traverse.cpp:42` nextLevel()")
      expect(analystReadProblem(t, { filePath: path.join(workspace, "src/lwt/traverse.cpp") })).toBeUndefined()
      expect(analystReadProblem(t, { filePath: "src/other.cpp" })).toContain("NEED_INFO")
    } finally {
      cleanup()
    }
  })

  test("/team-mode-* commands set the session's mode for new tasks and the open task", async () => {
    const { team, cleanup } = setup()
    try {
      expect(await team.setMode("ses_m", "polished")).toEqual({ text: "Team mode: **polished auto** for new tasks in this chat.", resume: false })
      await team.handle({ action: "start", text: "design the cache", workflow: "plan" }, "ses_m", signal)
      const t = team.task("ses_m")
      expect(t.auto).toBe("polished")
      team.apply(t, { mode: "analyst" }, report("QUESTIONS", { questions: ["LRU or LFU?"] }), {})
      expect(await team.setMode("ses_m", "safe")).toEqual({ text: "Team mode: **safe auto** for the open task and new tasks in this chat.", resume: true })
      expect(t.auto).toBe("safe")
      expect((await team.setMode("ses_m", "off")).resume).toBe(false)
      expect(t.auto).toBeUndefined()
      expect(MODE_COMMANDS.map((c) => c.name)).toEqual(["team-mode-default", "team-mode-polished", "team-mode-safe", "team-mode-full"])
    } finally {
      cleanup()
    }
  })

  test("auto mode: safe auto decides questions and approvals, stops at a risky plan; full auto implements", async () => {
    const switched: string[] = []
    const { team, cleanup } = setup(switched)
    try {
      await team.handle({ action: "start", text: "design the cache", workflow: "plan", auto: "safe" }, "ses_a", signal)
      const t = team.task("ses_a")
      expect(t.auto).toBe("safe")
      team.apply(t, { mode: "analyst" }, report("QUESTIONS", { questions: ["LRU or LFU? (recommended: LRU)"] }), {})
      expect(t.phase).toBe("questions")
      expect(render(t)).toContain("Next, on safe auto: answer analyst's questions with the recommended options")
      expect(await team.autoStep(t, signal)).toContain("AUTO (safe): took the recommended answer to 1 question from analyst")
      expect([t.phase, t.pending.mode]).toEqual(["running", "analyst"])
      expect(t.pending.note).toContain("take your recommended option for each question")
      t.pending = undefined
      team.apply(t, { mode: "analyst" }, report("ESCALATE", { content: "## Concept brief\n\n**Concerns**: speed" }), {})
      expect(await team.autoStep(t, signal)).toContain("approved the concept brief")
      t.pending = undefined
      team.apply(t, { mode: "planner" }, report("DOC"), {})
      expect(await team.autoStep(t, signal)).toContain("approved the what-document")
      expect(t.stage).toBe("how")
      t.pending = undefined
      team.apply(t, { mode: "analyst" }, report("ESCALATE", { content: "## Code\n\n`a.ts:1`" }), {})
      t.pending = undefined
      t.skipArchitectReview = true
      team.apply(t, { mode: "planner" }, report("PLAN", { content: "## Steps\n1. **Drop the table** — `db.ts:1`", steps: 1, risk: "yes" }), {})
      save(t)
      expect(await team.autoStep(t, signal)).toBeUndefined()
      expect(render(t)).toContain("**Safe auto stopped here:**")
      expect(render(t)).toContain("**Decided on auto:**\n- took the recommended answer to 1 question from analyst\n- approved the concept brief")

      await team.handle({ action: "auto", auto: "full" }, "ses_a", signal)
      expect(await team.autoStep(t, signal)).toContain("AUTO (full): approved the plan 1 (destructive or irreversible steps) and started implementing it")
      expect([t.phase, switched]).toEqual(["done", ["build-manager"]])
      expect(team.task("ses_a").auto).toBe("full")
      expect(readFileSync(path.join(t.dir, "how-answers.md"), "utf8")).toContain("## Decided on full auto")
    } finally {
      cleanup()
    }
  })

  test("a plan task skips checks, writes the document without overwriting, and never reaches the developer", async () => {
    const switched: string[] = []
    const { team, workspace, cleanup } = setup(switched)
    try {
      mkdirSync(path.join(workspace, "docs"))
      await team.handle({ action: "start", text: "design the cache", workflow: "plan" }, "ses_w", signal)
      const t = team.task("ses_w")
      expect([t.workflow, t.phase, t.skipChecks]).toEqual(["plan", "running", undefined])
      expect(allowedStatuses(DEFAULTS, "analyst", t)).not.toContain("TRIVIAL")
      writeFileSync(path.join(workspace, "docs", path.basename(t.output)), "someone else's file")
      // outputPath was fixed at start; a second task with the same name gets -2
      expect(team.outputPath(t)).toMatch(/-2\.md$/)
      // What stage: Analyst's concept brief waits for the user, then the Planner writes the what-document.
      team.apply(t, { mode: "analyst" }, report("ESCALATE", { content: "## Concept brief\n\n**Concerns**: speed\n\n## Excerpts\n\nE" }), {})
      expect([t.stage, t.phase]).toEqual(["what", "brief"])
      expect(render(t)).toContain("**Concept brief**\n\n**Concerns**: speed")
      expect(render(t)).not.toContain("## Excerpts")
      save(t)
      expect((await team.handle({ action: "approve" }, "ses_w", signal)).mode).toBe("planner")
      t.pending = undefined
      team.apply(t, { mode: "planner" }, report("DOC", { content: "# Design\n\n## Options\n\nA or B\n\n## Decisions\n\n- A (yours)" }), {})
      expect(t.phase).toBe("approval")
      expect(readFileSync(t.output, "utf8")).toContain("## Options")
      expect(render(t)).toContain("**Decisions**\n- A (yours)")
      expect(render(t)).toContain("**Sections**\n- S1 Design\n- S2 Options")
      t.sessions.analyst = "ses_analyst_what"
      save(t)

      // Approving the what-document starts the how stage in fresh sessions.
      const how = await team.handle({ action: "approve" }, "ses_w", signal)
      expect([how.mode, how.fresh, t.stage, t.sessions.analyst, t.whatSessions.analyst]).toEqual(["analyst", true, "how", undefined, "ses_analyst_what"])
      const analystPrompt = buildPrompt(DEFAULTS, t, how, true)
      expect(analystPrompt).toContain("Stage: HOW")
      expect(analystPrompt).toContain("The approved what-document:")
      expect(analystPrompt).not.toContain("**Concerns**: speed")
      t.pending = undefined
      team.apply(t, how, report("ESCALATE", { content: "## Code\n\n`a.ts:1-3`" }), {})
      expect([t.pending.mode, t.pending.fresh]).toEqual(["planner", true])
      const archPrompt = buildPrompt(DEFAULTS, t, t.pending, true)
      expect(archPrompt).toContain('name="how-brief.md"')
      expect(archPrompt).not.toContain('name="brief.md"')
      t.pending = undefined
      team.apply(t, { mode: "planner" }, report("PLAN", { content: "## Steps\n1. **Add the cache** — `a.ts:1`", steps: 1, risk: "no" }), {})
      expect(t.phase).toBe("approval")
      const howDoc = t.output.replace(/\.md$/, ".how.md")
      expect(readFileSync(howDoc, "utf8")).toContain("Add the cache")
      expect(render(t)).toContain(`**Plan file:** ${howDoc}`)
      save(t)
      await team.handle({ action: "approve" }, "ses_w", signal)
      expect(t.phase).toBe("done")
      expect(render(t)).toContain("[Implement it]")
      expect(t.history.some((h: any) => h.role === "developer")).toBe(false)

      // Implementing hands the approved plan straight to Developer.
      const p = await team.handle({ action: "implement", workflow: "plan" }, "ses_w", signal)
      expect(switched).toEqual(["build-manager"])
      const code = team.task("ses_w")
      expect(code.id).not.toBe(t.id)
      expect([code.workflow, code.forcePlan, code.stage, code.plan, code.pending.mode]).toEqual([undefined, undefined, "how", 1, "fix"])
      expect(readFileSync(path.join(code.dir, "plan-1.md"), "utf8")).toContain("Add the cache")
      expect(readFileSync(path.join(code.dir, "request.md"), "utf8")).toContain(`Implement the approved plan (${howDoc})`)
    } finally {
      cleanup()
    }
  })

  test("the user's review request: Architect reviews, Planner revises once, the user sees the marked review", async () => {
    const { team, cleanup } = setup()
    try {
      await team.handle({ action: "start", text: "design it", workflow: "plan" }, "ses_v", signal)
      const t = team.task("ses_v")
      team.apply(t, { mode: "planner" }, report("DOC"), {})
      save(t)
      const p = await team.handle({ action: "review", text: "check the error handling" }, "ses_v", signal)
      expect(p.mode).toBe("architect_doc_review")
      t.pending = undefined
      team.apply(t, p, report("CHANGES", { content: "1. no error handling" }), {})
      expect(t.pending.mode).toBe("planner")
      const revise = t.pending
      t.pending = undefined
      team.apply(t, revise, report("DOC"), {})
      expect(t.phase).toBe("approval")
      expect(render(t)).toContain("(this version was revised to address it)")
      t.reviews = DEFAULTS.limits.architectReviews
      expect(await team.handle({ action: "review" }, "ses_v", signal)).toContain("the limit")
    } finally {
      cleanup()
    }
  })

  test("comments on a document go to Analyst for a revision brief, then to the Planner", async () => {
    const { team, cleanup } = setup()
    try {
      await team.handle({ action: "start", text: "design it", workflow: "plan" }, "ses_r", signal)
      const t = team.task("ses_r")
      team.apply(t, { mode: "analyst" }, report("ESCALATE", { content: "first brief" }), {})
      t.pending = undefined
      team.apply(t, { mode: "planner" }, report("DOC"), {})
      save(t)
      const p = await team.handle({ action: "change", text: "pets are too specific, there may be more" }, "ses_r", signal)
      expect([p.mode, p.revision, t.revising]).toEqual(["analyst", true, true])
      const prompt = buildPrompt(DEFAULTS, t, p, false)
      expect(prompt).toContain("MODE: revision")
      expect(prompt).toContain("## Options")
      expect(prompt).toContain("pets are too specific")
      t.pending = undefined
      team.apply(t, p, report("ESCALATE", { content: "change section X" }), {})
      expect([t.pending.mode, t.revising, t.plannerUnseen]).toEqual(["planner", false, ["revision-1.md"]])
      expect(readFileSync(path.join(t.dir, "brief.md"), "utf8").trim()).toBe("first brief")
      expect(readFileSync(path.join(t.dir, "revision-1.md"), "utf8").trim()).toBe("change section X")
    } finally {
      cleanup()
    }
  })

  test("task files and agents' edits show in the user's edited files", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "omat-tr-"))
    const tracked: any[] = []
    const ctx = {
      location: { directory: root },
      session: { context: async () => [], get: async () => undefined },
      rpc: () => ({ track: async (i: any) => void tracked.push(...i.files.map((f: any) => ({ session: i.sessionID, ...f }))) }),
    }
    const team = new Team(ctx as never, merge(DEFAULTS, { taskDir: root }), () => {}) as any
    team.step = async (t: any) => t.pending
    try {
      await team.handle({ action: "start", text: "design it", workflow: "plan" }, "ses_t", signal)
      const t = team.task("ses_t")
      expect(tracked.find((x) => x.path.endsWith("request.md"))).toEqual({ session: "ses_t", path: path.join(t.dir, "request.md") })
      appendFile(t, "answers.md", "one")
      appendFile(t, "answers.md", "two")
      expect(tracked.filter((x) => x.path.endsWith("answers.md")).map((x) => x.before)).toEqual([undefined, "one\n"])
      expect(tracked.some((x) => x.path.endsWith("state.json"))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("scoped comments: only the chosen sections change, final ones stay byte for byte", async () => {
    const { team, cleanup } = setup()
    try {
      await team.handle({ action: "start", text: "design it", workflow: "plan" }, "ses_s", signal)
      const t = team.task("ses_s")
      const brief = "## Concept brief\n\n### Concerns\n\n#### 1. Scope\n\npost-edit only\n\n#### 2. Glossary\n\ntwo passes\n\n## Excerpts\n\nE"
      team.apply(t, { mode: "analyst" }, report("ESCALATE", { content: brief }), {})
      save(t)
      expect(render(t)).toContain("#### 1. Scope [S3]")
      expect(render(t)).toContain("finetune, revise, final, reopen (ids)")
      expect(await team.handle({ action: "change", text: "x", revise: ["S9"] }, "ses_s", signal)).toContain("Not section ids of this draft: S9")
      const p = await team.handle({ action: "change", text: "glossary needs entity linking", final: ["S3"], revise: ["S4"] }, "ses_s", signal)
      expect([t.scope, t.sections.final]).toEqual([{ draft: "brief", revise: ["S4"], finetune: [], add: [], open: false }, ["S3"]])
      expect(p.note).toContain("- S3 1. Scope: FINAL")
      expect(p.note).toContain("- S4 2. Glossary: REVISE")
      expect(p.note).toContain("report ESCALATE with the revised sections only")
      beginRun("ses_sc", { role: "analyst", mode: "analyst", task: t, toolLimit: 10 })
      expect(() => acceptReport(DEFAULTS, "ses_sc", { status: "ESCALATE", summary: "s", content: "whole brief" })).toThrow("Report `sections`")
      expect(() => acceptReport(DEFAULTS, "ses_sc", { status: "ESCALATE", summary: "s", content: "c", sections: [{ id: "S3", content: "#### 1. Scope\n\nx" }] } as any)).toThrow("S3 is final")
      runs.delete("ses_sc")
      t.pending = undefined
      team.apply(t, p, report("ESCALATE", { content: "added linking", sections: [{ id: "S4", content: "#### 2. Glossary\n\ntwo passes, then entity linking" }] }), {})
      expect(readFileSync(path.join(t.dir, "brief.md"), "utf8")).toBe(brief.replace("two passes", "two passes, then entity linking") + "\n")
      save(t)
      const shown = render(t)
      expect(shown).toContain("#### 1. Scope [S3 ✅]")
      expect(shown).toContain("**This version:** revised S4")
      expect(shown).toContain("**Final:** S3")
      expect(await team.handle({ action: "change", text: "redo scope", revise: ["S3"] }, "ses_s", signal)).toContain("S3 is final")

      // The what-document: a new draft with its own ids and final marks; Analyst's revision brief and the Planner see the scope.
      t.phase = "brief"
      await team.handle({ action: "approve" }, "ses_s", signal)
      t.pending = undefined
      const doc = "# Design\n\n## Glossary\n\nA\n\n## Review\n\nB"
      team.apply(t, { mode: "planner" }, report("DOC", { content: doc }), {})
      save(t)
      expect(render(t)).toContain("- S2 Glossary\n- S3 Review")
      const rev = await team.handle({ action: "change", text: "review needs a UI", final: ["S2"], revise: ["S3"] }, "ses_s", signal)
      expect(buildPrompt(DEFAULTS, t, rev, false)).toContain("Brief only the REVISE, FINE-TUNE and new sections")
      t.pending = undefined
      team.apply(t, rev, report("ESCALATE", { content: "S3: add a UI" }), {})
      expect(t.pending.note).toContain("report DOC with the revised sections only")
      const arch = t.pending
      t.pending = undefined
      team.apply(t, arch, report("DOC", { content: "UI added", sections: [{ id: "S3", content: "## Review\n\nB, with a UI" }] }), {})
      expect(readFileSync(path.join(t.dir, "doc-2.md"), "utf8")).toBe("# Design\n\n## Glossary\n\nA\n\n## Review\n\nB, with a UI\n")
      expect(readFileSync(t.output, "utf8")).toContain("B, with a UI")
      expect(t.scope).toBeUndefined()
      expect(render(t)).toContain("Mark sections you're happy with as **final**")

      // A fine-tune-only round: straight to the Planner, no comment round, the edit only.
      t.phase = "approval"
      const rounds = t.commentRounds
      const tune = await team.handle({ action: "change", text: "S3: say \"web UI\"", finetune: ["S3"] }, "ses_s", signal)
      expect([tune.mode, t.commentRounds]).toEqual(["planner", rounds])
      expect(tune.note).toContain("- S3 Review: FINE-TUNE")
      expect(tune.note).toContain("The user fine-tuned the what-document")
      expect(tune.adviceIds).toBeUndefined()
      t.pending = undefined
      team.apply(t, tune, report("DOC", { content: "web UI", sections: [{ id: "S3", content: "## Review\n\nB, with a web UI" }] }), {})
      expect(render(t)).toContain("**This version:** fine-tuned S3")

      // Only final marks: saved and shown again, no agent run.
      t.phase = "approval"
      const marks = await team.handle({ action: "change", final: ["S3"] }, "ses_s", signal)
      expect(marks).toContain("Saved: final S2, S3.")
      expect([t.phase, t.sections.final]).toEqual(["approval", ["S2", "S3"]])
      expect(await team.handle({ action: "change", text: "x", finetune: ["S3"] }, "ses_s", signal)).toContain("S3 is final")
    } finally {
      cleanup()
    }
  })

  test("section by section: ok/skip/comments, show the rest, one change at the end, approve when all pass", async () => {
    const { team, cleanup } = setup()
    try {
      await team.handle({ action: "start", text: "design it", workflow: "plan" }, "ses_w", signal)
      const t = team.task("ses_w")
      expect(t.reviewStyle).toBe("all")
      t.reviewStyle = "ask"
      const brief =
        "## Concept brief\n\n### Concerns\n\n#### 1. Scope\n\n**Summary:** Edit only after parsing.\n\npost-edit only\n\n**Recommended:** Post-edit only: no parser change\n\n#### 2. Glossary\n\n**Summary:** Two passes over the text.\n\ntwo passes\n\n**Recommended:** as written\n\n## Excerpts\n\nE"
      team.apply(t, { mode: "analyst" }, report("ESCALATE", { content: brief }), {})
      save(t)
      const ask = render(t)
      expect(ask).toContain("Concept brief ready: 2 sections to review.")
      expect(ask).toContain("[All at once] [One section at a time]")
      expect(ask).not.toContain("post-edit only")

      // Start, ok the first, then show the rest: the ok is kept and goes with the next change.
      const first = await team.handle({ action: "section", verdict: "start" }, "ses_w", signal)
      expect(first).toContain("**Concept brief, S3 · 1. Scope** (1 of 2)\n\n**Summary:** Edit only after parsing.\n\n**Recommended:** Post-edit only: no parser change")
      expect(first).not.toContain("post-edit only")
      expect(first).toContain("ask for details")
      const more = await team.handle({ action: "details", ids: ["s3"] }, "ses_w", signal)
      expect(more).toContain("**S3 · 1. Scope**\n\n**Summary:** Edit only after parsing.\n\npost-edit only")
      expect(more).toContain("no agent ran")
      expect(t.walk.at).toBe(0)
      expect(await team.handle({ action: "details", ids: ["S9"] }, "ses_w", signal)).toContain("No section S9")
      expect(await team.handle({ action: "details" }, "ses_w", signal)).toContain("## Excerpts")
      expect(first).not.toContain("Excerpts")
      const second = await team.handle({ action: "section", verdict: "ok" }, "ses_w", signal)
      expect(second).toContain("**Concept brief, S4 · 2. Glossary** (2 of 2)")
      expect(render(t)).toContain("**Concept brief, S4 · 2. Glossary** (2 of 2)")
      const rest = await team.handle({ action: "section", verdict: "rest" }, "ses_w", signal)
      expect(rest).toContain("#### 2. Glossary [S4]")
      expect(rest).toContain("From the walk-through: ok S3")
      const p = await team.handle({ action: "change", text: "glossary needs entity linking", revise: ["S4"] }, "ses_w", signal)
      expect([t.scope, t.sections.final, t.walk]).toEqual([{ draft: "brief", revise: ["S4"], finetune: [], add: [], open: false }, ["S3"], undefined])
      expect(p.note).toContain("- S4 2. Glossary: REVISE")

      // A scoped revision is checked as merged: the revised section needs its Recommended line too.
      t.pending = undefined
      beginRun("ses_wr", { role: "analyst", mode: "analyst", task: t, toolLimit: 10 })
      const noRec = { status: "ESCALATE", summary: "s", content: "linking", sections: [{ id: "S4", content: "#### 2. Glossary\n\n**Summary:** Two passes, then linking.\n\ntwo passes, then linking" }] }
      expect(() => acceptReport(DEFAULTS, "ses_wr", noRec as any)).toThrow("Missing in: 2. Glossary. Return those sections too")
      runs.delete("ses_wr")
      team.apply(t, p, report("ESCALATE", { content: "linking", sections: [{ id: "S4", content: "#### 2. Glossary\n\n**Summary:** Two passes, then linking.\n\ntwo passes, then linking\n\n**Recommended:** as written" }] }), {})
      save(t)

      // Only S4 is left to go through; a confirmed comment sends one change right away.
      expect(await team.handle({ action: "section", verdict: "start" }, "ses_w", signal)).toContain("**Concept brief, S4 · 2. Glossary** (1 of 1)")
      expect(await team.handle({ action: "section", verdict: "finetune" }, "ses_w", signal)).toContain("needs text")
      await team.handle({ action: "section", verdict: "finetune", text: "say \"entity linking\"" }, "ses_w", signal)
      expect(t.walk).toBeUndefined()
      expect(t.pending.note).toContain("- S4 2. Glossary: FINE-TUNE")
      expect(t.pending.note).toContain("**S4 2. Glossary** (fine-tune):")
      expect(t.pending.note).toContain('say "entity linking"')
      t.pending = undefined
      team.apply(t, t.pending ?? { mode: "analyst" }, report("ESCALATE", { content: "tuned", sections: [{ id: "S4", content: "#### 2. Glossary\n\n**Summary:** Two passes, then entity linking.\n\ntwo passes, then entity linking\n\n**Recommended:** as written" }] }), {})
      save(t)

      // Every section passes: marked final, the user approves once; the excerpts are listed, not walked.
      await team.handle({ action: "section", verdict: "start" }, "ses_w", signal)
      const done = await team.handle({ action: "section", verdict: "ok" }, "ses_w", signal)
      expect(done).toContain("ALL SECTIONS ACCEPTED")
      expect(done).toContain("S5 Excerpts")
      expect(done).toContain("[Approve] [Show it all at once]")
      expect(t.sections.final).toContain("S4")
      expect(await team.handle({ action: "section", verdict: "start" }, "ses_w", signal)).toContain("no sections to go through")

      // Config picks the style; auto modes skip the review altogether.
      t.reviewStyle = "all"
      expect(render(t)).not.toContain("One section at a time")
      t.sections.final = []
      t.walk = undefined
      t.reviewStyle = "sections"
      expect(render(t)).toContain('call team "section" with verdict "start" right away')
      t.reviewStyle = "ask"
      const whole = await team.handle({ action: "section", verdict: "rest" }, "ses_w", signal)
      expect(whole).toContain("#### 2. Glossary [S4]")
      expect(whole).not.toContain("From the walk-through")
      t.auto = "safe"
      expect(render(t)).not.toContain('verdict "start"')
    } finally {
      cleanup()
    }
  })

  test("review dialog: a TUI takes the review; replies come back once; questions, then comments, then one change", async () => {
    const { team, cleanup } = setup()
    try {
      await team.handle({ action: "start", text: "design it", workflow: "plan" }, "ses_d", signal)
      const t = team.task("ses_d")
      t.reviewStyle = "ask"
      const brief =
        "## Concept brief\n\n### Concerns\n\n#### 1. Scope\n\n**Summary:** Edit only after parsing.\n\npost-edit only\n\n**Recommended:** as written\n\n#### 2. Glossary\n\n**Summary:** Two passes over the text.\n\ntwo passes\n\n**Recommended:** as written\n\n## Excerpts\n\nE"
      team.apply(t, { mode: "analyst" }, report("ESCALATE", { content: brief }), {})
      save(t)
      const style = render(t)

      // No TUI plugin: the chat question stays.
      expect(await team.withDialog("ses_d", style)).toBe(style)
      expect(t.walk).toBeUndefined()

      // The review goes to the dialog whether or not a TUI shows the session now: the manager only points to it.
      let offered = 0
      team.offerDialog = () => void offered++
      const open = await team.withDialog("ses_d", join("Saved.", style))
      expect(offered).toBe(1)
      expect(open).toContain("Saved.")
      expect(open).toContain("REVIEW READY IN THE DIALOG: Concept brief, 2 sections.")
      expect(open).toContain("/team-review")
      expect(open).not.toContain("[All at once]")
      expect(render(t)).toContain("REVIEW READY IN THE DIALOG")
      expect((await team.sidebar("ses_d")).review).toEqual({ title: "Concept brief", done: 0, total: 2 })
      const first = team.dialog("ses_d")!
      expect(first.ask).toBe(true)
      expect(first.progress).toEqual({ at: 0, replies: [], comments: [], questions: [] })

      // Closed partway: the progress is kept, the style isn't asked again, and a stale draft is refused.
      const progress = { at: 1, replies: [{ id: "S3", verdict: "ok" as const }], comments: [], questions: [{ id: "S3", text: "why post-edit?" }] }
      expect(team.dialogSave("ses_d", { key: "old", progress })).toBe(false)
      expect(team.dialogSave("ses_d", { key: first.key, progress: { ...progress, at: 9 } })).toBe(true)
      expect(t.walk.at).toBe(2)
      expect(team.dialogSave("ses_d", { key: first.key, progress })).toBe(true)
      expect(render(t)).toContain("REVIEW READY IN THE DIALOG")
      expect((await team.sidebar("ses_d")).review).toEqual({ title: "Concept brief", done: 1, total: 2 })
      const draft = team.dialog("ses_d")!
      expect(draft.ask).toBe(false)
      expect(draft.progress).toEqual(progress)
      expect(draft.title).toBe("Concept brief")
      expect(draft.sections.map((s) => [s.id, s.title])).toEqual([["S3", "1. Scope"], ["S4", "2. Glossary"]])
      expect(draft.sections[0].summary).toBe("**Summary:** Edit only after parsing.\n\n**Recommended:** as written")
      expect(draft.sections[0].body).toBe("**Summary:** Edit only after parsing.\n\npost-edit only\n\n**Recommended:** as written")
      // Already open: not offered twice.
      expect(await team.withDialog("ses_d", style)).toBe(style)

      // A stale draft is refused; the replies come back with a question and a comment.
      const reply = { key: draft.key, end: "done" as const, replies: [{ id: "S3", verdict: "ok" as const }], comments: [{ id: "S4", text: "add linking" }], questions: [{ id: "S3", text: "why post-edit?" }] }
      expect(team.dialogDone("ses_d", { ...reply, key: "old" })).toBeUndefined()
      const wake = team.dialogDone("ses_d", reply)!
      expect(wake).toContain("REVIEW DIALOG FINISHED: Concept brief. ok S3.")
      expect(wake).toContain("- S3 1. Scope: why post-edit?")
      expect(wake).toContain("- S4 2. Glossary: add linking")
      expect(wake).toContain('1. call team "ask" once')
      expect(wake).toContain('2. polish the comments')
      expect(team.dialog("ses_d")).toBeUndefined()
      expect(team.dialogDone("ses_d", reply)).toBeUndefined()

      // Once asked, only the comments are left; the change keeps the ok as final.
      t.walk.dialog.questions = []
      expect(render(t)).not.toContain('call team "ask"')
      expect(render(t)).toContain("polish the comments")
      await team.handle({ action: "change", text: "S4: add entity linking", revise: ["S4"] }, "ses_d", signal)
      expect([t.sections.final, t.walk, t.scope?.revise]).toEqual([["S3"], undefined, ["S4"]])

      // Other ends: approve, stop, and show the rest (the comments go with the next change).
      const again = () => {
        t.phase = "brief"
        t.walk = { key: t.sections.key, ids: ["S3", "S4"], at: 0, replies: [], dialog: { comments: [], questions: [] } }
        return t.sections.key
      }
      expect(team.dialogDone("ses_d", { key: again(), end: "approve", replies: [], comments: [], questions: [] })).toContain('call team with action "approve"')
      expect(team.dialogDone("ses_d", { key: again(), end: "stop", replies: [], comments: [], questions: [] })).toContain('call team with action "stop"')
      const rest = team.dialogDone("ses_d", { key: again(), end: "rest", replies: [], comments: [{ id: "S4", text: "shorter" }], questions: [] })!
      expect(rest).toContain("#### 2. Glossary [S4]")
      expect(rest).toContain("- S4 2. Glossary: shorter")
      expect(rest).toContain("They go with the user's next comments")
    } finally {
      cleanup()
    }
  })

  test("reviewed sections must end with a Recommended line; excerpts, plan steps and how briefs are exempt", async () => {
    const { team, cleanup } = setup()
    try {
      await team.handle({ action: "start", text: "design it", workflow: "plan" }, "ses_r", signal)
      const t = team.task("ses_r")
      const check = (role: string, mode: string, input: object) => {
        beginRun("ses_rc", { role, mode, task: t, toolLimit: 10 } as any)
        try {
          return acceptReport(DEFAULTS, "ses_rc", { summary: "s", ...input } as any)
        } finally {
          runs.delete("ses_rc")
        }
      }
      const brief = "## Concept brief\n\n### Concerns\n\nA or B\n\n### Assumptions\n\nx\n\n## Excerpts\n\nE"
      expect(() => check("analyst", "analyst", { status: "ESCALATE", content: brief })).toThrow("Missing in: Concerns; Assumptions.")
      const recs = brief.replace("A or B", "A or B\n\n**Recommended:** A: simpler").replace("x\n", "x\n\n- **Recommended:** as written\n")
      expect(() => check("analyst", "analyst", { status: "ESCALATE", content: recs })).toThrow("opens with a line \"**Summary:**")
      const fixed = recs.replace("A or B", "**Summary:** Keep it simple.\n\nA or B").replace("### Assumptions\n\n", "### Assumptions\n\n**Summary:** Defaults.\n\n")
      expect(() => check("analyst", "analyst", { status: "ESCALATE", content: fixed })).not.toThrow()
      expect(() => check("analyst", "analyst", { status: "ESCALATE", content: "## Code\n\n`a.ts:1`" })).not.toThrow()
      const plan = "# Plan\n\n## Risks\n\n**Summary:** Low risk.\n\nnone\n\n## Steps\n\nIn order.\n\n1. **Edit a.ts**: the flag exists\n\nchange it\n\n2. **Test**: it is proven\n\nrun it"
      t.stage = "how"
      expect(() => check("planner", "planner", { status: "PLAN", content: plan, risk: "no", steps: 2 })).toThrow("Missing in: Risks.")
      const planOk = plan.replace("none", "none\n\n**Recommended:** as written")
      expect(() => check("planner", "planner", { status: "PLAN", content: planOk, risk: "no", steps: 2 })).not.toThrow()
      expect(() => check("planner", "planner", { status: "PLAN", content: planOk.replace("**Test**: it is proven", "**Test**"), risk: "no", steps: 2 })).toThrow("Missing in: 2. Test.")
      expect(() => check("planner", "planner", { status: "PLAN", content: planOk.replace("**Summary:** Low risk.\n\n", ""), risk: "no", steps: 2 })).toThrow("Missing in: Risks.")
    } finally {
      cleanup()
    }
  })

  test("a brief the user keeps sending back: Planner advises at round 3, Architect at 5; STUCK calls the next adviser", async () => {
    const { team, cleanup } = setup()
    try {
      await team.handle({ action: "start", text: "design it", workflow: "plan" }, "ses_l", signal)
      const t = team.task("ses_l")
      const brief = (p: any, extra: object = {}) => {
        t.pending = undefined
        team.apply(t, p, report("ESCALATE", { content: "## Concept brief\n\n**Concerns**: x", ...extra }), {})
        save(t)
      }
      const comment = async (n: number) => {
        const p = await team.handle({ action: "change", text: `comment ${n}` }, "ses_l", signal)
        expect(t.commentRounds).toBe(n)
        return p
      }
      brief({ mode: "analyst" })
      expect(allowedStatuses(DEFAULTS, "analyst", t)).not.toContain("STUCK")
      for (const n of [1, 2]) {
        const p = await comment(n)
        expect([p.mode, p.adviceIds]).toEqual(["analyst", undefined])
        brief(p)
      }
      const adv = await comment(3)
      expect([adv.mode, adv.advise, adv.fresh, adv.then.mode]).toEqual(["planner_advice", "analyst", true, "analyst"])
      expect(allowedStatuses(DEFAULTS, "planner_advice", t)).toEqual(["ADVICE", "ASK"])
      expect(buildPrompt(DEFAULTS, t, adv, true)).toContain("MODE: advice")
      beginRun("ses_adv", { role: "planner", mode: "planner_advice", task: t, toolLimit: 10 })
      expect(() => acceptReport(DEFAULTS, "ses_adv", { status: "ADVICE", summary: "s", content: "c" })).toThrow("items")
      runs.delete("ses_adv")
      t.pending = undefined
      team.apply(t, adv, report("ADVICE", { content: "It ignores scale.", items: ["cover scale", "drop pets"] }), {})
      const revise = t.pending
      expect([revise.mode, revise.adviceIds, revise.files]).toEqual(["analyst", ["ADV1", "ADV2"], ["advice-1.md"]])
      expect(buildPrompt(DEFAULTS, t, revise, false)).toContain("**ADV2**: drop pets")
      beginRun("ses_rev", { role: "analyst", mode: "analyst", task: t, toolLimit: 10 })
      const esc = { status: "ESCALATE", summary: "s", content: "## Concept brief\n\nx" }
      expect(() => acceptReport(DEFAULTS, "ses_rev", { ...esc, addressed: "ADV1: added scale" })).toThrow("missing: ADV2")
      runs.delete("ses_rev")
      brief(revise, { addressed: "ADV1: added scale\nADV2: dropped pets" })
      expect(render(t)).toContain("**Revised following Planner's advice**")
      expect(readFileSync(path.join(t.dir, "advice-1.md"), "utf8")).toContain("ADV2: dropped pets")

      const p4 = await comment(4)
      expect(p4.mode).toBe("analyst")
      expect(render(t)).not.toContain("Revised following")
      brief(p4)
      const p5 = await comment(5)
      expect([p5.mode, p5.advise]).toEqual(["architect_draft_advice", "analyst"])
      expect(buildPrompt(DEFAULTS, t, p5, true)).toContain("Earlier advice on this draft")
      t.pending = undefined
      team.apply(t, p5, report("ADVICE", { items: ["one"] }), {})
      expect(t.pending.adviceIds).toEqual(["ADV3"])
      brief(t.pending, { addressed: "ADV3: done" })

      // Both advisers used: STUCK goes to the user.
      const p6 = await comment(6)
      expect(p6.mode).toBe("analyst")
      expect(allowedStatuses(DEFAULTS, "analyst", t)).toContain("STUCK")
      t.pending = undefined
      team.apply(t, p6, report("STUCK", { content: "they want two things at once" }), {})
      expect([t.phase, t.pending.mode]).toEqual(["stuck", "analyst"])

      // Approving the brief starts a new ladder; a Planner that is stuck on its first comment round gets Architect.
      t.phase = "brief"
      t.pending = undefined
      save(t)
      expect((await team.handle({ action: "approve" }, "ses_l", signal)).mode).toBe("planner")
      expect([t.commentRounds, t.advisors, t.lastAdvice]).toEqual([0, [], undefined])
      t.pending = undefined
      team.apply(t, { mode: "planner" }, report("DOC"), {})
      save(t)
      const rev = await team.handle({ action: "change", text: "more" }, "ses_l", signal)
      t.pending = undefined
      team.apply(t, rev, report("ESCALATE", { content: "change X" }), {})
      expect(t.pending.mode).toBe("planner")
      const arch = t.pending
      t.pending = undefined
      team.apply(t, arch, report("STUCK", { content: "can't" }), {})
      expect([t.pending.mode, t.pending.advise, t.pending.then.mode]).toEqual(["architect_draft_advice", "planner", "planner"])
      const pa = t.pending
      t.pending = undefined
      team.apply(t, pa, report("ADVICE", { items: ["split it"] }), {})
      expect([t.pending.mode, t.pending.adviceIds]).toEqual(["planner", ["ADV4"]])
      expect(buildPrompt(DEFAULTS, t, t.pending, false)).toContain("**ADV4**: split it")
    } finally {
      cleanup()
    }
  })

  test("code: settled behaviour skips the what stage; the Planner asks Analyst; INFEASIBLE goes back to the user", async () => {
    const { team, cleanup } = setup()
    try {
      await team.handle({ action: "start", text: "add --upper" }, "ses_c", signal)
      const t = team.task("ses_c")
      t.phase = "running"
      team.apply(t, { mode: "analyst" }, report("ESCALATE", { what: "settled", content: "## Why the behaviour is settled\n\nNamed.\n\n## Code\n\nx" }), {})
      expect([t.stage, t.pending.mode]).toEqual(["how", "planner"])
      expect(readFileSync(path.join(t.dir, "how-brief.md"), "utf8")).toContain("settled")
      expect(buildPrompt(DEFAULTS, t, t.pending, true)).toContain("## Behaviour")

      // ASK: numbered questions to Analyst, answered in a numbered file the Planner gets next.
      t.pending = undefined
      team.apply(t, { mode: "planner" }, report("ASK", { questions: ["which file?", "C or C++?"], content: "" }), {})
      expect([t.pending.mode, t.pending.ids, t.needInfo]).toEqual(["analyst_answer", ["A1", "A2"], 1])
      expect(t.pending.note).toContain("**A2**: C or C++?")
      const ask = t.pending
      t.pending = undefined
      team.apply(t, ask, report("ANSWER", { content: "### A1\nmain.c\n### A2\nC only (`CMakeLists.txt:3`)" }), {})
      expect([t.pending.mode, t.plannerUnseen]).toEqual(["planner", ["how-brief-answer-1.md"]])
      expect(buildPrompt(DEFAULTS, t, t.pending, true)).toContain('name="how-brief-answer-1.md"')

      // INFEASIBLE in a how stage after a what-document: back to the what approval with the what sessions.
      t.pending = undefined
      t.stage = "how"
      t.doc = 1
      writeFileSync(path.join(t.dir, "doc-1.md"), "# What\n\n## Decisions\n\n- C++")
      t.whatSessions = { analyst: "ses_lw", planner: "ses_aw" }
      team.apply(t, { mode: "planner" }, report("INFEASIBLE", { content: "C++ can't build here" }), {})
      expect([t.stage, t.phase, t.infeasible, t.sessions.analyst]).toEqual(["what", "approval", "infeasible-1.md", "ses_lw"])
      expect(render(t)).toContain("C++ can't build here")
      save(t)
      const again = await team.handle({ action: "approve" }, "ses_c", signal)
      expect([again.mode, again.files, t.stage]).toEqual(["analyst", ["infeasible-1.md"], "how"])
    } finally {
      cleanup()
    }
  })

  test("attempts count failed tries only; all agent calls have a separate runaway cap; old tasks migrate", async () => {
    const { team, cleanup } = setup()
    try {
      await team.handle({ action: "start", text: "add a flag", workflow: "plan" }, "ses_a", signal)
      const t = team.task("ses_a")
      expect([t.attempts, t.attemptLimit, t.agentCalls, t.agentCallLimit]).toEqual([0, 10, 0, 100])

      // Info requests, searches and questions aren't failures.
      team.apply(t, { mode: "analyst" }, report("NEED_INFO", { content: "1. Where is main?" }), {})
      team.apply(t, t.pending, report("FOUND", { content: "main.cpp:1" }), {})
      team.apply(t, { mode: "analyst" }, report("QUESTIONS", { questions: ["Short form too?"] }), {})
      expect(t.attempts).toBe(0)

      // A failed step, a blocked step and a review sending work back are.
      Object.assign(t, { phase: "running", plan: 1, planSteps: 2, step: 1, rounds: 0 })
      team.apply(t, { mode: "fix" }, report("FAIL", { content: "build failed" }), {})
      expect([t.attempts, t.pending.mode]).toEqual([1, "diagnose"])
      team.apply(t, { mode: "fix" }, report("DONE", { content: "ok" }), {})
      expect(t.attempts).toBe(1)
      team.apply(t, { mode: "review" }, report("CHANGES", { content: "missing test" }), {})
      expect(t.attempts).toBe(2)
      team.apply(t, { mode: "fix" }, report("BLOCKED", { content: "no access" }), {})
      expect(t.attempts).toBe(3)

      // Budget: failed attempts, or the call cap; extend raises the one that ran out.
      const step = (Team.prototype as any).step
      Object.assign(t, { phase: "running", pending: { mode: "fix" }, attempts: 10 })
      await step.call(team, t, signal)
      expect([t.phase, t.budgetReason]).toEqual(["budget", "attempts"])
      expect(render(t)).toContain("ATTEMPT BUDGET USED UP: 10 failed attempts")
      expect(render(t)).toContain("[Continue +5 attempts]")
      Object.assign(t, { phase: "running", attempts: 0, agentCalls: 100 })
      await step.call(team, t, signal)
      expect([t.phase, t.budgetReason]).toEqual(["budget", "calls"])
      expect(render(t)).toContain("AGENT CALL LIMIT REACHED: 100 agent calls")
      team.step = async (x: any) => x.pending
      await team.handle({ action: "extend" }, "ses_a", signal)
      expect([t.agentCallLimit, t.attemptLimit, t.budgetReason]).toEqual([125, 10, undefined])

      // A task saved when attempts counted every call.
      const old = { ...t, attempts: 23, attemptLimit: 40, agentCalls: undefined, agentCallLimit: undefined }
      writeFileSync(path.join(t.dir, "state.json"), JSON.stringify(old))
      const loaded = loadTask(t.dir)!
      expect([loaded.attempts, loaded.agentCalls]).toEqual([0, 23])
    } finally {
      cleanup()
    }
  })

  test("Developer and Analyst ask the Planner mid-work: no failed attempt, the answer comes back, limited per step and brief, pair sessions reset", async () => {
    const { team, cleanup } = setup()
    try {
      await team.handle({ action: "start", text: "remove the old files" }, "ses_c", signal)
      const t = team.task("ses_c")
      writeFileSync(path.join(t.dir, "plan-1.md"), "# Plan\n\n1. **Remove**: delete the old files\n2. **Check**: build\n")
      Object.assign(t, { phase: "running", plan: 1, planSteps: 2, step: 1, rounds: 0 })
      const ask = report("CONSULT", { questions: ["rm or p4 delete?"], content: "```\n$ p4 files old.c\nno such file\n```" })

      // Developer asks: not an attempt; the Planner gets the plan and the question in a fresh pair session.
      team.apply(t, { mode: "fix" }, ask, {})
      expect(t.attempts).toBe(0)
      expect(t.pending).toMatchObject({ mode: "planner_consult", asker: "fix", then: { mode: "fix" } })
      expect(readFileSync(path.join(t.dir, t.pending.files[0]), "utf8")).toContain("**Q1**: rm or p4 delete?")
      const pair = team.pairSession(t, t.pending)
      expect(pair).toEqual({ key: "plan-1", asked: 1 })
      const fresh = buildPrompt(DEFAULTS, t, t.pending, true)
      expect(fresh).toContain("MODE: consult. Developer is on step 1 of 2 of plan 1")
      expect(fresh).toContain('<file name="plan-1.md">')
      expect(fresh).toContain("no such file")
      pair.session = "ses_pair1"

      // The answer goes back to Developer's session, which carries on.
      team.apply(t, t.pending, report("ANSWER", { content: "Use rm: the files were never added." }), {})
      expect(t.pending.mode).toBe("fix")
      expect(t.pending.note).toContain("Use rm: the files were never added.")
      expect(t.attempts).toBe(0)

      // A second question on the step reuses the pair session; then the step's limit (2) takes CONSULT away.
      expect(allowedStatuses(DEFAULTS, "fix", t)).toContain("CONSULT")
      team.apply(t, { mode: "fix" }, ask, {})
      expect(team.pairSession(t, t.pending)).toEqual({ key: "plan-1", session: "ses_pair1", asked: 2 })
      expect(buildPrompt(DEFAULTS, t, t.pending, false)).toContain("Another question. Developer is on step 1")
      expect(allowedStatuses(DEFAULTS, "fix", t)).not.toContain("CONSULT")
      t.step = 2
      expect(allowedStatuses(DEFAULTS, "fix", t)).toContain("CONSULT")

      // A new plan, or a full session, starts a fresh pair session.
      t.plan = 2
      expect(team.pairSession(t, { mode: "planner_consult", asker: "fix" })).toEqual({ key: "plan-2", asked: 1 })
      t.pairs.developer = { key: "plan-2", session: "ses_pair2", asked: DEFAULTS.limits.consultsPerSession }
      expect(team.pairSession(t, { mode: "planner_consult", asker: "fix" })).toEqual({ key: "plan-2", asked: 1 })

      // Analyst has its own pair and count; the answer resumes its hand-off with the advice ids.
      team.apply(t, { mode: "analyst", adviceIds: ["ADV1"] }, ask, {})
      expect(t.pending.then).toEqual({ mode: "analyst", adviceIds: ["ADV1"] })
      expect(team.pairSession(t, t.pending).key).toMatch(/^stage-/)
      expect(t.pairs.developer.key).toBe("plan-2")
      expect(buildPrompt(DEFAULTS, t, t.pending, true)).toContain("MODE: consult. Analyst is writing the brief")
      team.apply(t, t.pending, report("ANSWER", { content: "Option B." }), {})
      expect(t.pending).toMatchObject({ mode: "analyst", adviceIds: ["ADV1"] })
      expect(t.pending.note).toContain("Option B.")
      team.apply(t, { mode: "analyst" }, ask, {})
      team.apply(t, { mode: "analyst" }, ask, {})
      expect(allowedStatuses(DEFAULTS, "analyst", t)).not.toContain("CONSULT")
      // The user sends the brief back: a new count and a fresh pair session.
      t.commentRounds = 1
      expect(allowedStatuses(DEFAULTS, "analyst", t)).toContain("CONSULT")
      expect(team.pairSession(t, { mode: "planner_consult", asker: "analyst" }).asked).toBe(1)
      expect(t.attempts).toBe(0)
    } finally {
      cleanup()
    }
  })

  test("Developer and Analyst have the Operator run something: no failed attempt, the result comes back, limited per task, can be turned off", async () => {
    const { team, cleanup } = setup()
    try {
      await team.handle({ action: "start", text: "use the models API" }, "ses_run", signal)
      const t = team.task("ses_run")
      Object.assign(t, { phase: "running", plan: 1, planSteps: 1, step: 1, rounds: 0 })
      expect(allowedStatuses(DEFAULTS, "fix", t)).toContain("RUN")
      const run = report("RUN", { content: "curl -s https://example.com/v1/models in /w; return the JSON" })

      team.apply(t, { mode: "fix" }, run, {})
      expect(t.attempts).toBe(0)
      expect(t.pending).toMatchObject({ mode: "operator", asker: "fix", then: { mode: "fix" } })
      const prompt = buildPrompt(DEFAULTS, t, t.pending, true)
      expect(prompt).toContain("MODE: run for Developer")
      expect(prompt).toContain("curl -s https://example.com/v1/models")
      team.apply(t, t.pending, report("RESULT", { content: '{"data":[]}' }), {})
      expect(t.pending.mode).toBe("fix")
      expect(t.pending.note).toContain('{"data":[]}')
      expect(t.history.at(-1)).toMatchObject({ mode: "operator", status: "RESULT", file: "run-result-1.md" })

      // Analyst's run resumes its own hand-off.
      team.apply(t, { mode: "analyst", adviceIds: ["ADV1"] }, run, {})
      expect(buildPrompt(DEFAULTS, t, t.pending, true)).toContain("MODE: run for Analyst")
      team.apply(t, t.pending, report("FAILED", { content: "curl: (6) Could not resolve host" }), {})
      expect(t.pending).toMatchObject({ mode: "analyst", adviceIds: ["ADV1"] })
      expect(t.pending.note).toContain("Could not resolve host")
      expect(t.attempts).toBe(0)

      t.runs = DEFAULTS.limits.runsPerTask
      expect(allowedStatuses(DEFAULTS, "fix", t)).not.toContain("RUN")
      t.runs = 0
      expect(allowedStatuses(merge(DEFAULTS, { operatorCalls: false }), "analyst", t)).not.toContain("RUN")
      expect(allowedStatuses(DEFAULTS, "analyst", t)).toContain("RUN")
    } finally {
      cleanup()
    }
  })

  test("a blocked step: the Planner fixes that step, the user approves one line, Developer carries on; a fixed step blocking again fails the plan", async () => {
    const { team, cleanup } = setup()
    try {
      await team.handle({ action: "start", text: "remove the old files" }, "ses_f", signal)
      const t = team.task("ses_f")
      const plan = "# Plan\n\n## Steps\n\n1. **Back up**: keep a copy\n   cp a a.bak\n2. **Delete**: remove the old files\n   p4 delete old.c\n3. **Check**: build\n   make\n"
      writeFileSync(path.join(t.dir, "plan-1.md"), plan)
      t.seq.plan = 1
      Object.assign(t, { phase: "running", plan: 1, planSteps: 3, step: 2, rounds: 0, stage: "how", stageRun: 1 })

      // Blocked: a failed attempt, but not yet a failed plan; the Planner gets the step and the report.
      team.apply(t, { mode: "fix" }, report("BLOCKED", { summary: "old.c is not in the depot", content: "p4: no such file" }), {})
      expect([t.attempts, t.planFailures, t.pending.mode]).toEqual([1, 0, "planner_stepfix"])
      const ask = buildPrompt(DEFAULTS, t, t.pending, false)
      expect(ask).toContain("MODE: step fix. Developer is blocked on step 2: old.c is not in the depot")
      expect(ask).toContain("p4: no such file")

      // Two steps replace step 2; the rest stays and is renumbered.
      const fix = "2. **Check the depot**: see which files p4 knows\n   p4 files old.c\n3. **Delete**: remove the old files, with rm for files p4 doesn't know\n   rm old.c"
      team.apply(t, t.pending, report("STEP", { summary: "Use rm for files that were never added", content: fix, risk: "no" }), {})
      expect([t.plan, t.planSteps, t.step, t.phase]).toEqual([2, 4, 2, "approval"])
      const text = readFileSync(path.join(t.dir, "plan-2.md"), "utf8")
      expect(text).toContain("1. **Back up**: keep a copy\n   cp a a.bak\n2. **Check the depot**")
      expect(text).toContain("3. **Delete**: remove the old files, with rm")
      expect(text).toContain("4. **Check**: build")
      expect(text).not.toContain("p4 delete")
      const view = render(t)
      expect(view).toContain("**Steps 2-3 replace step 2** (plan 2): Use rm for files that were never added")
      expect(view).not.toContain("rm old.c")

      // Approved: Developer carries on at step 2 in its own session, with the new plan.
      team.step = async (x: any) => x.pending
      await team.handle({ action: "approve" }, "ses_f", signal)
      expect([t.phase, t.step, t.pending.mode, t.pending.fresh, t.developerSeenPlan]).toEqual(["running", 2, "fix", undefined, false])
      const dev = buildPrompt(DEFAULTS, t, t.pending, false)
      expect(dev).toContain('<file name="plan-2.md">')
      expect(dev).toContain("Step 2 was changed after you were blocked")

      // A fixed step that blocks again fails the plan; another step of it may get its own fix.
      t.step = 3
      team.apply(t, { mode: "fix" }, report("BLOCKED", { content: "rm denied" }), {})
      expect([t.pending.mode, t.planFailures]).toEqual(["planner", 1])
      t.step = 4
      team.apply(t, { mode: "fix" }, report("BLOCKED", { content: "make missing" }), {})
      expect(t.pending.mode).toBe("planner_stepfix")
      // The Planner can't patch it: today's path, a failed plan.
      team.apply(t, t.pending, report("REPLAN", { content: "the build setup is wrong" }), {})
      expect(t.planFailures).toBe(2)

      // A destructive step fix: Architect reviews it first; safe auto stops at it and shows the step.
      Object.assign(t, { phase: "running", plan: 1, planSteps: 3, step: 2, planFailures: 0, architectAdviceUsed: 0, stepFix: undefined, auto: "safe" })
      t.pending = { mode: "planner_stepfix" }
      team.apply(t, t.pending, report("STEP", { summary: "Delete with rm", content: "2. **Delete**: remove the old files with rm\n   rm -f old.c", risk: "yes" }), {})
      expect(t.pending.mode).toBe("architect_review")
      team.apply(t, t.pending, report("APPROVE", { content: "fine" }), {})
      expect(t.phase).toBe("approval")
      const risky = render(t)
      expect(risky).toContain("**Step 2 changed** (plan 3): Delete with rm")
      expect(risky).toContain("rm -f old.c")
      expect(risky).toContain("Safe auto stopped here")
      t.stepFix.risk = false
      expect(render(t)).toContain("AUTO")
    } finally {
      cleanup()
    }
  })

  test("research: Analyst's brief waits for the user unless the research is quick", async () => {
    const { team, cleanup } = setup()
    try {
      await team.handle({ action: "start", text: "how does auth work", workflow: "research" }, "ses_x", signal)
      const t = team.task("ses_x")
      team.apply(t, { mode: "analyst" }, report("ESCALATE", { depth: "depth", content: "## Research brief\n\nQ\n\n## Findings so far\n\nF" }), {})
      expect([t.phase, t.depth]).toEqual(["brief", "depth"])
      expect(render(t)).toContain("**Research brief** (depth research)\n\nQ")
      save(t)
      expect((await team.handle({ action: "approve" }, "ses_x", signal)).mode).toBe("planner")
      t.phase = "running"
      team.apply(t, { mode: "analyst" }, report("ESCALATE", { depth: "quick" }), {})
      expect(t.pending.mode).toBe("planner")
    } finally {
      cleanup()
    }
  })
})

describe("usage", () => {
  test("table and hints", () => {
    const usage = {}
    add(usage, "manager", { calls: 1, prompts: 3, tools: { search: 2 }, input: 12000, cacheRead: 30000, output: 1000, model: "a/b" })
    add(usage, "developer", { calls: 2, prompts: 30, tools: { edit: 5, build: 20 }, input: 160000, cacheRead: 1200000, output: 12000, model: "c/d" })
    const t = table(usage)
    expect(t).toContain("manager")
    // Cache reads are left out: the table shows the tokens that cost money.
    expect(t).not.toContain("1.2M")
    expect(t).toContain("160k")
    expect(t.split("\n").pop()).toMatch(/^total\s+3\s+33\s+27/)
    expect(hints(usage)).toContain("manager used 2 read/search/shell/edit calls (expected 0)")
  })
})

describe("start while the task waits on the user", () => {
  test("goes to the waiting task instead of asking [Stop task] [Wait]", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "omat-redirect-"))
    const team = new Team({ session: { context: async () => [] } } as never, merge(DEFAULTS, { taskDir: root }), () => {}) as any
    team.step = async (t: any) => t.pending
    try {
      save(newTask(root, "ses_r", "/w", "x", 40))
      const t = team.task("ses_r")
      t.phase = "approval"
      t.plan = 1
      save(t)
      const p = await team.handle({ action: "start", text: "critically review the plan" }, "ses_r", new AbortController().signal)
      expect([p.mode, p.revision]).toEqual(["analyst", true])
      expect(p.note).toContain("critically review the plan")
      const q = team.task("ses_r")
      q.phase = "questions"
      q.questionsFrom = "analyst"
      save(q)
      expect((await team.handle({ action: "start", text: "option B" }, "ses_r", new AbortController().signal)).mode).toBe("analyst")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("plan approval", () => {
  test("step titles come from the bold lead of numbered lines", () => {
    const plan = "## Steps\n1. **Write the parser** — `a.py:1-20`\n   1. nested detail\n2. plain step text\n- not a step"
    expect(stepTitles(plan)).toEqual(["1. Write the parser", "2. plain step text"])
  })
  test("the approval block shows what you get, steps, risk and the plan file", () => {
    const root = mkdtempSync(path.join(tmpdir(), "omat-approval-"))
    try {
      const t = newTask(root, "ses_a", "/w", "x", 40)
      t.phase = "approval"
      t.plan = 1
      t.planSteps = 1
      t.planSummary = "Approving this writes `r4.md` with the design."
      writeFileSync(path.join(t.dir, "plan-1.md"), "## Steps\n1. **Write r4.md** — details")
      const text = render(t)
      expect(text).toContain("<show>")
      expect(text).toContain("Approving this writes `r4.md`")
      expect(text).toContain("1. Write r4.md")
      expect(text).toContain("**Risk:** no")
      expect(text).toContain(path.join(t.dir, "plan-1.md"))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  test("with summaries, the approval block lists each section's direction and each step's purpose, not the details", () => {
    const root = mkdtempSync(path.join(tmpdir(), "omat-approval-"))
    try {
      const t = newTask(root, "ses_a", "/w", "x", 10)
      Object.assign(t, { phase: "approval", reviewStyle: "all", plan: 1, planSteps: 1, planSummary: "Approving this moves the files." })
      const plan = "## Behaviour\n\n**Summary:** Same behaviour, new place.\n\nAll includes change.\n\n**Recommended:** as written\n\n## Steps\n\n1. **Move the sources**: they live under lib/\n\np4 move src/a.cpp lib/a.cpp"
      writeFileSync(path.join(t.dir, "plan-1.md"), plan)
      const text = render(t)
      expect(text).toContain("- S3 1. Move the sources: they live under lib/")
      expect(text).toContain("- S1 Behaviour: Same behaviour, new place. · **Recommended:** as written")
      expect(text).not.toContain("p4 move")
      expect(text).not.toContain("All includes change")
      expect(text).toContain('team "details"')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("sidebar", () => {
  test("current task rows with a live call, plus session totals over finished tasks", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "omat-sidebar-"))
    const tokens = (input: number, read: number, output: number) => ({ input, output, reasoning: 0, cache: { read, write: 0 } })
    const ctx = { session: { get: async ({ sessionID }: { sessionID: string }) => ({ tokens: sessionID === "ses_fix" ? tokens(150, 500, 30) : tokens(0, 0, 0) }) } }
    const team = new Team(ctx as never, merge(DEFAULTS, { taskDir: root }), () => {})
    try {
      const old = newTask(root, "ses_p", "/w", "a old task", 40)
      old.phase = "done"
      add(old.usage, "developer", { calls: 1, prompts: 2, tools: { edit: 3 }, input: 1000, cacheRead: 0, output: 0 })
      save(old)
      const cur = newTask(root, "ses_p", "/w", "b current task", 40)
      cur.phase = "fixing" as never
      cur.attempts = 3
      add(cur.usage, "analyst", { calls: 1, prompts: 4, tools: { search: 5 }, input: 300, cacheRead: 0, output: 0 })
      save(cur)
      const run = beginRun("ses_fix", { role: "developer", mode: "fix", task: cur, toolLimit: 10 })
      run.base = { input: 50, cacheRead: 0, output: 0 }
      run.prompts = 2
      run.tools = { edit: 1 }

      const s = await team.sidebar("ses_p")
      expect(s.task?.id).toBe(cur.id)
      expect(s.task?.attempts).toBe(3)
      expect(s.task?.rows.map((r) => [r.role, r.running])).toEqual([["analyst", false], ["developer", true]])
      const developer = s.task!.rows[1]!
      expect([developer.calls, developer.prompts, developer.tools, developer.input, developer.cacheRead, developer.output]).toEqual([0, 2, 1, 100, 500, 30])
      expect(s.session.tasks).toBe(2)
      expect(s.session.total).toEqual({ calls: 2, prompts: 8, tools: 9, tokens: 300 + 130 + 1000 })
      expect("task" in (await team.sidebar("ses_other"))).toBe(false)
    } finally {
      runs.delete("ses_fix")
      rmSync(root, { recursive: true, force: true })
    }
  })
  test("mid-task questions go to the agent the task waits on; replies keep the user's original words", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "omat-reply-"))
    const context = [
      { type: "user", text: "old request", time: { created: 1 } },
      { type: "user", text: "lets keep option a", time: { created: 20 } },
    ]
    const team = new Team({ session: { context: async () => context } } as never, merge(DEFAULTS, { taskDir: root }), () => {}) as any
    try {
      const t = newTask(root, "ses_p", "/w", "x", 40)
      t.phase = "questions"
      t.questionsFrom = "analyst"
      expect(team.replier(t)).toBeUndefined()
      t.sessions.analyst = "ses_t"
      expect(team.replier(t)).toBe("analyst")
      t.sessions.planner = "ses_s"
      expect(team.replier(t)).toBe("analyst")
      t.questionsFrom = "planner"
      expect(team.replier(t)).toBe("planner")
      t.phase = "approval"
      expect(team.replier(t)).toBe("planner")
      t.phase = "questions"
      t.questionsFrom = "architect_advice"
      expect(team.replier(t)).toBe("planner")
      t.sessions.architect = "ses_o"
      expect(team.replier(t)).toBe("architect")
      t.phase = "approval"

      t.askedAt = 10
      const r = await team.withOriginal(t, "Grammar: option A (LLM-only).", "answer")
      expect(r.polished).toBe("Grammar: option A (LLM-only).")
      expect(r.note).toContain("<answer>\nGrammar: option A (LLM-only).\n</answer>")
      expect(r.note).toContain("<original>\nlets keep option a\n</original>")
      expect(r.note).not.toContain("old request")
      expect((await team.withOriginal(t, "lets keep  option a", "answer")).note).not.toContain("<original>")
      expect((await team.withOriginal(t, "", "answer")).polished).toBe("lets keep option a")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  test("saved data from before the rename: identifiers renamed, free text kept", () => {
    const old = `{"sessions":{"triage":"s1","senior":"s2"},"seniorUnseen":[],"skipOracleReview":false,"questionsFrom":"oracle_advice","summary":"senior plan","usage":{"Fixer":1}}`
    expect(JSON.parse(migrateNames(old))).toEqual({
      sessions: { analyst: "s1", planner: "s2" },
      plannerUnseen: [],
      skipArchitectReview: false,
      questionsFrom: "architect_advice",
      summary: "senior plan",
      usage: { Developer: 1 },
    })
    const second = `{"sessions":{"lead":"s1","architect":"s2"},"consultLead":1,"questionsFrom":"principal_advice","usage":{"Principal":1}}`
    expect(JSON.parse(migrateNames(second))).toEqual({
      sessions: { analyst: "s1", architect: "s2" },
      consultAnalyst: 1,
      questionsFrom: "architect_advice",
      usage: { Architect: 1 },
    })
  })
  test("an answer to Architect's questions goes back to its session", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "omat-architect-"))
    const team = new Team({ session: { context: async () => [] } } as never, merge(DEFAULTS, { taskDir: root }), () => {}) as any
    team.step = async (t: any) => t.pending
    try {
      save(newTask(root, "ses_p", "/w", "x", 40))
      const t = team.task("ses_p")
      t.phase = "questions"
      t.questionsFrom = "architect_advice"
      t.sessions.architect = "ses_o"
      const p = await team.handle({ action: "answer", text: "keep the API" }, "ses_p", new AbortController().signal)
      expect(p.mode).toBe("architect_advice")
      expect(p.fresh).toBeUndefined()
      expect(p.note).toContain("keep the API")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  test("a forced plan takes TRIVIAL away from analyst", () => {
    const t = newTask("/tmp/x", "ses_p", "/w", "x", 40)
    expect(allowedStatuses(DEFAULTS, "analyst", t)).toContain("TRIVIAL")
    t.forcePlan = true
    expect(allowedStatuses(DEFAULTS, "analyst", t)).toEqual(["ESCALATE", "QUESTIONS", "NEED_INFO", "CONSULT", "RUN"])
  })
  test("sidebar lists each row's models and the configured models", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "omat-models-"))
    const config = merge(DEFAULTS, { taskDir: root, agents: { analyst: { model: ["fuse/glm", "siemens/claude"] } } })
    const team = new Team({ session: { get: async () => undefined } } as never, config, () => {})
    try {
      const t = newTask(root, "ses_m", "/w", "x", 40)
      add(t.usage, "analyst", { calls: 1, prompts: 1, tools: {}, input: 1, cacheRead: 0, output: 0, model: "fuse/glm" })
      add(t.usage, "analyst", { calls: 1, prompts: 1, tools: {}, input: 1, cacheRead: 0, output: 0, model: "siemens/claude" })
      save(t)
      const s = await team.sidebar("ses_m")
      expect(s.task?.rows[0]?.models).toEqual(["fuse/glm", "siemens/claude"])
      expect(modelsText(s.task!.rows[0]!.models)).toBe("fuse/glm → siemens/claude (backup)")
      expect(s.task?.workflow).toBe("code")
      expect(s.models.find((m) => m.role === "analyst")?.models).toEqual(["fuse/glm", "siemens/claude"])
      expect(s.models).toHaveLength(8)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  test("compact numbers and fixed-width lines", () => {
    expect([compact(950), compact(1234), compact(56_000), compact(2_500_000)]).toEqual(["950", "1.2k", "56k", "2.5M"])
    expect(line("●", "developer", 1, 22, 333, "4.4k", "50%")).toHaveLength(35)
    expect(line(" ", "architect", 12, 1, 1, "1k", "1%")).toContain("architect  12")
  })
})

describe("version control", () => {
  test("git, none, and the line agents get", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "omat-vcs-"))
    mkdirSync(path.join(base, "repo", ".git"), { recursive: true })
    mkdirSync(path.join(base, "repo", "src"), { recursive: true })
    mkdirSync(path.join(base, "plain"))
    const g = await detectVcs(path.join(base, "repo", "src"))
    expect(g).toEqual({ kind: "git", root: path.join(base, "repo") })
    expect(vcsLine("/w", g)).toContain("not a Perforce workspace")
    expect(await detectVcs(path.join(base, "plain"))).toEqual({ kind: "none" })
    const p = vcsLine("/p4/ws/src", { kind: "perforce", client: "me_ws", root: "/p4/ws" })
    expect(p).toContain("Version control: Perforce workspace (client me_ws, root /p4/ws)")
    expect(p).not.toContain("p4_* tools")
  })
})
