import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { useFactory } from "@/lib/factory"
import { when } from "@/lib/format"

function describe(kind: string, data: string): string {
  let d: Record<string, unknown> = {}
  try {
    d = JSON.parse(data) as Record<string, unknown>
  } catch {
    /* not JSON */
  }
  if (kind === "task.transition") return `${String(d.from)} → ${String(d.to)}`
  if (kind.startsWith("notify.")) return String(d.text ?? "")
  return Object.keys(d).length ? JSON.stringify(d).slice(0, 200) : ""
}

export function ActivityPage() {
  const { state } = useFactory()
  const total = state.spend.reduce((s, r) => s + Number(r.usd), 0)
  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Activity</h1>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Spend, last 7 days</CardTitle>
            <CardDescription>Client-side estimates (~${total.toFixed(2)}). On a subscription, the usage gauges are what counts.</CardDescription>
          </CardHeader>
          <CardContent>
            {state.spend.length === 0 ? <p className="text-sm text-muted-foreground">No runs yet.</p> : (
              <table className="w-full text-sm">
                <thead className="text-xs text-muted-foreground"><tr><th className="pb-2 text-left font-medium">Role</th><th className="pb-2 text-left font-medium">Model</th><th className="pb-2 text-right font-medium">Runs</th><th className="pb-2 text-right font-medium">Est.</th></tr></thead>
                <tbody className="divide-y">
                  {state.spend.map((r) => (
                    <tr key={`${r.role}-${r.model}`}><td className="py-1.5">{r.role}</td><td><Badge variant="secondary">{r.model}</Badge></td><td className="text-right tabular-nums">{r.runs}</td><td className="text-right tabular-nums">${Number(r.usd).toFixed(2)}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Recent runs</CardTitle></CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full min-w-[34rem] text-sm">
              <tbody className="divide-y">
                {state.runs.map((r) => (
                  <tr key={r.id}>
                    <td className="py-1.5 text-xs text-muted-foreground">{when(r.started_at, state.timezone)}</td>
                    <td>{r.role}</td>
                    <td><Badge variant="secondary">{r.model}</Badge></td>
                    <td className="text-xs text-muted-foreground">{r.task_id}</td>
                    <td>{r.ok === null ? <Badge>running</Badge> : r.ok ? <span className="text-emerald-600 dark:text-emerald-400">ok</span> : <span className="text-red-600 dark:text-red-400">failed</span>}</td>
                    <td className="text-right text-xs tabular-nums">{r.cost_usd != null ? `$${r.cost_usd.toFixed(3)}` : ""}</td>
                    <td className="text-right text-xs text-muted-foreground tabular-nums">{r.finished_at ? `${r.finished_at - r.started_at}s` : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader><CardTitle>Events</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full min-w-[40rem] text-sm">
            <tbody className="divide-y">
              {state.events.map((e, i) => (
                <tr key={i}>
                  <td className="w-32 py-1.5 text-xs text-muted-foreground">{when(e.at, state.timezone)}</td>
                  <td className="w-44 font-mono text-xs">{e.kind}</td>
                  <td className="w-40 text-xs">{e.task_id}</td>
                  <td className="text-xs text-muted-foreground">{describe(e.kind, e.data)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  )
}
