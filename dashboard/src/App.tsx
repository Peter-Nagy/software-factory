import { Factory, Pause, Play } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
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

const NAV = [
  { href: "/", label: "Board" },
  { href: "/projects", label: "Projects" },
  { href: "/plans", label: "Plans" },
  { href: "/activity", label: "Activity" },
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
      <Button size="sm" variant="outline" onClick={() => run("resume", undefined, "Resumed")}>
        <Play /> <span className="hidden sm:inline">Paused until {when(state.pausedUntil, state.timezone)} ·</span> Resume
      </Button>
    )
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button size="sm" variant="ghost" />}>
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
  else if (path === "/plans") page = <PlansPage />
  else if ((params = match("/plans/:id", path))) page = <PlanPage key={params.id} id={Number(params.id)} />
  else if (path === "/activity") page = <ActivityPage />
  else page = <p className="text-sm text-muted-foreground">Nothing here. <Link href="/" className="text-primary hover:underline">Back to the board</Link></p>

  const active = (href: string) => (href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`))

  return (
    <div className="min-h-dvh bg-background pb-[env(safe-area-inset-bottom)]">
      <header className="sticky top-0 z-30 border-b bg-background/85 pt-[env(safe-area-inset-top)] backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[1500px] items-center gap-2 px-4 sm:gap-4 sm:px-6">
          <Link href="/" className="flex items-center gap-2 font-semibold">
            <Factory className="size-5" />
            <span className="hidden sm:inline">Software Factory</span>
          </Link>
          <nav className="flex gap-0.5">
            {NAV.map((n) => (
              <Link key={n.href} href={n.href}
                className={cn("inline-flex items-center rounded-md px-2 py-1.5 text-sm whitespace-nowrap transition-colors sm:px-2.5", active(n.href) ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground")}>
                {n.label}
                {n.href === "/" && needsYou > 0 && <Badge className="ml-1.5 h-4.5 bg-amber-500 px-1.5 text-[10px] text-white">{needsYou}</Badge>}
              </Link>
            ))}
          </nav>
          <div className="ml-auto">{state && <PauseControl state={state} reload={reload} />}</div>
        </div>
      </header>
      <main className="mx-auto max-w-[1500px] px-4 py-6 sm:px-6">
        {!state ? (
          error ? <p className="text-sm text-muted-foreground">Can't reach the factory: {error}</p> : <div className="space-y-4"><Skeleton className="h-40 w-full" /><Skeleton className="h-96 w-full" /></div>
        ) : (
          <FactoryContext.Provider value={{ state, reload }}>{page}</FactoryContext.Provider>
        )}
      </main>
    </div>
  )
}
