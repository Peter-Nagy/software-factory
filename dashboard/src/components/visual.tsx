import type { ReactNode } from "react"
import type { TaskState } from "@/lib/api"
import { STATE_LABEL } from "@/lib/format"
import { cn } from "@/lib/utils"

/** A stable hue per name, so each project keeps its colour everywhere. */
export function hue(name: string): number {
  let h = 2166136261 // FNV-1a, so similar names still land far apart
  for (const c of name) h = Math.imul(h ^ c.charCodeAt(0), 16777619)
  return (h >>> 0) % 360
}

export function projectGradient(name: string): string {
  const h = hue(name)
  return `linear-gradient(135deg, oklch(0.62 0.2 ${h}), oklch(0.55 0.22 ${(h + 50) % 360}))`
}

export function ProjectAvatar({ id, className }: { id: string; className?: string }) {
  const initials = id.split(/[-_ ]/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?"
  return (
    <span
      aria-hidden
      className={cn("inline-flex size-9 shrink-0 items-center justify-center rounded-xl text-xs font-semibold text-white shadow-sm ring-1 ring-white/15", className)}
      style={{ background: projectGradient(id) }}
    >
      {initials}
    </span>
  )
}

export const STATE_TONE: Record<TaskState, { dot: string; pill: string }> = {
  queued: { dot: "bg-slate-400", pill: "bg-slate-500/10 text-slate-600 dark:text-slate-300" },
  building: { dot: "bg-sky-500", pill: "bg-sky-500/12 text-sky-700 dark:text-sky-300" },
  fixing: { dot: "bg-sky-500", pill: "bg-sky-500/12 text-sky-700 dark:text-sky-300" },
  in_review: { dot: "bg-violet-500", pill: "bg-violet-500/12 text-violet-700 dark:text-violet-300" },
  merging: { dot: "bg-violet-500", pill: "bg-violet-500/12 text-violet-700 dark:text-violet-300" },
  deploying: { dot: "bg-violet-500", pill: "bg-violet-500/12 text-violet-700 dark:text-violet-300" },
  blocked: { dot: "bg-amber-500", pill: "bg-amber-500/14 text-amber-700 dark:text-amber-300" },
  parked: { dot: "bg-rose-500", pill: "bg-rose-500/12 text-rose-700 dark:text-rose-300" },
  done: { dot: "bg-emerald-500", pill: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300" },
  cancelled: { dot: "bg-muted-foreground/50", pill: "bg-muted text-muted-foreground" },
}

export const ACTIVE: TaskState[] = ["building", "fixing", "merging", "deploying"]

export function StatusDot({ state, className }: { state: TaskState; className?: string }) {
  const live = ACTIVE.includes(state)
  return (
    <span className={cn("relative inline-flex size-2 shrink-0", className)}>
      {live && <span className={cn("absolute inset-0 animate-ping rounded-full opacity-60", STATE_TONE[state].dot)} />}
      <span className={cn("relative size-2 rounded-full", STATE_TONE[state].dot)} />
    </span>
  )
}

export function StatusPill({ state, className }: { state: TaskState; className?: string }) {
  return (
    <span className={cn("inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium whitespace-nowrap", STATE_TONE[state].pill, className)}>
      <StatusDot state={state} />
      {STATE_LABEL[state]}
    </span>
  )
}

/** A circular gauge, like a spending ring. `marks` are thin ticks (e.g. where Opus stops). */
export function Ring({ pct, size = 112, stroke = 10, marks = [], children, className, onDark }: {
  pct: number | null | undefined
  size?: number
  stroke?: number
  marks?: number[]
  children?: ReactNode
  className?: string
  onDark?: boolean
}) {
  const v = Math.max(0, Math.min(100, pct ?? 0))
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const tone = v >= 90 ? "oklch(0.7 0.2 22)" : v >= 70 ? "oklch(0.8 0.16 75)" : onDark ? "oklch(1 0 0)" : "var(--primary)"
  return (
    <div className={cn("relative inline-flex items-center justify-center", className)} style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} stroke={onDark ? "oklch(1 0 0 / 0.18)" : "var(--muted)"} />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} strokeLinecap="round" stroke={tone}
          strokeDasharray={`${(v / 100) * c} ${c}`} style={{ transition: "stroke-dasharray 0.8s cubic-bezier(0.2,0.7,0.2,1)" }}
        />
        {marks.map((m) => {
          const a = (m / 100) * 2 * Math.PI
          const x1 = size / 2 + (r - stroke / 2 - 1) * Math.cos(a)
          const y1 = size / 2 + (r - stroke / 2 - 1) * Math.sin(a)
          const x2 = size / 2 + (r + stroke / 2 + 1) * Math.cos(a)
          const y2 = size / 2 + (r + stroke / 2 + 1) * Math.sin(a)
          return <line key={m} x1={x1} y1={y1} x2={x2} y2={y2} strokeWidth={2} stroke={onDark ? "oklch(1 0 0 / 0.75)" : "var(--foreground)"} strokeOpacity={0.6} />
        })}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">{children}</div>
    </div>
  )
}

export function PageHeader({ eyebrow, title, children, actions, className }: {
  eyebrow?: ReactNode
  title: ReactNode
  children?: ReactNode
  actions?: ReactNode
  className?: string
}) {
  return (
    <div className={cn("flex flex-wrap items-end gap-x-6 gap-y-3", className)}>
      <div className="min-w-0 flex-1">
        {eyebrow && <div className="mb-1 text-sm text-muted-foreground">{eyebrow}</div>}
        <h1 className="text-[1.75rem] leading-tight font-semibold tracking-tight sm:text-[2rem]">{title}</h1>
        {children}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  )
}

export function SectionTitle({ children, count, action }: { children: ReactNode; count?: number; action?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center gap-2">
      <h2 className="text-base font-semibold tracking-tight">{children}</h2>
      {count !== undefined && <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground tabular-nums">{count}</span>}
      {action && <div className="ml-auto">{action}</div>}
    </div>
  )
}

/** A small tile with a big number. */
export function Stat({ value, label, icon, tone, className }: { value: ReactNode; label: string; icon?: ReactNode; tone?: string; className?: string }) {
  return (
    <div className={cn("rounded-2xl bg-muted/60 p-3.5", className)}>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {icon && <span className={cn("inline-flex size-6 items-center justify-center rounded-full [&_svg]:size-3.5", tone ?? "bg-background text-foreground")}>{icon}</span>}
        {label}
      </div>
      <div className="mt-1.5 text-2xl font-semibold tracking-tight tabular-nums">{value}</div>
    </div>
  )
}
