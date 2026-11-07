import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildClaudeArgs } from '../claude.ts';
import type { PipelineContext } from '../pipeline.ts';
import { promptPath, roleConfig } from '../roles.ts';
import { runInContainer } from '../runner/container.ts';
import { snapshotAfterRun } from '../usage.ts';
import { INTAKE_JSON_SCHEMA, IntakeSchema, type IntakeRunner } from './bot.ts';

/** Classify an #inbox message with Haiku in an empty, tool-less container. Costs a fraction of a percent. */
export function containerIntake(ctx: PipelineContext): IntakeRunner {
  return async (message, context) => {
    const { config, store } = ctx;
    const role = roleConfig(config, 'intake');
    const work = mkdtempSync(join(tmpdir(), 'factory-intake-'));
    try {
      const prompt = [
        'Classify this message from the owner and fill in the fields for its kind.',
        `Existing projects: ${context.projects.join(', ') || 'none'}`,
        context.questions.length ? `Open questions:\n${context.questions.map((q) => `#${q.id}: ${q.question.split('\n')[0]}`).join('\n')}` : 'Open questions: none',
        '',
        'Message:',
        message.slice(0, 4000),
      ].join('\n');
      const args = buildClaudeArgs({
        prompt,
        model: role.model,
        effort: role.effort,
        maxTurns: role.maxTurns,
        appendSystemPromptFile: promptPath('intake'),
        jsonSchema: INTAKE_JSON_SCHEMA,
        disallowedTools: ['Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'NotebookEdit', 'Task'],
      });
      mkdirSync(config.paths.logs, { recursive: true });
      const logPath = join(config.paths.logs, `intake-${Date.now()}.jsonl`);
      const env = { [config.worker.claudeTokenEnv]: await ctx.secrets.get(config.worker.claudeTokenEnv) };
      const runId = store.startRun({ taskId: null, role: 'intake', model: role.model, logPath, usageBefore: store.latestUsage(), subject: 'intake' });
      const result = await runInContainer(
        {
          name: `factory-intake-${Date.now()}`,
          image: config.worker.image,
          worktree: work,
          readOnlyWork: true,
          workerConfigDir: config.paths.workerConfig,
          cpus: 1,
          memoryGb: 2,
          envNames: Object.keys(env),
          labels: { 'factory.role': 'intake' },
        },
        args,
        { env, timeoutMs: role.timeoutMinutes * 60_000, logPath },
      );
      store.finishRun(runId, result, result.resultText);
      const snap = snapshotAfterRun(store.latestUsage(), result, ctx.now());
      if (snap) store.recordUsage(snap);
      const parsed = IntakeSchema.safeParse(result.structuredOutput);
      return parsed.success ? parsed.data : null;
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  };
}
