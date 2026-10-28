import { describe, expect, test } from "bun:test"
import { evaluate, FRONT_AGENTS, managerPrompt, permissionsFor, roleOf, systemPrompt, toolVisible, workflowOf } from "../src/agents.ts"
import { buildPatterns, DEFAULTS, merge, parseModel, stripJsonc } from "../src/config.ts"
import { toolKind, trimLog } from "../src/guards.ts"
import { commandParts, matchesAny } from "../src/match.ts"
import { acceptReport, allowedStatuses, checkProblem } from "../src/report.ts"
import { beginRun, runs } from "../src/runtime.ts"
import { migrateNames, newTask, save, taskId, WORKFLOWS } from "../src/state.ts"
import { Team } from "../src/team.ts"
import { compact, line, modelsText } from "../src/rpc.ts"
import { buildPrompt, render, stepTitles } from "../src/messages.ts"
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
    expect(allowedStatuses(DEFAULTS, "architect", task)).toContain("NEED_INFO")
    task.needInfo = 6
    task.questionRounds = 4
    expect(allowedStatuses(DEFAULTS, "architect", task)).toEqual(["PLAN", "ESCALATE"])
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
  test("architect has no grep or shell", () => {
    const allowed = permissionsFor(DEFAULTS, "architect").filter((r) => r.effect === "allow").map((r) => r.action)
    expect(allowed).not.toContain("grep")
    expect(allowed).not.toContain("shell")
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
        architect: { mcps: ["codebase-memory"], tools: ["docs_search"], commands: ["graphify *"] },
        developer: { commands: ["rm -rf *"] },
      },
    })
    const architect = permissionsFor(config, "architect")
    expect(evaluate(architect, "codebase-memory_search_graph", ["*"])).toBe("allow")
    expect(evaluate(architect, "docs_search", ["*"])).toBe("allow")
    expect(evaluate(architect, "shell", ["graphify query foo"])).toBe("allow")
    expect(evaluate(architect, "shell", ["grep foo"])).toBe("deny")
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
      team.apply(t, { mode: "lead" }, report("ESCALATE"), {})
      expect(t.pending.mode).toBe("architect")
      t.pending = undefined
      team.apply(t, { mode: "architect" }, report("DOC"), {})
      expect(t.phase).toBe("approval")
      expect(readFileSync(t.output, "utf8")).toContain("## Options")
      expect(render(t)).toContain("**Sections**\n- Options")
      save(t)
      await team.handle({ action: "approve" }, "ses_w", signal)
      expect(t.phase).toBe("done")
      expect(render(t)).toContain("[Implement it]")
      expect(t.history.some((h: any) => h.role === "developer")).toBe(false)

      const p = await team.handle({ action: "implement", workflow: "plan" }, "ses_w", signal)
      expect(switched).toEqual(["build-manager"])
      const code = team.task("ses_w")
      expect(code.id).not.toBe(t.id)
      expect([code.workflow, code.forcePlan]).toEqual([undefined, true])
      expect(readFileSync(path.join(code.dir, "request.md"), "utf8")).toContain(`Implement the plan in ${t.output}`)
      expect(p).toContain("Switched to build-manager")
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
      expect(p.mode).toBe("architect")
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
