import { ArrowUp, Bot, Wand2 } from "lucide-react"
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react"
import { toast } from "sonner"
import { Markdown } from "@/components/markdown"
import { SimpleSelect } from "@/components/simple-select"
import { CommentButton, composeMessage, NoteList, OwnerText, useSelectionIn, type SpecNote } from "@/components/spec-comments"
import { Button } from "@/components/ui/button"
import { Card, CardHeader, CardTitle } from "@/components/ui/card"
import { Textarea } from "@/components/ui/textarea"
import type { Model } from "@/lib/api"
import { cn } from "@/lib/utils"

export interface ChatMessage {
  id: number
  role: "owner" | "planner" | "agent" | "system" | "standin"
  text: string
}

/** Comments collected by selecting text in a document (`docRef`), sent with the next chat message. */
export function useDocComments(docRef: RefObject<HTMLElement | null>, enabled = true) {
  const [notes, setNotes] = useState<SpecNote[]>([])
  const next = useRef(1)
  const [selection, clearSelection] = useSelectionIn(docRef)
  const add = () => {
    if (!selection) return
    setNotes((ns) => [...ns, { id: next.current++, quote: selection.text, source: selection.source, comment: "" }])
    document.getSelection()?.removeAllRanges()
    clearSelection()
  }
  const button = selection && enabled ? <CommentButton sel={selection} onComment={add} /> : null
  return { notes, setNotes, button }
}

/** A conversation with one agent: messages, attached comments, composer. */
export function ChatPanel({ title, model, onModel, modelLocked, messages, thinking, thinkingText, status, emptyHint, closed, notes, setNotes, onSend, headerExtra, className }: {
  title: string
  model?: Model
  onModel?: (m: Model) => void
  modelLocked?: boolean
  messages: ChatMessage[]
  thinking: boolean
  thinkingText?: string
  status?: ReactNode
  emptyHint: string
  /** No more messages (e.g. an executed plan). */
  closed?: boolean
  notes: SpecNote[]
  setNotes: (f: (ns: SpecNote[]) => SpecNote[]) => void
  onSend: (text: string) => Promise<void>
  headerExtra?: ReactNode
  className?: string
}) {
  const [text, setText] = useState("")
  const [sending, setSending] = useState(false)
  const chat = useRef<HTMLDivElement>(null)
  useEffect(() => {
    chat.current?.scrollTo({ top: chat.current.scrollHeight, behavior: "smooth" })
  }, [messages.length, thinking])

  const message = composeMessage(notes, text)
  const send = async () => {
    if (!message) return
    setSending(true)
    try {
      await onSend(message)
      setText("")
      setNotes(() => [])
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSending(false)
    }
  }

  return (
    <Card className={cn("flex max-h-[calc(100dvh-11rem)] min-h-[28rem] flex-col", className)}>
      <CardHeader className="flex flex-row items-center gap-2 border-b">
        <span className="bg-hero inline-flex size-7 items-center justify-center rounded-full text-white"><Bot className="size-3.5" /></span>
        <CardTitle className="text-sm">{title}</CardTitle>
        {headerExtra}
        {model && onModel && (
          <div className="ml-auto">
            <SimpleSelect<Model> ariaLabel={`${title} model`} value={model} onChange={onModel} disabled={modelLocked} className="h-8"
              options={[{ value: "opus", label: "Opus" }, { value: "sonnet", label: "Sonnet" }]} />
          </div>
        )}
      </CardHeader>
      <div ref={chat} className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {messages.length === 0 && !thinking && <p className="text-sm text-muted-foreground">{emptyHint}</p>}
        {messages.map((m) => (
          <div key={m.id} className={cn("flex", m.role === "owner" ? "justify-end" : m.role === "system" ? "justify-center" : "justify-start")}>
            {m.role === "standin" ? (
              <div className="max-w-[85%] rounded-3xl rounded-br-lg border border-dashed border-primary/40 bg-primary/6 px-4 py-2.5 text-sm">
                <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-primary"><Wand2 className="size-3.5" /> Answered for you</p>
                <OwnerText text={m.text} />
              </div>
            ) : m.role === "owner" ? (
              <div className="bg-accent-gradient max-w-[85%] rounded-3xl rounded-br-lg px-4 py-2.5 text-sm text-white shadow-[0_8px_20px_-12px_var(--primary)]"><OwnerText text={m.text} /></div>
            ) : m.role === "system" ? (
              <p className="max-w-[90%] rounded-full bg-muted/60 px-3 py-1 text-center text-xs text-muted-foreground">{m.text}</p>
            ) : (
              <div className="flex max-w-[92%] items-end gap-2">
                <span className="bg-hero mb-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-full text-white"><Bot className="size-3.5" /></span>
                <div className="rounded-3xl rounded-bl-lg bg-muted px-4 py-2.5"><Markdown text={m.text} /></div>
              </div>
            )}
          </div>
        ))}
        {thinking && <p className="animate-pulse text-xs text-muted-foreground">{thinkingText ?? "Thinking… usually 1–3 minutes."}</p>}
        {status}
      </div>
      {!closed && (
        <div className="border-t p-3">
          <NoteList
            notes={notes}
            disabled={sending}
            onChange={(id, comment) => setNotes((ns) => ns.map((n) => (n.id === id ? { ...n, comment } : n)))}
            onRemove={(id) => setNotes((ns) => ns.filter((n) => n.id !== id))}
          />
          <div className="relative">
            <Textarea
              value={text}
              onChange={(ev) => setText(ev.target.value)}
              onKeyDown={(ev) => {
                if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) void send()
              }}
              disabled={thinking}
              placeholder={thinking ? "Waiting for the agent…" : notes.length ? "Anything else? (optional, ⌘↵ to send)" : "Reply (⌘↵ to send)"}
              className="min-h-20 pr-12"
            />
            <Button size="icon-sm" className="absolute right-2 bottom-2" aria-label="Send" disabled={thinking || sending || !message} onClick={send}>
              <ArrowUp />
            </Button>
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground">
            {notes.some((n) => !n.comment.trim()) ? "Comments without text aren't sent. " : ""}
            {model ? `Each message is one ${model === "opus" ? "Opus" : "Sonnet"} run on your subscription` : "Each message is one run on your subscription"}
            {notes.length > 1 ? `; your ${notes.length} comments go in one` : ""}. Select text in the document to comment on it.
          </p>
        </div>
      )}
    </Card>
  )
}
