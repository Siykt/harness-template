#!/usr/bin/env tsx
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { type ArgsDef, defineCommand, parseArgs as parseCittyArgs, type ParsedArgs, runMain } from 'citty';
import {
  agentProviders,
  buildProviderCommand,
  formatProviderCommand,
  resolveAgentProvider,
  type AgentProviderId
} from './agent-providers';
import { buildFeatureAgentDryRunPrompt, validateChoreCommitMessage, writeFeatureSpec } from './feature-agent';

interface FeatureSummary {
  id: string;
  title: string;
  status: string;
  priority: number;
  layer2Refs: string[];
}

interface DispatchDecision {
  feature: FeatureSummary;
  reason: string;
  runner: ProviderRunnerMode;
  task: string;
}

interface CommandResult {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

interface DispatcherRunResult {
  decision?: DispatchDecision;
  exitCode: number;
  previousStatus?: string;
  stopReason?: 'blocked' | 'no_work';
}

const DEFAULT_MAX_TURNS = '40';
const DEFAULT_PERMISSION_MODE = 'full_auto';
const DEFAULT_AGENT_PROVIDER: AgentProviderId = 'codex';
const DEFAULT_AGENT_BIN = agentProviders[DEFAULT_AGENT_PROVIDER].defaultBin;
const DEFAULT_LOOP_DELAY_MS = '1000';
const DEFAULT_MAX_LOOP_ITERATIONS = '0';
const DEFAULT_CODER_MODEL = 'gpt-5.5';
const DEFAULT_CODER_EFFORT = 'high';
const DEFAULT_CODER_TEMPERATURE = '0.3';
const DEFAULT_REVIEWER_MODEL = 'gpt-5.5';
const DEFAULT_REVIEWER_EFFORT = 'high';
const DEFAULT_REVIEWER_TEMPERATURE = '0';

type ProviderRunnerMode = 'coder' | 'reviewer';
type RunnerMode = ProviderRunnerMode | 'dispatcher' | 'feature';

interface CliOptions {
  task?: string;
  feature?: string;
  runner: RunnerMode;
  model?: string;
  effort?: string;
  temperature?: string;
  coderModel?: string;
  coderEffort?: string;
  coderTemperature?: string;
  reviewerModel?: string;
  reviewerEffort?: string;
  reviewerTemperature?: string;
  newFeatureId?: string;
  featureTitle?: string;
  featurePriority?: string;
  frontendProject: boolean;
  designSource?: string;
  commitMessage?: string;
  maxTurns: string;
  permissionMode: string;
  name?: string;
  agentProvider: AgentProviderId;
  agentBin: string;
  planDir: string;
  layer2Refs: string[];
  dryRun: boolean;
  loop: boolean;
  loopDelayMs: string;
  maxLoopIterations: string;
  skipInit: boolean;
  continueSession: boolean;
  resume?: string;
  outputFormat?: string;
  dangerouslySkipPermissions: boolean;
  extraAgentArgs: string[];
}

interface RunnerConfig {
  runner: ProviderRunnerMode;
  model?: string;
  effort?: string;
  temperature: string;
}

const cliArgs = {
  task: {
    type: 'string',
    alias: 't',
    description: 'Task for the selected agent provider. Optional for dispatcher auto-discovery.'
  },
  feature: {
    type: 'string',
    alias: 'f',
    description: 'Preferred active feature to focus on.'
  },
  runner: {
    type: 'enum',
    options: ['coder', 'reviewer', 'dispatcher', 'feature'],
    default: 'coder',
    description: 'Runner mode.'
  },
  model: {
    type: 'string',
    alias: 'm',
    description: 'Override model for the selected runner(s).'
  },
  effort: {
    type: 'string',
    description: 'Override effort for the selected runner(s).'
  },
  temperature: {
    type: 'string',
    description: 'Recorded in the plan; current Codex provider has no temperature flag.'
  },
  'coder-model': {
    type: 'string',
    description: `Dispatcher/coder model. Default: ${DEFAULT_CODER_MODEL}.`
  },
  'coder-effort': {
    type: 'string',
    description: `Dispatcher/coder effort. Default: ${DEFAULT_CODER_EFFORT}.`
  },
  'coder-temperature': {
    type: 'string',
    description: `Recorded in coder plan. Default: ${DEFAULT_CODER_TEMPERATURE}.`
  },
  'reviewer-model': {
    type: 'string',
    description: `Dispatcher/reviewer model. Default: ${DEFAULT_REVIEWER_MODEL}.`
  },
  'reviewer-effort': {
    type: 'string',
    description: `Dispatcher/reviewer effort. Default: ${DEFAULT_REVIEWER_EFFORT}.`
  },
  'reviewer-temperature': {
    type: 'string',
    description: `Recorded in reviewer plan. Default: ${DEFAULT_REVIEWER_TEMPERATURE}.`
  },
  'new-feature-id': {
    type: 'string',
    description: 'For --runner feature, the feature id to create, for example HT-004.'
  },
  'feature-title': {
    type: 'string',
    description: 'For --runner feature, the title to write into feature_list.json and docs/features.'
  },
  'feature-priority': {
    type: 'string',
    description: 'For --runner feature, the priority to write into feature_list.json.'
  },
  'frontend-project': {
    type: 'boolean',
    description: 'For --runner feature, require a Figma MCP link or original design file path.'
  },
  'design-source': {
    type: 'string',
    description: 'For --runner feature, Figma MCP link or original design file path for frontend work.'
  },
  'commit-message': {
    type: 'string',
    description: 'For --runner feature, proposed commit message. Must start with chore:.'
  },
  'max-turns': {
    type: 'string',
    default: DEFAULT_MAX_TURNS,
    description: 'Recorded in the plan; current Codex provider has no max-turns flag.'
  },
  'permission-mode': {
    type: 'string',
    default: DEFAULT_PERMISSION_MODE,
    description: 'Compatibility mode. full_auto maps to provider-specific full-auto execution when supported.'
  },
  name: {
    type: 'string',
    alias: 'n',
    description: 'Compatibility metadata; current provider execution does not use session names.'
  },
  'agent-provider': {
    type: 'enum',
    options: [...Object.keys(agentProviders)],
    default: DEFAULT_AGENT_PROVIDER,
    description: `Agent provider. Default: ${DEFAULT_AGENT_PROVIDER}.`
  },
  'agent-bin': {
    type: 'string',
    description: `Agent executable. Default follows --agent-provider; codex defaults to ${DEFAULT_AGENT_BIN}.`
  },
  'codex-bin': {
    type: 'string',
    description: 'Legacy alias for --agent-bin when --agent-provider codex is used.'
  },
  'oh-bin': {
    type: 'string',
    description: 'Deprecated legacy alias for --agent-bin when --agent-provider codex is used.'
  },
  'plan-dir': {
    type: 'string',
    default: 'docs/plans',
    description: 'Prompt output directory.'
  },
  'layer2-ref': {
    type: 'string',
    description: 'Additional explicit Layer 2 reference. Repeatable.'
  },
  dryRun: {
    type: 'boolean',
    description: 'Write the plan and print provider argv without executing.'
  },
  loop: {
    type: 'boolean',
    description: 'For dispatcher mode, keep dispatching until blocked, no work remains, or a guard stops the loop.'
  },
  'loop-delay-ms': {
    type: 'string',
    default: DEFAULT_LOOP_DELAY_MS,
    description: 'Delay between dispatcher loop iterations.'
  },
  'max-loop-iterations': {
    type: 'string',
    default: DEFAULT_MAX_LOOP_ITERATIONS,
    description: 'Maximum dispatcher loop iterations. 0 means unlimited.'
  },
  skipInit: {
    type: 'boolean',
    description: 'Skip local ./init.sh preflight.'
  },
  continue: {
    type: 'boolean',
    alias: 'c',
    description: 'Resume the latest provider session.'
  },
  resume: {
    type: 'string',
    alias: 'r',
    description: 'Resume a specific provider session.'
  },
  'output-format': {
    type: 'string',
    description: 'Use json to pass --json to the current Codex provider.'
  },
  dangerouslySkipPermissions: {
    type: 'boolean',
    description: 'Pass --dangerously-bypass-approvals-and-sandbox to the current Codex provider.'
  }
} satisfies ArgsDef;

const knownCliFlags = new Set([
  '--task',
  '-t',
  '--feature',
  '-f',
  '--runner',
  '--model',
  '-m',
  '--effort',
  '--temperature',
  '--coder-model',
  '--coder-effort',
  '--coder-temperature',
  '--reviewer-model',
  '--reviewer-effort',
  '--reviewer-temperature',
  '--new-feature-id',
  '--feature-title',
  '--feature-priority',
  '--frontend-project',
  '--frontendProject',
  '--design-source',
  '--commit-message',
  '--max-turns',
  '--permission-mode',
  '--name',
  '-n',
  '--agent-provider',
  '--agent-bin',
  '--codex-bin',
  '--oh-bin',
  '--plan-dir',
  '--layer2-ref',
  '--dry-run',
  '--dryRun',
  '--loop',
  '--loop-delay-ms',
  '--max-loop-iterations',
  '--skip-init',
  '--skipInit',
  '--continue',
  '-c',
  '--resume',
  '-r',
  '--output-format',
  '--dangerously-skip-permissions',
  '--dangerouslySkipPermissions'
]);

function isKnownCliFlag(arg: string): boolean {
  const [flag] = arg.split('=', 1);
  return knownCliFlags.has(flag as string);
}

function splitForwardedArgs(argv: string[]): { cliArgs: string[]; extraAgentArgs: string[] } {
  let normalized = argv[0] === '--' ? argv.slice(1) : argv;
  const firstSeparatorIndex = normalized.indexOf('--');
  if (firstSeparatorIndex > 0 && normalized.slice(firstSeparatorIndex + 1).some(isKnownCliFlag))
    normalized = [...normalized.slice(0, firstSeparatorIndex), ...normalized.slice(firstSeparatorIndex + 1)];

  const separatorIndex = normalized.indexOf('--');
  if (separatorIndex < 0) return { cliArgs: normalized, extraAgentArgs: [] };

  return {
    cliArgs: normalized.slice(0, separatorIndex),
    extraAgentArgs: normalized.slice(separatorIndex + 1)
  };
}

function collectRepeatedValues(argv: string[], optionName: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === optionName) {
      const value = argv[++i];
      if (!value) throw new Error(`Missing value for ${optionName}`);
      values.push(value);
      continue;
    }

    if (arg?.startsWith(`${optionName}=`)) values.push(arg.slice(optionName.length + 1));
  }
  return values;
}

function collectLastValue(argv: string[], optionName: string): string | undefined {
  return collectRepeatedValues(argv, optionName).at(-1);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parseNonNegativeInteger(value: string, optionName: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${optionName} must be a non-negative integer, got: ${value}`);
  return Number(value);
}

function toCliOptions(args: ParsedArgs<typeof cliArgs>, rawCliArgs: string[], extraAgentArgs: string[]): CliOptions {
  const task = String(args.task ?? args._.join(' ')).trim();
  const runner = args.runner as RunnerMode;
  if (!task && runner !== 'dispatcher') throw new Error('Missing task. Use --task "..." or pass the task as trailing args.');
  const agentProvider = resolveAgentProvider(String(args.agentProvider ?? DEFAULT_AGENT_PROVIDER));
  const legacyBin = collectLastValue(rawCliArgs, '--codex-bin') ?? collectLastValue(rawCliArgs, '--oh-bin');
  if (legacyBin && agentProvider !== 'codex')
    throw new Error('Legacy --codex-bin/--oh-bin aliases are only valid with --agent-provider codex. Use --agent-bin instead.');

  return {
    task: task || undefined,
    feature: optionalString(args.feature),
    runner,
    model: optionalString(args.model),
    effort: optionalString(args.effort),
    temperature: optionalString(args.temperature),
    coderModel: optionalString(args.coderModel),
    coderEffort: optionalString(args.coderEffort),
    coderTemperature: optionalString(args.coderTemperature),
    reviewerModel: optionalString(args.reviewerModel),
    reviewerEffort: optionalString(args.reviewerEffort),
    reviewerTemperature: optionalString(args.reviewerTemperature),
    newFeatureId: optionalString(args.newFeatureId),
    featureTitle: optionalString(args.featureTitle),
    featurePriority: optionalString(args.featurePriority),
    frontendProject: Boolean(args.frontendProject),
    designSource: optionalString(args.designSource),
    commitMessage: optionalString(args.commitMessage),
    maxTurns: String(args.maxTurns),
    permissionMode: String(args.permissionMode),
    name: optionalString(args.name),
    agentProvider,
    agentBin:
      collectLastValue(rawCliArgs, '--agent-bin') ??
      legacyBin ??
      optionalString(args.agentBin) ??
      agentProviders[agentProvider].defaultBin,
    planDir: String(args.planDir),
    layer2Refs: collectRepeatedValues(rawCliArgs, '--layer2-ref'),
    dryRun: Boolean(args.dryRun),
    loop: Boolean(args.loop),
    loopDelayMs: String(args.loopDelayMs),
    maxLoopIterations: String(args.maxLoopIterations),
    skipInit: Boolean(args.skipInit),
    continueSession: Boolean(args.continue),
    resume: optionalString(args.resume),
    outputFormat: optionalString(args.outputFormat),
    dangerouslySkipPermissions: Boolean(args.dangerouslySkipPermissions),
    extraAgentArgs
  };
}

function run(command: string, args: string[], cwd: string, timeoutMs = 120_000): CommandResult {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 20 * 1024 * 1024
  });

  return {
    command: [command, ...args].join(' '),
    exitCode: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? ''
  };
}

function readText(path: string): string {
  return readFileSync(path, 'utf8');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatLocalDate(date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

function writePlanFile(cwd: string, planDir: string, prompt: string, runner: string): string {
  const absoluteDir = resolve(cwd, planDir);
  mkdirSync(absoluteDir, { recursive: true });

  const date = formatLocalDate();
  const escapedDate = date.replaceAll('-', '\\-');
  const escapedRunner = runner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^plan-${date.replaceAll('-', '\\-')}-${escapedRunner}-(\\d{3})\\.md$`);
  const legacyPattern = new RegExp(`^plan-${escapedDate}-(\\d{3})\\.md$`);
  const usedCounts = readdirSync(absoluteDir)
    .map(file => pattern.exec(file)?.[1] ?? legacyPattern.exec(file)?.[1])
    .filter((count): count is string => Boolean(count))
    .map(count => Number(count));
  const nextCount = Math.max(0, ...usedCounts) + 1;
  const fileName = `plan-${date}-${runner}-${String(nextCount).padStart(3, '0')}.md`;
  const absolutePath = join(absoluteDir, fileName);
  writeFileSync(absolutePath, `${prompt.trimEnd()}\n`, 'utf8');
  return absolutePath;
}

function tailLines(text: string, maxLines: number): string {
  const lines = text.trimEnd().split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - maxLines)).join('\n');
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars || maxChars === 0) return text;
  return `${text.slice(0, maxChars)}\n...[truncated ${text.length - maxChars} chars]`;
}

function extractCurrentStatusAndLatestSession(progress: string): string {
  const statusStart = progress.indexOf('## 当前已验证状态');
  const statusEnd = progress.indexOf('## 会话记录', statusStart);
  const status =
    statusStart >= 0 ? progress.slice(statusStart, statusEnd >= 0 ? statusEnd : statusStart + 2000) : progress.slice(0, 2000);

  const latestIdx = progress.lastIndexOf('### Session');
  const latest = latestIdx >= 0 ? progress.slice(latestIdx) : '';
  return `${status.trim()}\n\n--- latest session ---\n${truncate(latest.trim(), 9000)}`;
}

function parseFeatureSummaries(raw: string): FeatureSummary[] {
  const parsed = JSON.parse(raw) as { features?: Array<Record<string, unknown>> };
  return (parsed.features ?? []).map(feature => ({
    id: String(feature.id ?? ''),
    title: String(feature.title ?? ''),
    status: String(feature.status ?? ''),
    priority: Number(feature.priority ?? 999),
    layer2Refs: Array.isArray(feature.layer2_refs) ? feature.layer2_refs.map(ref => String(ref)) : []
  }));
}

function readFeatureSummaries(): FeatureSummary[] {
  return parseFeatureSummaries(readText('feature_list.json'));
}

function featureById(features: FeatureSummary[], id: string): FeatureSummary | undefined {
  return features.find(feature => feature.id === id);
}

function findBlockedFeature(features: FeatureSummary[], requested?: string): FeatureSummary | undefined {
  if (requested) {
    const feature = featureById(features, requested);
    return feature?.status === 'blocked' ? feature : undefined;
  }

  return features.filter(feature => feature.status === 'blocked').sort(byPriorityThenId)[0];
}

function selectFeature(features: FeatureSummary[], requested?: string): FeatureSummary | undefined {
  if (requested) {
    const found = features.find(feature => feature.id === requested);
    if (!found) throw new Error(`Requested feature not found: ${requested}`);
    return found;
  }

  const active = features.filter(feature => feature.status === 'in_progress');
  if (active.length > 1) throw new Error(`Multiple in_progress features found: ${active.map(feature => feature.id).join(', ')}`);
  if (active.length === 1) return active[0];

  return [...features].filter(feature => feature.status !== 'passing').sort((a, b) => a.priority - b.priority)[0];
}

function byPriorityThenId(a: FeatureSummary, b: FeatureSummary): number {
  return a.priority - b.priority || a.id.localeCompare(b.id);
}

function dispatchTaskFor(feature: FeatureSummary, runner: ProviderRunnerMode, requestedTask?: string): string {
  const statusContract =
    runner === 'coder'
      ? [
          `Dispatcher selected feature ${feature.id} (${feature.status}) - ${feature.title}.`,
          'Implement the feature end to end.',
          'When implementation and required local validation are complete, update feature_list.json status to pending_review and record evidence.',
          'If you cannot complete it, set the feature status to blocked and append a blocked report with exact cause, evidence, and restart instructions.'
        ]
      : [
          `Dispatcher selected feature ${feature.id} (${feature.status}) - ${feature.title}.`,
          'Review the pending feature with a strict acceptance-gate stance.',
          'If the evidence and implementation are acceptable, update feature_list.json status to passing and record review evidence.',
          'If not acceptable, set the feature status to blocked and append a blocked report with exact cause, evidence, and restart instructions.'
        ];

  if (requestedTask) return `${requestedTask}\n\nDispatcher status contract:\n- ${statusContract.join('\n- ')}`;

  return statusContract.join('\n');
}

function decideDispatch(features: FeatureSummary[], opts: CliOptions): DispatchDecision | undefined {
  if (opts.feature) {
    const feature = featureById(features, opts.feature);
    if (!feature) throw new Error(`Requested feature not found: ${opts.feature}`);

    if (feature.status === 'blocked') {
      console.error(`[agent.ts] dispatcher stopped: requested feature is blocked: ${feature.id}`);
      console.error('[agent.ts] Resolve the blocked report before dispatching new work.');
      return undefined;
    }
    if (feature.status === 'passing') {
      console.error(`[agent.ts] dispatcher stopped: requested feature is already passing: ${feature.id}`);
      return undefined;
    }

    const runner = feature.status === 'pending_review' ? 'reviewer' : 'coder';
    return {
      feature,
      runner,
      reason: `explicit feature ${feature.id} status=${feature.status}`,
      task: dispatchTaskFor(feature, runner, opts.task)
    };
  }

  const blocked = findBlockedFeature(features);
  if (blocked) {
    console.error(`[agent.ts] dispatcher stopped: blocked feature present: ${blocked.id}`);
    console.error('[agent.ts] Resolve the blocked report before dispatching new work.');
    return undefined;
  }

  const pendingReview = features.filter(feature => feature.status === 'pending_review').sort(byPriorityThenId)[0];
  if (pendingReview) {
    return {
      feature: pendingReview,
      runner: 'reviewer',
      reason: `auto-discovered pending_review feature ${pendingReview.id}`,
      task: dispatchTaskFor(pendingReview, 'reviewer', opts.task)
    };
  }

  const notStarted = features.filter(feature => feature.status === 'not_started').sort(byPriorityThenId)[0];
  if (notStarted) {
    return {
      feature: notStarted,
      runner: 'coder',
      reason: `auto-discovered not_started feature ${notStarted.id}`,
      task: dispatchTaskFor(notStarted, 'coder', opts.task)
    };
  }

  const inProgress = features.filter(feature => feature.status === 'in_progress').sort(byPriorityThenId)[0];
  if (inProgress) {
    console.error(`[agent.ts] dispatcher stopped: only in_progress work remains (${inProgress.id}).`);
    console.error('[agent.ts] Pass --feature explicitly if you want dispatcher to continue that feature with the coder.');
    return undefined;
  }

  console.error('[agent.ts] dispatcher stopped: no not_started or pending_review features found.');
  return undefined;
}

function resolveLayer2Docs(cwd: string, feature: FeatureSummary | undefined, extraRefs: string[]): string[] {
  if (!feature) return [];
  if (feature.layer2Refs.length === 0 && extraRefs.length === 0) {
    throw new Error(
      `Feature ${feature.id} is missing layer2_refs. Add explicit Layer 2 docs in feature_list.json or pass --layer2-ref.`
    );
  }

  const docs = [...new Set([...feature.layer2Refs, ...extraRefs])];
  for (const doc of docs) {
    if (!existsSync(resolve(cwd, doc))) throw new Error(`Layer 2 reference does not exist: ${doc}`);
  }
  return docs;
}

function formatFeatureSummaries(features: FeatureSummary[]): string {
  return features
    .map(
      feature =>
        `- ${feature.id} | ${feature.status} | P${feature.priority} | ${feature.title} | layer2_refs=${feature.layer2Refs.join(', ') || 'missing'}`
    )
    .join('\n');
}

function buildPrompt(params: {
  cwd: string;
  task: string;
  runnerConfig: RunnerConfig;
  generatedAt: string;
  agents: string;
  contextGate: string;
  gitLog: CommandResult;
  initResult?: CommandResult;
  progressSummary: string;
  features: FeatureSummary[];
  selectedFeature?: FeatureSummary;
  layer2: Array<{ path: string; text: string }>;
}) {
  const initBlock = params.initResult
    ? `exit=${params.initResult.exitCode}\n${tailLines(`${params.initResult.stdout}\n${params.initResult.stderr}`, 80)}`
    : 'Skipped by agent.ts --skip-init.';

  const selected = params.selectedFeature
    ? `${params.selectedFeature.id} (${params.selectedFeature.status}) - ${params.selectedFeature.title}`
    : 'none';

  const layer2Block = params.layer2.map(doc => `### ${doc.path}\n${truncate(doc.text, 0)}`).join('\n\n');

  const runnerContract =
    params.runnerConfig.runner === 'coder'
      ? `You are the CODER runner.

- Implement the requested change end to end.
- Make scoped code/documentation edits where needed.
- Favor practical implementation exploration. Target temperature: ${params.runnerConfig.temperature}.
- Run the smallest useful checks first, then the repository-required checks before finishing.
- Update progress/tracker files and commit when AGENTS.md requires it.
- If you finish implementation and validation, set the selected feature to pending_review, not passing.
- If you are blocked, set the selected feature to blocked and write a blocked report with cause, evidence, and restart instructions.`
      : `You are the REVIEWER runner.

- Take a code-review and acceptance-gate stance.
- Be strict, deterministic, and evidence-driven. Target temperature: ${params.runnerConfig.temperature}.
- Prioritize bugs, regressions, missing tests, unsafe state transitions, and evidence gaps.
- Do not make broad implementation changes. Only edit progress/tracker files if you are recording review evidence, blockers, or checklist results.
- If the work is acceptable, set the selected feature to passing with command evidence.
- If not acceptable, set the selected feature to blocked and write a blocked report with exact blockers.`;

  return `# Codex Runner Plan

- Generated at: ${params.generatedAt}
- Runner: ${params.runnerConfig.runner}
- Model: ${params.runnerConfig.model ?? 'default'}
- Effort: ${params.runnerConfig.effort ?? 'default'}
- Target temperature: ${params.runnerConfig.temperature}
- Repository: ${params.cwd}
- Selected feature: ${selected}
- User task: ${params.task}
- Routed docs: ${params.layer2.map(doc => doc.path).join(', ') || 'none'}

---

You are Codex running inside ${params.cwd}.

The user task is:
${params.task}

This prompt was generated by agent.ts. It has already split the repository AGENTS.md protocol into bounded context sections. Follow the repository rules exactly and continue from the evidence below rather than restarting from scratch.

## Runner Contract

${runnerContract}

## Required Operating Contract

- Work in repo root: ${params.cwd}
- Respect AGENTS.md and CONTEXT-GATE.md.
- Keep exactly one active feature. The selected feature for this run is: ${selected}
- If the selected feature is not the correct one, update feature tracking explicitly before changing production code.
- Do not hide incomplete work by weakening tests or marking features passing without evidence.
- Before finishing, update claude-progress.md and feature_list.json when required by AGENTS.md.
- Before finishing, read evaluator-rubric.md and clean-state-checklist.md and record the required PASS/FAIL evidence.
- If pnpm build passes, commit the completed work.

## Layer 0: AGENTS.md

${truncate(params.agents, 9000)}

## Layer 0: CONTEXT-GATE.md

${truncate(params.contextGate, 9000)}

## Preflight Evidence

### pwd
${params.cwd}

### git log --oneline -5
exit=${params.gitLog.exitCode}
${params.gitLog.stdout.trim()}
${params.gitLog.stderr.trim()}

### ./init.sh
${initBlock}

## Layer 1: claude-progress.md summary

${params.progressSummary}

## Layer 1: feature_list.json summaries

${formatFeatureSummaries(params.features)}

## Layer 2: routed docs

${layer2Block}

## Execution Request

Perform the user task now. Be autonomous: inspect only the files needed, implement changes, verify, update progress/tracker, and commit when appropriate.`;
}

function buildProviderInstruction(cwd: string, planPath: string): string {
  const repoRelativePlanPath = relative(cwd, planPath);
  return `Read ${repoRelativePlanPath} and execute the plan exactly. Use that file as the full prompt/context; do not ask me to paste it again.`;
}

function runnerDefaults(opts: CliOptions, runner: ProviderRunnerMode): RunnerConfig {
  if (runner === 'coder') {
    return {
      runner,
      model: opts.model ?? opts.coderModel ?? DEFAULT_CODER_MODEL,
      effort: opts.effort ?? opts.coderEffort ?? DEFAULT_CODER_EFFORT,
      temperature: opts.temperature ?? opts.coderTemperature ?? DEFAULT_CODER_TEMPERATURE
    };
  }

  return {
    runner,
    model: opts.model ?? opts.reviewerModel ?? DEFAULT_REVIEWER_MODEL,
    effort: opts.effort ?? opts.reviewerEffort ?? DEFAULT_REVIEWER_EFFORT,
    temperature: opts.temperature ?? opts.reviewerTemperature ?? DEFAULT_REVIEWER_TEMPERATURE
  };
}

function withRunnerConfig(opts: CliOptions, config: RunnerConfig): CliOptions {
  return {
    ...opts,
    runner: config.runner,
    model: config.model,
    effort: config.effort
  };
}

function makeRunnerTask(task: string, runner: RunnerConfig['runner']): string {
  if (runner === 'coder') return task;

  return `Review and acceptance-check the coder work for this task: ${task}`;
}

async function spawnAgentProvider(command: string, args: string[], cwd: string): Promise<number> {
  return new Promise(resolveExit => {
    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
      env: process.env
    });
    child.on('close', code => resolveExit(code ?? 1));
    child.on('error', error => {
      console.error(`[agent.ts] failed to start ${command}: ${error.message}`);
      resolveExit(1);
    });
  });
}

function loadRunContext(opts: CliOptions, cwd: string, selectedFeatureOverride?: FeatureSummary) {
  const agents = readText('AGENTS.md');
  const contextGate = readText('CONTEXT-GATE.md');
  const gitLog = run('git', ['log', '--oneline', '-5'], cwd);
  const initResult = opts.skipInit ? undefined : run('./init.sh', [], cwd, 180_000);
  if (initResult && initResult.exitCode !== 0) {
    console.error(
      '[agent.ts] ./init.sh failed. The generated prompt will include the failure, but Codex will not be launched automatically.'
    );
    console.error(tailLines(`${initResult.stdout}\n${initResult.stderr}`, 80));
    process.exit(1);
  }

  const progressSummary = extractCurrentStatusAndLatestSession(readText('claude-progress.md'));
  const features = parseFeatureSummaries(readText('feature_list.json'));
  const selectedFeature = selectedFeatureOverride ?? selectFeature(features, opts.feature);
  const layer2 = resolveLayer2Docs(cwd, selectedFeature, opts.layer2Refs).map(path => ({
    path,
    text: readText(path)
  }));

  return {
    agents,
    contextGate,
    gitLog,
    initResult,
    progressSummary,
    features,
    selectedFeature,
    layer2
  };
}

async function runHarness(
  opts: CliOptions,
  cwd: string,
  runnerConfig: RunnerConfig,
  selectedFeatureOverride?: FeatureSummary,
  taskOverride?: string
): Promise<number> {
  const context = loadRunContext(opts, cwd, selectedFeatureOverride);
  const baseTask = taskOverride ?? opts.task;
  if (!baseTask) throw new Error(`Missing task for ${runnerConfig.runner} runner.`);
  const runnerTask = makeRunnerTask(baseTask, runnerConfig.runner);
  const prompt = buildPrompt({
    cwd,
    task: runnerTask,
    runnerConfig,
    generatedAt: new Date().toISOString(),
    agents: context.agents,
    contextGate: context.contextGate,
    gitLog: context.gitLog,
    initResult: context.initResult,
    progressSummary: context.progressSummary,
    features: context.features,
    selectedFeature: context.selectedFeature,
    layer2: context.layer2
  });

  const runnerOpts = withRunnerConfig(opts, runnerConfig);
  const planPath = writePlanFile(cwd, opts.planDir, prompt, runnerConfig.runner);
  const providerInstruction = buildProviderInstruction(cwd, planPath);
  const providerCommand = buildProviderCommand({
    provider: runnerOpts.agentProvider,
    agentBin: runnerOpts.agentBin,
    permissionMode: runnerOpts.permissionMode,
    defaultPermissionMode: DEFAULT_PERMISSION_MODE,
    model: runnerOpts.model,
    outputFormat: runnerOpts.outputFormat,
    dangerouslySkipPermissions: runnerOpts.dangerouslySkipPermissions,
    continueSession: runnerOpts.continueSession,
    resume: runnerOpts.resume,
    cwd,
    instruction: providerInstruction,
    extraAgentArgs: runnerOpts.extraAgentArgs
  });
  if (opts.dryRun) {
    console.log(`[agent.ts] cwd=${cwd}`);
    console.log(
      `[agent.ts] runner=${runnerConfig.runner} model=${runnerConfig.model ?? '-'} effort=${runnerConfig.effort ?? '-'} temperature=${runnerConfig.temperature}`
    );
    console.log(`[agent.ts] agentProvider=${runnerOpts.agentProvider} agentBin=${runnerOpts.agentBin}`);
    console.log(
      `[agent.ts] selectedFeature=${context.selectedFeature?.id ?? 'none'} status=${context.selectedFeature?.status ?? '-'}`
    );
    console.log(`[agent.ts] layer2=${context.layer2.map(doc => doc.path).join(', ')}`);
    console.log(`[agent.ts] plan=${relative(cwd, planPath)}`);
    console.log(`[agent.ts] command=${formatProviderCommand(providerCommand)}`);
    console.log('\nPrompt written to the plan file above. Re-run without --dry-run to launch the selected provider.');
    return 0;
  }

  console.log(`[agent.ts] wrote plan ${relative(cwd, planPath)}`);
  console.log(
    `[agent.ts] launching ${basename(providerCommand.command)} provider=${runnerOpts.agentProvider} runner=${runnerConfig.runner} feature=${context.selectedFeature?.id ?? 'none'} with ${context.layer2.length} routed docs`
  );
  return spawnAgentProvider(providerCommand.command, providerCommand.args, cwd);
}

async function runDispatcherOnce(opts: CliOptions, cwd: string, iteration?: number): Promise<DispatcherRunResult> {
  const features = readFeatureSummaries();
  const blocked = findBlockedFeature(features, opts.feature);
  if (blocked) {
    console.error(`[agent.ts] dispatcher stopped: blocked feature present: ${blocked.id}`);
    console.error('[agent.ts] Resolve the blocked report before dispatching new work.');
    return {
      exitCode: 1,
      stopReason: 'blocked'
    };
  }

  const decision = decideDispatch(features, opts);
  if (!decision) {
    return {
      exitCode: 1,
      stopReason: 'no_work'
    };
  }

  const prefix = iteration === undefined ? 'dispatcher decision' : `dispatcher loop iteration=${iteration}`;
  console.log(`[agent.ts] ${prefix}: ${decision.reason} -> ${decision.runner}`);
  const dispatchOpts = {
    ...opts,
    feature: decision.feature.id
  };
  const exitCode = await runHarness(
    dispatchOpts,
    cwd,
    runnerDefaults(dispatchOpts, decision.runner),
    decision.feature,
    decision.task
  );
  return {
    decision,
    exitCode,
    previousStatus: decision.feature.status
  };
}

async function runDispatcherLoop(opts: CliOptions, cwd: string): Promise<number> {
  const maxIterations = parseNonNegativeInteger(opts.maxLoopIterations, '--max-loop-iterations');
  const delayMs = parseNonNegativeInteger(opts.loopDelayMs, '--loop-delay-ms');
  let iteration = 0;

  while (true) {
    if (maxIterations > 0 && iteration >= maxIterations) {
      console.log(`[agent.ts] dispatcher loop stopped: reached --max-loop-iterations=${maxIterations}`);
      return 0;
    }

    iteration += 1;
    const result = await runDispatcherOnce(opts, cwd, iteration);
    if (result.stopReason === 'blocked') return 1;
    if (result.stopReason === 'no_work') {
      console.log('[agent.ts] dispatcher loop stopped: no dispatchable feature remains.');
      return 0;
    }
    if (result.exitCode !== 0) return result.exitCode;
    if (opts.dryRun) {
      console.log('[agent.ts] dispatcher loop dry-run stops after one planned iteration to avoid repeating unchanged state.');
      return 0;
    }

    const decision = result.decision;
    if (!decision) return 1;

    const updatedFeature = featureById(readFeatureSummaries(), decision.feature.id);
    if (!updatedFeature) {
      console.error(`[agent.ts] dispatcher loop stopped: feature disappeared after run: ${decision.feature.id}`);
      return 1;
    }
    if (updatedFeature.status === 'blocked') {
      console.error(`[agent.ts] dispatcher loop stopped: feature became blocked: ${updatedFeature.id}`);
      return 1;
    }
    if (updatedFeature.status === result.previousStatus) {
      console.error(
        `[agent.ts] dispatcher loop stopped: feature status did not change after successful run: ${updatedFeature.id} status=${updatedFeature.status}`
      );
      console.error('[agent.ts] This guard prevents repeatedly dispatching the same unfinished state.');
      return 1;
    }

    console.log(
      `[agent.ts] dispatcher loop transition: ${updatedFeature.id} ${result.previousStatus} -> ${updatedFeature.status}`
    );
    if (delayMs > 0) await sleep(delayMs);
  }
}

async function runFeatureAgent(opts: CliOptions, cwd: string): Promise<number> {
  if (opts.commitMessage) validateChoreCommitMessage(opts.commitMessage);

  if (opts.dryRun) {
    console.log(buildFeatureAgentDryRunPrompt());
    console.log(`[agent.ts] cwd=${cwd}`);
    console.log('[agent.ts] runner=feature');
    console.log(`[agent.ts] targetFeature=${opts.newFeatureId ?? opts.feature ?? '<required for write>'}`);
    console.log(`[agent.ts] featureTitle=${opts.featureTitle ?? opts.name ?? '<required for write>'}`);
    console.log(`[agent.ts] featurePriority=${opts.featurePriority ?? '<required for write>'}`);
    console.log('[agent.ts] dry-run only; no docs/features file or feature_list.json entry was written.');
    return 0;
  }

  const targetFeatureId = opts.newFeatureId ?? opts.feature;
  const title = opts.featureTitle ?? opts.name;
  if (!targetFeatureId) throw new Error('Missing target feature id. Use --new-feature-id HT-004 with --runner feature.');
  if (!title) throw new Error('Missing feature title. Use --feature-title "..." with --runner feature.');
  if (!opts.featurePriority) throw new Error('Missing feature priority. Use --feature-priority N with --runner feature.');
  if (!opts.task) throw new Error('Missing feature requirement. Use --task "..." with --runner feature.');

  const result = writeFeatureSpec(
    cwd,
    {
      id: targetFeatureId,
      title,
      requirement: opts.task,
      priority: parseNonNegativeInteger(opts.featurePriority, '--feature-priority'),
      status: 'not_started',
      isFrontendProject: opts.frontendProject,
      designSource: opts.designSource
    },
    opts.commitMessage ?? 'chore: add feature spec'
  );

  console.log(`[agent.ts] feature spec written: ${result.featurePath}`);
  console.log(
    `[agent.ts] feature_list.json updated: ${result.feature.id} status=${result.feature.status} priority=${result.feature.priority} layer2_refs=${result.feature.layer2_refs.join(', ')}`
  );
  console.log('[agent.ts] commit discipline: use a chore: commit message for feature agent changes.');
  return 0;
}

async function runWithOptions(opts: CliOptions) {
  const cwd = process.cwd();

  for (const required of ['AGENTS.md', 'CONTEXT-GATE.md', 'claude-progress.md', 'feature_list.json']) {
    if (!existsSync(resolve(cwd, required))) throw new Error(`Missing ${required}; run from repository root.`);
  }

  if (opts.runner === 'dispatcher') {
    const exitCode = opts.loop ? await runDispatcherLoop(opts, cwd) : (await runDispatcherOnce(opts, cwd)).exitCode;
    process.exit(exitCode);
  }
  if (opts.runner === 'feature') {
    process.exit(await runFeatureAgent(opts, cwd));
  }

  const exitCode = await runHarness(opts, cwd, runnerDefaults(opts, opts.runner));
  process.exit(exitCode);
}

const main = defineCommand({
  meta: {
    name: 'agent',
    description: 'Agent dispatcher for repository feature work.'
  },
  args: cliArgs,
  async run({ rawArgs }) {
    const { cliArgs: parsedCliArgs, extraAgentArgs } = splitForwardedArgs(rawArgs);
    const reparsedArgs = parseCittyArgs<typeof cliArgs>(parsedCliArgs, cliArgs);
    await runWithOptions(toCliOptions(reparsedArgs, parsedCliArgs, extraAgentArgs));
  }
});

if (process.env.NODE_ENV !== 'test') {
  runMain(main).catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

export { buildProviderInstruction, splitForwardedArgs, toCliOptions };
