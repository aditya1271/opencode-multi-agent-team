// The section-by-section review in a TUI dialog: no model turn between sections; the manager is woken once at the end.
import type { Plugin } from "@opencode/plugin/tui"
import type { ScrollBoxRenderable } from "@opentui/core"
import { createSignal, For } from "solid-js"
import { TeamStats, type ReviewDraft, type ReviewProgress, type ReviewReply } from "./rpc.ts"

type Context = Plugin.Context
const client = (context: Context) => context.client.rpc(TeamStats)
type Rpc = ReturnType<typeof client>
type CallOptions = Parameters<Rpc["stats"]>[1]
type Choice = "ok" | "skip" | "comment" | "question" | "rest" | "stop" | "pause" | "prev" | "next" | "jump"

const KEYS: { key: string; choice: Choice; title: string }[] = [
  { key: "o", choice: "ok", title: "OK" },
  { key: "s", choice: "skip", title: "Skip" },
  { key: "c", choice: "comment", title: "Comment…" },
  { key: "q", choice: "question", title: "Question…" },
  { key: "r", choice: "rest", title: "Show the rest" },
  { key: "x", choice: "stop", title: "Stop" },
]

/** Moving about: ← and → (or p and n) go to the neighbouring section, g lists them all. */
const NAV: { key: string; alt?: string; choice: Choice; title: string }[] = [
  { key: "p", alt: "left", choice: "prev", title: "← Previous" },
  { key: "n", alt: "right", choice: "next", title: "Next →" },
  { key: "g", choice: "jump", title: "Go to…" },
]

const MARK = { ok: "✓", skip: "~", comment: "✎" } as const

export function setupReview(
  context: Context,
  rpc: Rpc,
  rootOf: (sessionID: string) => string,
  rpcOptions: (sessionID: string) => CallOptions,
  color: { header: () => string; muted: () => string; accent: () => string },
) {
  const dialog = context.ui.dialog
  let active = false

  /** Shows one section; resolves with the user's choice (Esc: pause). */
  const showSection = (draft: ReviewDraft, i: number, notes: string[], marks: string) =>
    new Promise<Choice>((resolve) => {
      let settled = false
      let scroll: ScrollBoxRenderable | undefined
      const finish = (choice: Choice) => {
        if (settled) return
        settled = true
        dialog.clear()
        resolve(choice)
      }
      const s = draft.sections[i]!
      const view = (text: string) => [...notes, i === 0 && draft.intro ? draft.intro : "", text].filter(Boolean).join("\n\n")
      // The summary view by default; d switches to the full text the agents work from.
      const [full, setFull] = createSignal(!s.summary)
      dialog.show(() => {
        context.keymap.layer(() => ({
          mode: "global",
          priority: 100,
          enabled: () => !settled,
          commands: [
            ...KEYS.map((k) => ({ title: k.title, group: "Team review", bind: k.key, run: () => finish(k.choice) })),
            ...NAV.flatMap((k) =>
              [k.key, k.alt].filter(Boolean).map((bind) => ({ title: k.title, group: "Team review", bind: bind!, run: () => finish(k.choice) })),
            ),
            ...(s.summary ? [{ title: "Details", group: "Team review", bind: "d", run: () => setFull(!full()) }] : []),
            { title: "Scroll up", group: "Team review", bind: "up", run: () => scroll?.scrollBy(-1) },
            { title: "Scroll down", group: "Team review", bind: "down", run: () => scroll?.scrollBy(1) },
            { title: "Page up", group: "Team review", bind: "pageup", run: () => scroll?.scrollBy(-10) },
            { title: "Page down", group: "Team review", bind: "pagedown", run: () => scroll?.scrollBy(10) },
          ],
        }))
        return (
          <box flexDirection="column" paddingX={2} paddingY={1} gap={1}>
            <box flexDirection="column">
              <text fg={color.header()}>{`${draft.title}, ${s.id} · ${s.title}  (${i + 1} of ${draft.sections.length})`}</text>
              <text fg={color.muted()}>{marks}</text>
            </box>
            <scrollbox ref={(r: ScrollBoxRenderable) => (scroll = r)} height={Math.max(6, Math.min(30, (context.renderer.height ?? 40) - 20))} scrollY>
              <text fg={color.header()} wrapMode="word">
                {view(full() ? s.body : s.summary!).replace(/\*\*/g, "")}
              </text>
            </scrollbox>
            <box flexDirection="row" gap={2}>
              <For each={KEYS}>
                {(k) => (
                  <box
                    onMouseDown={(event: { stopPropagation(): void }) => {
                      event.stopPropagation()
                      finish(k.choice)
                    }}
                  >
                    <text fg={color.accent()}>{`[${k.key}] ${k.title}`}</text>
                  </box>
                )}
              </For>
            </box>
            <box flexDirection="row" gap={2}>
              <For each={NAV}>
                {(k) => (
                  <box
                    onMouseDown={(event: { stopPropagation(): void }) => {
                      event.stopPropagation()
                      finish(k.choice)
                    }}
                  >
                    <text fg={color.accent()}>{`[${k.key}] ${k.title}`}</text>
                  </box>
                )}
              </For>
            </box>
            <text fg={color.muted()}>{`${s.summary ? `[d] ${full() ? "Summary" : "Details"} · ` : ""}↑↓ PgUp PgDn scroll · Esc: close (progress kept)`}</text>
          </box>
        )
      }, () => finish("pause"))
      dialog.set({ size: "xlarge" })
    })

  /** Closed partway: where the user is. Ended: how, with their replies. */
  type Outcome = { progress: ReviewProgress; end?: ReviewReply["end"] }

  const walk = async (draft: ReviewDraft): Promise<Outcome> => {
    const out: ReviewProgress = structuredClone(draft.progress)
    const n = draft.sections.length
    const ended = (end: ReviewReply["end"]): Outcome => ({ progress: out, end })
    const paused = (): Outcome => ({ progress: out })
    if (draft.ask) {
      const style = await dialog.select({
        title: `${draft.title} ready: ${n} section${n > 1 ? "s" : ""} to review`,
        options: [
          { title: "One section at a time", value: "walk" },
          { title: "All at once", value: "rest", description: "The whole draft shows in the chat." },
        ],
      })
      if (!style) return paused()
      if (style !== "walk") return ended("rest")
    }
    const verdictOf = (id: string) => out.replies.find((r) => r.id === id)?.verdict ?? (out.comments.some((c) => c.id === id) ? "comment" : undefined)
    const markOf = (id: string) => {
      const v = verdictOf(id)
      return v ? MARK[v] : "·"
    }
    const marks = () => draft.sections.map((s, j) => (j === out.at ? `[${markOf(s.id)}]` : markOf(s.id))).join(" ")
    /** The answer to a section is the latest one: going back replaces it. */
    const answer = (id: string, put: () => void) => {
      out.replies = out.replies.filter((r) => r.id !== id)
      out.comments = out.comments.filter((c) => c.id !== id)
      put()
    }
    const unanswered = () => draft.sections.findIndex((s) => !verdictOf(s.id))
    const STATE = { ok: "OK", skip: "skipped", comment: "your comment" }
    const jump = async () => {
      const picked = await dialog.select({
        title: "Go to section",
        options: draft.sections.map((s, j) => ({ title: `${j + 1}. ${s.title}`, value: j, description: STATE[verdictOf(s.id) as keyof typeof STATE] ?? "not answered yet" })),
        current: Math.min(out.at, n - 1),
      })
      if (picked !== undefined) out.at = picked
    }
    const plural = (k: number, word: string) => `${k} ${word}${k === 1 ? "" : "s"}`
    for (;;) {
      if (out.at >= n) {
        const open = unanswered()
        if (open >= 0) {
          out.at = open
          continue
        }
        const said = out.comments.length || out.questions.length
        const last = await dialog.select({
          title: `All ${plural(n, "section")} reviewed, ${said ? [plural(out.comments.length, "comment"), out.questions.length ? plural(out.questions.length, "question") : ""].filter(Boolean).join(", ") : "no comments"}`,
          options: [
            said ? { title: "Send to the team", value: "done" as const } : { title: "Approve", value: "approve" as const },
            { title: "Go back to a section…", value: "back" as const },
            { title: "Show it all at once", value: "rest" as const, description: "The whole draft shows in the chat." },
          ],
        })
        if (!last) return paused()
        if (last === "back") {
          await jump()
          if (out.at >= n) out.at = n - 1
          continue
        }
        return ended(last)
      }
      const s = draft.sections[out.at]!
      const notes = [
        ...out.questions.filter((q) => q.id === s.id).map((q) => `(Your question, answered at the end: ${q.text})`),
        ...out.comments.filter((c) => c.id === s.id).map((c) => `(Your comment: ${c.text})`),
      ]
      const choice = await showSection(draft, out.at, notes, marks())
      if (choice === "pause") return paused()
      if (choice === "rest" || choice === "stop") return ended(choice)
      if (choice === "prev") out.at = Math.max(0, out.at - 1)
      else if (choice === "next") out.at++
      else if (choice === "jump") await jump()
      else if (choice === "ok" || choice === "skip") {
        answer(s.id, () => out.replies.push({ id: s.id, verdict: choice }))
        out.at++
      } else {
        const before = out.comments.find((c) => c.id === s.id)?.text
        const text = await dialog.prompt(
          choice === "comment"
            ? { title: `Comment on ${s.id} · ${s.title}`, description: "What should change? State the exact edit, or what is wrong. It is polished and confirmed at the end.", ...(before && { value: before }) }
            : { title: `Question on ${s.id} · ${s.title}`, description: "Answered at the end, before your comments go to the team." },
        )
        if (!text?.trim()) continue
        if (choice === "comment") {
          answer(s.id, () => out.comments.push({ id: s.id, text: text.trim() }))
          out.at++
        } else out.questions.push({ id: s.id, text: text.trim() })
      }
    }
  }

  /** Opens the waiting review: on its own (only in a TUI showing the session), or from the sidebar or /team-review. */
  const open = async (sessionID: string, byUser = false) => {
    if (active) return
    const route = context.ui.router.current()
    if (!byUser && (route.type !== "session" || rootOf(route.sessionID) !== sessionID)) return
    active = true
    try {
      const claimed = (await rpc.reviewClaim({ sessionID, force: byUser }, rpcOptions(sessionID))) as { draft?: ReviewDraft }
      const draft = claimed.draft
      if (!draft) {
        if (byUser) context.ui.toast.show({ message: "No team review waits in this session.", variant: "info" })
        return
      }
      const { progress, end } = await walk(draft)
      const sent = (
        end
          ? await rpc.reviewDone({ sessionID, key: draft.key, end, replies: progress.replies, comments: progress.comments, questions: progress.questions }, rpcOptions(sessionID))
          : await rpc.reviewSave({ sessionID, key: draft.key, progress }, rpcOptions(sessionID))
      ) as { ok: boolean }
      if (!sent.ok) context.ui.toast.show({ message: "The draft changed meanwhile; your review replies were not kept.", variant: "warning" })
      else if (!end) context.ui.toast.show({ message: `Review paused at ${Math.min(progress.at + 1, draft.sections.length)} of ${draft.sections.length}. Reopen: Review in the Team sidebar, or /team-review.`, variant: "info" })
    } catch (e) {
      context.ui.toast.show({ message: `Team review dialog: ${(e as Error)?.message ?? String(e)}`, variant: "error" })
    } finally {
      active = false
    }
  }

  const currentRoot = () => {
    const route = context.ui.router.current()
    return route.type === "session" ? rootOf(route.sessionID) : undefined
  }

  context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "multi-agent-team.review",
        title: "Team: open the waiting review",
        group: "Team",
        palette: true,
        slash: { name: "team-review" },
        enabled: () => currentRoot() !== undefined,
        run: () => {
          const sessionID = currentRoot()
          if (sessionID) void open(sessionID, true)
        },
      },
    ],
  }))

  const stop = rpc.events.on("review", (event) => void open(String(event.data.sessionID)))
  return { open: (sessionID: string) => open(sessionID, true), stop }
}
