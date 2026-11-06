import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import type { FactoryState } from "@/lib/api"
import { ago, when } from "@/lib/format"
import { cn } from "@/lib/utils"

function Gauge({ label, pct, resetsAt, marks, timezone }: { label: string; pct: number | null | undefined; resetsAt: number | null | undefined; marks: { at: number | null; label: string }[]; timezone: string }) {
  const v = Math.min(100, pct ?? 0)
  const tone = v >= 90 ? "bg-red-500" : v >= 70 ? "bg-amber-500" : "bg-emerald-500"
  const shown = marks.filter((m): m is { at: number; label: string } => m.at !== null)
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between text-sm">
        <span className="font-medium">{label}</span>
        <span className="tabular-nums">{pct == null ? <span className="text-muted-foreground">no reading</span> : `${Math.round(v)}%`}</span>
      </div>
      <div className="relative h-2 rounded-full bg-muted">
        <div className={cn("h-full rounded-full transition-all", tone)} style={{ width: `${v}%` }} />
        {shown.map((m) => (
          <div key={m.label} title={m.label} className="absolute -top-1 h-4 w-0.5 rounded bg-foreground/50" style={{ left: `${Math.min(100, m.at)}%` }} />
        ))}
      </div>
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{shown.map((m) => m.label).join(" · ")}</span>
        <span>resets {when(resetsAt, timezone)}</span>
      </div>
    </div>
  )
}

export function UsageCard({ state, className }: { state: FactoryState; className?: string }) {
  const u = state.usage
  return (
    <Card className={className}>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Usage</CardTitle>
        <span className="text-xs text-muted-foreground">{u ? `read ${ago(u.takenAt)}` : ""}</span>
      </CardHeader>
      <CardContent className="space-y-5">
        <Gauge label="5-hour window" pct={u?.fiveHourPct} resetsAt={u?.fiveHourResetsAt} timezone={state.timezone}
          marks={[{ at: state.governor.opusMaxFiveHourPct, label: `Opus stops ${state.governor.opusMaxFiveHourPct}%` }, { at: state.governor.anyMaxFiveHourPct, label: `all stop ${state.governor.anyMaxFiveHourPct}%` }]} />
        <Gauge label="7-day window" pct={u?.sevenDayPct} resetsAt={u?.sevenDayResetsAt} timezone={state.timezone}
          marks={[{ at: state.burnLine, label: `pace line ${state.burnLine}%` }]} />
      </CardContent>
    </Card>
  )
}
