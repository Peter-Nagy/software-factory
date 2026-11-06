import { parseArgs } from 'node:util';
import { createApp } from './app.ts';
import { approveMigration, rejectMigration } from './review.ts';
import { dashboardToken } from './dashboard/server.ts';
import { execFileSync } from 'node:child_process';
import { GitHubError } from './github.ts';
import type { Project, ProjectKind } from './types.ts';

const HELP = `factory <command>

  add-project <repo> [--kind web-app|static-site|service|cli|ios] [--priority 1-5]
                         Register an existing repo (must carry the factory-managed topic) as an active project
  status                 Projects and open tasks by state
  usage                  Latest subscription usage reading
  pause <hours>          Start no new runs for <hours>
  resume                 Clear a pause
  dashboard-url          Print the dashboard login link (keep it private: it logs a browser in)
  dashboard-reset        Make a new login link; browsers logged in with the old one are logged out
  protect <repo>         (Re)apply branch protection on main: PRs only, factory checks required
  approve <task-id>      Approve a held destructive migration (exactly the change that was flagged)
  reject <task-id>       Reject it; the task is parked
  requeue <task-id>      Put a parked or blocked task back in the queue (e.g. "habit-tracker#12")
  cancel <task-id>       Cancel a task
`;

/**
 * Branch protection is an extra layer: agents can't push anyway (read-only tokens). GitHub offers it on private
 * repos only with a paid plan, so a refusal is reported and the project still works.
 */
async function tryProtect(app: Awaited<ReturnType<typeof createApp>>, project: Project): Promise<boolean> {
  const { gh } = await app.repoClient(project, { administration: 'write', metadata: 'read' });
  try {
    await gh.protectBranch(project.owner, project.id);
    return true;
  } catch (e) {
    if (e instanceof GitHubError && e.status === 403) {
      console.log('Branch protection not available (private repos need GitHub Pro). Agents have read-only tokens, so main is still only changed by the factory\'s own merges.');
      return false;
    }
    throw e;
  }
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { kind: { type: 'string', default: 'web-app' }, priority: { type: 'string', default: '3' } },
  });
  const [cmd, arg] = positionals;
  if (!cmd || cmd === 'help') return void console.log(HELP);

  const app = await createApp();
  const { store, config } = app;
  const now = app.now();

  switch (cmd) {
    case 'add-project': {
      if (!arg) throw new Error('Usage: add-project <repo>');
      const project = { id: arg, owner: config.github.owner, kind: values.kind as ProjectKind, state: 'active' as const, priority: Number(values.priority), createdAt: now };
      const { gh } = await app.repoClient(project, { metadata: 'read' });
      const topics = await gh.repoTopics(project.owner, project.id);
      if (!topics.includes(config.github.managedTopic)) {
        throw new Error(`${project.owner}/${project.id} lacks the "${config.github.managedTopic}" topic; the factory only touches repos that carry it.`);
      }
      const protectedNow = await tryProtect(app, project);
      store.upsertProject(project);
      store.setProjectState(project.id, 'active');
      console.log(`Added ${project.owner}/${project.id} (${project.kind}, priority ${project.priority}).${protectedNow ? ' main is protected.' : ''}`);
      break;
    }
    case 'dashboard-reset':
      store.setSetting('dashboardToken', null);
    // falls through
    case 'dashboard-url': {
      const token = dashboardToken(app);
      let host = '';
      try {
        const st = JSON.parse(execFileSync('tailscale', ['status', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })) as { Self?: { DNSName?: string } };
        host = (st.Self?.DNSName ?? '').replace(/\.$/, '');
      } catch {
        /* tailscale not available */
      }
      console.log(`On this Mac:  http://localhost:${config.dashboard.port}/login?t=${token}`);
      if (host) console.log(`Via Tailscale: https://${host}/login?t=${token}   (after: tailscale serve --bg ${config.dashboard.port})`);
      if (cmd === 'dashboard-reset') console.log('New link made; restart the orchestrator so it uses it.');
      break;
    }
    case 'protect': {
      if (!arg) throw new Error('Usage: protect <repo>');
      const project = store.projects().find((p) => p.id === arg) ?? { id: arg, owner: config.github.owner, kind: 'web-app' as const, state: 'active' as const, priority: 3, createdAt: now };
      if (await tryProtect(app, project)) console.log(`Protected ${project.owner}/${project.id} main.`);
      break;
    }
    case 'approve':
    case 'reject': {
      if (!arg) throw new Error(`Usage: ${cmd} <task-id>`);
      (cmd === 'approve' ? approveMigration : rejectMigration)(app, arg);
      console.log(`${arg}: ${cmd === 'approve' ? 'approved, back in review' : 'rejected, parked'}`);
      break;
    }
    case 'status': {
      for (const p of store.projects()) console.log(`project ${p.id}  ${p.state}  priority ${p.priority}`);
      const tasks = store.openTasks().sort((a, b) => a.state.localeCompare(b.state) || b.priority - a.priority);
      for (const t of tasks) {
        console.log(`${t.state.padEnd(10)} ${t.id.padEnd(30)} p${t.priority} ${t.risk.padEnd(6)} attempt ${t.attempt}${t.prNumber ? ` PR #${t.prNumber}` : ''}  ${t.title}`);
      }
      if (tasks.length === 0) console.log('No open tasks.');
      break;
    }
    case 'usage': {
      const u = store.latestUsage();
      if (!u) return void console.log('No usage reading yet.');
      const t = (s: number | null) => (s ? new Date(s * 1000).toLocaleString('en-GB', { timeZone: config.schedule.timezone }) : '?');
      console.log(`5-hour: ${u.fiveHourPct ?? '?'}% (resets ${t(u.fiveHourResetsAt)})`);
      console.log(`7-day:  ${u.sevenDayPct ?? '?'}% (resets ${t(u.sevenDayResetsAt)})`);
      console.log(`source ${u.source}, read ${t(u.takenAt)}`);
      break;
    }
    case 'pause': {
      const hours = Number(arg);
      if (!(hours > 0)) throw new Error('Usage: pause <hours>');
      store.setSetting('pausedUntil', String(now + Math.round(hours * 3600)));
      console.log(`Paused for ${hours} h. Running tasks finish; no new ones start.`);
      break;
    }
    case 'resume':
      store.setSetting('pausedUntil', null);
      console.log('Resumed.');
      break;
    case 'requeue':
    case 'cancel': {
      if (!arg) throw new Error(`Usage: ${cmd} <task-id>`);
      const t = store.transition(arg, cmd === 'requeue' ? 'queued' : 'cancelled', cmd === 'requeue' ? { fixRounds: 0 } : {});
      console.log(`${t.id} -> ${t.state}`);
      break;
    }
    default:
      console.log(HELP);
      process.exitCode = 1;
  }
  store.close();
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
