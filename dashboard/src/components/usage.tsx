import { Ring } from "@/components/visual"
import type { FactoryState } from "@/lib/api"
import { ago, when } from "@/lib/format"

/** The two subscription windows as rings, for the hero card. Ticks mark where the governor stops work. */
export function UsageRings({ state }: { state: FactoryState }) {
  const u = state.usage
  const rings = [
    { label: "5-hour", pct: u?.fiveHourPct, resets: u?.fiveHourResetsAt, marks: [state.governor.opusMaxFiveHourPct, state.governor.anyMaxFiveHourPct], hint: `Opus stops at ${state.governor.opusMaxFiveHourPct}%, everything at ${state.governor.anyMaxFiveHourPct}%` },
    { label: "7-day", pct: u?.sevenDayPct, resets: u?.sevenDayResetsAt, marks: state.burnLine != null ? [state.burnLine] : [], hint: state.burnLine != null ? `Pace line ${state.burnLine}%: above it only small tasks start` : "" },
  ]
  return (
    <div className="flex items-center gap-4 sm:gap-6">
      {rings.map((r) => (
        <div key={r.label} className="flex flex-col items-center gap-2" title={r.hint}>
          <Ring pct={r.pct} size={104} stroke={9} marks={r.marks} onDark>
            <span className="text-2xl font-semibold tracking-tight tabular-nums">{r.pct == null ? "–" : `${Math.round(r.pct)}%`}</span>
            <span className="text-[11px] text-white/70">{r.label}</span>
          </Ring>
          <span className="text-[11px] text-white/70">resets {when(r.resets, state.timezone)}</span>
        </div>
      ))}
      {u && <span className="sr-only">Usage read {ago(u.takenAt)}</span>}
    </div>
  )
}
