import { describe, expect, it } from 'vitest';
import {
  buildDnsSetupRecords,
  confirmPurchase,
  hasExplicitPurchaseConfirmation,
  type DnsSetupRecord,
} from './index.js';

describe('domains command helpers', () => {
  it('builds apex routing and verification DNS records', () => {
    const records = buildDnsSetupRecords({
      domain: 'example.com',
      apexDomain: 'example.com',
      verified: false,
      misconfigured: false,
      cnameTarget: null,
      aRecordValue: '216.150.16.1',
      verification: [
        {
          type: 'TXT',
          domain: '_vercel.example.com',
          value: 'vc-domain-verify=example.com,abc123',
        },
      ],
    });

    expect(records).toEqual<DnsSetupRecord[]>([
      {
        type: 'A',
        name: 'example.com',
        content: '216.150.16.1',
        purpose: 'routing',
      },
      {
        type: 'TXT',
        name: '_vercel.example.com',
        content: 'vc-domain-verify=example.com,abc123',
        purpose: 'verification',
      },
    ]);
  });

  it('builds subdomain CNAME records', () => {
    const records = buildDnsSetupRecords({
      domain: 'www.example.com',
      apexDomain: 'example.com',
      verified: false,
      misconfigured: false,
      cnameTarget: 'cname.vercel-dns.com',
      aRecordValue: '216.150.16.1',
      verification: [],
    });

    expect(records).toEqual<DnsSetupRecord[]>([
      {
        type: 'CNAME',
        name: 'www.example.com',
        content: 'cname.vercel-dns.com',
        purpose: 'routing',
      },
    ]);
  });

  it('requires all purchase confirmation fields to match exactly', () => {
    const candidate = {
      name: 'example.dev',
      registrable: true,
      pricing: {
        currency: 'USD',
        registration_cost: '10.11',
        renewal_cost: '10.11',
      },
    };

    expect(
      hasExplicitPurchaseConfirmation('example.dev', candidate, {
        confirmDomain: 'example.dev',
        confirmPrice: '10.11',
        confirmCurrency: 'usd',
        confirmCloudflareBilling: true,
        confirmNonRefundable: true,
      }),
    ).toBe(true);

    expect(
      hasExplicitPurchaseConfirmation('example.dev', candidate, {
        confirmDomain: 'example.dev',
        confirmPrice: '10.10',
        confirmCurrency: 'USD',
        confirmCloudflareBilling: true,
        confirmNonRefundable: true,
      }),
    ).toBe(false);
  });

  it('rejects non-interactive purchases without explicit confirmation flags', async () => {
    await expect(confirmPurchase('example.dev', {
      name: 'example.dev',
      registrable: true,
      pricing: {
        currency: 'USD',
        registration_cost: '10.11',
        renewal_cost: '10.11',
      },
    }, {})).rejects.toMatchObject({
      code: 'DOMAIN_PURCHASE_CONFIRMATION_REQUIRED',
    });
  });
});
