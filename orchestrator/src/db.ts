import { DatabaseSync } from 'node:sqlite';
import { assertTransition } from './tasks.ts';
import type { Project, ProjectState, Task, TaskState, UsageSnapshot, RunResult, Role, Model } from './types.ts';

const MIGRATIONS: string[] = [
  `CREATE TABLE projects (
     id TEXT PRIMARY KEY,
     owner TEXT NOT NULL,
     kind TEXT NOT NULL,
     state TEXT NOT NULL,
     priority INTEGER NOT NULL DEFAULT 3,
     created_at INTEGER NOT NULL
   );
   CREATE TABLE tasks (
     id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL REFERENCES projects(id),
     issue_number INTEGER NOT NULL,
     title TEXT NOT NULL,
     state TEXT NOT NULL,
     priority INTEGER NOT NULL,
     risk TEXT NOT NULL DEFAULT 'medium',
     area TEXT,
     depends_on TEXT NOT NULL DEFAULT '[]',
     attempt INTEGER NOT NULL DEFAULT 0,
     fix_rounds INTEGER NOT NULL DEFAULT 0,
     session_id TEXT,
     branch TEXT,
     pr_number INTEGER,
     split_on_fail INTEGER NOT NULL DEFAULT 0,
     pending_mode TEXT NOT NULL DEFAULT 'build',
     interruptions INTEGER NOT NULL DEFAULT 0,
     not_before INTEGER,
     estimated_cost_pct REAL NOT NULL DEFAULT 5,
     last_failure TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE INDEX tasks_state ON tasks(state);
   CREATE TABLE runs (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     task_id TEXT,
     role TEXT NOT NULL,
     model TEXT NOT NULL,
     started_at INTEGER NOT NULL,
     finished_at INTEGER,
     ok INTEGER,
     session_id TEXT,
     cost_usd REAL,
     num_turns INTEGER,
     usage_before TEXT,
     usage_after TEXT,
     log_path TEXT,
     summary TEXT
   );
   CREATE TABLE usage_samples (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     taken_at INTEGER NOT NULL,
     source TEXT NOT NULL,
     five_hour_pct REAL,
     five_hour_resets_at INTEGER,
     seven_day_pct REAL,
     seven_day_resets_at INTEGER
   );
   CREATE TABLE questions (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     task_id TEXT,
     project_id TEXT,
     question TEXT NOT NULL,
     options TEXT NOT NULL DEFAULT '[]',
     default_option TEXT,
     asked_at INTEGER NOT NULL,
     timeout_at INTEGER NOT NULL,
     answer TEXT,
     answered_by TEXT,
     answered_at INTEGER,
     discord_message_id TEXT
   );
   CREATE TABLE events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     at INTEGER NOT NULL,
     kind TEXT NOT NULL,
     task_id TEXT,
     data TEXT NOT NULL DEFAULT '{}'
   );
   CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
  // v2: question kinds (product decision vs destructive-migration approval), answer delivery, ideas from Discord
  `ALTER TABLE questions ADD COLUMN kind TEXT NOT NULL DEFAULT 'product';
   ALTER TABLE questions ADD COLUMN delivered INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE questions ADD COLUMN discord_channel_id TEXT;
   CREATE TABLE ideas (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     at INTEGER NOT NULL,
     name TEXT NOT NULL,
     text TEXT NOT NULL,
     state TEXT NOT NULL DEFAULT 'new'
   );`,
  // v3: plan mode (a conversation with the planner that ends in issues, and for new projects a repo)
  `CREATE TABLE plans (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     title TEXT NOT NULL,
     target TEXT NOT NULL,
     project_id TEXT,
     state TEXT NOT NULL DEFAULT 'drafting',
     model TEXT NOT NULL DEFAULT 'opus',
     session_id TEXT,
     result TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE plan_messages (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     plan_id INTEGER NOT NULL REFERENCES plans(id),
     role TEXT NOT NULL,
     text TEXT NOT NULL,
     at INTEGER NOT NULL
   );`,
  // v4: a plan's focus: a change (features, fixes) or the project's goals (docs/PRODUCT.md)
  `ALTER TABLE plans ADD COLUMN focus TEXT NOT NULL DEFAULT 'change';`,
  // v5: conversations about one existing issue
  `ALTER TABLE plans ADD COLUMN issue_number INTEGER;`,
  // v6: the Studio: an idea taken from brief to build plan in phases
  `CREATE TABLE studios (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     title TEXT NOT NULL,
     mode TEXT NOT NULL DEFAULT 'guided',
     plan_id INTEGER,
     archived INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE studio_phases (
     studio_id INTEGER NOT NULL REFERENCES studios(id),
     phase TEXT NOT NULL,
     state TEXT NOT NULL,
     model TEXT NOT NULL,
     session_id TEXT,
     note TEXT,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (studio_id, phase)
   );
   CREATE TABLE studio_messages (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     studio_id INTEGER NOT NULL REFERENCES studios(id),
     phase TEXT NOT NULL,
     role TEXT NOT NULL,
     text TEXT NOT NULL,
     at INTEGER NOT NULL
   );
   ALTER TABLE plans ADD COLUMN studio_id INTEGER;`,
];

type Row = Record<string, unknown>;

function rowToTask(r: Row): Task {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    issueNumber: Number(r.issue_number),
    title: String(r.title),
    state: r.state as TaskState,
    priority: Number(r.priority),
    risk: r.risk as Task['risk'],
    area: (r.area as string | null) ?? null,
    dependsOn: JSON.parse(String(r.depends_on)) as string[],
    attempt: Number(r.attempt),
    fixRounds: Number(r.fix_rounds),
    sessionId: (r.session_id as string | null) ?? null,
    branch: (r.branch as string | null) ?? null,
    prNumber: r.pr_number === null ? null : Number(r.pr_number),
    splitOnFail: Number(r.split_on_fail) === 1,
    pendingMode: r.pending_mode as Task['pendingMode'],
    interruptions: Number(r.interruptions),
    notBefore: r.not_before === null ? null : Number(r.not_before),
    estimatedCostPct: Number(r.estimated_cost_pct),
    lastFailure: (r.last_failure as string | null) ?? null,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

const nowS = () => Math.floor(Date.now() / 1000);

export type TaskPatch = Partial<
  Pick<Task, 'attempt' | 'fixRounds' | 'sessionId' | 'branch' | 'prNumber' | 'lastFailure' | 'pendingMode' | 'interruptions' | 'notBefore'>
>;

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
    const row = this.db.prepare('SELECT version FROM schema_version').get() as Row | undefined;
    let version = row ? Number(row.version) : 0;
    if (!row) this.db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();
    while (version < MIGRATIONS.length) {
      this.db.exec('BEGIN');
      try {
        this.db.exec(MIGRATIONS[version]!);
        version += 1;
        this.db.prepare('UPDATE schema_version SET version = ?').run(version);
        this.db.exec('COMMIT');
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
    }
  }

  close(): void {
    this.db.close();
  }

  // --- projects ---
  upsertProject(p: Project): void {
    this.db
      .prepare(
        `INSERT INTO projects (id, owner, kind, state, priority, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET owner = excluded.owner, kind = excluded.kind, priority = excluded.priority`,
      )
      .run(p.id, p.owner, p.kind, p.state, p.priority, p.createdAt);
  }

  setProjectState(id: string, state: ProjectState): void {
    this.db.prepare('UPDATE projects SET state = ? WHERE id = ?').run(state, id);
  }

  projects(): Project[] {
    return (this.db.prepare('SELECT * FROM projects').all() as Row[]).map((r) => ({
      id: String(r.id),
      owner: String(r.owner),
      kind: r.kind as Project['kind'],
      state: r.state as ProjectState,
      priority: Number(r.priority),
      createdAt: Number(r.created_at),
    }));
  }

  // --- tasks ---
  /** Insert a task if new. Existing tasks keep their state; title/priority/risk/area/deps are refreshed from the issue. */
  upsertTask(t: Omit<Task, 'createdAt' | 'updatedAt'> & { createdAt?: number }): void {
    const ts = t.createdAt ?? nowS();
    this.db
      .prepare(
        `INSERT INTO tasks (id, project_id, issue_number, title, state, priority, risk, area, depends_on, attempt, fix_rounds,
           session_id, branch, pr_number, split_on_fail, pending_mode, interruptions, not_before, estimated_cost_pct,
           last_failure, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, priority = excluded.priority, risk = excluded.risk,
           area = excluded.area, depends_on = excluded.depends_on, split_on_fail = excluded.split_on_fail,
           estimated_cost_pct = excluded.estimated_cost_pct, updated_at = excluded.updated_at`,
      )
      .run(
        t.id, t.projectId, t.issueNumber, t.title, t.state, t.priority, t.risk, t.area, JSON.stringify(t.dependsOn),
        t.attempt, t.fixRounds, t.sessionId, t.branch, t.prNumber, t.splitOnFail ? 1 : 0, t.pendingMode, t.interruptions,
        t.notBefore, t.estimatedCostPct, t.lastFailure, ts, ts,
      );
  }

  task(id: string): Task | null {
    const r = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Row | undefined;
    return r ? rowToTask(r) : null;
  }

  openTasks(): Task[] {
    return (this.db.prepare(`SELECT * FROM tasks WHERE state NOT IN ('done', 'cancelled')`).all() as Row[]).map(rowToTask);
  }

  cancelledTaskIds(): Set<string> {
    return new Set((this.db.prepare(`SELECT id FROM tasks WHERE state = 'cancelled'`).all() as Row[]).map((r) => String(r.id)));
  }

  /** Move a task to a new state (validated) and optionally update fields in the same statement. */
  transition(id: string, to: TaskState, patch: TaskPatch = {}): Task {
    const current = this.task(id);
    if (!current) throw new Error(`Unknown task ${id}`);
    assertTransition(current.state, to);
    const next: Task = { ...current, ...patch, state: to, updatedAt: nowS() };
    const res = this.db
      .prepare(
        `UPDATE tasks SET state = ?, attempt = ?, fix_rounds = ?, session_id = ?, branch = ?, pr_number = ?, last_failure = ?,
           pending_mode = ?, interruptions = ?, not_before = ?, updated_at = ?
         WHERE id = ? AND state = ?`,
      )
      .run(next.state, next.attempt, next.fixRounds, next.sessionId, next.branch, next.prNumber, next.lastFailure,
        next.pendingMode, next.interruptions, next.notBefore, next.updatedAt, id, current.state);
    if (Number(res.changes) === 0) throw new Error(`Task ${id} changed state concurrently; transition to ${to} not applied`);
    this.event('task.transition', id, { from: current.state, to });
    return next;
  }

  /** Record the session id as soon as a run reports it, so a crash mid-run can still resume the session. */
  setTaskSession(id: string, sessionId: string): void {
    this.db.prepare('UPDATE tasks SET session_id = ? WHERE id = ?').run(sessionId, id);
  }

  // --- runs & usage ---
  startRun(r: { taskId: string | null; role: Role; model: Model; logPath: string; usageBefore: UsageSnapshot | null }): number {
    const res = this.db
      .prepare('INSERT INTO runs (task_id, role, model, started_at, log_path, usage_before) VALUES (?, ?, ?, ?, ?, ?)')
      .run(r.taskId, r.role, r.model, nowS(), r.logPath, JSON.stringify(r.usageBefore));
    return Number(res.lastInsertRowid);
  }

  finishRun(runId: number, result: RunResult, summary: string): void {
    this.db
      .prepare('UPDATE runs SET finished_at = ?, ok = ?, session_id = ?, cost_usd = ?, num_turns = ?, usage_after = ?, summary = ? WHERE id = ?')
      .run(nowS(), result.ok ? 1 : 0, result.sessionId, result.totalCostUsd, result.numTurns, JSON.stringify(result.usage), summary.slice(0, 2000), runId);
  }

  recordUsage(u: UsageSnapshot): void {
    this.db
      .prepare(
        'INSERT INTO usage_samples (taken_at, source, five_hour_pct, five_hour_resets_at, seven_day_pct, seven_day_resets_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(u.takenAt, u.source, u.fiveHourPct, u.fiveHourResetsAt, u.sevenDayPct, u.sevenDayResetsAt);
  }

  latestUsage(): UsageSnapshot | null {
    const r = this.db.prepare('SELECT * FROM usage_samples ORDER BY taken_at DESC, id DESC LIMIT 1').get() as Row | undefined;
    if (!r) return null;
    const n = (v: unknown) => (v === null ? null : Number(v));
    return {
      takenAt: Number(r.taken_at),
      source: r.source as UsageSnapshot['source'],
      fiveHourPct: n(r.five_hour_pct),
      fiveHourResetsAt: n(r.five_hour_resets_at),
      sevenDayPct: n(r.seven_day_pct),
      sevenDayResetsAt: n(r.seven_day_resets_at),
    };
  }

  // --- misc ---
  event(kind: string, taskId: string | null, data: object = {}): void {
    this.db.prepare('INSERT INTO events (at, kind, task_id, data) VALUES (?, ?, ?, ?)').run(nowS(), kind, taskId, JSON.stringify(data));
  }

  getSetting(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as Row | undefined;
    return r ? String(r.value) : null;
  }

  setSetting(key: string, value: string | null): void {
    if (value === null) this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
    else this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }
}
