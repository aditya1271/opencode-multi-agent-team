// The section-by-section review in a TUI dialog: no model turn between sections; the manager is woken once at the end.
import type { Plugin } from "@opencode/plugin/tui"
import type { ScrollBoxRenderable } from "@opentui/core"
import { For } from "solid-js"
import { TeamStats, type ReviewDraft, type ReviewReply } from "./rpc.ts"

type Context = Plugin.Context
const client = (context: Context) => context.client.rpc(TeamStats)
type Rpc = ReturnType<typeof client>
type CallOptions = Parameters<Rpc["stats"]>[1]
type Choice = "ok" | "skip" | "comment" | "question" | "rest" | "stop"

const KEYS: { key: string; choice: Choice; title: string }[] = [
  { key: "o", choice: "ok", title: "OK" },
  { key: "s", choice: "skip", title: "Skip" },
  { key: "c", choice: "comment", title: "Comment…" },
  { key: "q", choice: "question", title: "Question…" },
  { key: "r", choice: "rest", title: "Show the rest" },
  { key: "x", choice: "stop", title: "Stop" },
]

export function setupReview(
  context: Context,
  rpc: Rpc,
  rootOf: (sessionID: string) => string,
  rpcOptions: (sessionID: string) => CallOptions,
  color: { header: () => string; muted: () => string; accent: () => string },
) {
  const dialog = context.ui.dialog
  let active = false

  /** Shows one section; resolves with the user's choice (Esc: show the rest). */
  const showSection = (draft: ReviewDraft, i: number, notes: string[]) =>
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
      const body = [...notes, i === 0 && draft.intro ? draft.intro : "", s.body].filter(Boolean).join("\n\n")
      dialog.show(() => {
        context.keymap.layer(() => ({
          mode: "global",
          priority: 100,
          enabled: () => !settled,
          commands: [
            ...KEYS.map((k) => ({ title: k.title, group: "Team review", bind: k.key, run: () => finish(k.choice) })),
            { title: "Scroll up", group: "Team review", bind: "up", run: () => scroll?.scrollBy(-1) },
            { title: "Scroll down", group: "Team review", bind: "down", run: () => scroll?.scrollBy(1) },
            { title: "Page up", group: "Team review", bind: "pageup", run: () => scroll?.scrollBy(-10) },
            { title: "Page down", group: "Team review", bind: "pagedown", run: () => scroll?.scrollBy(10) },
          ],
        }))
        return (
          <box flexDirection="column" paddingX={2} paddingY={1} gap={1}>
            <text fg={color.header()}>{`${draft.title}, ${s.id} · ${s.title}  (${i + 1} of ${draft.sections.length})`}</text>
            <scrollbox ref={(r: ScrollBoxRenderable) => (scroll = r)} height={Math.max(6, Math.min(30, (context.renderer.height ?? 40) - 20))} scrollY>
              <text fg={color.header()} wrapMode="word">
                {body}
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
            <text fg={color.muted()}>↑↓ PgUp PgDn scroll · Esc: show the rest</text>
          </box>
        )
      }, () => finish("rest"))
      dialog.set({ size: "xlarge" })
    })

  const walk = async (sessionID: string, draft: ReviewDraft): Promise<Omit<ReviewReply, "sessionID" | "key">> => {
    const out: Omit<ReviewReply, "sessionID" | "key"> = { end: "done", replies: [], comments: [], questions: [] }
    const n = draft.sections.length
    if (draft.ask) {
      const style = await dialog.select({
        title: `${draft.title} ready: ${n} section${n > 1 ? "s" : ""} to review`,
        options: [
          { title: "One section at a time", value: "walk" },
          { title: "All at once", value: "rest", description: "The whole draft shows in the chat." },
        ],
      })
      if (style !== "walk") return { ...out, end: "rest" }
    }
    for (let i = 0; i < n; ) {
      const s = draft.sections[i]!
      const notes = [
        ...out.questions.filter((q) => q.id === s.id).map((q) => `(Your question, answered at the end: ${q.text})`),
      ]
      const choice = await showSection(draft, i, notes)
      if (choice === "rest" || choice === "stop") return { ...out, end: choice }
      if (choice === "ok" || choice === "skip") {
        out.replies.push({ id: s.id, verdict: choice })
        i++
        continue
      }
      const text = await dialog.prompt(
        choice === "comment"
          ? { title: `Comment on ${s.id} · ${s.title}`, description: "What should change? State the exact edit, or what's wrong. It is polished and confirmed at the end." }
          : { title: `Question on ${s.id} · ${s.title}`, description: "Answered at the end, before your comments go to the team." },
      )
      if (!text?.trim()) continue
      if (choice === "comment") {
        out.comments.push({ id: s.id, text: text.trim() })
        i++
      } else out.questions.push({ id: s.id, text: text.trim() })
    }
    if (out.comments.length || out.questions.length) return out
    const last = await dialog.select({
      title: `All ${n} section${n > 1 ? "s" : ""} reviewed, no comments`,
      options: [
        { title: "Approve", value: "approve" as const },
        { title: "Show it all at once", value: "rest" as const, description: "The whole draft shows in the chat." },
      ],
    })
    return { ...out, end: last ?? "rest" }
  }

  const open = async (sessionID: string) => {
    if (active) return
    const route = context.ui.router.current()
    if (route.type !== "session" || rootOf(route.sessionID) !== sessionID) return
    active = true
    try {
      const claimed = (await rpc.reviewClaim({ sessionID }, rpcOptions(sessionID))) as { draft?: ReviewDraft }
      const draft = claimed.draft
      if (!draft) return
      const result = await walk(sessionID, draft)
      const sent = (await rpc.reviewDone({ sessionID, key: draft.key, ...result }, rpcOptions(sessionID))) as { ok: boolean }
      if (!sent.ok) context.ui.toast.show({ message: "The review dialog's draft changed meanwhile; replies not sent.", variant: "warning" })
    } catch (e) {
      context.ui.toast.show({ message: `Team review dialog: ${(e as Error)?.message ?? String(e)}`, variant: "error" })
    } finally {
      active = false
    }
  }

  return rpc.events.on("review", (event) => void open(String(event.data.sessionID)))
}

