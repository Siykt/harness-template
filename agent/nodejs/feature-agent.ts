import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const VALID_FEATURE_STATUSES = new Set(['not_started', 'in_progress', 'pending_review', 'blocked', 'passing']);

export interface FeatureSpecInput {
  id: string;
  title: string;
  requirement: string;
  priority: number;
  status?: string;
  isFrontendProject?: boolean;
  designSource?: string;
}

export interface FeatureListEntry {
  id: string;
  title: string;
  status: string;
  priority: number;
  layer2_refs: string[];
  evidence: Array<Record<string, string>>;
  notes: string;
}

export interface FeatureAgentResult {
  feature: FeatureListEntry;
  featurePath: string;
  specMarkdown: string;
}

export function validateChoreCommitMessage(message: string): void {
  if (!message.trim().startsWith('chore:')) {
    throw new Error('Feature agent changes must use a chore: commit message.');
  }
}

export function featureDocPath(featureId: string): string {
  return `docs/features/${featureId}.md`;
}

export function buildFeatureSpecMarkdown(input: FeatureSpecInput): string {
  validateFeatureSpecInput(input);
  const status = input.status ?? 'not_started';
  const layer2Ref = featureDocPath(input.id);
  const designArchive = input.isFrontendProject
    ? `- Frontend design source: ${input.designSource}`
    : '- Frontend design source: not required for this non-frontend feature.';

  return `# ${input.id} ${input.title}

## Requirement

${input.requirement.trim()}

${designArchive}

## Table Todo List

| ID | Todo | Acceptance | Status |
| --- | --- | --- | --- |
| \`${input.id}-T1\` | Clarify the atomic feature scope. | Requirement is specific enough for one coder session and has explicit non-goals if needed. | \`todo\` |
| \`${input.id}-T2\` | Implement the smallest coherent change. | Production code, docs, or scripts are updated only inside this feature scope. | \`todo\` |
| \`${input.id}-T3\` | Add or update focused validation. | Tests or command checks cover the new behavior and failure boundaries. | \`todo\` |
| \`${input.id}-T4\` | Record tracker evidence. | \`feature_list.json\` status, priority, \`layer2_refs\`, and evidence match the verified state. | \`todo\` |

## Verification

| Command | Required Result |
| --- | --- |
| \`pnpm test\` | PASS or explicitly documented failure with blocker evidence. |
| \`pnpm build\` | PASS before commit. |

## Feature List Consistency

| Field | Expected |
| --- | --- |
| \`id\` | \`${input.id}\` |
| \`status\` | \`${status}\` |
| \`priority\` | \`${input.priority}\` |
| \`layer2_refs\` | \`["${layer2Ref}"]\` |
`;
}

export function createFeatureListEntry(input: FeatureSpecInput): FeatureListEntry {
  validateFeatureSpecInput(input);
  return {
    id: input.id,
    title: input.title,
    status: input.status ?? 'not_started',
    priority: input.priority,
    layer2_refs: [featureDocPath(input.id)],
    evidence: [],
    notes: input.requirement.trim()
  };
}

export function upsertFeatureListEntry(raw: string, entry: FeatureListEntry): string {
  const parsed = JSON.parse(raw) as { features?: FeatureListEntry[] };
  const features = parsed.features ?? [];
  const existingIndex = features.findIndex(feature => feature.id === entry.id);
  if (existingIndex >= 0) {
    features[existingIndex] = {
      ...features[existingIndex],
      ...entry,
      evidence: features[existingIndex]?.evidence ?? entry.evidence
    };
  } else {
    features.push(entry);
  }
  parsed.features = features.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

export function validateFeatureSpecConsistency(markdown: string, entry: FeatureListEntry): void {
  const expectedLayer2 = featureDocPath(entry.id);
  const requiredSnippets = [
    '## Requirement',
    '## Table Todo List',
    '## Verification',
    '## Feature List Consistency',
    `| \`id\` | \`${entry.id}\` |`,
    `| \`status\` | \`${entry.status}\` |`,
    `| \`priority\` | \`${entry.priority}\` |`,
    `| \`layer2_refs\` | \`["${expectedLayer2}"]\` |`
  ];

  for (const snippet of requiredSnippets) {
    if (!markdown.includes(snippet)) throw new Error(`Feature spec consistency failed for ${entry.id}: missing ${snippet}`);
  }

  if (entry.layer2_refs.length !== 1 || entry.layer2_refs[0] !== expectedLayer2) {
    throw new Error(`Feature list consistency failed for ${entry.id}: layer2_refs must be ["${expectedLayer2}"].`);
  }
  if (!VALID_FEATURE_STATUSES.has(entry.status)) {
    throw new Error(`Feature list consistency failed for ${entry.id}: invalid status ${entry.status}.`);
  }
}

export function buildFeatureAgentDryRunPrompt(): string {
  return [
    'Feature agent dry-run:',
    '- Write the atomic feature spec to docs/features/<feature-id>.md.',
    '- Include natural-language requirements, a Table Todo List, Verification, and Feature List Consistency.',
    '- Update feature_list.json with id, title, status, priority, and layer2_refs.',
    '- Run a consistency check for feature id, status, priority, and layer2_refs before review.',
    '- Use only a chore: commit message for feature spec and tracker changes.',
    '- For frontend projects, require a Figma MCP link or original design file path before creating the spec.'
  ].join('\n');
}

export function writeFeatureSpec(cwd: string, input: FeatureSpecInput, commitMessage = 'chore: add feature spec'): FeatureAgentResult {
  validateChoreCommitMessage(commitMessage);
  const featurePath = featureDocPath(input.id);
  const absoluteFeaturePath = join(cwd, featurePath);
  if (existsSync(absoluteFeaturePath)) throw new Error(`Feature spec already exists: ${featurePath}`);

  const specMarkdown = buildFeatureSpecMarkdown(input);
  const feature = createFeatureListEntry(input);
  validateFeatureSpecConsistency(specMarkdown, feature);

  mkdirSync(join(cwd, 'docs/features'), { recursive: true });
  writeFileSync(absoluteFeaturePath, specMarkdown, 'utf8');

  const featureListPath = join(cwd, 'feature_list.json');
  const updatedFeatureList = upsertFeatureListEntry(readFileSync(featureListPath, 'utf8'), feature);
  writeFileSync(featureListPath, updatedFeatureList, 'utf8');

  return {
    feature,
    featurePath,
    specMarkdown
  };
}

function validateFeatureSpecInput(input: FeatureSpecInput): void {
  if (!/^[A-Z]+-\d+$/.test(input.id)) throw new Error(`Invalid feature id: ${input.id}. Expected format like HT-004.`);
  if (!input.title.trim()) throw new Error('Feature title is required.');
  if (!input.requirement.trim()) throw new Error('Feature requirement is required.');
  if (!Number.isInteger(input.priority) || input.priority < 0) throw new Error('Feature priority must be a non-negative integer.');
  if (input.status && !VALID_FEATURE_STATUSES.has(input.status)) throw new Error(`Invalid feature status: ${input.status}.`);
  if (input.isFrontendProject && !input.designSource?.trim()) {
    throw new Error('Frontend feature specs require a Figma MCP link or original design file path.');
  }
  if (basename(featureDocPath(input.id)) !== `${input.id}.md`) throw new Error(`Invalid feature path for ${input.id}.`);
}
