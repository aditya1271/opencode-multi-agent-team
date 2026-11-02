// The polished text the user confirms in a TUI dialog: the front agent's call waits for the choice, no model turn is spent on it.
import type { Plugin } from "@opencode/plugin/tui"
import type { ScrollBoxRenderable } from "@opentui/core"
import { For, Show } from "solid-js"
import { TeamStats } from "./rpc.ts"

type Context = Plugin.Context
const client = (context: Context) => context.client.rpc(TeamStats)
type Rpc = ReturnType<typeof client>
type CallOptions = Parameters<Rpc["stats"]>[1]
type Choice = "send" | "edit" | "cancel"
type Offer = { id: number; title: string; text: string; original?: string }

const KEYS: { key: string; choice: Choice; title: string }[] = [
  { key: "s", choice: "send", title: "Send" },
  { key: "e", choice: "edit", title: "Edit…" },
  { key: "c", choice: "cancel", title: "Cancel" },
]

export function setupConfirm(
  context: Context,
  rpc: Rpc,
  rootOf: (sessionID: string) => string,
  rpcOptions: (sessionID: string) => CallOptions,
  color: { header: () => string; muted: () => string; accent: () => string },
) {
  const dialog = context.ui.dialog
  /** The session whose dialog is open, so a stopped run can close it. */
  let open: { sessionID: string; close: () => void } | undefined

  const show = (offer: Offer, sessionID: string) =>
    new Promise<Choice>((resolve) => {
      let settled = false
      let scroll: ScrollBoxRenderable | undefined
      const finish = (choice: Choice) => {
        if (settled) return
        settled = true
        open = undefined
        dialog.clear()
        resolve(choice)
      }
      open = { sessionID, close: () => finish("cancel") }
      dialog.show(
        () => {
          context.keymap.layer(() => ({
            mode: "global",
            priority: 100,
            enabled: () => !settled,
            commands: [
              ...KEYS.map((k) => ({ title: k.title, group: "Team confirm", bind: k.key, run: () => finish(k.choice) })),
              { title: "Send", group: "Team confirm", bind: "return", run: () => finish("send") },
              { title: "Scroll up", group: "Team confirm", bind: "up", run: () => scroll?.scrollBy(-1) },
              { title: "Scroll down", group: "Team confirm", bind: "down", run: () => scroll?.scrollBy(1) },
            ],
          }))
          return (
            <box flexDirection="column" paddingX={2} paddingY={1} gap={1}>
              <text fg={color.header()}>{offer.title}</text>
              <scrollbox ref={(r: ScrollBoxRenderable) => (scroll = r)} height={Math.max(4, Math.min(18, (context.renderer.height ?? 40) - 16))} scrollY>
                <text fg={color.header()} wrapMode="word">
                  {offer.text}
                </text>
              </scrollbox>
              <Show when={offer.original}>
                <text fg={color.muted()} wrapMode="word">{`Your words: ${offer.original}`}</text>
              </Show>
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
              <text fg={color.muted()}>Enter: send · Esc: cancel</text>
            </box>
          )
        },
        () => finish("cancel"),
      )
      dialog.set({ size: "large" })
    })

  const ask = async (sessionID: string) => {
    if (open) return
    const route = context.ui.router.current()
    if (route.type !== "session" || rootOf(route.sessionID) !== sessionID) return
    try {
      const claimed = (await rpc.confirmClaim({ sessionID }, rpcOptions(sessionID))) as { offer?: Offer }
      const offer = claimed.offer
      if (!offer) return
      let text: string | undefined
      let choice = await show(offer, sessionID)
      if (choice === "edit") {
        text = await dialog.prompt({ title: "Edit, then Enter to send", value: offer.text })
        choice = text?.trim() ? "send" : "cancel"
      }
      await rpc.confirmDone({ sessionID, id: offer.id, send: choice === "send", ...(text?.trim() && { text }) }, rpcOptions(sessionID))
    } catch (e) {
      context.ui.toast.show({ message: `Team confirm dialog: ${(e as Error)?.message ?? String(e)}`, variant: "error" })
    }
  }

  const stopOffer = rpc.events.on("confirm", (event) => void ask(String(event.data.sessionID)))
  const stopWithdraw = rpc.events.on("unconfirm", (event) => {
    if (open?.sessionID === String(event.data.sessionID)) open.close()
  })
  return {
    stop: () => {
      stopOffer()
      stopWithdraw()
    },
  }
}
