import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentProviderIds, buildProviderCommand } from '../agent-providers';
import { buildPrompt, readCachedContextSummary, splitForwardedArgs, summarizeContext, toCliOptions } from '../agent';
import {
  buildFeatureAgentDryRunPrompt,
  buildFeatureSpecMarkdown,
  createFeatureListEntry,
  upsertFeatureListEntry,
  validateChoreCommitMessage,
  validateFeatureSpecConsistency,
  writeFeatureSpec
} from '../feature-agent';

type ToCliOptionsInput = Parameters<typeof toCliOptions>[0];

function asToCliOptionsInput(value: Record<string, unknown>): ToCliOptionsInput {
  return value as unknown as ToCliOptionsInput;
}

describe('agent provider registry', () => {
  it('registers the v0.1 provider list', () => {
    expect(agentProviderIds).toEqual(['codex', 'claude', 'openharness', 'kimi', 'gemini']);
  });

  it('builds the current codex execution command through the provider module', () => {
    const command = buildProviderCommand({
      provider: 'codex',
      agentBin: 'codex',
      permissionMode: 'full_auto',
      defaultPermissionMode: 'full_auto',
      model: 'gpt-5.5',
      outputFormat: 'json',
      dangerouslySkipPermissions: false,
      continueSession: false,
      cwd: '/repo',
      instruction: 'Read docs/plans/plan.md',
      extraAgentArgs: ['--color', 'never']
    });

    expect(command.command).toBe('codex');
    expect(command.args).toEqual([
      '--ask-for-approval',
      'never',
      'exec',
      '--cd',
      '/repo',
      '--sandbox',
      'danger-full-access',
      '--model',
      'gpt-5.5',
      '--json',
      '--color',
      'never',
      'Read docs/plans/plan.md'
    ]);
  });

  it('keeps non-codex providers registered as explicit unsupported stubs', () => {
    expect(() =>
      buildProviderCommand({
        provider: 'claude',
        agentBin: 'claude',
        permissionMode: 'full_auto',
        defaultPermissionMode: 'full_auto',
        model: undefined,
        outputFormat: undefined,
        dangerouslySkipPermissions: false,
        continueSession: false,
        cwd: '/repo',
        instruction: 'Read docs/plans/plan.md',
        extraAgentArgs: []
      })
    ).toThrow('registered but not executable yet');
  });
});

describe('agent CLI options', () => {
  it('uses provider-neutral agent bin naming by default', () => {
    const { cliArgs, extraAgentArgs } = splitForwardedArgs(['--task', 'smoke', '--dry-run', '--', '--color', 'never']);
    const opts = toCliOptions(
      asToCliOptionsInput({
        _: ['smoke'],
        task: 'smoke',
        feature: undefined,
        runner: 'coder',
        model: undefined,
        effort: undefined,
        temperature: undefined,
        'coder-model': undefined,
        maxTurns: '40',
        permissionMode: 'full_auto',
        agentProvider: 'codex',
        planDir: 'docs/plans',
        dryRun: true,
        loop: false,
        loopDelayMs: '1000',
        maxLoopIterations: '0',
        skipInit: false,
        continue: false,
        dangerouslySkipPermissions: false
      }),
      cliArgs,
      extraAgentArgs
    );

    expect(opts.agentProvider).toBe('codex');
    expect(opts.agentBin).toBe('codex');
    expect(opts.extraAgentArgs).toEqual(['--color', 'never']);
  });

  it('keeps --codex-bin as a codex-only legacy alias for --agent-bin', () => {
    const opts = toCliOptions(
      asToCliOptionsInput({
        _: [],
        task: 'smoke',
        runner: 'coder',
        maxTurns: '40',
        permissionMode: 'full_auto',
        agentProvider: 'codex',
        planDir: 'docs/plans',
        dryRun: true,
        loop: false,
        loopDelayMs: '1000',
        maxLoopIterations: '0',
        skipInit: false,
        continue: false,
        dangerouslySkipPermissions: false
      }),
      ['--task', 'smoke', '--codex-bin', '/bin/codex'],
      []
    );

    expect(opts.agentBin).toBe('/bin/codex');
  });
});

describe('runner context cache and preflight prompt', () => {
  it('summarizes feature_list.json without carrying evidence or notes payloads', () => {
    const summary = summarizeContext(
      'featureList',
      JSON.stringify({
        features: [
          {
            id: 'HT-004',
            title: 'Trim context',
            status: 'in_progress',
            priority: 4,
            dependsOn: ['HT-001'],
            layer2_refs: ['docs/features/HT-004.md'],
            evidence: [{ command: 'very noisy command', result: 'very noisy result' }],
            notes: 'long private note'
          }
        ]
      })
    );

    expect(summary).toContain('"id": "HT-004"');
    expect(summary).toContain('"dependsOn"');
    expect(summary).not.toContain('very noisy command');
    expect(summary).not.toContain('long private note');
  });

  it('writes file-hash keyed context summaries into dispatcher cache', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'context-cache-'));
    try {
      writeFileSync(join(cwd, 'AGENTS.md'), '# AGENTS.md\n\n## 规则\n\n- Keep one active feature.\n', 'utf8');
      const summary = readCachedContextSummary(cwd, 'AGENTS.md', 'agents');
      const expectedCachePath = join(
        cwd,
        '.harness/cache/context',
        `agents-AGENTS.md-${summary.sourceSha256.slice(0, 16)}-v${summary.schemaVersion}.json`
      );

      expect(summary.summary).toContain('Keep one active feature');
      expect(existsSync(expectedCachePath)).toBe(true);
      expect(readCachedContextSummary(cwd, 'AGENTS.md', 'agents').sourceSha256).toBe(summary.sourceSha256);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('builds a cache-friendly prompt that reuses preflight evidence instead of asking for a full restart', () => {
    const prompt = buildPrompt({
      cwd: '/repo',
      task: 'Implement HT-004.',
      runnerConfig: {
        runner: 'coder',
        model: 'gpt-5.5',
        effort: 'high',
        temperature: '0.3'
      },
      generatedAt: '2026-05-14T00:00:00.000Z',
      runId: 'run-HT-004-coder',
      preflightEvidencePath: '/repo/.harness/runs/run-HT-004-coder/preflight.json',
      preflight: {
        schemaVersion: 1,
        runId: 'run-HT-004-coder',
        repoRoot: '/repo',
        generatedAt: '2026-05-14T00:00:00.000Z',
        featureId: 'HT-004',
        runner: 'coder',
        commands: {
          pwd: { exitCode: 0, stdout: '/repo' },
          gitLog: { command: 'git log --oneline -5', exitCode: 0, stdout: 'abc123 commit\n', stderr: '' },
          init: { command: './init.sh', exitCode: 0, stdout: 'Tests 11 passed', stderr: '' }
        },
        context: {
          agents: {
            schemaVersion: 1,
            kind: 'agents',
            sourcePath: 'AGENTS.md',
            sourceSha256: 'agents-sha',
            generatedAt: '2026-05-14T00:00:00.000Z'
          },
          contextGate: {
            schemaVersion: 1,
            kind: 'contextGate',
            sourcePath: 'CONTEXT-GATE.md',
            sourceSha256: 'gate-sha',
            generatedAt: '2026-05-14T00:00:00.000Z'
          },
          featureList: {
            schemaVersion: 1,
            kind: 'featureList',
            sourcePath: 'feature_list.json',
            sourceSha256: 'features-sha',
            generatedAt: '2026-05-14T00:00:00.000Z'
          },
          layer2: []
        }
      },
      contextSummaries: {
        agents: {
          schemaVersion: 1,
          kind: 'agents',
          sourcePath: 'AGENTS.md',
          sourceSha256: 'agents-sha',
          generatedAt: '2026-05-14T00:00:00.000Z',
          summary: 'AGENTS summary only'
        },
        contextGate: {
          schemaVersion: 1,
          kind: 'contextGate',
          sourcePath: 'CONTEXT-GATE.md',
          sourceSha256: 'gate-sha',
          generatedAt: '2026-05-14T00:00:00.000Z',
          summary: 'CONTEXT summary only'
        },
        featureList: {
          schemaVersion: 1,
          kind: 'featureList',
          sourcePath: 'feature_list.json',
          sourceSha256: 'features-sha',
          generatedAt: '2026-05-14T00:00:00.000Z',
          summary: '{"features":[]}'
        },
        layer2: [
          {
            schemaVersion: 1,
            kind: 'featureDoc',
            sourcePath: 'docs/features/HT-004.md',
            sourceSha256: 'feature-sha',
            generatedAt: '2026-05-14T00:00:00.000Z',
            summary: 'Feature doc summary only'
          }
        ]
      },
      progressSummary: 'current status summary',
      features: [
        {
          id: 'HT-004',
          title: 'Trim context',
          status: 'in_progress',
          priority: 4,
          dependsOn: [],
          layer2Refs: ['docs/features/HT-004.md']
        }
      ],
      selectedFeature: {
        id: 'HT-004',
        title: 'Trim context',
        status: 'in_progress',
        priority: 4,
        dependsOn: [],
        layer2Refs: ['docs/features/HT-004.md']
      }
    });

    expect(prompt).toContain('## Stable Harness Contract');
    expect(prompt).toContain('preflight evidence file as the canonical startup evidence');
    expect(prompt).toContain('.harness/runs/run-HT-004-coder/preflight.json');
    expect(prompt).toContain('Codex/OpenAI automatic prompt caching');
    expect(prompt).toContain('AGENTS summary only');
    expect(prompt).not.toContain('每轮会话开始时，**严格按此顺序执行**');
  });
});

describe('feature agent', () => {
  const featureInput = {
    id: 'HT-004',
    title: 'Add sample feature',
    requirement: 'Add a small atomic feature spec for validation.',
    priority: 4
  };

  it('generates an atomic feature spec with tracker consistency metadata', () => {
    const markdown = buildFeatureSpecMarkdown(featureInput);
    const entry = createFeatureListEntry(featureInput);

    expect(markdown).toContain('## Requirement');
    expect(markdown).toContain('## Table Todo List');
    expect(markdown).toContain('## Verification');
    expect(markdown).toContain('## Feature List Consistency');
    expect(entry).toMatchObject({
      id: 'HT-004',
      title: 'Add sample feature',
      status: 'not_started',
      priority: 4,
      layer2_refs: ['docs/features/HT-004.md']
    });
    expect(() => validateFeatureSpecConsistency(markdown, entry)).not.toThrow();
  });

  it('syncs feature_list.json entries without dropping existing evidence', () => {
    const raw = JSON.stringify({
      features: [
        {
          id: 'HT-004',
          title: 'Old title',
          status: 'blocked',
          priority: 9,
          layer2_refs: [],
          evidence: [{ command: 'old', result: 'kept' }],
          notes: 'old'
        }
      ]
    });
    const updated = JSON.parse(upsertFeatureListEntry(raw, createFeatureListEntry(featureInput)));
    expect(updated.features[0]).toMatchObject({
      id: 'HT-004',
      title: 'Add sample feature',
      status: 'not_started',
      priority: 4,
      layer2_refs: ['docs/features/HT-004.md'],
      evidence: [{ command: 'old', result: 'kept' }]
    });
  });

  it('writes docs/features and feature_list.json for a new feature', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'feature-agent-'));
    try {
      writeFileSync(join(cwd, 'feature_list.json'), JSON.stringify({ features: [] }), 'utf8');
      const result = writeFeatureSpec(cwd, featureInput, 'chore: add HT-004 feature spec');
      const writtenSpec = readFileSync(join(cwd, result.featurePath), 'utf8');
      const writtenFeatureList = JSON.parse(readFileSync(join(cwd, 'feature_list.json'), 'utf8'));

      expect(writtenSpec).toContain('# HT-004 Add sample feature');
      expect(writtenFeatureList.features[0]).toMatchObject({
        id: 'HT-004',
        status: 'not_started',
        priority: 4,
        layer2_refs: ['docs/features/HT-004.md']
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('rejects inconsistent tracker fields and non-chore commit messages', () => {
    const markdown = buildFeatureSpecMarkdown(featureInput);
    expect(() =>
      validateFeatureSpecConsistency(markdown, {
        ...createFeatureListEntry(featureInput),
        layer2_refs: ['docs/features/wrong.md']
      })
    ).toThrow('layer2_refs');
    expect(() => validateChoreCommitMessage('feat: add feature spec')).toThrow('chore:');
  });

  it('requires archived design source for frontend feature specs', () => {
    expect(() => buildFeatureSpecMarkdown({ ...featureInput, isFrontendProject: true })).toThrow(
      'Figma MCP link or original design file path'
    );
    expect(buildFeatureSpecMarkdown({ ...featureInput, isFrontendProject: true, designSource: 'figma://file/node' })).toContain(
      'Frontend design source: figma://file/node'
    );
  });

  it('prints feature-agent dry-run instructions for docs, tracker sync, consistency, chore commits, and design source', () => {
    const prompt = buildFeatureAgentDryRunPrompt();
    expect(prompt).toContain('docs/features/<feature-id>.md');
    expect(prompt).toContain('feature_list.json');
    expect(prompt).toContain('consistency check');
    expect(prompt).toContain('chore:');
    expect(prompt).toContain('Figma MCP link');
  });
});
