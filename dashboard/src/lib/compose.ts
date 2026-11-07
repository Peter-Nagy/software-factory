import type { SpecNote } from "@/components/spec-comments"

/** One planner message: each quote with its comment, then the free text. Plain markdown the planner reads naturally. */
export function composeMessage(notes: SpecNote[], text: string): string {
  const parts = notes
    .filter((n) => n.comment.trim())
    .map((n) => {
      const where = n.source.startsWith("issue:") ? `On the issue "${n.source.slice(6)}":` : n.source.startsWith("doc:") ? `On ${n.source.slice(4)}:` : n.source === "draft" ? "On the draft:" : "On the spec:"
      const quote = n.quote.split("\n").map((l) => `> ${l}`).join("\n")
      return `${where}\n${quote}\n\n${n.comment.trim()}`
    })
  if (text.trim()) parts.push(text.trim())
  return parts.join("\n\n")
}
