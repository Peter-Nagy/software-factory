import { createApp, recoverInterrupted, stopAllRunners, syncIssues } from './app.ts';
import { runBuild } from './pipeline.ts';
import { startDashboard } from './dashboard/server.ts';
import { backupDue, runBackup } from './backup.ts';
import { localParts } from './discord/bot.ts';
import { digestText } from './discord/digest.ts';
import { pushFor, sendNtfy, type NotifyKind } from './push.ts';
import { Bot } from './discord/bot.ts';
import { containerIntake } from './discord/intake.ts';
import { DiscordRest } from './discord/rest.ts';
import { applyTimeouts } from './questions.ts';
import { ghRepoCreator } from './repo-create.ts';
import { REVIEW_COST_PCT, reviewModelGuess, runReviewStage } from './review.ts';
import { schedule, scheduleReviews } from './scheduler.ts';
import { recoverStudios, startQueuedPhases } from './studio.ts';

const ISSUE_SYNC_EVERY_S = 300;

async function main(): Promise<void> {
  const app = await createApp();
  const { config, store } = app;
  const running = new Map<string, Promise<void>>();
  const reviewing = new Map<string, string>(); // task id -> project id, for tasks in the review stage
  let stopping = false;
  let lastSync = 0;

  // Discord remote control (optional). Notifications fall back to the log when it's not configured.
  let bot: Bot | null = null;
  if (config.discord) {
    try {
      const token = await app.secrets.get(config.discord.botTokenSecret);
      bot = new Bot({ ctx: app, rest: new DiscordRest(token), guildId: config.discord.guildId, ownerUserId: config.discord.ownerUserId, intake: containerIntake(app) });
      await bot.start(token);
      const logNotify = app.notify;
      app.notify = async (kind, text) => {
        await logNotify(kind, text);
        await bot?.notify(kind, text).catch((e: Error) => console.error(`Discord notify failed: ${e.message}`));
      };
      console.log('Discord bot connected.');
    } catch (e) {
      bot = null;
      console.error(`Discord bot not started: ${(e as Error).message}`);
    }
  }

  // Phone push (optional): questions and alerts right away, the digest once a day when Discord isn't doing it.
  let pushDigest: ((now: number) => Promise<void>) | null = null;
  if (config.push) {
    try {
      const { server, topicSecret, info } = config.push.ntfy;
      const topic = await app.secrets.get(topicSecret);
      const publicUrl = config.dashboard.publicUrl ?? null;
      const send = (kind: NotifyKind, text: string) => {
        const m = pushFor(kind, text, { publicUrl, info });
        return m ? sendNtfy(server, topic, m).catch((e: Error) => console.error(`Push failed: ${e.message}`)) : Promise.resolve();
      };
      const before = app.notify;
      app.notify = async (kind, text) => {
        await before(kind, text);
        await send(kind, text);
      };
      if (!bot) {
        pushDigest = async (now) => {
          const local = localParts(now, config.schedule.timezone);
          if (local.hour < config.schedule.digestHourLocal || store.getSetting('lastPushDigestDate') === local.date) return;
          store.setSetting('lastPushDigestDate', local.date);
          const m = pushFor('alert', digestText(store, now, config.schedule.timezone).replace(/\*\*/g, ''), { publicUrl, info: true });
          if (m) await sendNtfy(server, topic, { ...m, priority: 3, tags: ['sunrise'] }).catch((e: Error) => console.error(`Push digest failed: ${e.message}`));
        };
      }
      console.log(`Push notifications on (${new URL(server).host}).`);
    } catch (e) {
      console.error(`Push notifications not started: ${(e as Error).message}`);
    }
  }

  const recovered = recoverInterrupted(app);
  recoverStudios(app);
  const studioWork = new Set<Promise<void>>(); // autopilot phases in flight

  let dashboard: Awaited<ReturnType<typeof startDashboard>> | null = null;
  if (config.dashboard.enabled) {
    try {
      const server = await startDashboard(app, { createRepo: ghRepoCreator(config.github.owner, config.github.managedTopic) });
      dashboard = server;
      process.once('exit', () => server.close());
      console.log(`Dashboard on http://127.0.0.1:${config.dashboard.port} (login link: factory dashboard-url)`);
    } catch (e) {
      console.error(`Dashboard not started: ${(e as Error).message}`);
    }
  }
  if (recovered.length) console.log(`Requeued interrupted tasks: ${recovered.join(', ')}`);

  const stop = () => {
    stopping = true;
    console.log(`Stopping: waiting for ${running.size} running task(s). Send SIGTERM again to exit now.`);
    process.once('SIGTERM', () => {
      stopAllRunners(app.config); // don't leave agents running without an orchestrator
      process.exit(143);
    });
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);

  let backingUp = false;
  console.log(`Factory orchestrator started (tick ${config.schedule.tickSeconds}s).`);
  while (!stopping) {
    const now = app.now();
    app.store.setSetting('heartbeat', String(now)); // GET /api/health reports it; ops/update.sh waits for a fresh one
    if (now - lastSync >= ISSUE_SYNC_EVERY_S) {
      await syncIssues(app);
      lastSync = now;
    }

    if (pushDigest) await pushDigest(now);
    if (bot) {
      await bot.tick(now, config.schedule.timezone, config.schedule.digestHourLocal).catch((e: Error) => console.error(`Discord tick failed: ${e.message}`));
    } else {
      for (const t of applyTimeouts(app)) console.log(`Question #${t.id} timed out; applied "${t.answer}": ${t.effect}`);
    }

    if (config.backup.enabled && !backingUp) {
      const last = store.getSetting('lastBackupAt');
      if (backupDue(last ? Number(last) : null, now, localParts(now, config.schedule.timezone).hour, config.backup.hourLocal)) {
        backingUp = true;
        store.setSetting('lastBackupAt', String(now)); // also on failure: retried tomorrow, not every tick
        runBackup(store, config, now, process.env.FACTORY_CONFIG)
          .then((b) => store.event('backup.done', null, { path: b.path, bytes: b.bytes, copies: b.copies }))
          .catch(async (e: Error) => {
            store.event('backup.failed', null, { error: e.message });
            await app.notify('alert', `Backup failed: ${e.message}`);
          })
          .finally(() => (backingUp = false));
      }
    }

    const projects = store.projects();
    const pausedUntilRaw = store.getSetting('pausedUntil');
    const base = {
      now,
      tasks: store.openTasks(),
      runningTaskIds: new Set(running.keys()),
      cancelledTaskIds: store.cancelledTaskIds(),
      activeProjects: new Set(projects.filter((p) => p.state === 'active').map((p) => p.id)),
      usage: store.latestUsage(),
      pausedUntil: pausedUntilRaw ? Number(pausedUntilRaw) : null,
      ownUseDetected: store.getSetting('ownUseDetected') === '1',
    };

    // Finish work before starting new work: review stages first.
    for (const { task } of scheduleReviews(config.governor, {
      ...base,
      reviewModel: reviewModelGuess,
      reviewCostPct: REVIEW_COST_PCT,
      runningProjects: new Set(reviewing.values()),
    })) {
      const project = projects.find((p) => p.id === task.projectId)!;
      console.log(`Reviewing ${task.id} (PR #${task.prNumber})`);
      const p = runReviewStage(app, project, task)
        .then((outcome) => console.log(`Review stage for ${task.id}: ${outcome}`))
        .catch((e: Error) => {
          console.error(`Review stage for ${task.id} crashed: ${e.stack ?? e.message}`);
          store.event('review.crash', task.id, { error: e.message });
          // Retry later; repeated crashes are counted and park the task.
          try {
            const t = store.task(task.id);
            if (t && t.state === 'merging') store.transition(task.id, 'in_review');
            const n = (t?.interruptions ?? 0) + 1;
            if (n >= 5 && t) {
              store.transition(task.id, 'parked', { interruptions: n, lastFailure: `Review stage error: ${e.message}` });
              void app.notify('alert', `Parked ${task.id} after repeated review-stage errors: ${e.message}`);
            } else {
              store.db.prepare('UPDATE tasks SET interruptions = ?, not_before = ? WHERE id = ?').run(n, app.now() + 300 * n, task.id);
            }
          } catch (inner) {
            console.error(`Could not record the error for ${task.id}: ${(inner as Error).message}`);
          }
        })
        .finally(() => {
          running.delete(task.id);
          reviewing.delete(task.id);
        });
      running.set(task.id, p);
      reviewing.set(task.id, task.projectId);
      base.runningTaskIds.add(task.id);
    }

    const out = schedule(config.governor, base);

    // Studio autopilot shares the budget with builds and reviews: everything in flight counts.
    if (!stopping) {
      const inFlight = [...running.keys(), ...studioWork].map(() => ({ estimatedCostPct: 3 }));
      for (const id of startQueuedPhases(app, inFlight, (work) => {
        studioWork.add(work);
        void work.finally(() => studioWork.delete(work));
      })) console.log(`Studio autopilot: started ${id}`);
    }

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

  // Stop taking dashboard requests before the database closes under them.
  dashboard?.close();
  dashboard?.closeAllConnections();
  await Promise.allSettled([...running.values(), ...studioWork]);
  bot?.stop();
  store.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
