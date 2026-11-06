import { createApp, recoverInterrupted, syncIssues } from './app.ts';
import { runBuild } from './pipeline.ts';
import { killLeftoverContainers } from './runner/container.ts';
import { schedule } from './scheduler.ts';

const ISSUE_SYNC_EVERY_S = 300;

async function main(): Promise<void> {
  const app = await createApp();
  const { config, store } = app;
  const running = new Map<string, Promise<void>>();
  let stopping = false;
  let lastSync = 0;

  const recovered = recoverInterrupted(app);
  if (recovered.length) console.log(`Requeued interrupted tasks: ${recovered.join(', ')}`);

  const stop = () => {
    stopping = true;
    console.log(`Stopping: waiting for ${running.size} running task(s). Send SIGTERM again to exit now.`);
    process.once('SIGTERM', () => {
      killLeftoverContainers(); // don't leave agents running without an orchestrator
      process.exit(143);
    });
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);

  console.log(`Factory orchestrator started (tick ${config.schedule.tickSeconds}s).`);
  while (!stopping) {
    const now = app.now();
    if (now - lastSync >= ISSUE_SYNC_EVERY_S) {
      await syncIssues(app);
      lastSync = now;
    }

    const projects = store.projects();
    const pausedUntilRaw = store.getSetting('pausedUntil');
    const out = schedule(config.governor, {
      now,
      tasks: store.openTasks(),
      runningTaskIds: new Set(running.keys()),
      cancelledTaskIds: store.cancelledTaskIds(),
      activeProjects: new Set(projects.filter((p) => p.state === 'active').map((p) => p.id)),
      usage: store.latestUsage(),
      pausedUntil: pausedUntilRaw ? Number(pausedUntilRaw) : null,
      ownUseDetected: store.getSetting('ownUseDetected') === '1',
    });

    for (const { task, model } of out.picks) {
      const project = projects.find((p) => p.id === task.projectId)!;
      console.log(`Starting ${task.pendingMode} for ${task.id} on ${model}`);
      const p = runBuild(app, project, task, model)
        .catch((e: Error) => {
          console.error(`Run for ${task.id} crashed: ${e.stack ?? e.message}`);
          try {
            store.event('run.crash', task.id, { error: e.message });
            // Park instead of retrying blindly: an infrastructure error would otherwise repeat every tick.
            const current = store.task(task.id);
            if (current && ['queued', 'building', 'fixing'].includes(current.state)) {
              store.transition(task.id, 'parked', { lastFailure: `Orchestrator error: ${e.message}` });
              void app.notify('alert', `Parked ${task.id} after an orchestrator error: ${e.message}`);
            }
          } catch (inner) {
            console.error(`Could not park ${task.id}: ${(inner as Error).message}`);
          }
        })
        .finally(() => running.delete(task.id));
      running.set(task.id, p);
    }

    await new Promise((r) => setTimeout(r, config.schedule.tickSeconds * 1000));
  }

  await Promise.allSettled(running.values());
  store.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
