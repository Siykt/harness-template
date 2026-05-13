import { describe, expect, it } from 'vitest';
import { agentProviderIds, buildProviderCommand } from '../agent-providers';
import { splitForwardedArgs, toCliOptions } from '../agent';

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
