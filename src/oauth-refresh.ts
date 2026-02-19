/**
 * OAuth token auto-refresh for Claude Pro subscriptions.
 *
 * Reads ~/.claude/.credentials.json, checks expiry, and refreshes
 * via https://claude.ai/oauth/token when needed. Falls back to the
 * existing token on any failure.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { logger } from './logger.js';

interface OAuthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
  subscriptionType: string;
  rateLimitTier: string;
}

interface CredentialsFile {
  claudeAiOauth: OAuthCredentials;
}

const CREDENTIALS_PATH = path.join(
  os.homedir(),
  '.claude',
  '.credentials.json',
);

/** Refresh if token expires within this window (5 minutes). */
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

function readCredentials(): CredentialsFile | null {
  try {
    const raw = fs.readFileSync(CREDENTIALS_PATH, 'utf-8');
    return JSON.parse(raw) as CredentialsFile;
  } catch (err) {
    logger.warn({ err }, 'Failed to read credentials.json');
    return null;
  }
}

function writeCredentials(creds: CredentialsFile): void {
  fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(creds, null, 2) + '\n');
}

async function refreshAccessToken(
  oauth: OAuthCredentials,
): Promise<OAuthCredentials | null> {
  try {
    const res = await fetch('https://claude.ai/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: oauth.refreshToken,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.error(
        { status: res.status, body },
        'OAuth token refresh failed',
      );
      return null;
    }

    const data = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };

    return {
      ...oauth,
      accessToken: data.access_token,
      refreshToken: data.refresh_token || oauth.refreshToken,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
  } catch (err) {
    logger.error({ err }, 'OAuth token refresh request error');
    return null;
  }
}

/**
 * Ensure the OAuth token is fresh. Returns the current (or refreshed)
 * access token, or null if credentials are unavailable.
 */
export async function ensureFreshToken(): Promise<string | null> {
  const creds = readCredentials();
  if (!creds?.claudeAiOauth) return null;

  const oauth = creds.claudeAiOauth;
  const now = Date.now();

  if (oauth.expiresAt - now > REFRESH_BUFFER_MS) {
    // Token still valid
    return oauth.accessToken;
  }

  logger.info(
    { expiresAt: new Date(oauth.expiresAt).toISOString() },
    'OAuth token expiring soon, refreshing…',
  );

  const refreshed = await refreshAccessToken(oauth);
  if (!refreshed) {
    // Refresh failed — return existing token as fallback
    logger.warn('Token refresh failed, using existing token');
    return oauth.accessToken;
  }

  // Persist refreshed credentials
  creds.claudeAiOauth = refreshed;
  writeCredentials(creds);

  logger.info(
    { expiresAt: new Date(refreshed.expiresAt).toISOString() },
    'OAuth token refreshed successfully',
  );

  return refreshed.accessToken;
}
