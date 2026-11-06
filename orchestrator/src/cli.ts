import { parseArgs } from 'node:util';
import { createApp } from './app.ts';
import type { ProjectKind } from './types.ts';

const HELP = `factory <command>

  add-project <repo> [--kind web-app|static-site|service|cli|ios] [--priority 1-5]
                         Register an existing repo (must carry the factory-managed topic) as an active project
  status                 Projects and open tasks by state
  usage                  Latest subscription usage reading
  pause <hours>          Start no new runs for <hours>
  resume                 Clear a pause
  requeue <task-id>      Put a parked or blocked task back in the queue (e.g. "habit-tracker#12")
  cancel <task-id>       Cancel a task
`;

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
      store.upsertProject(project);
      store.setProjectState(project.id, 'active');
      console.log(`Added ${project.owner}/${project.id} (${project.kind}, priority ${project.priority}).`);
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
