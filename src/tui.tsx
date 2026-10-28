import { Plugin } from "@opencode/plugin/tui"
import { For, Show, createEffect, createSignal, on, onCleanup } from "solid-js"
import { compact, line, TeamStats, type SidebarStats, type StatsRow } from "./rpc.ts"

interface Prefs {
  expanded: boolean
}

/** While an agent is running, re-read its live token counts this often. */
const LIVE_POLL_MS = 3000

const resolveColor = (theme: unknown, tokenPath: string, fallback: string) => {
  const value = tokenPath.split(".").reduce<any>((acc, key) => acc?.[key], theme)
  return value ?? fallback
}

const tokensOf = (r: StatsRow) => r.input + r.cacheRead + r.output

export default Plugin.define({
  id: "multi-agent-team.tui",
  setup(context) {
    const rpc = context.client.rpc(TeamStats)
    const [prefs, setPrefs] = context.storage.store<Prefs>("prefs", { initial: { expanded: true } })

    const color = {
      header: () => resolveColor(context.theme, "text.base", "#eeffff"),
      muted: () => resolveColor(context.theme, "text.muted", "#546e7a"),
      running: () => resolveColor(context.theme, "text.feedback.success.base", "#c3e88d"),
      warning: () => resolveColor(context.theme, "text.feedback.warning.base", "#ffcb6b"),
    }

    const rootOf = (sessionID: string) => context.data.session.root(sessionID) ?? sessionID
    const rpcOptions = (sessionID: string) => {
      const directory = context.data.session.get(sessionID)?.location?.directory
      return directory ? { location: { directory } } : undefined
    }

    function TeamSection(props: { sessionID: string }) {
      const [stats, setStats] = createSignal<SidebarStats | undefined>()
      const [error, setError] = createSignal<string | undefined>()
      let seq = 0
      let timer: ReturnType<typeof setTimeout> | undefined

      // Child sessions (developer, lead, ...) show their manager's numbers.
      const root = () => rootOf(props.sessionID)
      const refresh = () => {
        clearTimeout(timer)
        timer = setTimeout(async () => {
          const mine = ++seq
          try {
            const next = (await rpc.stats({ sessionID: root() }, rpcOptions(root()))) as SidebarStats
            if (mine === seq) {
              setStats(next)
              setError(undefined)
            }
          } catch (e) {
            // Keep the last numbers if the server is briefly unavailable; say why when there are none.
            if (mine === seq) setError(e instanceof Error ? e.message : String(e))
          }
        }, 150)
      }

      createEffect(
        on(root, () => {
          setStats(undefined)
          refresh()
        }),
      )
      createEffect(() => {
        if (!stats()?.task?.rows.some((r) => r.running)) return
        const poll = setInterval(refresh, LIVE_POLL_MS)
        onCleanup(() => clearInterval(poll))
      })
      const stopChanged = rpc.events.on("changed", (event) => {
        if (event.data.sessionID === root()) refresh()
      })
      const stopTurn = context.data.on("session.execution.succeeded", () => refresh())
      onCleanup(() => {
        clearTimeout(timer)
        stopChanged()
        stopTurn()
      })

      const rows = () => stats()?.task?.rows ?? []
      const taskTokens = () => rows().reduce((n, r) => n + tokensOf(r), 0)
      const pct = (r: StatsRow) => (taskTokens() ? `${Math.round((tokensOf(r) / taskTokens()) * 100)}%` : "-")
      const sum = (key: "calls" | "prompts" | "tools") => rows().reduce((n, r) => n + r[key], 0)
      const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`
      const status = () => {
        const s = stats()
        if (!s) return error() ? `· error: ${error()}` : "· loading"
        return s.session.tasks || s.session.questions ? "· no open task" : "· no task yet"
      }

      return (
        <box flexDirection="column" paddingX={1} paddingY={1}>
          <box
            flexDirection="row"
            onMouseDown={(event: { stopPropagation(): void }) => {
              event.stopPropagation()
              void setPrefs((d) => void (d.expanded = !d.expanded)).catch(() => {})
            }}
          >
            <text fg={color.header()}>{`${prefs.expanded ? "▼" : "▶"} Team `}</text>
            <Show when={stats()?.task} fallback={<text fg={error() ? color.warning() : color.muted()}>{status()}</text>}>
              {(task: () => NonNullable<SidebarStats["task"]>) => (
                <>
                  <text fg={color.muted()}>{`${task().phase} · `}</text>
                  <text fg={task().attempts >= task().attemptLimit ? color.warning() : color.muted()}>
                    {`${task().attempts}/${task().attemptLimit} attempts`}
                  </text>
                </>
              )}
            </Show>
          </box>
          <Show when={prefs.expanded}>
            <Show when={rows().length > 0}>
              <text fg={color.muted()}>{line(" ", "agent", "call", "prmt", "tool", "tok", "%")}</text>
              <For each={rows()}>
                {(r) => (
                  <text fg={r.running ? color.running() : color.header()}>
                    {line(r.running ? "●" : " ", r.role, r.calls, r.prompts, r.tools, compact(tokensOf(r)), pct(r))}
                  </text>
                )}
              </For>
              <text fg={color.muted()}>
                {line(" ", "task", sum("calls"), sum("prompts"), sum("tools"), compact(taskTokens()), "")}
              </text>
            </Show>
            <Show when={stats()?.session.tasks || stats()?.session.questions ? stats() : undefined}>
              {(s: () => SidebarStats) => (
                <>
                  <text fg={color.muted()}>
                    {line(" ", "session", s().session.total.calls, s().session.total.prompts, s().session.total.tools, compact(s().session.total.tokens), "")}
                  </text>
                  <text fg={color.muted()}>
                    {`  ${plural(s().session.tasks, "task")} · ${plural(s().session.questions, "question")}`}
                  </text>
                </>
              )}
            </Show>
          </Show>
        </box>
      )
    }

    // Built-in sections (Context, Limit, MCP, Todo) are appended first; at the bottom the section can end up off screen.
    return context.ui.slot({ prepend: "sidebar.content", render: (input: { sessionID: string }) => <TeamSection sessionID={input.sessionID} /> })
  },
})
