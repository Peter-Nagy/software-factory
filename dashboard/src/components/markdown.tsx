import { Fragment, type ReactNode } from "react"
import { cn } from "@/lib/utils"

// Markdown from agents rendered as React elements: no HTML is ever injected, so nothing an agent writes can run in this page.

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = []
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[([^\]]+)\]\((https?:\/\/[^)\s]+)\))|(?<![\w*])[*_]([^*_\s][^*_]*?)[*_](?![\w*])/g
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const k = `${key}-${i++}`
    if (m[1]) out.push(<code key={k} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">{m[1].slice(1, -1)}</code>)
    else if (m[2]) out.push(<strong key={k}>{m[2].slice(2, -2)}</strong>)
    else if (m[6]) out.push(<em key={k}>{m[6]}</em>)
    else if (m[3]) out.push(<a key={k} href={m[5]} target="_blank" rel="noopener noreferrer" className="text-primary underline-offset-4 hover:underline">{m[4]}</a>)
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n")
  const blocks: ReactNode[] = []
  let list: ReactNode[] = []
  let code: string[] | null = null
  let table: string[][] = []
  const cells = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim())
  const flushTable = () => {
    if (!table.length) return
    const [head, ...rows] = table
    const k = `t-${blocks.length}`
    blocks.push(
      <div key={k} className="my-3 overflow-x-auto rounded-xl ring-1 ring-border">
        <table className="w-full text-left text-[0.8rem]">
          <thead className="bg-muted/70"><tr>{head!.map((c, i) => <th key={i} className="px-3 py-2 font-semibold whitespace-nowrap">{inline(c, `${k}-h${i}`)}</th>)}</tr></thead>
          <tbody className="divide-y">{rows.map((r, ri) => <tr key={ri}>{r.map((c, ci) => <td key={ci} className="px-3 py-2 align-top">{inline(c, `${k}-${ri}-${ci}`)}</td>)}</tr>)}</tbody>
        </table>
      </div>,
    )
    table = []
  }
  const flushList = () => {
    if (list.length) blocks.push(<ul key={`ul-${blocks.length}`} className="my-1.5 space-y-0.5 pl-5">{list}</ul>)
    list = []
  }
  lines.forEach((line, n) => {
    if (line.startsWith("```")) {
      flushTable()
      if (code) {
        blocks.push(<pre key={`pre-${n}`} className="my-2 overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">{code.join("\n")}</pre>)
        code = null
      } else {
        flushList()
        code = []
      }
      return
    }
    if (code) return void code.push(line)
    // Tables: a header row, a |---| separator, then rows.
    if (/^\s*\|.*\|\s*$/.test(line)) {
      if (/^\s*\|[\s:|-]+\|\s*$/.test(line) && table.length === 1) return
      flushList()
      table.push(cells(line))
      return
    }
    flushTable()
    const li = /^\s*(?:[-*]|\d+\.)\s+(?:\[( |x|X)\]\s+)?(.*)$/.exec(line)
    if (li) {
      const box = li[1] === undefined ? "" : li[1] === " " ? "☐ " : "☑ "
      list.push(<li key={`li-${n}`} className={box ? "-ml-5 list-none" : "list-disc"}>{box}{inline(li[2]!, `li-${n}`)}</li>)
      return
    }
    flushList()
    const h = /^(#{1,4})\s+(.*)$/.exec(line)
    if (h) {
      const size = h[1]!.length === 1 ? "text-lg" : h[1]!.length === 2 ? "text-base" : "text-sm"
      blocks.push(<div key={`h-${n}`} className={cn("mt-4 mb-1.5 font-semibold first:mt-0", size)}>{inline(h[2]!, `h-${n}`)}</div>)
      return
    }
    if (line.trim()) blocks.push(<p key={`p-${n}`} className="my-1.5 leading-relaxed">{inline(line, `p-${n}`)}</p>)
  })
  flushList()
  flushTable()
  if (code) blocks.push(<pre key="pre-end" className="my-2 overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">{(code as string[]).join("\n")}</pre>)
  return <div className={cn("text-sm break-words", className)}>{blocks.map((b, i) => <Fragment key={i}>{b}</Fragment>)}</div>
}
