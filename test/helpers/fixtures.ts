/**
 * Verbatim response bodies from the Cursor Cloud Agents API v1 docs / OpenAPI
 * examples. Do not "tidy" these — they are the contract.
 */

export const meUserFixture = {
  apiKeyName: 'Production API Key',
  userId: 42,
  createdAt: '2026-04-13T18:30:00.000Z',
  userEmail: 'developer@example.com',
  userFirstName: 'Alex',
  userLastName: 'Rivera',
};

export const meServiceAccountFixture = {
  apiKeyName: 'Production Service Account',
  createdAt: '2026-04-13T18:30:00.000Z',
};

export const createAgentFixture = {
  agent: {
    id: 'bc-00000000-0000-0000-0000-000000000001',
    name: 'Add README with setup instructions',
    status: 'ACTIVE',
    env: { type: 'cloud' },
    repos: [{ url: 'https://github.com/your-org/your-repo', startingRef: 'main' }],
    workOnCurrentBranch: false,
    autoCreatePR: true,
    url: 'https://cursor.com/agents/bc-00000000-0000-0000-0000-000000000001',
    createdAt: '2026-04-13T18:30:00.000Z',
    updatedAt: '2026-04-13T18:30:00.000Z',
    latestRunId: 'run-00000000-0000-0000-0000-000000000001',
  },
  run: {
    id: 'run-00000000-0000-0000-0000-000000000001',
    agentId: 'bc-00000000-0000-0000-0000-000000000001',
    status: 'CREATING',
    createdAt: '2026-04-13T18:30:00.000Z',
    updatedAt: '2026-04-13T18:30:00.000Z',
  },
};

export const agentFixture = {
  id: 'bc-00000000-0000-0000-0000-000000000001',
  name: 'Add README with setup instructions',
  status: 'ACTIVE',
  env: { type: 'cloud' },
  repos: [{ url: 'https://github.com/your-org/your-repo', startingRef: 'main' }],
  workOnCurrentBranch: false,
  autoCreatePR: true,
  url: 'https://cursor.com/agents/bc-00000000-0000-0000-0000-000000000001',
  createdAt: '2026-04-13T18:30:00.000Z',
  updatedAt: '2026-04-13T18:30:00.000Z',
  latestRunId: 'run-00000000-0000-0000-0000-000000000001',
};

export const listAgentsFixture = {
  items: [
    {
      id: 'bc-00000000-0000-0000-0000-000000000001',
      name: 'Add README with setup instructions',
      status: 'ACTIVE',
      env: { type: 'cloud' },
      url: 'https://cursor.com/agents/bc-00000000-0000-0000-0000-000000000001',
      createdAt: '2026-04-13T18:30:00.000Z',
      updatedAt: '2026-04-13T18:45:00.000Z',
      latestRunId: 'run-00000000-0000-0000-0000-000000000001',
    },
  ],
  nextCursor: 'bc-00000000-0000-0000-0000-000000000002',
};

export const createRunFixture = {
  run: {
    id: 'run-00000000-0000-0000-0000-000000000002',
    agentId: 'bc-00000000-0000-0000-0000-000000000001',
    status: 'CREATING',
    createdAt: '2026-04-13T18:50:00.000Z',
    updatedAt: '2026-04-13T18:50:00.000Z',
  },
};

export const listRunsFixture = {
  items: [
    {
      id: 'run-00000000-0000-0000-0000-000000000002',
      agentId: 'bc-00000000-0000-0000-0000-000000000001',
      status: 'RUNNING',
      createdAt: '2026-04-13T18:50:00.000Z',
      updatedAt: '2026-04-13T18:51:00.000Z',
      git: {
        branches: [
          { repoUrl: 'github.com/your-org/your-repo', branch: 'cursor/add-readme-a1b2' },
        ],
      },
    },
  ],
};

export const finishedRunFixture = {
  id: 'run-00000000-0000-0000-0000-000000000001',
  agentId: 'bc-00000000-0000-0000-0000-000000000001',
  status: 'FINISHED',
  createdAt: '2026-04-13T18:30:00.000Z',
  updatedAt: '2026-04-13T18:45:00.000Z',
  durationMs: 12357,
  result: 'Added README.md with installation instructions and usage examples.',
  git: {
    branches: [
      {
        repoUrl: 'github.com/your-org/your-repo',
        branch: 'cursor/add-readme-a1b2',
        prUrl: 'https://github.com/your-org/your-repo/pull/123',
      },
    ],
  },
};

export const runningRunFixture = {
  id: 'run-00000000-0000-0000-0000-000000000001',
  agentId: 'bc-00000000-0000-0000-0000-000000000001',
  status: 'RUNNING',
  createdAt: '2026-04-13T18:30:00.000Z',
  updatedAt: '2026-04-13T18:31:00.000Z',
};

export const usageFixture = {
  totalUsage: {
    inputTokens: 12480,
    outputTokens: 3110,
    cacheWriteTokens: 18200,
    cacheReadTokens: 42600,
    totalTokens: 76390,
  },
  runs: [
    {
      id: 'run-00000000-0000-0000-0000-000000000002',
      usageUuid: '00000000-0000-0000-0000-000000000002',
      usage: {
        inputTokens: 6320,
        outputTokens: 1450,
        cacheWriteTokens: 7100,
        cacheReadTokens: 21300,
        totalTokens: 36170,
      },
    },
  ],
};

export const artifactsFixture = {
  items: [{ path: 'artifacts/screenshot.png', sizeBytes: 12345, updatedAt: '2026-04-13T18:45:00.000Z' }],
};

export const artifactDownloadFixture = {
  url: 'https://cloud-agent-artifacts.s3.us-east-1.amazonaws.com/...',
  expiresAt: '2026-04-13T19:00:00.000Z',
};

export const modelsFixture = {
  items: [
    {
      id: 'composer-2',
      displayName: 'Composer 2',
      aliases: ['composer-latest', 'composer'],
      parameters: [
        {
          id: 'fast',
          displayName: 'Fast',
          values: [{ value: 'false' }, { value: 'true', displayName: 'Fast' }],
        },
      ],
      variants: [
        { params: [{ id: 'fast', value: 'true' }], displayName: 'Composer 2', isDefault: true },
        { params: [{ id: 'fast', value: 'false' }], displayName: 'Composer 2' },
      ],
    },
    {
      id: 'claude-4.6-sonnet-thinking',
      displayName: 'Claude 4.6 Sonnet (Thinking)',
      variants: [
        { params: [], displayName: 'Claude 4.6 Sonnet (Thinking)', isDefault: true },
      ],
    },
  ],
};

export const repositoriesFixture = {
  items: [{ url: 'https://github.com/your-org/your-repo' }],
};

export const idResponseFixture = { id: 'bc-00000000-0000-0000-0000-000000000001' };

/** `{"error": {...}}` — nested, per the OpenAPI Error schema. */
export function errorBody(code: string, message: string, extra: Record<string, unknown> = {}) {
  return { error: { code, message, ...extra } };
}

/** Verbatim SSE transcript from the docs page (status has no id line). */
export const SSE_TRANSCRIPT = [
  'event: status',
  'data: {"runId":"run-00000000-0000-0000-0000-000000000001","status":"RUNNING"}',
  '',
  'id: 1713033000000-0',
  'event: assistant',
  'data: {"text":"I\'ll update the README now."}',
  '',
  'id: 1713033004000-0',
  'event: heartbeat',
  'data: {}',
  '',
  'id: 1713033005000-0',
  'event: tool_call',
  'data: {"callId":"call-1","name":"read_file","status":"running","args":{"path":"README.md"}}',
  '',
  'id: 1713033010000-0',
  'event: result',
  'data: {"runId":"run-00000000-0000-0000-0000-000000000001","status":"FINISHED","text":"Added README.md with installation instructions.","durationMs":12357,"git":{"branches":[{"repoUrl":"github.com/your-org/your-repo","branch":"cursor/add-readme-a1b2"}]}}',
  '',
  'id: 1713033010000-0',
  'event: done',
  'data: {}',
  '',
  '',
].join('\n');
