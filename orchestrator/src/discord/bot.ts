import { z } from 'zod';
import { ORCHESTRATOR_PERMISSIONS, type GitHub, type RepoPermissions } from '../github.ts';
import type { PipelineContext } from '../pipeline.ts';
import { answerQuestion, applyTimeouts, getQuestion, markPosted, openQuestions, unpostedQuestions, type Question } from '../questions.ts';
import { taskId as makeTaskId } from '../tasks.ts';
import type { Project } from '../types.ts';
import { digestText } from './digest.ts';
import { Gateway, INTENTS, type SocketFactory } from './gateway.ts';
import { clip, type ActionRow, type DiscordRest } from './rest.ts';

export const CHANNELS = {
  inbox: 'Send ideas and tasks here in plain words. The factory replies with what it did.',
  questions: 'Product questions from the agents. Tap an answer; no reply means the default after the timeout.',
  approvals: 'Destructive database changes waiting for your yes or no.',
  alerts: 'Parked tasks, reverts and factory problems.',
  digest: 'One summary a day.',
} as const;
export type ChannelName = keyof typeof CHANNELS;

/** What the intake agent (Haiku) makes of a free-text #inbox message. */
export const IntakeSchema = z.object({
  kind: z.enum(['task', 'new_project', 'answer', 'command', 'unclear']),
  project: z.string().optional(),
  title: z.string().optional(),
  body: z.string().optional(),
  questionId: z.number().int().optional(),
  answer: z.string().optional(),
  name: z.string().optional(),
  idea: z.string().optional(),
  reply: z.string().optional(),
});
export type Intake = z.infer<typeof IntakeSchema>;
export const INTAKE_JSON_SCHEMA = {
  type: 'object',
  required: ['kind'],
  properties: {
    kind: { type: 'string', enum: ['task', 'new_project', 'answer', 'command', 'unclear'] },
    project: { type: 'string', description: 'existing project id, for kind=task' },
    title: { type: 'string', description: 'issue title, for kind=task' },
    body: { type: 'string', description: 'issue body with an "Acceptance criteria" checklist, for kind=task' },
    questionId: { type: 'integer', description: 'open question id, for kind=answer' },
    answer: { type: 'string', description: 'for kind=answer' },
    name: { type: 'string', description: 'kebab-case repo name, for kind=new_project' },
    idea: { type: 'string', description: 'the idea in the owner\'s words, for kind=new_project' },
    reply: { type: 'string', description: 'clarifying question for kind=unclear, or a short note for kind=command' },
  },
};

export type IntakeRunner = (message: string, context: { projects: string[]; questions: { id: number; question: string }[] }) => Promise<Intake | null>;

export interface BotContext extends PipelineContext {
  repoClient(project: Project, permissions?: RepoPermissions): Promise<{ gh: GitHub; token: string }>;
}

export const COMMANDS = [
  { name: 'status', description: 'Projects and open tasks' },
  { name: 'usage', description: 'Subscription usage: 5-hour and 7-day windows' },
  { name: 'pause', description: 'Start no new runs for a while', options: [{ type: 10, name: 'hours', description: 'How long', required: true, min_value: 0.25, max_value: 168 }] },
  { name: 'resume', description: 'End a pause' },
  {
    name: 'task',
    description: 'Add a task to a project (becomes a GitHub issue)',
    options: [
      { type: 3, name: 'project', description: 'Project (repo name)', required: true },
      { type: 3, name: 'text', description: 'What to do, with acceptance criteria if you have them', required: true },
    ],
  },
  { name: 'retry', description: 'Retry a parked task', options: [{ type: 3, name: 'task', description: 'e.g. habit-tracker#12', required: true }] },
  {
    name: 'answer',
    description: 'Answer an open question in your own words',
    options: [
      { type: 4, name: 'id', description: 'Question number', required: true },
      { type: 3, name: 'text', description: 'Your answer', required: true },
    ],
  },
];

interface Interaction {
  id: string;
  token: string;
  type: number; // 2 = slash command, 3 = button
  channel_id?: string;
  member?: { user?: { id: string } };
  user?: { id: string };
  data?: { name?: string; custom_id?: string; options?: { name: string; value: string | number }[] };
  message?: { content?: string };
}

interface Message {
  id: string;
  channel_id: string;
  content: string;
  author: { id: string; bot?: boolean };
}

export class Bot {
  private readonly ctx: BotContext;
  private readonly rest: DiscordRest;
  private readonly guildId: string;
  private readonly ownerId: string;
  private readonly intake: IntakeRunner;
  private gateway: Gateway | null = null;
  private appId: string | null = null;
  readonly channels = new Map<ChannelName, string>();

  constructor(opts: { ctx: BotContext; rest: DiscordRest; guildId: string; ownerUserId: string; intake: IntakeRunner }) {
    this.ctx = opts.ctx;
    this.rest = opts.rest;
    this.guildId = opts.guildId;
    this.ownerId = opts.ownerUserId;
    this.intake = opts.intake;
  }

  /** Create missing channels, register slash commands, connect to the gateway. */
  async start(token: string, socketFactory?: SocketFactory): Promise<void> {
    this.appId = (await this.rest.application()).id;
    await this.ensureChannels();
    await this.rest.setGuildCommands(this.appId, this.guildId, COMMANDS);
    this.gateway = new Gateway({
      token,
      intents: INTENTS.GUILDS | INTENTS.GUILD_MESSAGES | INTENTS.MESSAGE_CONTENT,
      onDispatch: (event, data) => void this.dispatch(event, data).catch((e: Error) => console.error(`Discord event ${event} failed: ${e.message}`)),
      onFatal: (reason) => console.error(`Discord bot stopped: ${reason}`),
      log: (m) => console.log(`[discord] ${m}`),
      socketFactory,
    });
    this.gateway.start();
  }

  stop(): void {
    this.gateway?.stop();
  }

  async ensureChannels(): Promise<void> {
    const existing = await this.rest.guildChannels(this.guildId);
    for (const [name, topic] of Object.entries(CHANNELS) as [ChannelName, string][]) {
      const found = existing.find((c) => c.type === 0 && c.name === name);
      const id = found?.id ?? (await this.rest.createTextChannel(this.guildId, name, topic)).id;
      this.channels.set(name, id);
    }
  }

  private isOwner(userId: string | undefined): boolean {
    return userId === this.ownerId;
  }

  async dispatch(event: string, data: unknown): Promise<void> {
    if (event === 'INTERACTION_CREATE') return this.onInteraction(data as Interaction);
    if (event === 'MESSAGE_CREATE') return this.onMessage(data as Message);
  }

  // ---------- notifications ----------

  /** Alerts post right away (with a mention, so your phone buzzes). Info waits for the digest. */
  async notify(kind: 'question' | 'alert' | 'info', text: string): Promise<void> {
    if (kind === 'alert') {
      await this.post('alerts', `<@${this.ownerId}> ${text}`, [this.ownerId]);
    }
    // questions are posted by postPendingQuestions(), with buttons
  }

  private async post(channel: ChannelName, content: string, mentionUsers: string[] = [], components?: ActionRow[]) {
    const id = this.channels.get(channel);
    if (!id) throw new Error(`Channel #${channel} not set up`);
    return this.rest.send(id, { content: clip(content), components, allowed_mentions: { parse: [], users: mentionUsers } });
  }

  /** Called every tick: post new questions, apply timeouts, send the daily digest when it's due. */
  async tick(now: number, timezone: string, digestHour: number): Promise<void> {
    for (const q of unpostedQuestions(this.ctx)) {
      const channel: ChannelName = q.kind === 'migration' ? 'approvals' : 'questions';
      const msg = await this.post(channel, renderQuestion(q, timezone), [this.ownerId], questionButtons(q));
      markPosted(this.ctx, q.id, this.channels.get(channel)!, msg.id);
    }
    for (const t of applyTimeouts(this.ctx)) {
      const q = getQuestion(this.ctx, t.id);
      if (q?.discordChannelId && q.discordMessageId) {
        await this.rest.edit(q.discordChannelId, q.discordMessageId, { content: clip(`${renderQuestion(q, timezone)}\n\n**No reply in time: "${t.answer}"** applied. ${t.effect}.`), components: [] });
      }
    }
    const local = localParts(now, timezone);
    if (local.hour >= digestHour && this.ctx.store.getSetting('lastDigestDate') !== local.date) {
      this.ctx.store.setSetting('lastDigestDate', local.date);
      await this.post('digest', digestText(this.ctx.store, now, timezone));
    }
  }

  // ---------- interactions ----------

  private async onInteraction(i: Interaction): Promise<void> {
    const userId = i.member?.user?.id ?? i.user?.id;
    if (!this.isOwner(userId)) {
      await this.rest.respond(i.id, i.token, 4, { content: 'Only the factory owner can do that.' });
      return;
    }
    if (i.type === 3) return this.onButton(i);
    if (i.type !== 2 || !i.data?.name) return;
    const opt = (name: string) => i.data?.options?.find((o) => o.name === name)?.value;
    const reply = (content: string) => this.rest.respond(i.id, i.token, 4, { content: clip(content) });
    const store = this.ctx.store;
    switch (i.data.name) {
      case 'status':
        return void (await reply(statusText(this.ctx)));
      case 'usage':
        return void (await reply(usageText(this.ctx, this.timezone())));
      case 'pause': {
        const hours = Number(opt('hours'));
        store.setSetting('pausedUntil', String(this.ctx.now() + Math.round(hours * 3600)));
        return void (await reply(`Paused for ${hours} h. Running tasks finish; nothing new starts.`));
      }
      case 'resume':
        store.setSetting('pausedUntil', null);
        return void (await reply('Resumed.'));
      case 'retry': {
        const id = String(opt('task'));
        const t = store.task(id);
        if (!t) return void (await reply(`No task ${id}.`));
        if (t.state !== 'parked') return void (await reply(`${id} is ${t.state}, not parked.`));
        store.transition(id, 'queued', { fixRounds: 0, interruptions: 0, notBefore: null });
        return void (await reply(`${id} is back in the queue.`));
      }
      case 'answer': {
        const r = answerQuestion(this.ctx, Number(opt('id')), String(opt('text')), 'owner');
        if (r.ok) await this.closeQuestionMessage(Number(opt('id')), String(opt('text')), r.effect);
        return void (await reply(r.ok ? `Got it: ${r.effect}.` : r.reason));
      }
      case 'task': {
        // Creating the issue can take a few seconds: acknowledge first.
        await this.rest.respond(i.id, i.token, 5);
        const result = await this.createTask(String(opt('project')), String(opt('text')), null);
        await this.rest.followUp(this.appId!, i.token, result);
        return;
      }
    }
  }

  private async onButton(i: Interaction): Promise<void> {
    const m = /^q:(\d+):(\d+)$/.exec(i.data?.custom_id ?? '');
    if (!m) return;
    const q = getQuestion(this.ctx, Number(m[1]));
    const choice = q?.options[Number(m[2])];
    if (!q || choice === undefined) return void (await this.rest.respond(i.id, i.token, 4, { content: 'That question no longer exists.' }));
    const r = answerQuestion(this.ctx, q.id, choice, 'owner');
    const note = r.ok ? `**Answered: ${choice}.** ${r.effect}.` : r.reason;
    await this.rest.respond(i.id, i.token, 7, { content: clip(`${renderQuestion(q, this.timezone())}\n\n${note}`), components: [] });
  }

  private async closeQuestionMessage(id: number, answer: string, effect: string): Promise<void> {
    const q = getQuestion(this.ctx, id);
    if (q?.discordChannelId && q.discordMessageId) {
      await this.rest.edit(q.discordChannelId, q.discordMessageId, { content: clip(`${renderQuestion(q, this.timezone())}\n\n**Answered: ${answer}.** ${effect}.`), components: [] });
    }
  }

  private timezone(): string {
    return this.ctx.config.schedule.timezone;
  }

  // ---------- #inbox ----------

  private async onMessage(m: Message): Promise<void> {
    if (m.author.bot || m.channel_id !== this.channels.get('inbox')) return;
    if (!this.isOwner(m.author.id)) return; // ignore anyone else entirely
    const respond = (content: string) => this.rest.send(m.channel_id, { content: clip(content), message_reference: { message_id: m.id } });
    const projects = this.ctx.store.projects().filter((p) => p.state !== 'archived').map((p) => p.id);
    const questions = openQuestions(this.ctx).map((q) => ({ id: q.id, question: q.question }));
    let intake: Intake | null;
    try {
      intake = await this.intake(m.content, { projects, questions });
    } catch (e) {
      intake = null;
      console.error(`Intake failed: ${(e as Error).message}`);
    }
    if (!intake) return void (await respond("I couldn't read that one (the intake run failed or hit the usage limit). Try `/task` or `/answer`."));

    switch (intake.kind) {
      case 'task': {
        if (!intake.project || !projects.includes(intake.project)) {
          return void (await respond(`Which project is this for? Known projects: ${projects.join(', ') || 'none yet'}.`));
        }
        return void (await respond(await this.createTask(intake.project, intake.body ?? m.content, intake.title ?? null)));
      }
      case 'answer': {
        if (intake.questionId === undefined || !intake.answer) return void (await respond('Which question is that for? Use `/answer <id> <text>`.'));
        const r = answerQuestion(this.ctx, intake.questionId, intake.answer, 'owner');
        if (r.ok) await this.closeQuestionMessage(intake.questionId, intake.answer, r.effect);
        return void (await respond(r.ok ? `Recorded for question #${intake.questionId}: ${r.effect}.` : r.reason));
      }
      case 'new_project': {
        const name = (intake.name ?? 'new-project').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'new-project';
        this.ctx.store.db.prepare('INSERT INTO ideas (at, name, text) VALUES (?, ?, ?)').run(this.ctx.now(), name, intake.idea ?? m.content);
        return void (await respond(`Saved the idea as **${name}**. Turning ideas into a spec and a repo is the next milestone (M5); until then it waits in the ideas list.`));
      }
      case 'command':
        return void (await respond(intake.reply ?? 'Use the slash commands for that: /status, /usage, /pause, /resume, /retry.'));
      case 'unclear':
        return void (await respond(intake.reply ?? 'Could you say a bit more about what you want?'));
    }
  }

  /** Open a GitHub issue that the factory picks up (factory:ready). */
  async createTask(projectId: string, text: string, title: string | null): Promise<string> {
    const project = this.ctx.store.projects().find((p) => p.id === projectId);
    if (!project) return `No project called ${projectId}. Known: ${this.ctx.store.projects().map((p) => p.id).join(', ') || 'none'}.`;
    const issueTitle = (title ?? text.split('\n')[0]!).slice(0, 120);
    const { gh } = await this.ctx.repoClient(project, ORCHESTRATOR_PERMISSIONS);
    const issue = await gh.createIssue(project.owner, project.id, {
      title: issueTitle,
      body: `${text}\n\n_Added from Discord._`,
      labels: ['factory:ready', 'size:m'],
    });
    return `Created ${makeTaskId(project.id, issue.number)}: ${issue.html_url}. The factory picks it up within 5 minutes.`;
  }
}

// ---------- rendering (pure) ----------

export function questionButtons(q: Question): ActionRow[] {
  const opts = q.options.slice(0, 5);
  if (opts.length === 0) return [];
  return [
    {
      type: 1,
      components: opts.map((label, idx) => ({
        type: 2 as const,
        style: q.kind === 'migration' ? (label === 'approve' ? (3 as const) : (4 as const)) : label === q.defaultOption ? (1 as const) : (2 as const),
        label: label.slice(0, 80),
        custom_id: `q:${q.id}:${idx}`,
      })),
    },
  ];
}

export function renderQuestion(q: Question, timezone: string): string {
  const when = new Date(q.timeoutAt * 1000).toLocaleString('en-GB', { timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit' });
  const head = q.kind === 'migration' ? `**Approval needed** (#${q.id}, ${q.taskId})` : `**Question #${q.id}** from ${q.taskId ?? 'the factory'}`;
  const fallback = q.kind === 'migration' ? `No answer by ${when} means **reject**.` : `No answer by ${when} means **${q.defaultOption ?? 'the agent decides'}**. Or reply with \`/answer ${q.id} …\`.`;
  return `${head}\n${q.question}\n\n${fallback}`;
}

export function statusText(ctx: Pick<PipelineContext, 'store'>): string {
  const tasks = ctx.store.openTasks();
  const projects = ctx.store.projects();
  if (projects.length === 0) return 'No projects yet.';
  const lines = projects.map((p) => {
    const mine = tasks.filter((t) => t.projectId === p.id);
    const by = (s: string) => mine.filter((t) => t.state === s).length;
    return `**${p.id}** (${p.state}): ${mine.length} open — ${by('queued')} queued, ${by('building') + by('fixing')} building, ${by('in_review') + by('merging')} in review, ${by('blocked')} waiting on you, ${by('parked')} parked`;
  });
  const attention = tasks.filter((t) => t.state === 'parked' || t.state === 'blocked').map((t) => `- ${t.id} ${t.state}: ${t.title}${t.lastFailure ? ` (${t.lastFailure.split('\n')[0]!.slice(0, 120)})` : ''}`);
  const paused = ctx.store.getSetting('pausedUntil');
  return [paused && Number(paused) > Date.now() / 1000 ? '**Paused.**' : '', ...lines, attention.length ? `\nNeeds a look:\n${attention.join('\n')}` : ''].filter(Boolean).join('\n');
}

export function usageText(ctx: Pick<PipelineContext, 'store'>, timezone: string): string {
  const u = ctx.store.latestUsage();
  if (!u) return 'No usage reading yet (one arrives with the next agent run).';
  const t = (s: number | null) => (s ? new Date(s * 1000).toLocaleString('en-GB', { timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '?');
  return `5-hour window: **${u.fiveHourPct ?? '?'}%** (resets ${t(u.fiveHourResetsAt)})\n7-day window: **${u.sevenDayPct ?? '?'}%** (resets ${t(u.sevenDayResetsAt)})\nRead ${t(u.takenAt)}.`;
}

export function localParts(epochSeconds: number, timezone: string): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(epochSeconds * 1000));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
}
