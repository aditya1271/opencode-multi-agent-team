import { describe, expect, test } from "bun:test"
import { evaluate, permissionsFor, systemPrompt, toolVisible } from "../src/agents.ts"
import { buildPatterns, DEFAULTS, merge, parseModel, stripJsonc } from "../src/config.ts"
import { toolKind, trimLog } from "../src/guards.ts"
import { commandParts, matchesAny } from "../src/match.ts"
import { acceptReport, allowedStatuses, checkProblem } from "../src/report.ts"
import { beginRun, runs } from "../src/runtime.ts"
import { newTask, taskId } from "../src/state.ts"
import { add, hints, table } from "../src/usage.ts"

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
    expect(c.limits.fixerRounds).toBe(2)
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
    expect(allowedStatuses(DEFAULTS, "senior", task)).toContain("NEED_INFO")
    task.needInfo = 6
    task.questionRounds = 4
    expect(allowedStatuses(DEFAULTS, "senior", task)).toEqual(["PLAN", "ESCALATE"])
  })
  test("triage after a failed trivial attempt may only escalate", () => {
    task.trivialFailed = true
    expect(allowedStatuses(DEFAULTS, "triage", task)).toEqual(["ESCALATE"])
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
    beginRun("ses_fix", { role: "fixer", mode: "fix", task: t, toolLimit: 10 })
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
  test("polisher can only use team and question", () => {
    const rules = permissionsFor(DEFAULTS, "polisher")
    expect(rules[0]).toEqual({ action: "*", resource: "*", effect: "deny" })
    expect(rules.filter((r) => r.effect === "allow").map((r) => r.action)).toEqual(["team", "question"])
  })
  test("senior has no grep or shell", () => {
    const allowed = permissionsFor(DEFAULTS, "senior").filter((r) => r.effect === "allow").map((r) => r.action)
    expect(allowed).not.toContain("grep")
    expect(allowed).not.toContain("shell")
  })
  test("evaluate: last match wins, team rules decide", () => {
    const triage = permissionsFor(DEFAULTS, "triage")
    expect(evaluate(triage, "read", ["src/a.ts"])).toBe("allow")
    expect(evaluate(triage, "edit", ["src/a.ts"])).toBe("deny")
    expect(evaluate(triage, "shell", ["git status"])).toBe("allow")
    expect(evaluate(triage, "shell", ["make"])).toBe("deny")
    const fixer = permissionsFor(DEFAULTS, "fixer")
    expect(evaluate(fixer, "edit", ["a.ts", "b.ts"])).toBe("allow")
    expect(evaluate(fixer, "shell", ["git reset --hard"])).toBe("ask")
    expect(evaluate(permissionsFor(DEFAULTS, "polisher"), "read", ["a.ts"])).toBe("deny")
  })
  test("toolVisible", () => {
    const polisher = permissionsFor(DEFAULTS, "polisher")
    expect(["team", "question", "read", "shell", "edit"].filter((t) => toolVisible(polisher, t))).toEqual(["team", "question"])
    expect(toolVisible(permissionsFor(DEFAULTS, "triage"), "shell")).toBe(true)
    expect(toolVisible(permissionsFor(DEFAULTS, "triage"), "write")).toBe(false)
    expect(toolVisible(permissionsFor(DEFAULTS, "fixer"), "write")).toBe(true)
  })
  test("fixer asks before destructive commands", () => {
    const rules = permissionsFor(DEFAULTS, "fixer")
    expect(rules.some((r) => r.action === "shell" && r.resource === "git reset *" && r.effect === "ask")).toBe(true)
  })
  test("per-agent search tools, commands and mcps", () => {
    const config = merge(DEFAULTS, {
      agents: {
        senior: { mcps: ["codebase-memory"], tools: ["docs_search"], commands: ["graphify *"] },
        fixer: { commands: ["rm -rf *"] },
      },
    })
    const senior = permissionsFor(config, "senior")
    expect(evaluate(senior, "codebase-memory_search_graph", ["*"])).toBe("allow")
    expect(evaluate(senior, "docs_search", ["*"])).toBe("allow")
    expect(evaluate(senior, "shell", ["graphify query foo"])).toBe("allow")
    expect(evaluate(senior, "shell", ["grep foo"])).toBe("deny")
    expect(evaluate(permissionsFor(config, "fixer"), "shell", ["rm -rf /"])).toBe("ask")
    expect(toolKind("docs_search", {}, config)).toBe("index")
    expect(toolKind("shell", { command: "graphify query foo" }, config)).toBe("index")
  })
})

describe("prompts", () => {
  test("default instructions fill the core prompt", () => {
    const p = systemPrompt(DEFAULTS, "explorer")
    expect(p).toContain("You are the Explorer")
    expect(p).toContain("## How to search")
    expect(p).not.toContain("{{instructions}}")
    expect(p).not.toContain("## Your tools\n\n-")
  })
  test("instructions replace the default; append and tools are added", () => {
    const config = merge(DEFAULTS, {
      agents: { explorer: { instructions: "Use the RAG docs first.", append: "Answer in English.", tools: ["docs_search"] } },
    })
    const p = systemPrompt(config, "explorer")
    expect(p).toContain("Use the RAG docs first.")
    expect(p).not.toContain("## How to search")
    expect(p).toContain("Report **FOUND**")
    expect(p).toContain("- Tools: docs_search.")
    expect(p.trimEnd().endsWith("Answer in English.")).toBe(true)
  })
})

describe("usage", () => {
  test("table and hints", () => {
    const usage = {}
    add(usage, "polisher", { calls: 1, prompts: 3, tools: { search: 2 }, input: 12000, cacheRead: 30000, output: 1000, model: "a/b" })
    add(usage, "fixer", { calls: 2, prompts: 30, tools: { edit: 5, build: 20 }, input: 160000, cacheRead: 1200000, output: 12000, model: "c/d" })
    const t = table(usage)
    expect(t).toContain("polisher")
    expect(t).toContain("1.2M")
    expect(t.split("\n").pop()).toMatch(/^total\s+3\s+33\s+27/)
    expect(hints(usage)).toContain("polisher used 2 read/search/shell/edit calls (expected 0)")
  })
})
