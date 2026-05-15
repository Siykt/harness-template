import { basename } from 'node:path';

export const agentProviderIds = ['codex', 'claude', 'openharness', 'kimi', 'gemini'] as const;

export type AgentProviderId = (typeof agentProviderIds)[number];

export interface AgentProvider {
  id: AgentProviderId;
  displayName: string;
  defaultBin: string;
  status: 'supported' | 'registered_unsupported';
}

export interface ProviderCommandOptions {
  provider: AgentProviderId;
  agentBin: string;
  permissionMode: string;
  defaultPermissionMode: string;
  model?: string;
  outputFormat?: string;
  dangerouslySkipPermissions: boolean;
  continueSession: boolean;
  resume?: string;
  cwd: string;
  instruction: string;
  extraAgentArgs: string[];
}

export interface ProviderCommand {
  command: string;
  args: string[];
}

export const agentProviders: Record<AgentProviderId, AgentProvider> = {
  codex: {
    id: 'codex',
    displayName: 'Codex',
    defaultBin: 'codex',
    status: 'supported'
  },
  claude: {
    id: 'claude',
    displayName: 'Claude',
    defaultBin: 'claude',
    status: 'registered_unsupported'
  },
  openharness: {
    id: 'openharness',
    displayName: 'OpenHarness',
    defaultBin: 'openharness',
    status: 'registered_unsupported'
  },
  kimi: {
    id: 'kimi',
    displayName: 'Kimi',
    defaultBin: 'kimi',
    status: 'registered_unsupported'
  },
  gemini: {
    id: 'gemini',
    displayName: 'Gemini',
    defaultBin: 'gemini',
    status: 'registered_unsupported'
  }
};

export function isAgentProviderId(value: string): value is AgentProviderId {
  return agentProviderIds.includes(value as AgentProviderId);
}

export function resolveAgentProvider(value: string): AgentProviderId {
  if (isAgentProviderId(value)) return value;
  throw new Error(`Unsupported agent provider: ${value}. Supported providers: ${agentProviderIds.join(', ')}`);
}

export function buildCodexProviderCommand(opts: ProviderCommandOptions): ProviderCommand {
  const args: string[] = ['exec'];

  if (opts.continueSession || opts.resume) {
    args.push('resume');
    if (opts.continueSession && !opts.resume) args.push('--last');
    if (opts.resume) args.push(opts.resume);
  } else {
    args.push('--cd', opts.cwd);
    if (opts.permissionMode === opts.defaultPermissionMode) {
      args.push('--sandbox', 'danger-full-access');
      args.unshift('--ask-for-approval', 'never');
    }
  }

  if (opts.model) args.push('--model', opts.model);
  if (opts.outputFormat === 'json') args.push('--json');
  else if (opts.outputFormat)
    throw new Error(
      `Unsupported Codex output format: ${opts.outputFormat}. Use --output-format json or pass raw provider args after --.`
    );
  if (opts.dangerouslySkipPermissions) args.push('--dangerously-bypass-approvals-and-sandbox');
  args.push(...opts.extraAgentArgs);
  args.push(opts.instruction);

  return {
    command: opts.agentBin,
    args
  };
}

export function buildProviderCommand(opts: ProviderCommandOptions): ProviderCommand {
  if (opts.provider === 'codex') return buildCodexProviderCommand(opts);

  const provider = agentProviders[opts.provider];
  throw new Error(
    `Agent provider ${provider.id} (${provider.displayName}) is registered but not executable yet. ` +
      'Use --agent-provider codex for the current supported execution path.'
  );
}

export function formatProviderCommand(command: ProviderCommand): string {
  return `${basename(command.command)} ${command.args.map(arg => JSON.stringify(arg)).join(' ')}`;
}
