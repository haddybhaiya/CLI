import { shutdownAnalytics, trackDeployments } from '../../lib/analytics.js';
import { getProjectConfig } from '../../lib/config.js';

export type DeploymentCommandTelemetry = Record<
  string,
  string | number | boolean | undefined
>;

export async function trackDeploymentUsage(
  subcommand: string,
  success: boolean,
  properties: DeploymentCommandTelemetry = {},
): Promise<void> {
  try {
    const config = getProjectConfig();
    if (config) {
      trackDeployments(subcommand, config, {
        success,
        ...properties,
      });
    }
  } catch {
    // Telemetry should never affect command behavior.
  } finally {
    await shutdownAnalytics();
  }
}
