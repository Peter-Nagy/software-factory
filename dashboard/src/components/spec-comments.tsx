import { MessageSquareQuote, X } from "lucide-react"
import { useEffect, useState, type RefObject } from "react"
import { createPortal } from "react-dom"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"

/**
 * Commenting on the plan like replying to a passage: select text in the spec or an issue, press Comment, and the
 * quote is attached to the composer with its own comment. All attached comments go to the planner in one turn.
 * Sources are marked in the DOM with data-comment-source ("spec" or "issue:<title>").
 */
export interface SpecNote {
  id: number
  quote: string
  source: string
  comment: string
}

export interface TextSelection {
  text: string
  source: string
  x: number // viewport, center of the selection
  y: number // viewport, bottom of the selection
}

/** The current text selection, if it lies inside `ref`. Follows scrolling so the button stays under it. */
export function useSelectionIn(ref: RefObject<HTMLElement | null>): [TextSelection | null, () => void] {
  const [sel, setSel] = useState<TextSelection | null>(null)
  useEffect(() => {
    const read = () => {
      const s = document.getSelection()
      const root = ref.current
      if (!s || s.isCollapsed || !s.rangeCount || !root) return setSel(null)
      const range = s.getRangeAt(0)
      if (!root.contains(range.commonAncestorContainer)) return setSel(null)
      const text = s.toString().replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim()
      if (!text) return setSel(null)
      const start = range.startContainer
      const el = start.nodeType === Node.ELEMENT_NODE ? (start as Element) : start.parentElement
      const source = el?.closest("[data-comment-source]")?.getAttribute("data-comment-source") ?? "spec"
      const rects = range.getClientRects()
      const last = rects[rects.length - 1] ?? range.getBoundingClientRect()
      if (last.bottom < 0 || last.top > window.innerHeight) return setSel(null) // scrolled out of view
      setSel({ text, source, x: last.left + last.width / 2, y: last.bottom })
    }
    document.addEventListener("selectionchange", read)
    window.addEventListener("scroll", read, true)
    window.addEventListener("resize", read)
    return () => {
      document.removeEventListener("selectionchange", read)
      window.removeEventListener("scroll", read, true)
      window.removeEventListener("resize", read)
    }
  }, [ref])
  return [sel, () => setSel(null)]
}

/** Floating "Comment" button under the selection (below it, so it never fights the phone's own selection menu). */
export function CommentButton({ sel, onComment }: { sel: TextSelection; onComment: () => void }) {
  const left = Math.min(Math.max(sel.x, 60), window.innerWidth - 60)
  return createPortal(
    <div className="fixed z-50 -translate-x-1/2" style={{ left, top: Math.min(sel.y + 8, window.innerHeight - 44) }}>
      <Button
        size="sm"
        className="shadow-lg"
        // keep the selection alive while pressing (mouse and touch)
        onPointerDown={(e) => e.preventDefault()}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onComment}
      >
        <MessageSquareQuote /> Comment
      </Button>
    </div>,
    document.body,
  )
}

const sourceLabel = (source: string) => (source.startsWith("issue:") ? `Issue: ${source.slice(6)}` : "Spec")

/** The attached comments, above the composer. */
export function NoteList({ notes, onChange, onRemove, disabled }: {
  notes: SpecNote[]
  onChange: (id: number, comment: string) => void
  onRemove: (id: number) => void
  disabled?: boolean
}) {
  if (notes.length === 0) return null
  return (
    <div className="mb-2 max-h-64 space-y-2 overflow-y-auto">
      {notes.map((n, i) => (
        <div key={n.id} className="rounded-lg border bg-muted/40 p-2">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1 border-l-2 border-primary/50 pl-2">
              <div className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">{sourceLabel(n.source)}</div>
              <p className="line-clamp-3 text-xs whitespace-pre-wrap text-muted-foreground">{n.quote}</p>
            </div>
            <Button size="icon-xs" variant="ghost" aria-label="Remove comment" onClick={() => onRemove(n.id)} disabled={disabled}>
              <X />
            </Button>
          </div>
          <Textarea
            autoFocus={i === notes.length - 1 && !n.comment}
            value={n.comment}
            onChange={(e) => onChange(n.id, e.target.value)}
            disabled={disabled}
            placeholder="Your comment on this…"
            className="mt-2 min-h-12 bg-background text-sm"
          />
        </div>
      ))}
    </div>
  )
}

/** One planner message: each quote with its comment, then the free text. Plain markdown the planner reads naturally. */
export function composeMessage(notes: SpecNote[], text: string): string {
  const parts = notes
    .filter((n) => n.comment.trim())
    .map((n) => {
      const where = n.source.startsWith("issue:") ? `On the issue "${n.source.slice(6)}":` : "On the spec:"
      const quote = n.quote.split("\n").map((l) => `> ${l}`).join("\n")
      return `${where}\n${quote}\n\n${n.comment.trim()}`
    })
  if (text.trim()) parts.push(text.trim())
  return parts.join("\n\n")
}

/** The owner's message in the chat, with quoted passages shown as quotes. */
export function OwnerText({ text }: { text: string }) {
  const blocks: { quote: boolean; lines: string[] }[] = []
  for (const line of text.split("\n")) {
    const quote = line.startsWith("> ") || line === ">"
    const content = quote ? line.replace(/^> ?/, "") : line
    const last = blocks[blocks.length - 1]
    if (last && last.quote === quote) last.lines.push(content)
    else blocks.push({ quote, lines: [content] })
  }
  return (
    <>
      {blocks.map((b, i) =>
        b.quote ? (
          <blockquote key={i} className="my-1 border-l-2 border-primary-foreground/50 pl-2 text-xs whitespace-pre-wrap opacity-80">{b.lines.join("\n")}</blockquote>
        ) : (
          <div key={i} className="whitespace-pre-wrap">{b.lines.join("\n").replace(/^\n+|\n+$/g, "")}</div>
        ),
      )}
    </>
  )
}
