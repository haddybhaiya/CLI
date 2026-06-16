import { describe, expect, it, vi } from 'vitest';
import {
  buildCloudflareAuthorizeUrl,
  listCloudflareAccounts,
  registerCloudflareDomain,
} from './cloudflare.js';

describe('Cloudflare OAuth helpers', () => {
  it('builds the Cloudflare OAuth URL with PKCE and the fixed CLI callback', () => {
    const url = new URL(buildCloudflareAuthorizeUrl({
      state: 'state-123456',
      codeChallenge: 'challenge-abc',
    }));

    expect(url.origin + url.pathname).toBe('https://dash.cloudflare.com/oauth2/auth');
    expect(url.searchParams.get('client_id')).toBe('18cf4d9bc2f1b53f205cf92ec4f143c8');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:8787/callback');
    expect(url.searchParams.get('code_challenge')).toBe('challenge-abc');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toBe(
      'registrar-domains.admin registrar-domains.read dns.write dns.read zone.write zone.read',
    );
  });

  it('allows a development override for the Cloudflare OAuth client id', () => {
    vi.stubEnv('INSFORGE_CLOUDFLARE_OAUTH_CLIENT_ID', 'dev-client-id');
    const url = new URL(buildCloudflareAuthorizeUrl({
      state: 'state-123456',
      codeChallenge: 'challenge-abc',
    }));

    expect(url.searchParams.get('client_id')).toBe('dev-client-id');
    vi.unstubAllEnvs();
  });

  it('registers domains with auto-renew and WHOIS redaction enabled', async () => {
    vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'account-123');
    vi.stubEnv('CLOUDFLARE_ACCESS_TOKEN', 'oauth-access-token');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      result: {
        domain_name: 'example.dev',
        state: 'in_progress',
        completed: false,
      },
      errors: [],
      messages: [],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await registerCloudflareDomain('example.dev');

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init?.body as string)).toEqual({
      domain_name: 'example.dev',
      auto_renew: true,
      privacy_mode: 'redaction',
    });
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('lists Cloudflare accounts with the OAuth access token', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      result: [
        {
          id: 'account-123',
          name: 'Demo Account',
          type: 'standard',
        },
      ],
      errors: [],
      messages: [],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const accounts = await listCloudflareAccounts({
      accountId: '',
      accessToken: 'oauth-access-token',
    });

    expect(accounts).toEqual([
      {
        id: 'account-123',
        name: 'Demo Account',
        type: 'standard',
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.cloudflare.com/client/v4/accounts',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer oauth-access-token',
        }),
      }),
    );
    vi.unstubAllGlobals();
  });

});
