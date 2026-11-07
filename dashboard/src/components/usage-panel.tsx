import { useState } from "react"
import { api, type CostLine, type CostReport } from "@/lib/api"
import { usePoll } from "@/lib/use-poll"
import { cn } from "@/lib/utils"

const pct = (v: number) => (v > 0 && v < 0.1 ? "<0.1%" : `${v.toFixed(1)}%`)
const usd = (v: number) => `$${v.toFixed(v >= 100 ? 0 : 2)}`

/** One series, one hue: each line's spend relative to the largest, value in text ink beside the bar. */
function RankedBars({ title, lines, total, label }: { title: string; lines: CostLine[]; total: number; label?: (k: string) => string }) {
  if (!lines.length) return null
  const max = Math.max(...lines.map((l) => l.usd), 0.0001)
  return (
    <div>
      <p className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{title}</p>
      <ul className="space-y-2">
        {lines.slice(0, 6).map((l) => {
          const name = label?.(l.key) ?? l.key
          return (
            <li key={l.key} className="group grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-3 text-sm"
              title={`${name}: ${usd(l.usd)} in ${l.runs} run${l.runs === 1 ? "" : "s"}${l.sevenDayPct !== null ? `, ≈${pct(l.sevenDayPct)} of a weekly limit` : ""} (${total ? Math.round((l.usd / total) * 100) : 0}% of this period)`}>
              <span className="truncate">{name}</span>
              <span className="h-2 rounded-full bg-muted">
                <span className="block h-full rounded-full bg-primary transition-[width] group-hover:bg-primary/80" style={{ width: `${Math.max(2, (l.usd / max) * 100)}%` }} />
              </span>
              <span className="w-28 text-right text-xs text-muted-foreground tabular-nums">
                {l.sevenDayPct !== null
                  ? <><span className="font-medium text-foreground">{pct(l.sevenDayPct)}</span> · {usd(l.usd)}</>
                  : <span className="font-medium text-foreground">{usd(l.usd)}</span>}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/** Spend per day: thin bars from a shared baseline; hover shows the day's value. */
function DailyBars({ days, from, count }: { days: CostReport["days"]; from: number; count: number }) {
  const byDate = new Map(days.map((d) => [d.date, d.usd]))
  const fmt = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" })
  const series = Array.from({ length: count }, (_, i) => {
    const date = fmt.format(new Date((from + (i + 1) * 86400) * 1000))
    return { date, usd: byDate.get(date) ?? 0 }
  })
  const max = Math.max(...series.map((d) => d.usd), 0.0001)
  return (
    <div>
      <div className="flex h-20 items-end gap-[2px]" role="img" aria-label={`Spend per day, last ${count} days`}>
        {series.map((d) => (
          <div key={d.date} className="group flex h-full flex-1 items-end" title={`${d.date}: ${usd(d.usd)}`}>
            <div className={cn("w-full rounded-t-[4px] transition-colors", d.usd ? "bg-primary group-hover:bg-primary/80" : "bg-muted")}
              style={{ height: d.usd ? `${Math.max(4, (d.usd / max) * 100)}%` : "2px" }} />
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex justify-between text-[0.7rem] text-muted-foreground tabular-nums">
        <span>{series[0]?.date.slice(5)}</span>
        <span>today</span>
      </div>
    </div>
  )
}

/** How much of the subscription the factory used, by day, project and agent. */
export function UsagePanel() {
  const [days, setDays] = useState<7 | 30>(7)
  const { data } = usePoll(() => api<CostReport>("GET", `costs/${days}`), 60_000, [days])
  const cal = data?.calibration
  return (
    <section className="rounded-3xl border bg-card p-6 shadow-elevation">
      <div className="flex items-center gap-2">
        <p className="text-sm text-muted-foreground">Usage</p>
        <div className="ml-auto inline-flex rounded-full bg-muted p-0.5 text-xs">
          {([7, 30] as const).map((d) => (
            <button key={d} type="button" onClick={() => setDays(d)}
              className={cn("rounded-full px-2.5 py-1 font-medium transition-colors", days === d ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>
              {d} days
            </button>
          ))}
        </div>
      </div>
      {!data ? <div className="mt-4 h-48 animate-pulse rounded-2xl bg-muted/50" /> : (
        <>
          <div className="mt-2 flex flex-wrap items-end gap-x-5 gap-y-1">
            {data.total.sevenDayPct !== null ? (
              <p><span className="text-5xl font-semibold tracking-tighter tabular-nums">≈{data.total.sevenDayPct.toFixed(data.total.sevenDayPct < 10 ? 1 : 0)}%</span> <span className="text-sm text-muted-foreground">of a weekly limit</span></p>
            ) : (
              <p className="text-5xl font-semibold tracking-tighter tabular-nums">{usd(data.total.usd)}</p>
            )}
            <p className="pb-1.5 text-sm text-muted-foreground">{data.total.runs} runs · {usd(data.total.usd)} at API prices</p>
          </div>
          <div className="mt-5"><DailyBars days={data.days} from={data.since} count={days} /></div>
          <div className="mt-6 space-y-5">
            <RankedBars title="By project" lines={data.byProject} total={data.total.usd} />
            <RankedBars title="By agent" lines={data.byRole} total={data.total.usd} label={(k) => k.charAt(0).toUpperCase() + k.slice(1)} />
          </div>
          <p className="mt-5 text-xs text-muted-foreground">
            {cal?.sevenDayPctPerUsd != null
              ? `Shares of the limits are estimates: ≈${cal.fiveHourPctPerUsd?.toFixed(1)}% of a 5-hour window and ≈${cal.sevenDayPctPerUsd.toFixed(1)}% of the week per API-dollar, measured on ${cal.samples} runs that ran alone.`
              : "Shares of the limits appear once enough runs have run alone to measure them."}
          </p>
        </>
      )}
    </section>
  )
}
