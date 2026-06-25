import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';
import { registerDeploymentsMetadataCommand } from './metadata.js';
import { registerDeploymentsSlugCommand } from './slug.js';
import type * as ErrorsModule from '../../lib/errors.js';

let nextMetadataResponse: unknown = {};
let nextDeploymentMetadataResponse: unknown = {};

const ossFetchMock = vi.fn(async (path: string, init?: RequestInit) => {
  if (path === '/api/metadata' && (!init || init.method === undefined || init.method === 'GET')) {
    return new Response(JSON.stringify(nextMetadataResponse), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (
    path === '/api/deployments/metadata' &&
    (!init || init.method === undefined || init.method === 'GET')
  ) {
    return new Response(JSON.stringify(nextDeploymentMetadataResponse), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (path === '/api/deployments/slug' && init?.method === 'PUT') {
    const body = JSON.parse(String(init.body ?? '{}')) as { slug: string | null };
    return new Response(
      JSON.stringify({
        success: true,
        slug: body.slug,
        domain: body.slug ? `${body.slug}.insforge.app` : null,
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    );
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
});

vi.mock('../../lib/api/oss.js', () => ({
  ossFetch: (path: string, init?: RequestInit) => ossFetchMock(path, init),
}));

vi.mock('../../lib/credentials.js', () => ({
  requireAuth: vi.fn(async () => ({ accessToken: 'tok', userId: 'u' })),
}));

vi.mock('../../lib/config.js', () => ({
  getProjectConfig: vi.fn(() => ({
    project_id: 'p1',
    project_name: 'project',
    org_id: 'o1',
    appkey: 'app',
    region: 'us-east',
    api_key: 'key',
    oss_host: 'https://app.us-east.insforge.app',
  })),
}));

vi.mock('./utils.js', () => ({
  trackDeploymentUsage: vi.fn(async () => {}),
}));

vi.mock('../../lib/errors.js', async (orig) => {
  const actual = await orig<typeof ErrorsModule>();
  return {
    ...actual,
    handleError: vi.fn((err: unknown) => {
      throw err;
    }),
  };
});

function makeProgram(): Command {
  const program = new Command().exitOverride();
  program.option('--json');
  const deployments = program.command('deployments');
  registerDeploymentsMetadataCommand(deployments);
  registerDeploymentsSlugCommand(deployments);
  return program;
}

async function runWithCapturedLog(program: Command, argv: string[]): Promise<string[]> {
  const logs: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
  try {
    await program.parseAsync(argv, { from: 'user' });
  } finally {
    logSpy.mockRestore();
  }
  return logs;
}

beforeEach(() => {
  vi.clearAllMocks();
  nextMetadataResponse = {};
  nextDeploymentMetadataResponse = {};
});

describe('deployments metadata and slug registration', () => {
  it('registers both subcommands on a deployments command', () => {
    const deployments = new Command('deployments');
    registerDeploymentsMetadataCommand(deployments);
    registerDeploymentsSlugCommand(deployments);

    expect(deployments.commands.map((cmd) => cmd.name())).toEqual(['metadata', 'slug']);
  });
});

describe('deployments metadata', () => {
  it('json mode calls /api/deployments/metadata and outputs the backend response', async () => {
    nextDeploymentMetadataResponse = {
      currentDeploymentId: 'dep_123',
      defaultDomainUrl: 'https://default.example',
      customDomainUrl: 'https://custom.example',
    };

    const logs = await runWithCapturedLog(makeProgram(), [
      '--json',
      'deployments',
      'metadata',
    ]);

    expect(ossFetchMock.mock.calls.map(([path]) => path)).toEqual([
      '/api/deployments/metadata',
    ]);
    expect(JSON.parse(logs.join('\n'))).toEqual(nextDeploymentMetadataResponse);
  });
});

describe('deployments slug', () => {
  it('json mode with no slug calls /api/metadata and reports current customSlug', async () => {
    nextMetadataResponse = { deployments: { customSlug: 'my-app' } };

    const logs = await runWithCapturedLog(makeProgram(), ['--json', 'deployments', 'slug']);

    expect(ossFetchMock.mock.calls.map(([path]) => path)).toEqual(['/api/metadata']);
    expect(JSON.parse(logs.join('\n'))).toEqual({ slug: 'my-app' });
  });

  it('setting a slug calls /api/metadata, then PUTs slug body', async () => {
    nextMetadataResponse = { deployments: { customSlug: null } };

    const logs = await runWithCapturedLog(makeProgram(), [
      '--json',
      'deployments',
      'slug',
      'my-app',
    ]);

    const putCall = ossFetchMock.mock.calls.find(
      ([path, init]) => path === '/api/deployments/slug' && init?.method === 'PUT',
    );
    expect(ossFetchMock.mock.calls.map(([path]) => path)).toEqual([
      '/api/metadata',
      '/api/deployments/slug',
    ]);
    expect(JSON.parse(String(putCall?.[1]?.body))).toEqual({ slug: 'my-app' });
    expect(JSON.parse(logs.join('\n'))).toMatchObject({ success: true, slug: 'my-app' });
  });

  it('removing a slug calls /api/metadata, then PUTs slug null', async () => {
    nextMetadataResponse = { deployments: { customSlug: 'my-app' } };

    const logs = await runWithCapturedLog(makeProgram(), [
      '--json',
      'deployments',
      'slug',
      '--remove',
    ]);

    const putCall = ossFetchMock.mock.calls.find(
      ([path, init]) => path === '/api/deployments/slug' && init?.method === 'PUT',
    );
    expect(ossFetchMock.mock.calls.map(([path]) => path)).toEqual([
      '/api/metadata',
      '/api/deployments/slug',
    ]);
    expect(JSON.parse(String(putCall?.[1]?.body))).toEqual({ slug: null });
    expect(JSON.parse(logs.join('\n'))).toMatchObject({ success: true, slug: null });
  });

  it('does not call /api/deployments/slug when backend lacks deployments metadata', async () => {
    nextMetadataResponse = { auth: { allowedRedirectUrls: [] } };

    await expect(
      runWithCapturedLog(makeProgram(), ['--json', 'deployments', 'slug', 'my-app']),
    ).rejects.toMatchObject({
      code: 'DEPLOYMENT_SLUG_UNSUPPORTED',
    });

    expect(ossFetchMock.mock.calls.map(([path]) => path)).toEqual(['/api/metadata']);
  });

  it('does not remove a slug when backend lacks deployments metadata', async () => {
    nextMetadataResponse = { auth: { allowedRedirectUrls: [] } };

    await expect(
      runWithCapturedLog(makeProgram(), ['--json', 'deployments', 'slug', '--remove']),
    ).rejects.toMatchObject({
      code: 'DEPLOYMENT_SLUG_UNSUPPORTED',
    });

    expect(ossFetchMock.mock.calls.map(([path]) => path)).toEqual(['/api/metadata']);
  });
});
