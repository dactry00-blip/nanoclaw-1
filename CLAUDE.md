# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process that connects to Slack (Socket Mode), routes messages to Claude Agent SDK running in Docker containers. Each group has isolated filesystem and memory. Authentication uses Claude Pro OAuth tokens auto-refreshed from `~/.claude/.credentials.json`.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, singleton PID lock, agent invocation |
| `src/channels/slack.ts` | Slack connection (Socket Mode), send/receive, typing indicator |
| `src/oauth-refresh.ts` | OAuth token auto-refresh from `~/.claude/.credentials.json` |
| `src/threads-refresh.ts` | Threads API long-lived token auto-refresh (60-day, 7-day buffer) |
| `src/container-runner.ts` | Spawns Docker containers, pre-built dist fast path, latency instrumentation |
| `src/config.ts` | Trigger pattern, paths, intervals (POLL_INTERVAL=500ms) |
| `src/router.ts` | Message formatting and outbound routing |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `src/group-queue.ts` | Per-group message queue with concurrency control |
| `container/agent-runner/src/index.ts` | Agent runner inside container (Claude Agent SDK) |
| `container/entrypoint.sh` | Container entrypoint: uses pre-built dist or recompiles (dev mode) |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `nanoclaw.service` | systemd service file for production deployment |

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |

## Production (OCI)

```bash
# Service management
sudo systemctl start nanoclaw    # Start
sudo systemctl stop nanoclaw     # Stop
sudo systemctl restart nanoclaw  # Restart
sudo systemctl status nanoclaw   # Status
sudo journalctl -u nanoclaw -f   # Live logs
```

## Development

Run commands directly — don't tell the user to run them.

```bash
DEV_MOUNT=true npm run dev   # Dev mode (hot reload, source mount into containers)
npm run build                # Compile TypeScript
./container/build.sh         # Rebuild agent container image
```

## Container Build Cache

To force a truly clean rebuild:

```bash
docker builder prune -af
./container/build.sh
```

Always verify after rebuild: `docker run -i --rm --entrypoint wc nanoclaw-agent:latest -l /app/src/index.ts`

## Critical: Container Authentication

Claude CLI inside containers requires THREE things to work:
1. `CLAUDE_CODE_OAUTH_TOKEN` env var passed via SDK `env` option
2. `~/.claude.json` writable at `/home/node/.claude.json` (mounted from host)
3. `~/.claude/.credentials.json` copied into container's `/home/node/.claude/`

Without `.claude.json` mount, CLI silently exits with 0 messages and no error.

## Singleton Guard

Host process uses PID lock (`data/host.pid`) to prevent duplicate Slack listeners. If another instance is already running, new instance exits immediately. Stale locks from dead processes are auto-reclaimed.

## Container Startup Optimization

Entrypoint uses pre-built `/app/dist` by default (0.3s startup). Only recompiles TypeScript when `DEV_MOUNT=true` mounts newer source from host (2.3s startup). Controlled by `.build_stamp` timestamp comparison.

## 작업 완료 체크리스트

매 작업 완료 시 사용자에게 다음 진행 여부를 물어볼 것:
1. **OCI 정책서 3종 업데이트** — OCI 환경 변경에 해당하는 작업(인프라, 서버 설정, 배포, 운영 변경 등)인 경우에만 물어볼 것. 에이전트 지침이나 코드 로직 변경은 해당 없음.
2. **Git 커밋 & 푸시** — 항상 물어볼 것. 변경된 파일들을 커밋하고 원격에 푸시.
