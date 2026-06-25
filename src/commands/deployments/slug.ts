import type { Command } from 'commander';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { getProjectConfig } from '../../lib/config.js';
import { CLIError, handleError, getRootOpts, ProjectNotLinkedError } from '../../lib/errors.js';
import { outputJson, outputSuccess } from '../../lib/output.js';
import { trackDeploymentUsage } from './utils.js';

interface DeploymentMetadataSlice {
  customSlug?: string | null;
}

interface MetadataResponse {
  deployments?: DeploymentMetadataSlice | null;
}

function getSupportedDeploymentsSlice(raw: MetadataResponse): DeploymentMetadataSlice {
  const deployments = raw.deployments;
  if (!deployments || typeof deployments !== 'object') {
    throw new CLIError(
      'Deployment slug management is not supported by this backend. Upgrade the project or use a cloud deployment that exposes /api/metadata.deployments.',
      1,
      'DEPLOYMENT_SLUG_UNSUPPORTED',
    );
  }
  return deployments;
}

export function registerDeploymentsSlugCommand(deploymentsCmd: Command): void {
  deploymentsCmd
    .command('slug [slug]')
    .description('Set or remove the custom slug for the deployed site')
    .option('--remove', 'Remove the custom slug')
    .action(async (slug: string | undefined, opts, cmd) => {
      const { json } = getRootOpts(cmd);
      const action = opts.remove ? 'remove' : slug ? 'set' : 'show';
      let success = false;
      let commandFailed = false;
      let commandError: unknown;
      try {
        await requireAuth();
        if (!getProjectConfig()) throw new ProjectNotLinkedError();

        const slugValue = opts.remove ? null : (slug ?? null);
        const metadataRes = await ossFetch('/api/metadata');
        const metadata = (await metadataRes.json()) as MetadataResponse;
        const deployments = getSupportedDeploymentsSlice(metadata);

        if (!opts.remove && !slug) {
          const currentSlug = deployments.customSlug ?? null;
          if (json) {
            outputJson({ slug: currentSlug });
          } else {
            console.log(`Current slug: ${currentSlug ?? '(none)'}`);
          }
          success = true;
          return;
        }

        const res = await ossFetch('/api/deployments/slug', {
          method: 'PUT',
          body: JSON.stringify({ slug: slugValue }),
        });
        const result = await res.json() as { success: boolean; slug: string | null; domain: string | null };

        if (json) {
          outputJson(result);
        } else {
          if (result.slug) {
            outputSuccess(`Slug set to "${result.slug}"`);
            if (result.domain) console.log(`  Domain: ${result.domain}`);
          } else {
            outputSuccess('Custom slug removed.');
          }
        }
        success = true;
      } catch (err) {
        commandFailed = true;
        commandError = err;
      } finally {
        try {
          await trackDeploymentUsage('slug', success, { action });
        } catch {
          // Telemetry should never affect command behavior.
        }
      }
      if (commandFailed) handleError(commandError, json);
    });
}
