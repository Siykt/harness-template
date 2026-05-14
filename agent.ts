#!/usr/bin/env tsx
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  dependsOn: string[];
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

interface RunnerWorktree {
  runId: string;
  path: string;
  resultJsonPath: string;
  cleanupPolicy: string;
}

interface RunnerResultEvidence {
  command: string;
  result: string;
}

interface RunnerResult {
  schemaVersion: number;
  runId: string;
  featureId: string;
  runner: ProviderRunnerMode;
  recommendedStatus: 'pending_review' | 'passing' | 'blocked';
  evidence: RunnerResultEvidence[];
  changedFiles: string[];
  blocker?: {
    cause: string;
    evidence: string;
    restartInstructions: string;
  };
  notes?: string[];
}

type ContextSummaryKind = 'agents' | 'contextGate' | 'featureList' | 'featureDoc';

interface ContextSummary {
  schemaVersion: number;
  kind: ContextSummaryKind;
  sourcePath: string;
  sourceSha256: string;
  generatedAt: string;
  summary: string;
}

interface PreflightEvidence {
  schemaVersion: number;
  runId: string;
  repoRoot: string;
  generatedAt: string;
  featureId?: string;
  runner: ProviderRunnerMode;
  commands: {
    pwd: {
      exitCode: number;
      stdout: string;
    };
    gitLog: Pick<CommandResult, 'command' | 'exitCode' | 'stdout' | 'stderr'>;
    init?: Pick<CommandResult, 'command' | 'exitCode' | 'stdout' | 'stderr'>;
  };
  context: {
    agents: Omit<ContextSummary, 'summary'>;
    contextGate: Omit<ContextSummary, 'summary'>;
    featureList: Omit<ContextSummary, 'summary'>;
    layer2: Array<Omit<ContextSummary, 'summary'>>;
  };
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
const CONTEXT_SUMMARY_SCHEMA_VERSION = 1;
const PREFLIGHT_SCHEMA_VERSION = 1;
const RUNNER_RESULT_SCHEMA_VERSION = 1;

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

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function safeRunIdPathSegment(runId: string): string {
  return runId.replace(/[^a-zA-Z0-9._-]+/g, '-');
}

function cacheSafePath(path: string): string {
  return path.replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function contextSummaryMetadata(summary: ContextSummary): Omit<ContextSummary, 'summary'> {
  const { summary: _summary, ...metadata } = summary;
  return metadata;
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

function compactLines(text: string, maxLines: number): string {
  return text
    .split(/\r?\n/)
    .map(line => line.trimEnd())
    .filter(line => line.trim().length > 0)
    .slice(0, maxLines)
    .join('\n');
}

function extractSection(text: string, heading: string, maxChars: number): string {
  const start = text.indexOf(heading);
  if (start < 0) return '';
  const next = text.indexOf('\n## ', start + heading.length);
  return truncate(text.slice(start, next >= 0 ? next : text.length).trim(), maxChars);
}

function summarizeAgents(text: string): string {
  const lines = text.split(/\r?\n/);
  const selected = lines.filter(line => {
    const trimmed = line.trim();
    return (
      trimmed.startsWith('#') ||
      /^\d+\.\s/.test(trimmed) ||
      trimmed.startsWith('- ') ||
      trimmed.includes('完成门槛') ||
      trimmed.includes('结束前')
    );
  });

  return compactLines(
    [
      'AGENTS.md summary for runner prompts. The full file is available at AGENTS.md if exact wording is needed.',
      ...selected
    ].join('\n'),
    90
  );
}

function summarizeContextGate(text: string): string {
  const lines = text.split(/\r?\n/);
  const selected = lines.filter(line => {
    const trimmed = line.trim();
    return (
      trimmed.startsWith('#') ||
      trimmed.startsWith('| H') ||
      trimmed.startsWith('| R') ||
      trimmed.startsWith('| -') ||
      trimmed.includes('Layer 0') ||
      trimmed.includes('Layer 1') ||
      trimmed.includes('Layer 2') ||
      trimmed.includes('Layer 3')
    );
  });

  return compactLines(
    [
      'CONTEXT-GATE.md summary for runner prompts. The full file is available at CONTEXT-GATE.md if exact wording is needed.',
      ...selected
    ].join('\n'),
    90
  );
}

function summarizeFeatureList(text: string): string {
  const features = parseFeatureSummaries(text).map(feature => ({
    id: feature.id,
    title: feature.title,
    status: feature.status,
    priority: feature.priority,
    dependsOn: feature.dependsOn,
    layer2_refs: feature.layer2Refs
  }));
  return JSON.stringify({ features }, null, 2);
}

function summarizeFeatureDoc(text: string): string {
  const title = text.split(/\r?\n/, 1)[0] ?? '';
  const requirement = extractSection(text, '## Requirement', 2200);
  const todos = extractSection(text, '## Table Todo List', 2600);
  const verification = extractSection(text, '## Verification', 1200);
  return [title, requirement, todos, verification].filter(Boolean).join('\n\n');
}

function summarizeContext(kind: ContextSummaryKind, text: string): string {
  if (kind === 'agents') return summarizeAgents(text);
  if (kind === 'contextGate') return summarizeContextGate(text);
  if (kind === 'featureList') return summarizeFeatureList(text);
  return summarizeFeatureDoc(text);
}

function readCachedContextSummary(cwd: string, sourcePath: string, kind: ContextSummaryKind): ContextSummary {
  const raw = readText(resolve(cwd, sourcePath));
  const sourceSha256 = sha256(raw);
  const cacheDir = resolve(cwd, '.harness/cache/context');
  ensureDir(cacheDir);

  const cachePath = join(
    cacheDir,
    `${kind}-${cacheSafePath(sourcePath)}-${sourceSha256.slice(0, 16)}-v${CONTEXT_SUMMARY_SCHEMA_VERSION}.json`
  );

  if (existsSync(cachePath)) {
    const cached = JSON.parse(readText(cachePath)) as ContextSummary;
    if (
      cached.schemaVersion === CONTEXT_SUMMARY_SCHEMA_VERSION &&
      cached.kind === kind &&
      cached.sourcePath === sourcePath &&
      cached.sourceSha256 === sourceSha256
    ) {
      return cached;
    }
  }

  const summary: ContextSummary = {
    schemaVersion: CONTEXT_SUMMARY_SCHEMA_VERSION,
    kind,
    sourcePath,
    sourceSha256,
    generatedAt: new Date().toISOString(),
    summary: summarizeContext(kind, raw)
  };
  writeFileSync(cachePath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  return summary;
}

function createRunId(feature: FeatureSummary | undefined, runner: ProviderRunnerMode, date = new Date()): string {
  const timestamp = date.toISOString().replaceAll(':', '').replaceAll('.', '-');
  return `${timestamp}-${feature?.id ?? 'no-feature'}-${runner}`;
}

function planRunnerWorktree(cwd: string, runId: string): RunnerWorktree {
  const worktreePath = resolve(cwd, '.harness/worktrees', safeRunIdPathSegment(runId));
  return {
    runId,
    path: worktreePath,
    resultJsonPath: join(worktreePath, '.harness/runs', runId, 'result.json'),
    cleanupPolicy:
      'dry-run: do not create a permanent worktree; success: remove after patch/result finalization; failure or blocked: preserve for inspection.'
  };
}

function createRunnerWorktree(cwd: string, worktree: RunnerWorktree): void {
  if (existsSync(worktree.path)) rmSync(worktree.path, { recursive: true, force: true });
  ensureDir(resolve(cwd, '.harness/worktrees'));
  const result = run('git', ['worktree', 'add', '--detach', worktree.path, 'HEAD'], cwd, 120_000);
  if (result.exitCode !== 0) {
    throw new Error(`Failed to create runner worktree at ${worktree.path}:\n${result.stdout}\n${result.stderr}`);
  }

  const mainNodeModules = resolve(cwd, 'node_modules');
  const worktreeNodeModules = join(worktree.path, 'node_modules');
  if (existsSync(mainNodeModules) && !existsSync(worktreeNodeModules)) symlinkSync(mainNodeModules, worktreeNodeModules, 'dir');
  ensureDir(join(worktree.path, '.harness/runs', worktree.runId));
}

function removeRunnerWorktree(cwd: string, worktree: RunnerWorktree): void {
  const result = run('git', ['worktree', 'remove', '--force', worktree.path], cwd, 120_000);
  if (result.exitCode !== 0 && existsSync(worktree.path)) rmSync(worktree.path, { recursive: true, force: true });
  run('git', ['worktree', 'prune'], cwd, 120_000);
}

function extractCurrentStatusAndLatestSession(progress: string): string {
  const statusStart = progress.indexOf('## 当前已验证状态');
  const statusEnd = progress.indexOf('## 会话记录', statusStart);
  const status =
    statusStart >= 0 ? progress.slice(statusStart, statusEnd >= 0 ? statusEnd : statusStart + 2000) : progress.slice(0, 2000);

  const sessionMatches = [...progress.matchAll(/^### Session[^\n]*$/gm)];
  const sessions = sessionMatches.flatMap((match, index) => {
    const heading = match[0];
    if (/^### Session template\s*$/i.test(heading.trim())) return [];

    const start = match.index ?? 0;
    const next = sessionMatches[index + 1]?.index;
    const date = /### Session\s+(\d{4}-\d{2}-\d{2})/.exec(heading)?.[1] ?? '';
    return [
      {
        date,
        start,
        text: progress.slice(start, next).trim()
      }
    ];
  });

  const latest =
    sessions
      .sort((a, b) => b.date.localeCompare(a.date) || a.start - b.start)
      .at(0)?.text ?? '';

  return `${status.trim()}\n\n--- latest session ---\n${truncate(latest.trim(), 9000)}`;
}

function parseFeatureSummaries(raw: string): FeatureSummary[] {
  const parsed = JSON.parse(raw) as { features?: Array<Record<string, unknown>> };
  return (parsed.features ?? []).map(feature => ({
    id: String(feature.id ?? ''),
    title: String(feature.title ?? ''),
    status: String(feature.status ?? ''),
    priority: Number(feature.priority ?? 999),
    dependsOn: Array.isArray(feature.dependsOn) ? feature.dependsOn.map(ref => String(ref)) : [],
    layer2Refs: Array.isArray(feature.layer2_refs) ? feature.layer2_refs.map(ref => String(ref)) : []
  }));
}

function isRunnerResultEvidence(value: unknown): value is RunnerResultEvidence {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.command === 'string' && typeof candidate.result === 'string';
}

function validateRunnerResult(raw: string, expected: { runId: string; featureId: string; runner: ProviderRunnerMode }): RunnerResult {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const recommendedStatus = parsed.recommendedStatus;
  if (
    parsed.schemaVersion !== RUNNER_RESULT_SCHEMA_VERSION ||
    parsed.runId !== expected.runId ||
    parsed.featureId !== expected.featureId ||
    parsed.runner !== expected.runner
  ) {
    throw new Error('runner result does not match the expected schema, run id, feature id, or runner');
  }

  const allowedStatuses =
    expected.runner === 'coder' ? new Set(['pending_review', 'blocked']) : new Set(['passing', 'blocked']);
  if (typeof recommendedStatus !== 'string' || !allowedStatuses.has(recommendedStatus)) {
    throw new Error(
      `runner result recommendedStatus must be one of ${[...allowedStatuses].join(', ')} for ${expected.runner}`
    );
  }

  if (!Array.isArray(parsed.evidence) || !parsed.evidence.every(isRunnerResultEvidence)) {
    throw new Error('runner result evidence must be an array of { command, result } entries');
  }
  if (!Array.isArray(parsed.changedFiles) || !parsed.changedFiles.every(file => typeof file === 'string')) {
    throw new Error('runner result changedFiles must be an array of strings');
  }
  if (recommendedStatus === 'blocked') {
    const blocker = parsed.blocker as Record<string, unknown> | undefined;
    if (
      !blocker ||
      typeof blocker.cause !== 'string' ||
      typeof blocker.evidence !== 'string' ||
      typeof blocker.restartInstructions !== 'string'
    ) {
      throw new Error('blocked runner result must include blocker cause, evidence, and restartInstructions');
    }
  }
  if (parsed.notes !== undefined && (!Array.isArray(parsed.notes) || !parsed.notes.every(note => typeof note === 'string'))) {
    throw new Error('runner result notes must be an array of strings when present');
  }

  return parsed as unknown as RunnerResult;
}

function appendProgressSession(cwd: string, result: RunnerResult, worktree: RunnerWorktree): void {
  const progressPath = resolve(cwd, 'claude-progress.md');
  const progress = readText(progressPath);
  const marker = '## 会话记录';
  const markerIndex = progress.indexOf(marker);
  if (markerIndex < 0) throw new Error('claude-progress.md is missing ## 会话记录');

  const insertAt = progress.indexOf('\n', markerIndex);
  const today = formatLocalDate();
  const evidenceLines = result.evidence.map(item => `  - \`${item.command}\`：${item.result}`).join('\n');
  const changedFiles = result.changedFiles.length > 0 ? result.changedFiles.map(file => `  - \`${file}\``).join('\n') : '  - 无';
  const blockerLines = result.blocker
    ? [
        '- Blocker：',
        `  - 原因：${result.blocker.cause}`,
        `  - 证据：${result.blocker.evidence}`,
        `  - 重启路径：${result.blocker.restartInstructions}`
      ].join('\n')
    : '- Blocker：无';
  const notes = result.notes?.length ? result.notes.map(note => `  - ${note}`).join('\n') : '  - 无';
  const session = `

### Session ${today} ${result.featureId} ${result.runner} dispatcher finalization

- 日期：${today}
- 本轮目标：由 \`agent.ts\` 统一落库 ${result.featureId} ${result.runner} runner 的 result.json。
- 已完成：
  - 校验 \`${relative(cwd, worktree.resultJsonPath)}\`，recommendedStatus=\`${result.recommendedStatus}\`。
  - 由主工作树更新 \`feature_list.json\` 状态和 evidence，子 agent 不直接落库状态。
  - worktree 路径：\`${relative(cwd, worktree.path)}\`。
- Runner evidence：
${evidenceLines}
- 回写文件：
${changedFiles}
${blockerLines}
- 备注：
${notes}
`;

  writeFileSync(progressPath, `${progress.slice(0, insertAt)}${session}${progress.slice(insertAt)}`, 'utf8');
}

function updateFeatureListFromRunnerResult(cwd: string, result: RunnerResult): void {
  const featureListPath = resolve(cwd, 'feature_list.json');
  const parsed = JSON.parse(readText(featureListPath)) as { features?: Array<Record<string, unknown>> };
  const features = parsed.features ?? [];
  const feature = features.find(candidate => candidate.id === result.featureId);
  if (!feature) throw new Error(`Cannot update missing feature from runner result: ${result.featureId}`);

  feature.status = result.recommendedStatus;
  const evidence = Array.isArray(feature.evidence) ? feature.evidence : [];
  feature.evidence = [
    ...evidence,
    ...result.evidence.map(item => ({
      date: formatLocalDate(),
      command: item.command,
      result: item.result
    }))
  ];
  if (result.blocker) {
    feature.blocker = {
      date: formatLocalDate(),
      ...result.blocker
    };
  } else {
    delete feature.blocker;
  }

  writeFileSync(featureListPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
}

function applyWorktreePatchToMain(cwd: string, worktree: RunnerWorktree): string[] {
  run('git', ['add', '-N', '.'], worktree.path, 120_000);
  const diff = run(
    'git',
    ['diff', '--binary', '--', '.', ':(exclude).harness', ':(exclude)feature_list.json', ':(exclude)claude-progress.md'],
    worktree.path,
    120_000
  );
  if (diff.exitCode !== 0) throw new Error(`Failed to inspect worktree diff:\n${diff.stdout}\n${diff.stderr}`);
  if (!diff.stdout.trim()) return [];

  const check = spawnSync('git', ['apply', '--check', '--whitespace=nowarn', '-'], {
    cwd,
    input: diff.stdout,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 20 * 1024 * 1024
  });
  if (check.status !== 0) {
    throw new Error(`Worktree patch cannot be applied cleanly to the main checkout:\n${check.stdout ?? ''}\n${check.stderr ?? ''}`);
  }

  const apply = spawnSync('git', ['apply', '--whitespace=nowarn', '-'], {
    cwd,
    input: diff.stdout,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 20 * 1024 * 1024
  });
  if (apply.status !== 0) {
    throw new Error(`Failed to apply worktree patch to the main checkout:\n${apply.stdout ?? ''}\n${apply.stderr ?? ''}`);
  }

  const changed = run('git', ['-C', worktree.path, 'diff', '--name-only', '--', '.', ':(exclude).harness'], cwd, 120_000);
  return changed.stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .filter(file => file !== 'feature_list.json' && file !== 'claude-progress.md');
}

function finalizeRunnerResult(cwd: string, worktree: RunnerWorktree, feature: FeatureSummary, runner: ProviderRunnerMode): RunnerResult {
  if (!existsSync(worktree.resultJsonPath)) {
    throw new Error(`Runner did not write result JSON: ${relative(cwd, worktree.resultJsonPath)}`);
  }

  const result = validateRunnerResult(readText(worktree.resultJsonPath), {
    runId: worktree.runId,
    featureId: feature.id,
    runner
  });
  const changedFiles = applyWorktreePatchToMain(cwd, worktree);
  result.changedFiles = [...new Set([...result.changedFiles, ...changedFiles])].sort();
  updateFeatureListFromRunnerResult(cwd, result);
  appendProgressSession(cwd, result, worktree);
  return result;
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

function buildPrompt(params: {
  cwd: string;
  task: string;
  runnerConfig: RunnerConfig;
  generatedAt: string;
  runId: string;
  preflightEvidencePath: string;
  worktree: RunnerWorktree;
  preflight: PreflightEvidence;
  contextSummaries: {
    agents: ContextSummary;
    contextGate: ContextSummary;
    featureList: ContextSummary;
    layer2: ContextSummary[];
  };
  progressSummary: string;
  features: FeatureSummary[];
  selectedFeature?: FeatureSummary;
}) {
  const initBlock = params.preflight.commands.init
    ? `exit=${params.preflight.commands.init.exitCode}\n${tailLines(`${params.preflight.commands.init.stdout}\n${params.preflight.commands.init.stderr}`, 40)}`
    : 'Skipped by agent.ts --skip-init.';

  const selected = params.selectedFeature
    ? `${params.selectedFeature.id} (${params.selectedFeature.status}) - ${params.selectedFeature.title}`
    : 'none';

  const layer2Block = params.contextSummaries.layer2
    .map(doc => `### ${doc.sourcePath}\nsha256=${doc.sourceSha256}\n${doc.summary}`)
    .join('\n\n');
  const resultJsonInWorktree = relative(params.worktree.path, params.worktree.resultJsonPath);
  const recommendedStatusSchema =
    params.runnerConfig.runner === 'coder' ? 'pending_review|blocked' : 'passing|blocked';

  const runnerContract =
    params.runnerConfig.runner === 'coder'
      ? `You are the CODER runner.

- Implement the requested change end to end.
- Make scoped code/documentation edits where needed.
- Favor practical implementation exploration. Target temperature: ${params.runnerConfig.temperature}.
- Run the smallest useful checks first, then the repository-required checks before finishing.
- Do not edit feature_list.json or claude-progress.md directly for status/progress finalization.
- Write ${resultJsonInWorktree} with recommendedStatus, evidence, changedFiles, blocker, and notes.
- If you finish implementation and validation, recommend pending_review, not passing.
- If you are blocked, recommend blocked and write a blocked report with cause, evidence, and restart instructions in result.json.`
      : `You are the REVIEWER runner.

- Take a code-review and acceptance-gate stance.
- Be strict, deterministic, and evidence-driven. Target temperature: ${params.runnerConfig.temperature}.
- Prioritize bugs, regressions, missing tests, unsafe state transitions, and evidence gaps.
- Do not make broad implementation changes.
- Do not edit feature_list.json or claude-progress.md directly for status/progress finalization.
- Write ${resultJsonInWorktree} with recommendedStatus, evidence, changedFiles, blocker, and notes.
- If the work is acceptable, recommend passing with command evidence.
- If not acceptable, recommend blocked and write exact blockers in result.json.`;

  return `# Codex Runner Plan

- Generated at: ${params.generatedAt}
- Run id: ${params.runId}
- Runner: ${params.runnerConfig.runner}
- Model: ${params.runnerConfig.model ?? 'default'}
- Effort: ${params.runnerConfig.effort ?? 'default'}
- Target temperature: ${params.runnerConfig.temperature}
- Repository: ${params.cwd}
- Selected feature: ${selected}
- User task: ${params.task}
- Preflight evidence: ${relative(params.cwd, params.preflightEvidencePath)}
- Execution worktree: ${relative(params.cwd, params.worktree.path)}
- Result JSON: ${relative(params.cwd, params.worktree.resultJsonPath)}
- Routed docs: ${params.contextSummaries.layer2.map(doc => doc.sourcePath).join(', ') || 'none'}

---

You are Codex running inside ${params.cwd}.

The user task is:
${params.task}

This prompt was generated by agent.ts. It has already split the repository AGENTS.md protocol into bounded context sections. Follow the repository rules exactly and continue from the evidence below rather than restarting from scratch.

## Stable Harness Contract

- agent.ts is the preflight owner for this runner invocation.
- The downstream runner is the execution owner for the selected task.
- The downstream runner must work inside the run-scoped git worktree: ${params.worktree.path}
- The downstream runner must not directly update feature_list.json status or claude-progress.md final progress; agent.ts owns those updates in the main checkout after validating result.json.
- The downstream runner must write result JSON at: ${params.worktree.resultJsonPath}
- Result JSON schema: {"schemaVersion":1,"runId":"${params.runId}","featureId":"${params.selectedFeature?.id ?? ''}","runner":"${params.runnerConfig.runner}","recommendedStatus":"${recommendedStatusSchema}","evidence":[{"command":"...","result":"..."}],"changedFiles":["..."],"blocker":{"cause":"...","evidence":"...","restartInstructions":"..."},"notes":["..."]}.
- Worktree lifecycle: ${params.worktree.cleanupPolicy}
- Treat the preflight evidence file as the canonical startup evidence for run ${params.runId}.
- Do not repeat the full startup protocol unless evidence is missing or failed, you changed files that invalidate it, the user explicitly asks, or you need a narrower verification command for your implementation.
- Keep stable, repeated instructions near the top of this plan so Codex/OpenAI automatic prompt caching can reuse the shared prefix when available.
- Codex CLI currently exposes no harness-specific prompt cache flag here; dispatcher cache is implemented by stable summaries and file-hash keyed context artifacts.

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

## Context Index

The full source files remain available in the repository, but this plan intentionally carries summaries by default.
Read full files only when exact wording or implementation details are needed.

### AGENTS.md

sha256=${params.contextSummaries.agents.sourceSha256}
${params.contextSummaries.agents.summary}

### CONTEXT-GATE.md

sha256=${params.contextSummaries.contextGate.sourceSha256}
${params.contextSummaries.contextGate.summary}

### feature_list.json summary

sha256=${params.contextSummaries.featureList.sourceSha256}
${params.contextSummaries.featureList.summary}

## Preflight Evidence Summary

Full machine-readable evidence is available at ${relative(params.cwd, params.preflightEvidencePath)}.

### pwd
exit=${params.preflight.commands.pwd.exitCode}
${params.preflight.commands.pwd.stdout}

### git log --oneline -5
exit=${params.preflight.commands.gitLog.exitCode}
${params.preflight.commands.gitLog.stdout.trim()}
${params.preflight.commands.gitLog.stderr.trim()}

### ./init.sh
${initBlock}

## Layer 1: claude-progress.md summary

${params.progressSummary}

## Layer 1: feature_list.json summaries

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

function loadRunContext(
  opts: CliOptions,
  cwd: string,
  runner: ProviderRunnerMode,
  selectedFeatureOverride?: FeatureSummary
) {
  const agentsSummary = readCachedContextSummary(cwd, 'AGENTS.md', 'agents');
  const contextGateSummary = readCachedContextSummary(cwd, 'CONTEXT-GATE.md', 'contextGate');
  const gitLog = run('git', ['log', '--oneline', '-5'], cwd);
  const initResult = opts.skipInit ? undefined : run('./init.sh', [], cwd, 180_000);
  const initFailed = Boolean(initResult && initResult.exitCode !== 0);

  const progressSummary = extractCurrentStatusAndLatestSession(readText('claude-progress.md'));
  const featureListSummary = readCachedContextSummary(cwd, 'feature_list.json', 'featureList');
  const features = parseFeatureSummaries(readText('feature_list.json'));
  const selectedFeature = selectedFeatureOverride ?? selectFeature(features, opts.feature);
  const layer2 = resolveLayer2Docs(cwd, selectedFeature, opts.layer2Refs).map(path =>
    readCachedContextSummary(cwd, path, 'featureDoc')
  );
  const runId = createRunId(selectedFeature, runner);
  const runDir = resolve(cwd, '.harness/runs', runId);
  ensureDir(runDir);
  const preflightCommands: PreflightEvidence['commands'] = {
    pwd: {
      exitCode: 0,
      stdout: cwd
    },
    gitLog: {
      command: gitLog.command,
      exitCode: gitLog.exitCode,
      stdout: gitLog.stdout,
      stderr: gitLog.stderr
    }
  };
  if (initResult) {
    preflightCommands.init = {
      command: initResult.command,
      exitCode: initResult.exitCode,
      stdout: tailLines(initResult.stdout, 80),
      stderr: tailLines(initResult.stderr, 80)
    };
  }

  const preflight: PreflightEvidence = {
    schemaVersion: PREFLIGHT_SCHEMA_VERSION,
    runId,
    repoRoot: cwd,
    generatedAt: new Date().toISOString(),
    featureId: selectedFeature?.id,
    runner,
    commands: preflightCommands,
    context: {
      agents: contextSummaryMetadata(agentsSummary),
      contextGate: contextSummaryMetadata(contextGateSummary),
      featureList: contextSummaryMetadata(featureListSummary),
      layer2: layer2.map(contextSummaryMetadata)
    }
  };
  const preflightEvidencePath = join(runDir, 'preflight.json');
  writeFileSync(preflightEvidencePath, `${JSON.stringify(preflight, null, 2)}\n`, 'utf8');

  return {
    runId,
    preflight,
    preflightEvidencePath,
    contextSummaries: {
      agents: agentsSummary,
      contextGate: contextGateSummary,
      featureList: featureListSummary,
      layer2
    },
    progressSummary,
    features,
    selectedFeature,
    initFailed
  };
}

async function runHarness(
  opts: CliOptions,
  cwd: string,
  runnerConfig: RunnerConfig,
  selectedFeatureOverride?: FeatureSummary,
  taskOverride?: string
): Promise<number> {
  const context = loadRunContext(opts, cwd, runnerConfig.runner, selectedFeatureOverride);
  const worktree = planRunnerWorktree(cwd, context.runId);
  const baseTask = taskOverride ?? opts.task;
  if (!baseTask) throw new Error(`Missing task for ${runnerConfig.runner} runner.`);
  const runnerTask = makeRunnerTask(baseTask, runnerConfig.runner);
  const prompt = buildPrompt({
    cwd,
    task: runnerTask,
    runnerConfig,
    generatedAt: new Date().toISOString(),
    runId: context.runId,
    preflightEvidencePath: context.preflightEvidencePath,
    worktree,
    preflight: context.preflight,
    contextSummaries: context.contextSummaries,
    progressSummary: context.progressSummary,
    features: context.features,
    selectedFeature: context.selectedFeature
  });

  const runnerOpts = withRunnerConfig(opts, runnerConfig);
  const planPath = writePlanFile(cwd, opts.planDir, prompt, runnerConfig.runner);
  const providerInstruction = buildProviderInstruction(cwd, planPath);
  const providerCwd = opts.dryRun ? worktree.path : worktree.path;
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
    cwd: providerCwd,
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
    console.log(`[agent.ts] preflight=${relative(cwd, context.preflightEvidencePath)}`);
    console.log(`[agent.ts] worktree=${relative(cwd, worktree.path)} (dry-run: not created)`);
    console.log(`[agent.ts] resultJson=${relative(worktree.path, worktree.resultJsonPath)}`);
    console.log('[agent.ts] statusOwner=agent.ts will validate result JSON and update feature_list.json/claude-progress.md from the main checkout');
    console.log(`[agent.ts] layer2=${context.contextSummaries.layer2.map(doc => doc.sourcePath).join(', ')}`);
    console.log(`[agent.ts] plan=${relative(cwd, planPath)}`);
    console.log(`[agent.ts] command=${formatProviderCommand(providerCommand)}`);
    console.log('\nPrompt written to the plan file above. Re-run without --dry-run to launch the selected provider.');
    return 0;
  }

  if (context.initFailed) {
    console.error(
      '[agent.ts] ./init.sh failed. Plan and preflight evidence were written, but Codex will not be launched automatically.'
    );
    console.error(`[agent.ts] plan=${relative(cwd, planPath)}`);
    console.error(`[agent.ts] preflight=${relative(cwd, context.preflightEvidencePath)}`);
    return 1;
  }

  createRunnerWorktree(cwd, worktree);
  const worktreePlanPath = resolve(worktree.path, relative(cwd, planPath));
  ensureDir(resolve(worktree.path, relative(cwd, opts.planDir)));
  writeFileSync(worktreePlanPath, `${prompt.trimEnd()}\n`, 'utf8');

  console.log(`[agent.ts] wrote plan ${relative(cwd, planPath)}`);
  console.log(`[agent.ts] runner worktree ${relative(cwd, worktree.path)}`);
  console.log(
    `[agent.ts] launching ${basename(providerCommand.command)} provider=${runnerOpts.agentProvider} runner=${runnerConfig.runner} feature=${context.selectedFeature?.id ?? 'none'} with ${context.contextSummaries.layer2.length} routed docs`
  );
  const exitCode = await spawnAgentProvider(providerCommand.command, providerCommand.args, worktree.path);
  if (exitCode !== 0) {
    console.error(`[agent.ts] runner exited with code ${exitCode}; preserving worktree ${relative(cwd, worktree.path)}`);
    return exitCode;
  }

  if (!context.selectedFeature) throw new Error('Runner completed without a selected feature.');
  const result = finalizeRunnerResult(cwd, worktree, context.selectedFeature, runnerConfig.runner);
  if (result.recommendedStatus === 'blocked') {
    console.error(`[agent.ts] runner recommended blocked; preserving worktree ${relative(cwd, worktree.path)}`);
    return 1;
  }

  removeRunnerWorktree(cwd, worktree);
  console.log(`[agent.ts] finalized ${result.featureId} -> ${result.recommendedStatus}`);
  return 0;
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

export {
  buildPrompt,
  buildProviderInstruction,
  extractCurrentStatusAndLatestSession,
  planRunnerWorktree,
  readCachedContextSummary,
  splitForwardedArgs,
  summarizeContext,
  toCliOptions,
  validateRunnerResult
};
