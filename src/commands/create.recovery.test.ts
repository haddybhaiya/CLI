import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { CLIError } from '../lib/errors.js';

vi.mock('../lib/api/platform.js', () => ({
  listOrganizations: vi.fn(),
  createProject: vi.fn(),
  getProject: vi.fn(),
  getProjectApiKey: vi.fn(),
  NETWORK_ERROR_CODE: 'NETWORK_ERROR',
}));

import {
  createProjectOrReportAmbiguousResult,
  isAmbiguousProjectCreateFailure,
  waitForProjectActive,
} from './create.js';

const createdProject = {
  id: 'project-id',
  organization_id: 'org-id',
  name: 'demo',
  appkey: 'demo-appkey',
  region: 'eu-central',
  status: 'creating',
  instance_type: 'shared',
  service_version: null,
  customized_domain: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

describe('create project recovery', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const platform = await import('../lib/api/platform.js');
    (platform.createProject as Mock).mockResolvedValue(createdProject);
    (platform.getProject as Mock).mockResolvedValue({ ...createdProject, status: 'active' });
  });

  it('reports an unknown result after a gateway failure without adopting a project', async () => {
    const platform = await import('../lib/api/platform.js');
    (platform.createProject as Mock).mockRejectedValueOnce(
      new CLIError('Request failed: 502', 1, undefined, 502),
    );

    await expect(createProjectOrReportAmbiguousResult('org-id', 'demo', 'eu-central', undefined))
      .rejects.toMatchObject({
        code: 'PROJECT_CREATE_RESULT_UNKNOWN',
        statusCode: 502,
        message: expect.stringContaining('insforge list --json'),
      });
  });

  it('never reconciles an ordinary API 500', async () => {
    const platform = await import('../lib/api/platform.js');
    const failure = new CLIError('Internal server error', 1, undefined, 500);
    (platform.createProject as Mock).mockRejectedValueOnce(failure);

    await expect(createProjectOrReportAmbiguousResult('org-id', 'demo', 'eu-central', undefined))
      .rejects.toBe(failure);
  });

  it('recognizes only gateway and transport failures as ambiguous', () => {
    expect(isAmbiguousProjectCreateFailure(new CLIError('network', 1, 'NETWORK_ERROR'))).toBe(true);
    expect(isAmbiguousProjectCreateFailure(new CLIError('gateway', 1, undefined, 503))).toBe(true);
    expect(isAmbiguousProjectCreateFailure(new CLIError('invalid request', 1, undefined, 400))).toBe(false);
    expect(isAmbiguousProjectCreateFailure(new CLIError('server error', 1, undefined, 500))).toBe(false);
  });

  it('continues polling through three transient activation-read failures when the project recovers', async () => {
    const platform = await import('../lib/api/platform.js');
    (platform.getProject as Mock)
      .mockRejectedValueOnce(new CLIError('Request failed: 502', 1, undefined, 502))
      .mockRejectedValueOnce(new CLIError('Request failed: 502', 1, undefined, 502))
      .mockRejectedValueOnce(new CLIError('Request failed: 502', 1, undefined, 502))
      .mockResolvedValueOnce({ ...createdProject, status: 'active' });
    vi.useFakeTimers();
    try {
      const pending = waitForProjectActive('project-id');
      await vi.runAllTimersAsync();
      await expect(pending).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
    expect(platform.getProject).toHaveBeenCalledTimes(4);
  });

  it('preserves the last actionable error when the activation deadline expires', async () => {
    const platform = await import('../lib/api/platform.js');
    (platform.getProject as Mock).mockRejectedValue(
      new CLIError('Request failed: 502', 1, undefined, 502),
    );
    vi.useFakeTimers();
    try {
      const expected = expect(waitForProjectActive('project-id', undefined, 10_000)).rejects.toMatchObject({
        message: expect.stringContaining('Last control-plane error: Request failed: 502'),
        statusCode: 502,
      });
      await vi.runAllTimersAsync();
      await expected;
    } finally {
      vi.useRealTimers();
    }
    expect(platform.getProject).toHaveBeenCalledTimes(4);
  });
});
