import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { CLIError } from '../lib/errors.js';

vi.mock('../lib/api/platform.js', () => ({
  listOrganizations: vi.fn(),
  listProjects: vi.fn(),
  createProject: vi.fn(),
  getProject: vi.fn(),
  getProjectApiKey: vi.fn(),
  NETWORK_ERROR_CODE: 'NETWORK_ERROR',
}));

import {
  createProjectOrAdopt,
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
    (platform.listProjects as Mock).mockResolvedValue([]);
    (platform.getProject as Mock).mockResolvedValue({ ...createdProject, status: 'active' });
  });

  it('adopts a project created despite a gateway 502', async () => {
    const platform = await import('../lib/api/platform.js');
    (platform.createProject as Mock).mockRejectedValueOnce(
      new CLIError('Request failed: 502', 1, undefined, 502),
    );
    (platform.listProjects as Mock).mockResolvedValueOnce([createdProject]);

    await expect(createProjectOrAdopt('org-id', 'demo', 'eu-central', undefined))
      .resolves.toEqual(createdProject);
    expect(platform.listProjects).toHaveBeenCalledWith('org-id', undefined);
  });

  it('does not adopt an older or differently-regioned project', async () => {
    const platform = await import('../lib/api/platform.js');
    const failure = new CLIError('Request failed: 502', 1, undefined, 502);
    (platform.createProject as Mock).mockRejectedValueOnce(failure);
    (platform.listProjects as Mock).mockResolvedValueOnce([
      { ...createdProject, created_at: '2020-01-01T00:00:00.000Z' },
      { ...createdProject, id: 'other-project', region: 'us-east' },
    ]);

    await expect(createProjectOrAdopt('org-id', 'demo', 'eu-central', undefined))
      .rejects.toBe(failure);
  });

  it('does not guess when multiple matching projects were created in the recovery window', async () => {
    const platform = await import('../lib/api/platform.js');
    const failure = new CLIError('Request failed: 502', 1, undefined, 502);
    (platform.createProject as Mock).mockRejectedValueOnce(failure);
    (platform.listProjects as Mock).mockResolvedValueOnce([
      createdProject,
      { ...createdProject, id: 'other-project' },
    ]);

    await expect(createProjectOrAdopt('org-id', 'demo', 'eu-central', undefined))
      .rejects.toBe(failure);
  });

  it('does not adopt a same-named project when the requested region is unknown', async () => {
    const platform = await import('../lib/api/platform.js');
    const failure = new CLIError('Request failed: 502', 1, undefined, 502);
    (platform.createProject as Mock).mockRejectedValueOnce(failure);
    (platform.listProjects as Mock).mockResolvedValueOnce([
      { ...createdProject, created_at: new Date(Date.now() - 30_000).toISOString() },
    ]);

    await expect(createProjectOrAdopt('org-id', 'demo', undefined, undefined))
      .rejects.toBe(failure);
    expect(platform.listProjects).not.toHaveBeenCalled();
  });

  it('never reconciles an ordinary API 500', async () => {
    const platform = await import('../lib/api/platform.js');
    const failure = new CLIError('Internal server error', 1, undefined, 500);
    (platform.createProject as Mock).mockRejectedValueOnce(failure);

    await expect(createProjectOrAdopt('org-id', 'demo', 'eu-central', undefined))
      .rejects.toBe(failure);
    expect(platform.listProjects).not.toHaveBeenCalled();
  });

  it('recognizes only gateway and transport failures as ambiguous', () => {
    expect(isAmbiguousProjectCreateFailure(new CLIError('network', 1, 'NETWORK_ERROR'))).toBe(true);
    expect(isAmbiguousProjectCreateFailure(new CLIError('gateway', 1, undefined, 503))).toBe(true);
    expect(isAmbiguousProjectCreateFailure(new CLIError('invalid request', 1, undefined, 400))).toBe(false);
    expect(isAmbiguousProjectCreateFailure(new CLIError('server error', 1, undefined, 500))).toBe(false);
  });

  it('continues polling after a transient activation-read failure', async () => {
    const platform = await import('../lib/api/platform.js');
    (platform.getProject as Mock)
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
    expect(platform.getProject).toHaveBeenCalledTimes(2);
  });
});
