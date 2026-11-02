import { describe, expect, test } from "bun:test"
import { fillProblems, layoutProblems, outline, renderDoc, type Block, type FillMap } from "../src/blocks.ts"
import { DEFAULTS } from "../src/config.ts"
import { acceptReport, blocksActive, reportSchema } from "../src/report.ts"
import { beginRun, runs } from "../src/runtime.ts"
import { indexOf, split, unrecommended, userView, walkIds } from "../src/sections.ts"
import { newTask } from "../src/state.ts"

const layout: Block[] = [
  {
    kind: "group",
    title: "What the user gets",
    intent: "the result",
    children: [
      { kind: "note", title: "The result", intent: "what changes for the user" },
      { kind: "process", title: "How it behaves", intent: "what happens from the first key to the end" },
    ],
  },
  {
    kind: "group",
    title: "Decisions",
    intent: "what the team picked",
    children: [{ kind: "choice", title: "Where the name shows", intent: "everywhere, recommended" }],
  },
]

const fill: FillMap = {
  "1": { in_short: "The user renames a task and sees the new name wherever the task is listed." },
  "1.1": {
    in_short: "A task gets a name the user chose, shown in place of the generated one.",
    details: "The user types a name while reading. From then on the task is listed under that name everywhere.",
    chose: ["The name is a label only."],
    risk: "Two tasks may get the same name.",
  },
  "1.2": {
    in_short: "The user presses a key, types a name and confirms, and the name replaces the old one.",
    steps: ["The user presses the rename key.", "The user types a name and confirms."],
  },
  "2": { in_short: "One decision is open: where the new name is shown to the user." },
  "2.1": {
    in_short: "The name can show in every list or only in the sidebar of the open task.",
    options: [
      { name: "Everywhere", tradeoff: "Consistent, but touches every list." },
      { name: "Sidebar only", tradeoff: "Small, but the name is missing elsewhere." },
    ],
    recommended: "Everywhere",
    why: "The user finds the task by one name.",
  },
}

describe("blocks: checks", () => {
  test("a good layout and fill pass", () => {
    expect(layoutProblems(layout)).toEqual([])
    expect(fillProblems(layout, fill)).toEqual([])
  })
  test("layout: top level holds groups, steps and code are refused, groups need children", () => {
    const bad = [
      { kind: "note", title: "Loose", intent: "x" },
      { kind: "group", title: "Change plan", intent: "x", children: [{ kind: "note", title: "Edit src/a.ts", intent: "x" }] },
      { kind: "group", title: "Empty", intent: "x" },
    ]
    const out = layoutProblems(bad).join("\n")
    expect(out).toContain("1 \"Loose\": the top level holds groups")
    expect(out).toContain("steps and change plans belong to the how stage")
    expect(out).toContain("names code")
    expect(out).toContain("3 \"Empty\": a group holds blocks")
    expect(layoutProblems("x")).toHaveLength(1)
  })
  test("fill: missing, wrong recommended, short in_short and unknown paths are named by path", () => {
    const f: FillMap = {
      ...fill,
      "1.2": { in_short: "Too short", steps: ["one"] },
      "2.1": { ...fill["2.1"]!, recommended: "Nowhere" },
      "9": { in_short: "x" },
    }
    delete f["1.1"]
    const out = fillProblems(layout, f)
    expect(out.some((l) => l.startsWith("1.1 ") && l.includes("missing"))).toBe(true)
    expect(out.some((l) => l.startsWith("1.2 ") && l.includes("words"))).toBe(true)
    expect(out.some((l) => l.startsWith("1.2 ") && l.includes("at least 2"))).toBe(true)
    expect(out.some((l) => l.startsWith("2.1 ") && l.includes("not the name of one option"))).toBe(true)
    expect(out.some((l) => l.startsWith("9:"))).toBe(true)
  })
  test("fill: code names are refused", () => {
    const f = { ...fill, "1.1": { ...fill["1.1"]!, details: "The name is kept in task.json and read by renameTask()." } }
    expect(fillProblems(layout, f).join("\n")).toContain("names code")
  })
  test("outline lists every block by path", () => {
    expect(outline(layout).split("\n").map((l) => l.split(" ")[0])).toEqual(["1", "1.1", "1.2", "2", "2.1"])
  })
})

describe("blocks: rendering", () => {
  const md = renderDoc("Rename", layout, fill)
  test("top-level groups are reviewed sections; a group of only choices decides", () => {
    const idx = indexOf(md, "doc:0")
    expect(walkIds(md, idx)).toHaveLength(2)
    expect(unrecommended(md)).toEqual([])
    const [a, b] = split(md).sections.filter((s) => /^##\s/.test(s.title) || s.title.startsWith("1.") || s.title.startsWith("2."))
    expect(a!.kind).not.toBe("decide")
    expect(b!.kind).toBe("decide")
    expect(userView(a!)).toContain("**Summary:**")
    expect(userView(a!)).toContain("Two tasks may get the same name.")
    expect(userView(a!)).toContain("The name is a label only.")
  })
  test("details keep the steps and the recommended line", () => {
    expect(md).toContain("1. The user presses the rename key.")
    expect(md).toContain("**Recommended:** Everywhere: The user finds the task by one name.")
  })
})

describe("blocks: the two-call report", () => {
  const config = { ...DEFAULTS, workflows: { ...DEFAULTS.workflows, plan: { ...DEFAULTS.workflows.plan, blocks: true } } }
  const task = newTask("/tmp/opencode/omat-test", "ses_b", "/tmp", "Goal\nrename", 40)
  task.workflow = "plan"
  task.stage = "what"
  const call = (input: object) => {
    if (!runs.get("ses_bk")) beginRun("ses_bk", { role: "planner", mode: "planner", task, toolLimit: 10 } as any)
    return acceptReport(config, "ses_bk", { status: "DOC", summary: "Approving this settles the rename.", ...input } as any)
  }

  test("active only for the Planner's what-document, and only when configured", () => {
    expect(blocksActive(config, "planner", task)).toBe(true)
    expect(blocksActive(DEFAULTS, "planner", task)).toBe(false)
    expect(blocksActive(config, "analyst", task)).toBe(false)
    expect(blocksActive(config, "planner", { ...task, workflow: "research" })).toBe(false)
    expect(blocksActive(config, "planner", { ...task, stage: "how" })).toBe(false)
    const props = (reportSchema("planner", ["DOC"], task, true) as any).properties
    expect(props.layout && props.fill && props.title).toBeTruthy()
    expect((reportSchema("planner", ["DOC"], task, false) as any).properties.layout).toBeUndefined()
  })

  test("layout accepted, fill asked for, refused fill kept, partial fill finishes it", () => {
    try {
      expect(() => call({ layout: [{ kind: "note", title: "Loose", intent: "x" }] })).toThrow("The layout is not accepted")
      const asked = call({ title: "Rename", layout })
      expect(typeof asked).toBe("string")
      expect(asked).toContain("1.2 process")
      expect(runs.get("ses_bk")!.report).toBeUndefined()
      const wrong = { ...fill, "2.1": { ...fill["2.1"]!, recommended: "Nowhere" } }
      expect(() => call({ fill: wrong })).toThrow("only the blocks below")
      try {
        call({ fill: wrong })
      } catch (e) {
        const msg = (e as Error).message
        expect(msg).toContain("2.1")
        expect(msg).not.toContain("1.2 ")
      }
      call({ fill: { "2.1": fill["2.1"] } })
      const r = runs.get("ses_bk")!.report!
      expect(r.content).toContain("# Rename")
      expect(r.content).toContain("## 2. Decisions")
      expect(r.blocks!.layout).toEqual(layout)
      expect(r.layout).toBeUndefined()
      expect(r.fill).toBeUndefined()
    } finally {
      runs.delete("ses_bk")
    }
  })

  test("a fill before a layout is refused", () => {
    try {
      expect(() => call({ fill })).toThrow("Send `layout` first")
    } finally {
      runs.delete("ses_bk")
    }
  })
})
