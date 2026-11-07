import { Activity, Factory, FolderKanban, LayoutGrid, Pause, Play, Sparkles } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
import { api, type FactoryState } from "@/lib/api"
import { FactoryContext } from "@/lib/factory"
import { when } from "@/lib/format"
import { Link, match, usePath } from "@/lib/router"
import { usePoll } from "@/lib/use-poll"
import { cn } from "@/lib/utils"
import { ActivityPage } from "@/pages/activity-page"
import { BoardPage } from "@/pages/board-page"
import { ProjectPage } from "@/pages/project-page"
import { ProjectsPage } from "@/pages/projects-page"
import { PlanPage, PlansPage } from "@/pages/plans-page"
import { IssuePage } from "@/pages/issue-page"

const NAV = [
  { href: "/", label: "Board", icon: LayoutGrid },
  { href: "/projects", label: "Projects", icon: FolderKanban },
  { href: "/plans", label: "Plans", icon: Sparkles },
  { href: "/activity", label: "Activity", icon: Activity },
]

function PauseControl({ state, reload }: { state: FactoryState; reload: () => Promise<void> }) {
  const run = async (path: string, body: unknown, ok: string) => {
    try {
      await api("POST", path, body)
      toast.success(ok)
      await reload()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }
  if (state.pausedUntil) {
    return (
      <Button size="sm" variant="outline" className="border-amber-500/40 text-amber-700 dark:text-amber-300" onClick={() => run("resume", undefined, "Resumed")}>
        <Play /> <span className="hidden sm:inline">Paused until {when(state.pausedUntil, state.timezone)} ·</span> Resume
      </Button>
    )
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button size="sm" variant="outline" />}>
        <Pause /> <span className="hidden sm:inline">Pause</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {[1, 3, 12, 24].map((h) => (
          <DropdownMenuItem key={h} onClick={() => run("pause", { hours: h }, `Paused for ${h} h`)}>
            Pause {h} h
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export default function App() {
  const path = usePath()
  const { data: state, error, reload } = usePoll(() => api<FactoryState>("GET", "state"), 6000)
  const needsYou = state ? state.questions.length + state.tasks.filter((t) => t.state === "parked").length : 0

  let page: React.ReactNode = null
  let params: Record<string, string> | null
  if (path === "/") page = <BoardPage />
  else if (path === "/projects") page = <ProjectsPage />
  else if ((params = match("/projects/:id", path))) page = <ProjectPage key={params.id} id={params.id!} />
  else if ((params = match("/projects/:id/issues/:n", path))) page = <IssuePage key={path} projectId={params.id!} number={Number(params.n)} />
  else if (path === "/plans") page = <PlansPage />
  else if ((params = match("/plans/:id", path))) page = <PlanPage key={params.id} id={Number(params.id)} />
  else if (path === "/activity") page = <ActivityPage />
  else page = <p className="text-sm text-muted-foreground">Nothing here. <Link href="/" className="text-primary hover:underline">Back to the board</Link></p>

  const active = (href: string) => (href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`))

  const badge = (n: number) => (
    <span className="ml-1.5 inline-flex h-4.5 min-w-4.5 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-semibold text-white tabular-nums">{n}</span>
  )

  return (
    <div className="min-h-dvh pb-[calc(env(safe-area-inset-bottom)+5rem)] sm:pb-[env(safe-area-inset-bottom)]">
      <header className="glass sticky top-0 z-30 border-b border-border/60 pt-[env(safe-area-inset-top)]">
        <div className="mx-auto flex h-16 max-w-[1500px] items-center gap-3 px-4 sm:px-6">
          <Link href="/" className="flex items-center gap-2.5 font-semibold tracking-tight">
            <span className="bg-hero inline-flex size-8 items-center justify-center rounded-xl text-white shadow-[0_6px_16px_-6px_var(--primary)]">
              <Factory className="size-4.5" />
            </span>
            <span className="text-[1.05rem]">Factory</span>
          </Link>
          <nav className="mx-auto hidden items-center gap-1 rounded-full bg-muted/70 p-1 sm:flex">
            {NAV.map((n) => (
              <Link key={n.href} href={n.href}
                className={cn("inline-flex h-8 items-center rounded-full px-4 text-sm font-medium whitespace-nowrap transition-all", active(n.href) ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>
                {n.label}
                {n.href === "/" && needsYou > 0 && badge(needsYou)}
              </Link>
            ))}
          </nav>
          <div className="ml-auto sm:ml-0">{state && <PauseControl state={state} reload={reload} />}</div>
        </div>
      </header>
      <main className="mx-auto max-w-[1500px] px-4 py-6 sm:px-6 sm:py-8">
        {!state ? (
          error ? <p className="text-sm text-muted-foreground">Can't reach the factory: {error}</p> : <div className="space-y-4"><Skeleton className="h-48 w-full rounded-3xl" /><Skeleton className="h-96 w-full rounded-3xl" /></div>
        ) : (
          <FactoryContext.Provider value={{ state, reload }}>
            <div key={path} className="animate-rise">{page}</div>
          </FactoryContext.Provider>
        )}
      </main>
      {/* Phones: an app-style tab bar */}
      <nav className="glass fixed inset-x-0 bottom-0 z-30 border-t border-border/60 pb-[env(safe-area-inset-bottom)] sm:hidden">
        <div className="grid grid-cols-4">
          {NAV.map((n) => {
            const Icon = n.icon
            const on = active(n.href)
            return (
              <Link key={n.href} href={n.href} className={cn("relative flex flex-col items-center gap-1 pt-2.5 pb-2 text-[11px] font-medium", on ? "text-primary" : "text-muted-foreground")}>
                <span className={cn("inline-flex h-7 w-12 items-center justify-center rounded-full transition-colors", on && "bg-primary/12")}>
                  <Icon className="size-5" />
                </span>
                {n.label}
                {n.href === "/" && needsYou > 0 && <span className="absolute top-1.5 left-1/2 ml-2 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-semibold text-white">{needsYou}</span>}
              </Link>
            )
          })}
        </div>
      </nav>
    </div>
  )
}
