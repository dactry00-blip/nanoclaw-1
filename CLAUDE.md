# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process that connects to Slack (or WhatsApp), routes messages to Claude Agent SDK running in Docker containers. Each group has isolated filesystem and memory. Authentication uses Claude Pro OAuth tokens auto-refreshed from `~/.claude/.credentials.json`.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/slack.ts` | Slack connection (Socket Mode), send/receive, typing indicator |
| `src/channels/whatsapp.ts` | WhatsApp connection, auth, send/receive |
| `src/oauth-refresh.ts` | OAuth token auto-refresh from `~/.claude/.credentials.json` |
| `src/container-runner.ts` | Spawns Docker containers with mounts, passes secrets via stdin |
| `src/config.ts` | Trigger pattern, paths, intervals (POLL_INTERVAL=500ms) |
| `src/router.ts` | Message formatting and outbound routing |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `src/group-queue.ts` | Per-group message queue with concurrency control |
| `container/agent-runner/src/index.ts` | Agent runner inside container (Claude Agent SDK) |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management (Linux):
```bash
sudo systemctl start docker
```

## Container Build Cache

To force a truly clean rebuild:

```bash
docker builder prune -af
./container/build.sh
```

Always verify after rebuild: `docker run -i --rm --entrypoint wc nanoclaw-agent:latest -l /app/src/index.ts`

## Critical: Container Authentication

Claude CLI inside containers requires TWO things to work:
1. `CLAUDE_CODE_OAUTH_TOKEN` env var passed via SDK `env` option
2. `~/.claude.json` writable at `/home/node/.claude.json` (mounted from host)
3. `~/.claude/.credentials.json` copied into container's `/home/node/.claude/`

Without `.claude.json` mount, CLI silently exits with 0 messages and no error.
