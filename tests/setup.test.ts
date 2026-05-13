import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentProviderIds, buildProviderCommand } from '../agent-providers';
import { splitForwardedArgs, toCliOptions } from '../agent';
import {
  buildFeatureAgentDryRunPrompt,
  buildFeatureSpecMarkdown,
  createFeatureListEntry,
  upsertFeatureListEntry,
  validateChoreCommitMessage,
  validateFeatureSpecConsistency,
  writeFeatureSpec
} from '../feature-agent';

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
      {
        _: ['smoke'],
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
      },
      cliArgs,
      extraAgentArgs
    );

    expect(opts.agentProvider).toBe('codex');
    expect(opts.agentBin).toBe('codex');
    expect(opts.extraAgentArgs).toEqual(['--color', 'never']);
  });

  it('keeps --codex-bin as a codex-only legacy alias for --agent-bin', () => {
    const opts = toCliOptions(
      {
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
      },
      ['--task', 'smoke', '--codex-bin', '/bin/codex'],
      []
    );

    expect(opts.agentBin).toBe('/bin/codex');
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
