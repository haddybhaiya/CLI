import pc from 'picocolors';
import type { Command } from 'commander';
import * as prompts from '../../lib/prompts.js';
import { ossFetch } from '../../lib/api/oss.js';
import {
  checkCloudflareDomains,
  ensureCloudflareZone,
  getCloudflareRegistration,
  getCloudflareRegistrationStatus,
  performCloudflareOAuthLogin,
  registerCloudflareDomain,
  searchCloudflareDomains,
  upsertCloudflareDnsRecord,
  type CloudflareAccount,
  type CloudflareDomainCandidate,
  type CloudflareRegistrationWorkflow,
} from '../../lib/cloudflare.js';
import { requireAuth } from '../../lib/credentials.js';
import { CLIError, getRootOpts, handleError } from '../../lib/errors.js';
import { outputJson, outputSuccess, outputTable } from '../../lib/output.js';
import { trackDomainUsage } from './telemetry.js';

interface DomainVerificationRecord {
  type: string;
  domain: string;
  value: string;
}

interface CustomDomain {
  domain: string;
  apexDomain: string;
  verified: boolean;
  misconfigured: boolean;
  verification: DomainVerificationRecord[];
  cnameTarget: string | null;
  aRecordValue: string | null;
}

interface ListCustomDomainsResponse {
  domains: CustomDomain[];
}

export interface DnsSetupRecord {
  type: string;
  name: string;
  content: string;
  purpose: 'routing' | 'verification';
}

interface PurchaseConfirmationOptions {
  confirmDomain?: string;
  confirmPrice?: string;
  confirmCurrency?: string;
  confirmCloudflareBilling?: boolean;
  confirmNonRefundable?: boolean;
}

interface DomainCommandOptions extends PurchaseConfirmationOptions {
  accountId?: string;
  skipBrowser?: boolean;
  limit?: string;
  tlds?: string;
  pollSeconds?: string;
  cloudflare?: boolean;
}

function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/\.$/, '');
}

function parsePositiveInteger(value: string | undefined, option: string, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new CLIError(`${option} must be a non-negative integer.`);
  }
  return parsed;
}

function parseTlds(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim().toLowerCase().replace(/^\./, ''))
    .filter(Boolean);
}

function getTld(domain: string): string {
  return domain.split('.').pop()?.toLowerCase() ?? '';
}

function formatPrice(candidate: CloudflareDomainCandidate): string {
  if (!candidate.pricing) return '-';
  return `${candidate.pricing.currency} ${candidate.pricing.registration_cost}`;
}

function formatRenewal(candidate: CloudflareDomainCandidate): string {
  if (!candidate.pricing) return '-';
  return `${candidate.pricing.currency} ${candidate.pricing.renewal_cost}`;
}

function assertRegistrable(candidate: CloudflareDomainCandidate | undefined, domain: string): CloudflareDomainCandidate {
  if (!candidate) {
    throw new CLIError(`Cloudflare did not return availability for ${domain}.`, 1, 'DOMAIN_CHECK_MISSING');
  }
  if (!candidate.registrable) {
    throw new CLIError(
      `${domain} is not registrable${candidate.reason ? `: ${candidate.reason}` : ''}.`,
      1,
      'DOMAIN_NOT_REGISTRABLE',
    );
  }
  if (!candidate.pricing) {
    throw new CLIError(`Cloudflare did not return pricing for ${domain}.`, 1, 'DOMAIN_PRICE_MISSING');
  }
  return candidate;
}

export function hasExplicitPurchaseConfirmation(
  domain: string,
  candidate: CloudflareDomainCandidate,
  opts: PurchaseConfirmationOptions,
): boolean {
  return opts.confirmDomain === domain &&
    opts.confirmPrice === candidate.pricing?.registration_cost &&
    opts.confirmCurrency?.toUpperCase() === candidate.pricing?.currency.toUpperCase() &&
    opts.confirmCloudflareBilling === true &&
    opts.confirmNonRefundable === true;
}

async function confirmPurchase(
  domain: string,
  candidate: CloudflareDomainCandidate,
  opts: PurchaseConfirmationOptions,
): Promise<void> {
  if (hasExplicitPurchaseConfirmation(domain, candidate, opts)) {
    return;
  }

  if (!prompts.isInteractive) {
    throw new CLIError(
      [
        'Domain registration requires explicit confirmation.',
        `Re-run with --confirm-domain ${domain}`,
        `--confirm-price ${candidate.pricing?.registration_cost}`,
        `--confirm-currency ${candidate.pricing?.currency}`,
        '--confirm-cloudflare-billing',
        '--confirm-non-refundable',
      ].join(' '),
      1,
      'DOMAIN_PURCHASE_CONFIRMATION_REQUIRED',
    );
  }

  const confirmed = await prompts.confirm({
    message: `Register ${domain} for ${formatPrice(candidate)}? Cloudflare will charge the account default payment method and successful registrations are non-refundable.`,
    initialValue: false,
  });
  if (prompts.isCancel(confirmed) || !confirmed) {
    throw new CLIError('Domain registration cancelled.', 1, 'DOMAIN_PURCHASE_CANCELLED');
  }
}

export function buildDnsSetupRecords(domain: CustomDomain): DnsSetupRecord[] {
  const records: DnsSetupRecord[] = [];
  if (domain.domain === domain.apexDomain && domain.aRecordValue) {
    records.push({
      type: 'A',
      name: domain.apexDomain,
      content: domain.aRecordValue,
      purpose: 'routing',
    });
  }
  if (domain.domain !== domain.apexDomain && domain.cnameTarget) {
    records.push({
      type: 'CNAME',
      name: domain.domain,
      content: domain.cnameTarget,
      purpose: 'routing',
    });
  }
  for (const record of domain.verification) {
    records.push({
      type: record.type,
      name: record.domain,
      content: record.value,
      purpose: 'verification',
    });
  }
  return records;
}

async function getInsForgeCustomDomain(domain: string): Promise<CustomDomain | null> {
  const res = await ossFetch('/api/deployments/domains');
  const data = await res.json() as ListCustomDomainsResponse;
  return data.domains.find((entry) => normalizeDomain(entry.domain) === domain) ?? null;
}

async function attachInsForgeCustomDomain(domain: string): Promise<CustomDomain> {
  try {
    const res = await ossFetch('/api/deployments/domains', {
      method: 'POST',
      body: JSON.stringify({ domain }),
    });
    return await res.json() as CustomDomain;
  } catch (err) {
    if (err instanceof CLIError && err.code === 'DOMAIN_ALREADY_EXISTS') {
      const existing = await getInsForgeCustomDomain(domain);
      if (existing) return existing;
    }
    throw err;
  }
}

async function verifyInsForgeCustomDomain(domain: string): Promise<CustomDomain> {
  const res = await ossFetch(`/api/deployments/domains/${encodeURIComponent(domain)}/verify`, {
    method: 'POST',
  });
  return await res.json() as CustomDomain;
}

async function syncCloudflareDns(domain: CustomDomain): Promise<DnsSetupRecord[]> {
  const records = buildDnsSetupRecords(domain);
  if (records.length === 0) {
    throw new CLIError(
      'InsForge did not return DNS records for this domain yet. Run `domains status` and retry `domains dns sync` later.',
      1,
      'DOMAIN_DNS_RECORDS_PENDING',
    );
  }

  const zone = await ensureCloudflareZone(domain.apexDomain);
  for (const record of records) {
    await upsertCloudflareDnsRecord(zone.id, {
      type: record.type,
      name: record.name,
      content: record.content,
      proxied: false,
    });
  }
  return records;
}

function printDomains(domains: CloudflareDomainCandidate[], json: boolean): void {
  if (json) {
    outputJson({ domains });
    return;
  }
  outputTable(
    ['Domain', 'Registrable', 'Price', 'Renewal', 'Reason'],
    domains.map((entry) => [
      entry.name,
      entry.registrable ? 'Yes' : 'No',
      formatPrice(entry),
      formatRenewal(entry),
      entry.reason ?? '-',
    ]),
  );
}

function printCustomDomain(domain: CustomDomain, json: boolean): void {
  if (json) {
    outputJson(domain);
    return;
  }
  outputTable(
    ['Field', 'Value'],
    [
      ['Domain', domain.domain],
      ['Apex Domain', domain.apexDomain],
      ['Verified', domain.verified ? 'Yes' : 'No'],
      ['Misconfigured', domain.misconfigured ? 'Yes' : 'No'],
      ['CNAME Target', domain.cnameTarget ?? '-'],
      ['A Record', domain.aRecordValue ?? '-'],
    ],
  );
}

function printDnsRecords(records: DnsSetupRecord[], json: boolean): void {
  if (json) {
    outputJson({ records });
    return;
  }
  outputTable(
    ['Type', 'Name', 'Content', 'Purpose'],
    records.map((record) => [record.type, record.name, record.content, record.purpose]),
  );
}

function isTerminalRegistrationState(workflow: CloudflareRegistrationWorkflow): boolean {
  return workflow.state === 'succeeded' ||
    workflow.state === 'failed' ||
    workflow.state === 'action_required' ||
    workflow.state === 'blocked';
}

async function pollRegistration(domain: string, seconds: number): Promise<CloudflareRegistrationWorkflow | null> {
  if (seconds <= 0) return null;
  const deadline = Date.now() + seconds * 1000;
  let latest: CloudflareRegistrationWorkflow | null = null;
  while (Date.now() < deadline) {
    latest = await getCloudflareRegistrationStatus(domain);
    if (isTerminalRegistrationState(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  return latest;
}

async function registerAfterCheck(
  domain: string,
  opts: DomainCommandOptions,
  pollSeconds: number,
): Promise<CloudflareRegistrationWorkflow> {
  const checked = await checkCloudflareDomains([domain]);
  const candidate = assertRegistrable(checked.find((entry) => normalizeDomain(entry.name) === domain), domain);
  await confirmPurchase(domain, candidate, opts);
  const workflow = await registerCloudflareDomain(domain);
  if (isTerminalRegistrationState(workflow)) return workflow;
  return await pollRegistration(domain, pollSeconds) ?? workflow;
}

function assertRegistrationSucceeded(workflow: CloudflareRegistrationWorkflow): void {
  if (workflow.state !== 'succeeded') {
    const detail = workflow.error?.message ? ` ${workflow.error.message}` : '';
    throw new CLIError(
      `Cloudflare registration is ${workflow.state}.${detail} Run \`npx @insforge/cli domains resume ${workflow.domain_name}\` after it succeeds.`,
      1,
      'DOMAIN_REGISTRATION_NOT_READY',
    );
  }
}

async function selectCloudflareAccount(accounts: CloudflareAccount[]): Promise<string> {
  const selected = await prompts.select({
    message: 'Cloudflare account',
    options: accounts.map((account) => ({
      value: account.id,
      label: account.name,
      hint: account.id,
    })),
  });
  if (prompts.isCancel(selected)) throw new CLIError('Cloudflare login cancelled.');
  return selected;
}

export function registerDomainsCommands(program: Command): void {
  const domainsCmd = program.command('domains').description('Register and attach custom domains');

  const cloudflareCmd = domainsCmd.command('cloudflare').description('Manage Cloudflare OAuth connection');
  cloudflareCmd
    .command('login')
    .description('Connect Cloudflare through OAuth')
    .option('--account-id <id>', 'Cloudflare account ID')
    .option('--skip-browser', 'Do not auto-open the browser; only print the OAuth URL')
    .action(async (opts: DomainCommandOptions, cmd) => {
      const { json } = getRootOpts(cmd);
      const telemetry = { account_id_provided: Boolean(opts.accountId) };
      try {
        const creds = await performCloudflareOAuthLogin({
          accountId: opts.accountId,
          skipBrowser: opts.skipBrowser,
          selectAccount: prompts.isInteractive && !json ? selectCloudflareAccount : undefined,
        });
        await trackDomainUsage('cloudflare_login', true, telemetry);
        if (json) {
          outputJson({ success: true, accountId: creds.accountId, scope: creds.scope });
        } else {
          outputSuccess(`Cloudflare connected for account ${pc.bold(creds.accountId)}`);
        }
      } catch (err) {
        await trackDomainUsage('cloudflare_login', false, telemetry, err);
        handleError(err, json);
      }
    });

  domainsCmd
    .command('search <query>')
    .description('Search for available domains through Cloudflare Registrar')
    .option('--limit <limit>', 'Maximum Cloudflare search results', '10')
    .option('--tlds <list>', 'Optional comma-separated TLD filter')
    .action(async (query: string, opts: DomainCommandOptions, cmd) => {
      const { json } = getRootOpts(cmd);
      const telemetry = { has_tlds_filter: Boolean(opts.tlds) };
      try {
        const limit = parsePositiveInteger(opts.limit, '--limit', 10);
        const domains = await searchCloudflareDomains(query, limit);
        const tlds = opts.tlds ? new Set(parseTlds(opts.tlds)) : null;
        const filtered = tlds ? domains.filter((entry) => tlds.has(getTld(entry.name))) : domains;
        await trackDomainUsage('search', true, {
          ...telemetry,
          result_count: filtered.length,
        });
        printDomains(filtered, json);
      } catch (err) {
        await trackDomainUsage('search', false, telemetry, err);
        handleError(err, json);
      }
    });

  domainsCmd
    .command('check <domains...>')
    .description('Check real-time availability and pricing')
    .action(async (domains: string[], _opts, cmd) => {
      const { json } = getRootOpts(cmd);
      const normalized = domains.map(normalizeDomain);
      const telemetry = {
        tld: normalized.length === 1 ? getTld(normalized[0]) : undefined,
        result_count: normalized.length,
      };
      try {
        const checked = await checkCloudflareDomains(normalized);
        await trackDomainUsage('check', true, {
          ...telemetry,
          result_count: checked.length,
        });
        printDomains(checked, json);
      } catch (err) {
        await trackDomainUsage('check', false, telemetry, err);
        handleError(err, json);
      }
    });

  domainsCmd
    .command('buy <domain>')
    .description('Register a domain in the connected Cloudflare account')
    .option('--confirm-domain <domain>', 'Required non-interactive purchase confirmation')
    .option('--confirm-price <amount>', 'Required non-interactive purchase confirmation')
    .option('--confirm-currency <currency>', 'Required non-interactive purchase confirmation')
    .option('--confirm-cloudflare-billing', 'Confirm Cloudflare will charge the account default payment method')
    .option('--confirm-non-refundable', 'Confirm successful registrations are non-refundable')
    .option('--poll-seconds <seconds>', 'Wait for Cloudflare registration completion', '0')
    .action(async (rawDomain: string, opts: DomainCommandOptions, cmd) => {
      const { json } = getRootOpts(cmd);
      const domain = normalizeDomain(rawDomain);
      const baseTelemetry = { tld: getTld(domain) };
      try {
        const pollSeconds = parsePositiveInteger(opts.pollSeconds, '--poll-seconds', 0);
        const telemetry = {
          ...baseTelemetry,
          poll_seconds: pollSeconds,
          confirmed: Boolean(hasExplicitPurchaseConfirmation(domain, {
            name: domain,
            registrable: true,
            pricing: {
              currency: opts.confirmCurrency ?? '',
              registration_cost: opts.confirmPrice ?? '',
              renewal_cost: opts.confirmPrice ?? '',
            },
          }, opts)),
        };
        const workflow = await registerAfterCheck(
          domain,
          opts,
          pollSeconds,
        );
        await trackDomainUsage('buy', true, {
          ...telemetry,
          registration_state: workflow.state,
          registration_completed: workflow.completed,
        });
        if (json) {
          outputJson(workflow);
        } else {
          outputSuccess(`Cloudflare registration workflow is ${workflow.state}`);
          outputTable(
            ['Field', 'Value'],
            [
              ['Domain', workflow.domain_name],
              ['State', workflow.state],
              ['Completed', workflow.completed ? 'Yes' : 'No'],
            ],
          );
        }
      } catch (err) {
        await trackDomainUsage('buy', false, baseTelemetry, err);
        handleError(err, json);
      }
    });

  domainsCmd
    .command('attach <domain>')
    .description('Attach a domain to the linked InsForge deployment')
    .action(async (rawDomain: string, _opts, cmd) => {
      const { json, apiUrl } = getRootOpts(cmd);
      const domainName = normalizeDomain(rawDomain);
      const telemetry = { tld: getTld(domainName) };
      try {
        await requireAuth(apiUrl);
        const domain = await attachInsForgeCustomDomain(domainName);
        await trackDomainUsage('attach', true, telemetry);
        printCustomDomain(domain, json);
      } catch (err) {
        await trackDomainUsage('attach', false, telemetry, err);
        handleError(err, json);
      }
    });

  const dnsCmd = domainsCmd.command('dns').description('Manage DNS records for attached domains');
  dnsCmd
    .command('sync <domain>')
    .description('Write InsForge/Vercel DNS records to Cloudflare DNS')
    .action(async (rawDomain: string, _opts, cmd) => {
      const { json, apiUrl } = getRootOpts(cmd);
      const domain = normalizeDomain(rawDomain);
      const telemetry = { tld: getTld(domain) };
      try {
        await requireAuth(apiUrl);
        const attached = await getInsForgeCustomDomain(domain);
        if (!attached) {
          throw new CLIError(`Domain ${domain} is not attached to this InsForge project.`, 4, 'DOMAIN_NOT_FOUND');
        }
        const records = await syncCloudflareDns(attached);
        await trackDomainUsage('dns_sync', true, {
          ...telemetry,
          result_count: records.length,
        });
        printDnsRecords(records, json);
      } catch (err) {
        await trackDomainUsage('dns_sync', false, telemetry, err);
        handleError(err, json);
      }
    });

  domainsCmd
    .command('verify <domain>')
    .description('Verify an attached domain through InsForge')
    .action(async (rawDomain: string, _opts, cmd) => {
      const { json, apiUrl } = getRootOpts(cmd);
      const domainName = normalizeDomain(rawDomain);
      const telemetry = { tld: getTld(domainName) };
      try {
        await requireAuth(apiUrl);
        const domain = await verifyInsForgeCustomDomain(domainName);
        await trackDomainUsage('verify', true, telemetry);
        printCustomDomain(domain, json);
      } catch (err) {
        await trackDomainUsage('verify', false, telemetry, err);
        handleError(err, json);
      }
    });

  domainsCmd
    .command('status <domain>')
    .description('Show InsForge domain status, optionally including Cloudflare registration status')
    .option('--cloudflare', 'Also fetch Cloudflare registration status')
    .action(async (rawDomain: string, opts: DomainCommandOptions, cmd) => {
      const { json, apiUrl } = getRootOpts(cmd);
      const domain = normalizeDomain(rawDomain);
      const telemetry = {
        tld: getTld(domain),
        cloudflare: Boolean(opts.cloudflare),
      };
      try {
        await requireAuth(apiUrl);
        const attached = await getInsForgeCustomDomain(domain);
        const registration = opts.cloudflare
          ? await getCloudflareRegistration(domain).catch(() => null)
          : null;
        await trackDomainUsage('status', true, {
          ...telemetry,
          registration_state: registration?.status,
        });
        if (json) {
          outputJson({ domain: attached, registration });
        } else if (!attached) {
          console.log(`Domain ${domain} is not attached to this InsForge project.`);
        } else {
          printCustomDomain(attached, false);
          if (registration) {
            outputTable(
              ['Cloudflare Field', 'Value'],
              [
                ['Status', registration.status],
                ['Expires', registration.expires_at ?? '-'],
                ['Auto Renew', registration.auto_renew === undefined ? '-' : registration.auto_renew ? 'Yes' : 'No'],
                ['Privacy', registration.privacy_mode ?? '-'],
              ],
            );
          }
        }
      } catch (err) {
        await trackDomainUsage('status', false, telemetry, err);
        handleError(err, json);
      }
    });

  domainsCmd
    .command('resume <domain>')
    .description('Resume attach, DNS sync, and verification after Cloudflare registration completes')
    .action(async (rawDomain: string, _opts, cmd) => {
      const { json, apiUrl } = getRootOpts(cmd);
      const domain = normalizeDomain(rawDomain);
      const telemetry = { tld: getTld(domain) };
      try {
        await requireAuth(apiUrl);
        const workflow = await getCloudflareRegistrationStatus(domain);
        assertRegistrationSucceeded(workflow);
        const attached = await attachInsForgeCustomDomain(domain);
        const records = await syncCloudflareDns(attached);
        const verified = await verifyInsForgeCustomDomain(domain);
        await trackDomainUsage('resume', true, {
          ...telemetry,
          registration_state: workflow.state,
          registration_completed: workflow.completed,
          result_count: records.length,
        });
        if (json) {
          outputJson({ registration: workflow, domain: verified, dnsRecords: records });
        } else {
          outputSuccess(`Resumed ${domain}`);
          printCustomDomain(verified, false);
          printDnsRecords(records, false);
        }
      } catch (err) {
        await trackDomainUsage('resume', false, telemetry, err);
        handleError(err, json);
      }
    });

  domainsCmd
    .command('buy-and-attach <domain>')
    .description('Register a domain, attach it to InsForge, sync Cloudflare DNS, and verify')
    .option('--confirm-domain <domain>', 'Required non-interactive purchase confirmation')
    .option('--confirm-price <amount>', 'Required non-interactive purchase confirmation')
    .option('--confirm-currency <currency>', 'Required non-interactive purchase confirmation')
    .option('--confirm-cloudflare-billing', 'Confirm Cloudflare will charge the account default payment method')
    .option('--confirm-non-refundable', 'Confirm successful registrations are non-refundable')
    .option('--poll-seconds <seconds>', 'Wait for Cloudflare registration completion', '90')
    .action(async (rawDomain: string, opts: DomainCommandOptions, cmd) => {
      const { json, apiUrl } = getRootOpts(cmd);
      const domain = normalizeDomain(rawDomain);
      const baseTelemetry = { tld: getTld(domain) };
      try {
        await requireAuth(apiUrl);
        const pollSeconds = parsePositiveInteger(opts.pollSeconds, '--poll-seconds', 90);
        const telemetry = {
          ...baseTelemetry,
          poll_seconds: pollSeconds,
          confirmed: Boolean(hasExplicitPurchaseConfirmation(domain, {
            name: domain,
            registrable: true,
            pricing: {
              currency: opts.confirmCurrency ?? '',
              registration_cost: opts.confirmPrice ?? '',
              renewal_cost: opts.confirmPrice ?? '',
            },
          }, opts)),
        };
        const registration = await registerAfterCheck(
          domain,
          opts,
          pollSeconds,
        );
        assertRegistrationSucceeded(registration);

        const attached = await attachInsForgeCustomDomain(domain);
        const dnsRecords = await syncCloudflareDns(attached);
        const verified = await verifyInsForgeCustomDomain(domain);
        await trackDomainUsage('buy_and_attach', true, {
          ...telemetry,
          registration_state: registration.state,
          registration_completed: registration.completed,
          result_count: dnsRecords.length,
        });

        if (json) {
          outputJson({ registration, domain: verified, dnsRecords });
        } else {
          outputSuccess(`Registered and attached ${domain}`);
          printCustomDomain(verified, false);
          printDnsRecords(dnsRecords, false);
        }
      } catch (err) {
        await trackDomainUsage('buy_and_attach', false, baseTelemetry, err);
        handleError(err, json);
      }
    });
}
