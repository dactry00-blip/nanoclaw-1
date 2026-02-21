/**
 * Threads API long-lived token auto-refresh.
 *
 * Meta long-lived tokens last 60 days and can be refreshed after 24 hours.
 * This module checks token expiry on each container spawn and refreshes
 * proactively (7 days before expiry). On successful refresh it updates
 * both the state file and .env so the new token survives restarts.
 *
 * Refresh endpoint:
 *   GET https://graph.threads.net/refresh_access_token
 *     ?grant_type=th_refresh_token&access_token=<long-lived-token>
 */
import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';
import { readEnvFile } from './env.js';

interface ThreadsTokenState {
  accessToken: string;
  expiresAt: number; // ms since epoch
  lastRefreshAt: number; // ms since epoch
}

const STATE_PATH = path.join(process.cwd(), 'data', 'threads-token-state.json');
const ENV_PATH = path.join(process.cwd(), '.env');

/** Refresh 7 days before expiry. */
const REFRESH_BUFFER_MS = 7 * 24 * 60 * 60 * 1000;

function readState(): ThreadsTokenState | null {
  try {
    const raw = fs.readFileSync(STATE_PATH, 'utf-8');
    return JSON.parse(raw) as ThreadsTokenState;
  } catch {
    return null;
  }
}

function writeState(state: ThreadsTokenState): void {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
}

/** Persist the refreshed token back to .env so it survives restarts. */
function updateEnvToken(newToken: string): void {
  try {
    let content = fs.readFileSync(ENV_PATH, 'utf-8');
    content = content.replace(
      /^THREADS_ACCESS_TOKEN=.+$/m,
      `THREADS_ACCESS_TOKEN=${newToken}`,
    );
    fs.writeFileSync(ENV_PATH, content);
  } catch (err) {
    logger.warn({ err }, 'Failed to update THREADS_ACCESS_TOKEN in .env');
  }
}

async function refreshToken(
  currentToken: string,
): Promise<{ accessToken: string; expiresIn: number } | null> {
  try {
    const url = new URL('https://graph.threads.net/refresh_access_token');
    url.searchParams.set('grant_type', 'th_refresh_token');
    url.searchParams.set('access_token', currentToken);

    const res = await fetch(url.toString());

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.error(
        { status: res.status, body },
        'Threads token refresh failed',
      );
      return null;
    }

    const data = (await res.json()) as {
      access_token: string;
      token_type: string;
      expires_in: number;
    };

    if (!data.access_token) {
      logger.error({ data }, 'Threads token refresh returned no access_token');
      return null;
    }

    return { accessToken: data.access_token, expiresIn: data.expires_in };
  } catch (err) {
    logger.error({ err }, 'Threads token refresh request error');
    return null;
  }
}

/**
 * Ensure the Threads long-lived token is fresh.
 * Returns the current or refreshed token, or null if not configured.
 */
export async function ensureFreshThreadsToken(): Promise<string | null> {
  const env = readEnvFile(['THREADS_ACCESS_TOKEN']);
  const tokenFromEnv = env.THREADS_ACCESS_TOKEN;

  if (!tokenFromEnv) return null;

  const now = Date.now();
  let state = readState();

  // First run or token changed externally — seed the state file
  if (!state || state.accessToken !== tokenFromEnv) {
    state = {
      accessToken: tokenFromEnv,
      expiresAt: now + 60 * 24 * 60 * 60 * 1000, // assume 60 days
      lastRefreshAt: now,
    };
    writeState(state);
    return tokenFromEnv;
  }

  // Token still comfortably valid
  if (state.expiresAt - now > REFRESH_BUFFER_MS) {
    return state.accessToken;
  }

  logger.info(
    {
      expiresAt: new Date(state.expiresAt).toISOString(),
      daysLeft: Math.round((state.expiresAt - now) / (24 * 60 * 60 * 1000)),
    },
    'Threads token expiring soon, refreshing…',
  );

  const refreshed = await refreshToken(state.accessToken);
  if (!refreshed) {
    logger.warn('Threads token refresh failed, using existing token');
    return state.accessToken;
  }

  const newState: ThreadsTokenState = {
    accessToken: refreshed.accessToken,
    expiresAt: now + refreshed.expiresIn * 1000,
    lastRefreshAt: now,
  };

  writeState(newState);
  updateEnvToken(refreshed.accessToken);

  const daysValid = Math.round(refreshed.expiresIn / 86400);
  logger.info(
    { expiresAt: new Date(newState.expiresAt).toISOString(), daysValid },
    'Threads token refreshed successfully',
  );

  return refreshed.accessToken;
}
