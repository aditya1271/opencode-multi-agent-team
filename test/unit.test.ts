import { describe, expect, test } from "bun:test"
import { evaluate, FRONT_AGENTS, ignoredTools, managerPrompt, permissionsFor, roleOf, systemPrompt, toolVisible, workflowOf } from "../src/agents.ts"
import { buildPatterns, DEFAULTS, merge, parseModel, stripJsonc } from "../src/config.ts"
import { toolKind, trimLog } from "../src/guards.ts"
import { commandParts, matchesAny } from "../src/match.ts"
import { acceptReport, allowedStatuses, checkProblem } from "../src/report.ts"
import { beginRun, runs } from "../src/runtime.ts"
import { appendFile, migrateNames, newTask, save, taskId, WORKFLOWS } from "../src/state.ts"
import { Team } from "../src/team.ts"
import { compact, line, modelsText } from "../src/rpc.ts"
import { buildPrompt, render, stepTitles } from "../src/messages.ts"
import { annotate, checkEdits, idRanges, indexOf, splice, split } from "../src/sections.ts"
import { add, hints, table } from "../src/usage.ts"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
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
    expect(allowedStatuses(DEFAULTS, "architect", task)).toEqual(["PLAN", "ASK", "QUESTIONS", "ESCALATE"])
    task.needInfo = 6
    task.questionRounds = 4
    expect(allowedStatuses(DEFAULTS, "architect", task)).toEqual(["PLAN", "ESCALATE"])
    task.needInfo = 0
    task.questionRounds = 0
  })
  test("stages pick the Architect's statuses; only the how stage after a what-document may report INFEASIBLE", () => {
    const t = newTask("/tmp/opencode/omat-test", "ses_s", "/tmp", "Goal\nadd a feature", 40)
    expect(allowedStatuses(DEFAULTS, "lead", t)).toEqual(["TRIVIAL", "ESCALATE", "QUESTIONS"])
    t.stage = "what"
    expect(allowedStatuses(DEFAULTS, "architect", t)).toEqual(["DOC", "ASK", "QUESTIONS", "ESCALATE"])
    expect(allowedStatuses(DEFAULTS, "lead", t)).toEqual(["ESCALATE", "QUESTIONS"])
    t.stage = "how"
    expect(allowedStatuses(DEFAULTS, "architect", t)).toEqual(["PLAN", "ASK", "QUESTIONS", "ESCALATE"])
    t.doc = 1
    expect(allowedStatuses(DEFAULTS, "architect", t)).toContain("INFEASIBLE")
    expect(allowedStatuses(DEFAULTS, "lead", t)).toContain("INFEASIBLE")
    const r = newTask("/tmp/opencode/omat-test", "ses_rs", "/tmp", "Goal\nresearch", 40)
    r.workflow = "research"
    expect(allowedStatuses(DEFAULTS, "architect", r)).toEqual(["DOC", "NEED_INFO", "QUESTIONS", "ESCALATE"])
  })
  test("Lead's first ESCALATE in a code task must say whether the behaviour is settled", () => {
    const t = newTask("/tmp/opencode/omat-test", "ses_ws", "/tmp", "Goal\nadd --upper", 40)
    beginRun("ses_lead", { role: "lead", mode: "lead", task: t, toolLimit: 10 })
    const esc = { status: "ESCALATE", summary: "s", content: "## Code\n\nx" }
    expect(() => acceptReport(DEFAULTS, "ses_lead", esc)).toThrow("what")
    expect(() => acceptReport(DEFAULTS, "ses_lead", { ...esc, what: "settled" })).toThrow("Why the behaviour is settled")
    expect(acceptReport(DEFAULTS, "ses_lead", { ...esc, what: "settled", content: "## Why the behaviour is settled\n\nThe flag is named.\n\n## Code\n\nx" })).toContain("Report received")
    runs.delete("ses_lead")
  })
  test("Lead's answer must cite every question id", () => {
    const t = newTask("/tmp/opencode/omat-test", "ses_la", "/tmp", "Goal\nx", 40)
    t.pending = { mode: "lead_answer", ids: ["A1", "A2"] }
    beginRun("ses_ans", { role: "lead", mode: "lead_answer", task: t, toolLimit: 10 })
    expect(() => acceptReport(DEFAULTS, "ses_ans", { status: "ANSWER", summary: "s", content: "### A1\nyes" })).toThrow("missing: A2")
    expect(acceptReport(DEFAULTS, "ses_ans", { status: "ANSWER", summary: "s", content: "### A1\nyes\n### A2\nno" })).toContain("Report received")
    runs.delete("ses_ans")
  })
  test("lead after a failed trivial attempt may only escalate", () => {
    task.trivialFailed = true
    expect(allowedStatuses(DEFAULTS, "lead", task)).toEqual(["ESCALATE"])
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
  test("architect and principal can only report (and load their skills)", () => {
    const config = merge(DEFAULTS, { agents: { principal: { skills: ["csh-terminal"] } } })
    expect(permissionsFor(config, "architect").filter((r) => r.effect === "allow").map((r) => r.action)).toEqual(["report"])
    const principal = permissionsFor(config, "principal")
    expect(principal.filter((r) => r.effect === "allow").map((r) => r.action)).toEqual(["skill", "report"])
    expect(evaluate(principal, "read", ["a.ts"])).toBe("deny")
  })
  test("evaluate: last match wins, team rules decide", () => {
    const lead = permissionsFor(DEFAULTS, "lead")
    expect(evaluate(lead, "read", ["src/a.ts"])).toBe("allow")
    expect(evaluate(lead, "edit", ["src/a.ts"])).toBe("deny")
    expect(evaluate(lead, "shell", ["git status"])).toBe("allow")
    expect(evaluate(lead, "shell", ["make"])).toBe("deny")
    const developer = permissionsFor(DEFAULTS, "developer")
    expect(evaluate(developer, "edit", ["a.ts", "b.ts"])).toBe("allow")
    expect(evaluate(developer, "shell", ["git reset --hard"])).toBe("ask")
    expect(evaluate(permissionsFor(DEFAULTS, "manager"), "read", ["a.ts"])).toBe("deny")
  })
  test("toolVisible", () => {
    const manager = permissionsFor(DEFAULTS, "manager")
    expect(["team", "question", "read", "shell", "edit"].filter((t) => toolVisible(manager, t))).toEqual(["team", "question"])
    expect(toolVisible(permissionsFor(DEFAULTS, "lead"), "shell")).toBe(true)
    expect(toolVisible(permissionsFor(DEFAULTS, "lead"), "write")).toBe(false)
    expect(toolVisible(permissionsFor(DEFAULTS, "developer"), "write")).toBe(true)
  })
  test("developer asks before destructive commands", () => {
    const rules = permissionsFor(DEFAULTS, "developer")
    expect(rules.some((r) => r.action === "shell" && r.resource === "git reset *" && r.effect === "ask")).toBe(true)
  })
  test("per-agent search tools, commands and mcps", () => {
    const config = merge(DEFAULTS, {
      agents: {
        lead: { mcps: ["codebase-memory"], tools: ["docs_search"], commands: ["graphify *"] },
        architect: { mcps: ["codebase-memory"] },
        developer: { commands: ["rm -rf *"] },
      },
    })
    const lead = permissionsFor(config, "lead")
    expect(evaluate(lead, "codebase-memory_search_graph", ["*"])).toBe("allow")
    expect(evaluate(lead, "docs_search", ["*"])).toBe("allow")
    expect(evaluate(lead, "shell", ["graphify query foo"])).toBe("allow")
    expect(evaluate(lead, "shell", ["rm foo"])).toBe("deny")
    expect(evaluate(permissionsFor(config, "architect"), "codebase-memory_search_graph", ["*"])).toBe("deny")
    expect(ignoredTools(config)).toEqual(["agents.architect: codebase-memory ignored (architect has no tool access; Lead answers its questions)"])
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
    expect(workflowOf("team-lead")).toBe("code")
    expect(roleOf(DEFAULTS, "plan-manager")).toBe("manager")
    expect(roleOf(DEFAULTS, "manager")).toBe("manager")
    expect(roleOf(DEFAULTS, "team-lead")).toBe("lead")
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
    const team = new Team(ctx as never, merge(DEFAULTS, { taskDir: root }), () => {}) as any
    team.step = async (t: any) => t.pending
    const cleanup = () => {
      rmSync(root, { recursive: true, force: true })
      rmSync(workspace, { recursive: true, force: true })
    }
    return { team, workspace, cleanup }
  }
  const report = (status: string, extra: object = {}) => ({ status, summary: "Approving this gives you a design.", content: "# Design\n\n## Options\n\nA or B", ...extra })

  test("a plan task skips checks, writes the document without overwriting, and never reaches the developer", async () => {
    const switched: string[] = []
    const { team, workspace, cleanup } = setup(switched)
    try {
      mkdirSync(path.join(workspace, "docs"))
      await team.handle({ action: "start", text: "design the cache", workflow: "plan" }, "ses_w", signal)
      const t = team.task("ses_w")
      expect([t.workflow, t.phase, t.skipChecks]).toEqual(["plan", "running", undefined])
      expect(allowedStatuses(DEFAULTS, "lead", t)).not.toContain("TRIVIAL")
      writeFileSync(path.join(workspace, "docs", path.basename(t.output)), "someone else's file")
      // outputPath was fixed at start; a second task with the same name gets -2
      expect(team.outputPath(t)).toMatch(/-2\.md$/)
      // What stage: Lead's concept brief waits for the user, then the Architect writes the what-document.
      team.apply(t, { mode: "lead" }, report("ESCALATE", { content: "## Concept brief\n\n**Concerns**: speed\n\n## Excerpts\n\nE" }), {})
      expect([t.stage, t.phase]).toEqual(["what", "brief"])
      expect(render(t)).toContain("**Concept brief**\n\n**Concerns**: speed")
      expect(render(t)).not.toContain("## Excerpts")
      save(t)
      expect((await team.handle({ action: "approve" }, "ses_w", signal)).mode).toBe("architect")
      t.pending = undefined
      team.apply(t, { mode: "architect" }, report("DOC", { content: "# Design\n\n## Options\n\nA or B\n\n## Decisions\n\n- A (yours)" }), {})
      expect(t.phase).toBe("approval")
      expect(readFileSync(t.output, "utf8")).toContain("## Options")
      expect(render(t)).toContain("**Decisions**\n- A (yours)")
      expect(render(t)).toContain("**Sections**\n- S1 Design\n- S2 Options")
      t.sessions.lead = "ses_lead_what"
      save(t)

      // Approving the what-document starts the how stage in fresh sessions.
      const how = await team.handle({ action: "approve" }, "ses_w", signal)
      expect([how.mode, how.fresh, t.stage, t.sessions.lead, t.whatSessions.lead]).toEqual(["lead", true, "how", undefined, "ses_lead_what"])
      const leadPrompt = buildPrompt(DEFAULTS, t, how, true)
      expect(leadPrompt).toContain("Stage: HOW")
      expect(leadPrompt).toContain("The approved what-document:")
      expect(leadPrompt).not.toContain("**Concerns**: speed")
      t.pending = undefined
      team.apply(t, how, report("ESCALATE", { content: "## Code\n\n`a.ts:1-3`" }), {})
      expect([t.pending.mode, t.pending.fresh]).toEqual(["architect", true])
      const archPrompt = buildPrompt(DEFAULTS, t, t.pending, true)
      expect(archPrompt).toContain('name="how-brief.md"')
      expect(archPrompt).not.toContain('name="brief.md"')
      t.pending = undefined
      team.apply(t, { mode: "architect" }, report("PLAN", { content: "## Steps\n1. **Add the cache** — `a.ts:1`", steps: 1, risk: "no" }), {})
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

  test("the user's review request: Principal reviews, Architect revises once, the user sees the marked review", async () => {
    const { team, cleanup } = setup()
    try {
      await team.handle({ action: "start", text: "design it", workflow: "plan" }, "ses_v", signal)
      const t = team.task("ses_v")
      team.apply(t, { mode: "architect" }, report("DOC"), {})
      save(t)
      const p = await team.handle({ action: "review", text: "check the error handling" }, "ses_v", signal)
      expect(p.mode).toBe("principal_doc_review")
      t.pending = undefined
      team.apply(t, p, report("CHANGES", { content: "1. no error handling" }), {})
      expect(t.pending.mode).toBe("architect")
      const revise = t.pending
      t.pending = undefined
      team.apply(t, revise, report("DOC"), {})
      expect(t.phase).toBe("approval")
      expect(render(t)).toContain("(this version was revised to address it)")
      t.reviews = DEFAULTS.limits.principalReviews
      expect(await team.handle({ action: "review" }, "ses_v", signal)).toContain("the limit")
    } finally {
      cleanup()
    }
  })

  test("comments on a document go to Lead for a revision brief, then to the Architect", async () => {
    const { team, cleanup } = setup()
    try {
      await team.handle({ action: "start", text: "design it", workflow: "plan" }, "ses_r", signal)
      const t = team.task("ses_r")
      team.apply(t, { mode: "lead" }, report("ESCALATE", { content: "first brief" }), {})
      t.pending = undefined
      team.apply(t, { mode: "architect" }, report("DOC"), {})
      save(t)
      const p = await team.handle({ action: "change", text: "pets are too specific, there may be more" }, "ses_r", signal)
      expect([p.mode, p.revision, t.revising]).toEqual(["lead", true, true])
      const prompt = buildPrompt(DEFAULTS, t, p, false)
      expect(prompt).toContain("MODE: revision")
      expect(prompt).toContain("## Options")
      expect(prompt).toContain("pets are too specific")
      t.pending = undefined
      team.apply(t, p, report("ESCALATE", { content: "change section X" }), {})
      expect([t.pending.mode, t.revising, t.architectUnseen]).toEqual(["architect", false, ["revision-1.md"]])
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
      team.apply(t, { mode: "lead" }, report("ESCALATE", { content: brief }), {})
      save(t)
      expect(render(t)).toContain("#### 1. Scope [S3]")
      expect(render(t)).toContain("finetune, revise, final, reopen (ids)")
      expect(await team.handle({ action: "change", text: "x", revise: ["S9"] }, "ses_s", signal)).toContain("Not section ids of this draft: S9")
      const p = await team.handle({ action: "change", text: "glossary needs entity linking", final: ["S3"], revise: ["S4"] }, "ses_s", signal)
      expect([t.scope, t.sections.final]).toEqual([{ draft: "brief", revise: ["S4"], finetune: [], add: [], open: false }, ["S3"]])
      expect(p.note).toContain("- S3 1. Scope: FINAL")
      expect(p.note).toContain("- S4 2. Glossary: REVISE")
      expect(p.note).toContain("report ESCALATE with the revised sections only")
      beginRun("ses_sc", { role: "lead", mode: "lead", task: t, toolLimit: 10 })
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

      // The what-document: a new draft with its own ids and final marks; Lead's revision brief and the Architect see the scope.
      t.phase = "brief"
      await team.handle({ action: "approve" }, "ses_s", signal)
      t.pending = undefined
      const doc = "# Design\n\n## Glossary\n\nA\n\n## Review\n\nB"
      team.apply(t, { mode: "architect" }, report("DOC", { content: doc }), {})
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

      // A fine-tune-only round: straight to the Architect, no comment round, the edit only.
      t.phase = "approval"
      const rounds = t.commentRounds
      const tune = await team.handle({ action: "change", text: "S3: say \"web UI\"", finetune: ["S3"] }, "ses_s", signal)
      expect([tune.mode, t.commentRounds]).toEqual(["architect", rounds])
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

  test("a brief the user keeps sending back: Architect advises at round 3, Principal at 5; STUCK calls the next adviser", async () => {
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
      brief({ mode: "lead" })
      expect(allowedStatuses(DEFAULTS, "lead", t)).not.toContain("STUCK")
      for (const n of [1, 2]) {
        const p = await comment(n)
        expect([p.mode, p.adviceIds]).toEqual(["lead", undefined])
        brief(p)
      }
      const adv = await comment(3)
      expect([adv.mode, adv.advise, adv.fresh, adv.then.mode]).toEqual(["architect_advice", "lead", true, "lead"])
      expect(allowedStatuses(DEFAULTS, "architect_advice", t)).toEqual(["ADVICE", "ASK"])
      expect(buildPrompt(DEFAULTS, t, adv, true)).toContain("MODE: advice")
      beginRun("ses_adv", { role: "architect", mode: "architect_advice", task: t, toolLimit: 10 })
      expect(() => acceptReport(DEFAULTS, "ses_adv", { status: "ADVICE", summary: "s", content: "c" })).toThrow("items")
      runs.delete("ses_adv")
      t.pending = undefined
      team.apply(t, adv, report("ADVICE", { content: "It ignores scale.", items: ["cover scale", "drop pets"] }), {})
      const revise = t.pending
      expect([revise.mode, revise.adviceIds, revise.files]).toEqual(["lead", ["ADV1", "ADV2"], ["advice-1.md"]])
      expect(buildPrompt(DEFAULTS, t, revise, false)).toContain("**ADV2**: drop pets")
      beginRun("ses_rev", { role: "lead", mode: "lead", task: t, toolLimit: 10 })
      const esc = { status: "ESCALATE", summary: "s", content: "## Concept brief\n\nx" }
      expect(() => acceptReport(DEFAULTS, "ses_rev", { ...esc, addressed: "ADV1: added scale" })).toThrow("missing: ADV2")
      runs.delete("ses_rev")
      brief(revise, { addressed: "ADV1: added scale\nADV2: dropped pets" })
      expect(render(t)).toContain("**Revised following Architect's advice**")
      expect(readFileSync(path.join(t.dir, "advice-1.md"), "utf8")).toContain("ADV2: dropped pets")

      const p4 = await comment(4)
      expect(p4.mode).toBe("lead")
      expect(render(t)).not.toContain("Revised following")
      brief(p4)
      const p5 = await comment(5)
      expect([p5.mode, p5.advise]).toEqual(["principal_draft_advice", "lead"])
      expect(buildPrompt(DEFAULTS, t, p5, true)).toContain("Earlier advice on this draft")
      t.pending = undefined
      team.apply(t, p5, report("ADVICE", { items: ["one"] }), {})
      expect(t.pending.adviceIds).toEqual(["ADV3"])
      brief(t.pending, { addressed: "ADV3: done" })

      // Both advisers used: STUCK goes to the user.
      const p6 = await comment(6)
      expect(p6.mode).toBe("lead")
      expect(allowedStatuses(DEFAULTS, "lead", t)).toContain("STUCK")
      t.pending = undefined
      team.apply(t, p6, report("STUCK", { content: "they want two things at once" }), {})
      expect([t.phase, t.pending.mode]).toEqual(["stuck", "lead"])

      // Approving the brief starts a new ladder; an Architect that is stuck on its first comment round gets Principal.
      t.phase = "brief"
      t.pending = undefined
      save(t)
      expect((await team.handle({ action: "approve" }, "ses_l", signal)).mode).toBe("architect")
      expect([t.commentRounds, t.advisors, t.lastAdvice]).toEqual([0, [], undefined])
      t.pending = undefined
      team.apply(t, { mode: "architect" }, report("DOC"), {})
      save(t)
      const rev = await team.handle({ action: "change", text: "more" }, "ses_l", signal)
      t.pending = undefined
      team.apply(t, rev, report("ESCALATE", { content: "change X" }), {})
      expect(t.pending.mode).toBe("architect")
      const arch = t.pending
      t.pending = undefined
      team.apply(t, arch, report("STUCK", { content: "can't" }), {})
      expect([t.pending.mode, t.pending.advise, t.pending.then.mode]).toEqual(["principal_draft_advice", "architect", "architect"])
      const pa = t.pending
      t.pending = undefined
      team.apply(t, pa, report("ADVICE", { items: ["split it"] }), {})
      expect([t.pending.mode, t.pending.adviceIds]).toEqual(["architect", ["ADV4"]])
      expect(buildPrompt(DEFAULTS, t, t.pending, false)).toContain("**ADV4**: split it")
    } finally {
      cleanup()
    }
  })

  test("code: settled behaviour skips the what stage; the Architect asks Lead; INFEASIBLE goes back to the user", async () => {
    const { team, cleanup } = setup()
    try {
      await team.handle({ action: "start", text: "add --upper" }, "ses_c", signal)
      const t = team.task("ses_c")
      t.phase = "running"
      team.apply(t, { mode: "lead" }, report("ESCALATE", { what: "settled", content: "## Why the behaviour is settled\n\nNamed.\n\n## Code\n\nx" }), {})
      expect([t.stage, t.pending.mode]).toEqual(["how", "architect"])
      expect(readFileSync(path.join(t.dir, "how-brief.md"), "utf8")).toContain("settled")
      expect(buildPrompt(DEFAULTS, t, t.pending, true)).toContain("## Behaviour")

      // ASK: numbered questions to Lead, answered in a numbered file the Architect gets next.
      t.pending = undefined
      team.apply(t, { mode: "architect" }, report("ASK", { questions: ["which file?", "C or C++?"], content: "" }), {})
      expect([t.pending.mode, t.pending.ids, t.needInfo]).toEqual(["lead_answer", ["A1", "A2"], 1])
      expect(t.pending.note).toContain("**A2**: C or C++?")
      const ask = t.pending
      t.pending = undefined
      team.apply(t, ask, report("ANSWER", { content: "### A1\nmain.c\n### A2\nC only (`CMakeLists.txt:3`)" }), {})
      expect([t.pending.mode, t.architectUnseen]).toEqual(["architect", ["how-brief-answer-1.md"]])
      expect(buildPrompt(DEFAULTS, t, t.pending, true)).toContain('name="how-brief-answer-1.md"')

      // INFEASIBLE in a how stage after a what-document: back to the what approval with the what sessions.
      t.pending = undefined
      t.stage = "how"
      t.doc = 1
      writeFileSync(path.join(t.dir, "doc-1.md"), "# What\n\n## Decisions\n\n- C++")
      t.whatSessions = { lead: "ses_lw", architect: "ses_aw" }
      team.apply(t, { mode: "architect" }, report("INFEASIBLE", { content: "C++ can't build here" }), {})
      expect([t.stage, t.phase, t.infeasible, t.sessions.lead]).toEqual(["what", "approval", "infeasible-1.md", "ses_lw"])
      expect(render(t)).toContain("C++ can't build here")
      save(t)
      const again = await team.handle({ action: "approve" }, "ses_c", signal)
      expect([again.mode, again.files, t.stage]).toEqual(["lead", ["infeasible-1.md"], "how"])
    } finally {
      cleanup()
    }
  })

  test("research: Lead's brief waits for the user unless the research is quick", async () => {
    const { team, cleanup } = setup()
    try {
      await team.handle({ action: "start", text: "how does auth work", workflow: "research" }, "ses_x", signal)
      const t = team.task("ses_x")
      team.apply(t, { mode: "lead" }, report("ESCALATE", { depth: "depth", content: "## Research brief\n\nQ\n\n## Findings so far\n\nF" }), {})
      expect([t.phase, t.depth]).toEqual(["brief", "depth"])
      expect(render(t)).toContain("**Research brief** (depth research)\n\nQ")
      save(t)
      expect((await team.handle({ action: "approve" }, "ses_x", signal)).mode).toBe("architect")
      t.phase = "running"
      team.apply(t, { mode: "lead" }, report("ESCALATE", { depth: "quick" }), {})
      expect(t.pending.mode).toBe("architect")
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
    expect(t).toContain("1.2M")
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
      expect([p.mode, p.revision]).toEqual(["lead", true])
      expect(p.note).toContain("critically review the plan")
      const q = team.task("ses_r")
      q.phase = "questions"
      q.questionsFrom = "lead"
      save(q)
      expect((await team.handle({ action: "start", text: "option B" }, "ses_r", new AbortController().signal)).mode).toBe("lead")
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
      add(cur.usage, "lead", { calls: 1, prompts: 4, tools: { search: 5 }, input: 300, cacheRead: 0, output: 0 })
      save(cur)
      const run = beginRun("ses_fix", { role: "developer", mode: "fix", task: cur, toolLimit: 10 })
      run.base = { input: 50, cacheRead: 0, output: 0 }
      run.prompts = 2
      run.tools = { edit: 1 }

      const s = await team.sidebar("ses_p")
      expect(s.task?.id).toBe(cur.id)
      expect(s.task?.attempts).toBe(3)
      expect(s.task?.rows.map((r) => [r.role, r.running])).toEqual([["lead", false], ["developer", true]])
      const developer = s.task!.rows[1]!
      expect([developer.calls, developer.prompts, developer.tools, developer.input, developer.cacheRead, developer.output]).toEqual([0, 2, 1, 100, 500, 30])
      expect(s.session.tasks).toBe(2)
      expect(s.session.total).toEqual({ calls: 2, prompts: 8, tools: 9, tokens: 300 + 630 + 1000 })
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
      t.questionsFrom = "lead"
      expect(team.replier(t)).toBeUndefined()
      t.sessions.lead = "ses_t"
      expect(team.replier(t)).toBe("lead")
      t.sessions.architect = "ses_s"
      expect(team.replier(t)).toBe("lead")
      t.questionsFrom = "architect"
      expect(team.replier(t)).toBe("architect")
      t.phase = "approval"
      expect(team.replier(t)).toBe("architect")
      t.phase = "questions"
      t.questionsFrom = "principal_advice"
      expect(team.replier(t)).toBe("architect")
      t.sessions.principal = "ses_o"
      expect(team.replier(t)).toBe("principal")
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
      sessions: { lead: "s1", architect: "s2" },
      architectUnseen: [],
      skipPrincipalReview: false,
      questionsFrom: "principal_advice",
      summary: "senior plan",
      usage: { Developer: 1 },
    })
  })
  test("an answer to Principal's questions goes back to its session", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "omat-principal-"))
    const team = new Team({ session: { context: async () => [] } } as never, merge(DEFAULTS, { taskDir: root }), () => {}) as any
    team.step = async (t: any) => t.pending
    try {
      save(newTask(root, "ses_p", "/w", "x", 40))
      const t = team.task("ses_p")
      t.phase = "questions"
      t.questionsFrom = "principal_advice"
      t.sessions.principal = "ses_o"
      const p = await team.handle({ action: "answer", text: "keep the API" }, "ses_p", new AbortController().signal)
      expect(p.mode).toBe("principal_advice")
      expect(p.fresh).toBeUndefined()
      expect(p.note).toContain("keep the API")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  test("a forced plan takes TRIVIAL away from lead", () => {
    const t = newTask("/tmp/x", "ses_p", "/w", "x", 40)
    expect(allowedStatuses(DEFAULTS, "lead", t)).toContain("TRIVIAL")
    t.forcePlan = true
    expect(allowedStatuses(DEFAULTS, "lead", t)).toEqual(["ESCALATE", "QUESTIONS"])
  })
  test("sidebar lists each row's models and the configured models", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "omat-models-"))
    const config = merge(DEFAULTS, { taskDir: root, agents: { lead: { model: ["fuse/glm", "siemens/claude"] } } })
    const team = new Team({ session: { get: async () => undefined } } as never, config, () => {})
    try {
      const t = newTask(root, "ses_m", "/w", "x", 40)
      add(t.usage, "lead", { calls: 1, prompts: 1, tools: {}, input: 1, cacheRead: 0, output: 0, model: "fuse/glm" })
      add(t.usage, "lead", { calls: 1, prompts: 1, tools: {}, input: 1, cacheRead: 0, output: 0, model: "siemens/claude" })
      save(t)
      const s = await team.sidebar("ses_m")
      expect(s.task?.rows[0]?.models).toEqual(["fuse/glm", "siemens/claude"])
      expect(modelsText(s.task!.rows[0]!.models)).toBe("fuse/glm → siemens/claude (backup)")
      expect(s.task?.workflow).toBe("code")
      expect(s.models.find((m) => m.role === "lead")?.models).toEqual(["fuse/glm", "siemens/claude"])
      expect(s.models).toHaveLength(7)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  test("compact numbers and fixed-width lines", () => {
    expect([compact(950), compact(1234), compact(56_000), compact(2_500_000)]).toEqual(["950", "1.2k", "56k", "2.5M"])
    expect(line("●", "developer", 1, 22, 333, "4.4k", "50%")).toHaveLength(35)
    expect(line(" ", "principal", 12, 1, 1, "1k", "1%")).toContain("principal  12")
  })
})
