/**
 * Container Runner for NanoClaw
 * Spawns agent execution in Docker container and handles IPC
 */
import { ChildProcess, exec, execSync, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
} from './config.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { ensureFreshToken } from './oauth-refresh.js';
import { ensureFreshThreadsToken } from './threads-refresh.js';
import { validateAdditionalMounts } from './mount-security.js';
import { RegisteredGroup } from './types.js';

// ── Auth fallback state management ──────────────────────────────────
const AUTH_STATE_PATH = path.join(DATA_DIR, 'auth-state.json');
const FALLBACK_DURATION_MS = 5 * 60 * 60 * 1000; // 5 hours

interface AuthState {
  fallbackSince: number | null;
}

function readAuthState(): AuthState {
  try {
    return JSON.parse(fs.readFileSync(AUTH_STATE_PATH, 'utf-8'));
  } catch {
    return { fallbackSince: null };
  }
}

function writeAuthState(state: AuthState): void {
  fs.mkdirSync(path.dirname(AUTH_STATE_PATH), { recursive: true });
  fs.writeFileSync(AUTH_STATE_PATH, JSON.stringify(state) + '\n');
}

function enterFallbackMode(): void {
  writeAuthState({ fallbackSince: Date.now() });
  logger.warn('Auth: entered fallback mode (API key), will retry OAuth in 5 hours');
}

function clearFallbackMode(): void {
  const state = readAuthState();
  if (state.fallbackSince) {
    writeAuthState({ fallbackSince: null });
    logger.info('Auth: cleared fallback mode, back to OAuth');
  }
}

interface SecretsResult {
  secrets: Record<string, string>;
  authMethod: 'oauth' | 'fallback';
}

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

/**
 * Pre-warm the Docker container image by running a no-op container at startup.
 * This pulls the image layers into Docker's cache and pre-loads the runtime,
 * reducing first-container startup from ~7-8s to ~2-3s.
 */
export function prewarmContainer(): void {
  logger.info('Pre-warming container image...');
  const child = spawn('docker', [
    'run', '--rm', '--entrypoint', 'true', CONTAINER_IMAGE,
  ], { stdio: 'pipe' });

  child.on('close', (code) => {
    if (code === 0) {
      logger.info('Container image pre-warmed successfully');
    } else {
      logger.warn({ code }, 'Container pre-warm exited with non-zero code');
    }
  });

  child.on('error', (err) => {
    logger.warn({ err }, 'Container pre-warm failed');
  });
}

function getHomeDir(): string {
  const home = process.env.HOME || os.homedir();
  if (!home) {
    throw new Error(
      'Unable to determine home directory: HOME environment variable is not set and os.homedir() returned empty',
    );
  }
  return home;
}

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  secrets?: Record<string, string>;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  progress?: string;
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const homeDir = getHomeDir();
  const projectRoot = process.cwd();

  if (isMain) {
    // Main gets the entire project root mounted
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: false,
    });

    // Main also gets its group folder as the working directory
    mounts.push({
      hostPath: path.join(GROUPS_DIR, group.folder),
      containerPath: '/workspace/group',
      readonly: false,
    });
  } else {
    // Other groups only get their own folder
    mounts.push({
      hostPath: path.join(GROUPS_DIR, group.folder),
      containerPath: '/workspace/group',
      readonly: false,
    });

    // Global memory directory (read-only for non-main)
    // Docker bind mounts work with both files and directories
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: true,
      });
    }
  }

  // Per-group Claude sessions directory (isolated from other groups)
  // Each group gets their own .claude/ to prevent cross-group session access
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true, mode: 0o777 });
  // Pre-create debug directory for Claude Agent SDK debug logs
  fs.mkdirSync(path.join(groupSessionsDir, 'debug'), { recursive: true, mode: 0o777 });
  // Ensure directory is writable by container's node user (uid 1000)
  // which differs from the host user on some Linux setups
  try { fs.chmodSync(groupSessionsDir, 0o777); } catch { /* best effort */ }
  try { fs.chmodSync(path.join(groupSessionsDir, 'debug'), 0o777); } catch { /* best effort */ }

  // Copy host credentials.json into group session dir so Claude CLI
  // can authenticate inside the container (it reads ~/.claude/.credentials.json)
  const hostCredentials = path.join(getHomeDir(), '.claude', '.credentials.json');
  const containerCredentials = path.join(groupSessionsDir, '.credentials.json');
  try {
    if (fs.existsSync(hostCredentials)) {
      fs.copyFileSync(hostCredentials, containerCredentials);
      fs.chmodSync(containerCredentials, 0o666);
    }
  } catch { /* best effort */ }

  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(settingsFile, JSON.stringify({
      env: {
        // Enable agent swarms (subagent orchestration)
        // https://code.claude.com/docs/en/agent-teams#orchestrate-teams-of-claude-code-sessions
        CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
        // Load CLAUDE.md from additional mounted directories
        // https://code.claude.com/docs/en/memory#load-memory-from-additional-directories
        CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
        // Enable Claude's memory feature (persists user preferences between sessions)
        // https://code.claude.com/docs/en/memory#manage-auto-memory
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
      },
    }, null, 2) + '\n');
  }

  // Sync skills from container/skills/ into each group's .claude/skills/
  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      fs.mkdirSync(dstDir, { recursive: true });
      for (const file of fs.readdirSync(srcDir)) {
        const srcFile = path.join(srcDir, file);
        const dstFile = path.join(dstDir, file);
        fs.copyFileSync(srcFile, dstFile);
      }
    }
  }
  // Ensure the sessions dir tree is writable by container's node user (uid 1000)
  try { execSync(`sudo chmod -R a+rwX "${groupSessionsDir}"`, { stdio: 'pipe' }); } catch { /* best effort */ }
  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: '/home/node/.claude',
    readonly: false,
  });

  // Per-group IPC namespace: each group gets its own IPC directory
  // This prevents cross-group privilege escalation via IPC
  const groupIpcDir = path.join(DATA_DIR, 'ipc', group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  // Mount host's .claude.json so Claude CLI can write config inside the container.
  // Without this, CLI silently fails due to EACCES on /home/node/.claude.json.
  const hostClaudeJson = path.join(getHomeDir(), '.claude.json');
  const groupClaudeJson = path.join(DATA_DIR, 'sessions', group.folder, '.claude.json');
  try {
    if (fs.existsSync(hostClaudeJson)) {
      fs.copyFileSync(hostClaudeJson, groupClaudeJson);
    } else {
      fs.writeFileSync(groupClaudeJson, '{}');
    }
    fs.chmodSync(groupClaudeJson, 0o666);
  } catch { /* best effort */ }
  mounts.push({
    hostPath: groupClaudeJson,
    containerPath: '/home/node/.claude.json',
    readonly: false,
  });

  // Dev mode: mount agent-runner source from host for live code changes.
  // In production (DEV_MOUNT=false or unset), uses pre-built /app/dist inside
  // the image, saving ~2s of TypeScript compilation per container start.
  if (process.env.DEV_MOUNT === 'true') {
    const agentRunnerSrc = path.join(projectRoot, 'container', 'agent-runner', 'src');
    mounts.push({
      hostPath: agentRunnerSrc,
      containerPath: '/app/src',
      readonly: true,
    });
  }

  // Additional mounts validated against external allowlist (tamper-proof from containers)
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    mounts.push(...validatedMounts);
  }

  return mounts;
}

/**
 * Read allowed secrets for passing to the container via stdin.
 *
 * Auth priority (bypassPermissions mode):
 *   1. CLAUDE_CODE_OAUTH_TOKEN (Pro subscription — free)
 *   2. ANTHROPIC_API_KEY (prepaid fallback — paid per token)
 *
 * IMPORTANT: In bypassPermissions mode, the SDK uses ANTHROPIC_API_KEY
 * over CLAUDE_CODE_OAUTH_TOKEN when both are present. So we must only
 * pass one at a time to ensure Pro subscription is used when available.
 *
 * Fallback state: when a container fails while using OAuth, we switch to
 * the prepaid API key for 5 hours (Pro quota reset window), then
 * automatically retry OAuth.
 */
async function readSecrets(): Promise<SecretsResult> {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY_FALLBACK', 'THREADS_ACCESS_TOKEN', 'THREADS_USER_ID']);
  let authMethod: 'oauth' | 'fallback' = 'oauth';

  const authState = readAuthState();

  // If in fallback mode and 5 hours haven't passed, use API key directly
  if (authState.fallbackSince && Date.now() - authState.fallbackSince < FALLBACK_DURATION_MS) {
    const fallbackKey = secrets.ANTHROPIC_API_KEY_FALLBACK;
    if (fallbackKey) {
      secrets.ANTHROPIC_API_KEY = fallbackKey;
      authMethod = 'fallback';
      const remainingMin = Math.ceil(
        (FALLBACK_DURATION_MS - (Date.now() - authState.fallbackSince)) / 60000,
      );
      logger.info(
        { remainingMinutes: remainingMin },
        'Auth: in fallback mode, using prepaid API key',
      );
      delete secrets.ANTHROPIC_API_KEY_FALLBACK;
      return { secrets, authMethod };
    }
  }

  // Fallback period expired — clear state and try OAuth again
  if (authState.fallbackSince) {
    clearFallbackMode();
  }

  // Try Pro subscription OAuth token
  const oauthToken = await ensureFreshToken();
  if (oauthToken) {
    secrets.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
    authMethod = 'oauth';
    logger.info('Auth: using Pro subscription OAuth token');
  } else {
    // OAuth unavailable — enter fallback mode
    const fallbackKey = secrets.ANTHROPIC_API_KEY_FALLBACK;
    if (fallbackKey) {
      secrets.ANTHROPIC_API_KEY = fallbackKey;
      authMethod = 'fallback';
      enterFallbackMode();
      logger.info('Auth: OAuth unavailable, using fallback prepaid API key');
    }
  }

  // Clean up — don't pass the renamed key to the container
  delete secrets.ANTHROPIC_API_KEY_FALLBACK;

  // Refresh Threads long-lived token if expiring soon
  const freshThreadsToken = await ensureFreshThreadsToken();
  if (freshThreadsToken) {
    secrets.THREADS_ACCESS_TOKEN = freshThreadsToken;
  }

  return { secrets, authMethod };
}

function buildContainerArgs(mounts: VolumeMount[], containerName: string): string[] {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  // Run as host user so bind-mounted files are accessible.
  // Skip when running as root (uid 0), as the container's node user (uid 1000),
  // or when getuid is unavailable (native Windows without WSL).
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
  }

  // Explicitly set HOME so Claude Agent SDK writes to /home/node/.claude
  args.push('-e', 'HOME=/home/node');

  // Pass host timezone to container
  args.push('-e', `TZ=${process.env.TZ || 'Asia/Seoul'}`);

  // Docker: -v with :ro suffix for readonly
  for (const mount of mounts) {
    if (mount.readonly) {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}:ro`);
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  args.push(CONTAINER_IMAGE);

  return args;
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = path.join(GROUPS_DIR, group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const mounts = buildVolumeMounts(group, input.isMain);
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `nanoclaw-${safeName}-${Date.now()}`;
  const containerArgs = buildContainerArgs(mounts, containerName);

  logger.debug(
    {
      group: group.name,
      containerName,
      mounts: mounts.map(
        (m) =>
          `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
      ),
      containerArgs: containerArgs.join(' '),
    },
    'Container mount configuration',
  );

  logger.info(
    {
      group: group.name,
      containerName,
      mountCount: mounts.length,
      isMain: input.isMain,
    },
    'Spawning container agent',
  );

  const logsDir = path.join(GROUPS_DIR, group.folder, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  // Resolve secrets before entering the Promise callback (which isn't async)
  const { secrets, authMethod } = await readSecrets();

  return new Promise((resolve) => {
    const container = spawn('docker', containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    onProcess(container, containerName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    // Pass secrets via stdin (never written to disk or mounted as files)
    input.secrets = secrets;
    container.stdin.write(JSON.stringify(input));
    container.stdin.end();
    // Remove secrets from input so they don't appear in logs
    delete input.secrets;

    // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();
    let firstOutputLogged = false;

    container.stdout.on('data', (data) => {
      const chunk = data.toString();

      // Detect rate-limit signals in stdout as well
      if (!rateLimitDetected && authMethod === 'oauth' && RATE_LIMIT_PATTERN.test(chunk)) {
        rateLimitDetected = true;
        logger.warn({ group: group.name }, 'Rate limit detected in container stdout');
      }

      // Always accumulate for logging
      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Container stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      // Stream-parse for output markers
      if (onOutput) {
        parseBuffer += chunk;
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break; // Incomplete pair, wait for more data

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed: ContainerOutput = JSON.parse(jsonStr);
            if (parsed.newSessionId) {
              newSessionId = parsed.newSessionId;
            }
            hadStreamingOutput = true;
            if (!firstOutputLogged) {
              firstOutputLogged = true;
              logger.info(
                { group: group.name, coldStartMs: Date.now() - startTime },
                'First output from container (includes startup + inference)',
              );
            }
            // Activity detected — reset the hard timeout
            resetTimeout();
            // Call onOutput for all markers (including null results)
            // so idle timers start even for "silent" query completions.
            outputChain = outputChain.then(() => onOutput(parsed));
          } catch (err) {
            logger.warn(
              { group: group.name, error: err },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }
    });

    let containerReadyLogged = false;
    let rateLimitDetected = false;
    const RATE_LIMIT_PATTERN = /\b(429|rate.?limit|too many requests|quota exceeded|usage limit|hit your limit|hit .+ limit|resets \d+\w+\s*\(UTC\))\b/i;
    container.stderr.on('data', (data) => {
      const chunk = data.toString();

      // Detect 429 / rate-limit signals in real time
      if (!rateLimitDetected && authMethod === 'oauth' && RATE_LIMIT_PATTERN.test(chunk)) {
        rateLimitDetected = true;
        logger.warn({ group: group.name }, 'Rate limit detected in container stderr');
      }

      if (!containerReadyLogged && chunk.includes('[agent-runner]')) {
        containerReadyLogged = true;
        logger.info(
          { group: group.name, containerStartupMs: Date.now() - startTime },
          'Container ready (agent-runner first log)',
        );
      }
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ container: group.folder }, line);
      }
      // Don't reset timeout on stderr — SDK writes debug logs continuously.
      // Timeout only resets on actual output (OUTPUT_MARKER in stdout).
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { group: group.name, size: stderr.length },
          'Container stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    let timedOut = false;
    let hadStreamingOutput = false;
    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    // Grace period: hard timeout must be at least IDLE_TIMEOUT + 30s so the
    // graceful _close sentinel has time to trigger before the hard kill fires.
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error({ group: group.name, containerName }, 'Container timeout, stopping gracefully');
      exec(`docker stop ${containerName}`, { timeout: 15000 }, (err) => {
        if (err) {
          logger.warn({ group: group.name, containerName, err }, 'Graceful stop failed, force killing');
          container.kill('SIGKILL');
        }
      });
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    // Reset the timeout whenever there's activity (streaming output)
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    container.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      if (timedOut) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const timeoutLog = path.join(logsDir, `container-${ts}.log`);
        fs.writeFileSync(timeoutLog, [
          `=== Container Run Log (TIMEOUT) ===`,
          `Timestamp: ${new Date().toISOString()}`,
          `Group: ${group.name}`,
          `Container: ${containerName}`,
          `Duration: ${duration}ms`,
          `Exit Code: ${code}`,
          `Had Streaming Output: ${hadStreamingOutput}`,
        ].join('\n'));

        // Timeout after output = idle cleanup, not failure.
        // The agent already sent its response; this is just the
        // container being reaped after the idle period expired.
        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, containerName, duration, code },
            'Container timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            resolve({
              status: 'success',
              result: null,
              newSessionId,
            });
          });
          return;
        }

        logger.error(
          { group: group.name, containerName, duration, code },
          'Container timed out with no output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container timed out after ${configTimeout}ms`,
        });
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `container-${timestamp}.log`);
      const isVerbose = process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Container Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``,
      ];

      const isError = code !== 0;

      if (isVerbose || isError) {
        logLines.push(
          `=== Input ===`,
          JSON.stringify(input, null, 2),
          ``,
          `=== Container Args ===`,
          containerArgs.join(' '),
          ``,
          `=== Mounts ===`,
          mounts
            .map(
              (m) =>
                `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
            )
            .join('\n'),
          ``,
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          ``,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout,
        );
      } else {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.length} chars`,
          `Session ID: ${input.sessionId || 'new'}`,
          ``,
          `=== Mounts ===`,
          mounts
            .map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`)
            .join('\n'),
          ``,
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      logger.debug({ logFile, verbose: isVerbose }, 'Container log written');

      if (code !== 0) {
        logger.error(
          {
            group: group.name,
            code,
            duration,
            stderr,
            stdout,
            logFile,
          },
          'Container exited with error',
        );

        // If rate limit was detected while using OAuth, switch to fallback
        // API key for the next 5 hours (Pro quota reset window)
        if (rateLimitDetected) {
          enterFallbackMode();
        }

        resolve({
          status: 'error',
          result: null,
          error: `Container exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      // If rate limit was detected even on a "successful" exit, enter fallback.
      // Otherwise, OAuth is confirmed working — clear any stale fallback state.
      if (rateLimitDetected) {
        enterFallbackMode();
      } else if (authMethod === 'oauth') {
        clearFallbackMode();
      }

      // Streaming mode: wait for output chain to settle, return completion marker
      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            { group: group.name, duration, newSessionId },
            'Container completed (streaming mode)',
          );
          resolve({
            status: 'success',
            result: null,
            newSessionId,
          });
        });
        return;
      }

      // Legacy mode: parse the last output marker pair from accumulated stdout
      try {
        // Extract JSON between sentinel markers for robust parsing
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          // Fallback: last non-empty line (backwards compatibility)
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output: ContainerOutput = JSON.parse(jsonLine);

        logger.info(
          {
            group: group.name,
            duration,
            status: output.status,
            hasResult: !!output.result,
          },
          'Container completed',
        );

        resolve(output);
      } catch (err) {
        logger.error(
          {
            group: group.name,
            stdout,
            stderr,
            error: err,
          },
          'Failed to parse container output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse container output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    container.on('error', (err) => {
      clearTimeout(timeout);
      logger.error({ group: group.name, containerName, error: err }, 'Container spawn error');
      resolve({
        status: 'error',
        result: null,
        error: `Container spawn error: ${err.message}`,
      });
    });
  });
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  // Write filtered tasks to the group's IPC directory
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all tasks, others only see their own
  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

/**
 * Write available groups snapshot for the container to read.
 * Only main group can see all available groups (for activation).
 * Non-main groups only see their own registration status.
 */
export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  registeredJids: Set<string>,
): void {
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all groups; others see nothing (they can't activate groups)
  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
