#!/usr/bin/env tsx
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

interface CheckResult {
  name: string;
  command: string;
  stdout: string;
  stderr: string;
}

function runCheck(name: string, args: string[], expected: string[]): CheckResult {
  const result = spawnSync('pnpm', args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 20 * 1024 * 1024
  });

  const command = ['pnpm', ...args].join(' ');
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const combined = `${stdout}\n${stderr}`;

  if (result.status !== 0) {
    throw new Error(`${name} failed: ${command}\n${combined.trim()}`);
  }

  const missing = expected.filter(text => !combined.includes(text));
  if (missing.length > 0) {
    throw new Error(`${name} missed expected output: ${missing.join(', ')}\n${combined.trim()}`);
  }

  return {
    name,
    command,
    stdout,
    stderr
  };
}

const planDir = mkdtempSync(join(tmpdir(), 'harness-template-e2e-plans-'));

try {
  const checks = [
    runCheck(
      'default coder dry-run',
      ['agent', '--', '--task', 'e2e default provider smoke', '--plan-dir', planDir, '--dry-run'],
      ['agentProvider=codex agentBin=codex', 'runner=coder', 'command=codex', 'Read ', 'harness-template-e2e-plans-']
    ),
    runCheck(
      'explicit codex provider dry-run',
      [
        'agent',
        '--',
        '--agent-provider',
        'codex',
        '--agent-bin',
        'codex',
        '--task',
        'e2e codex provider smoke',
        '--plan-dir',
        planDir,
        '--dry-run'
      ],
      ['agentProvider=codex agentBin=codex', 'runner=coder', 'command=codex', 'Read ', 'harness-template-e2e-plans-']
    ),
    runCheck(
      'feature agent dry-run',
      ['agent:feature', '--', '--task', 'Draft an atomic feature', '--dry-run'],
      ['docs/features/<feature-id>.md', 'feature_list.json', 'consistency check', 'chore:', 'Figma MCP link']
    )
  ];

  for (const check of checks) {
    console.log(`[e2e] PASS ${check.name}: ${check.command}`);
  }

  console.log(`[e2e] completed ${checks.length} dry-run checks`);
} finally {
  rmSync(planDir, { recursive: true, force: true });
}
