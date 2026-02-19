# NanoClaw 개발 참조 문서

이 문서는 전체 코드를 읽지 않고도 빠르게 작업할 수 있도록 핵심 구조와 흐름을 정리합니다.

## 아키텍처 개요

```
User (Slack) → SlackChannel → DB(storeMessage) → notifyNewMessage() [즉시 wake]
  → GroupQueue → container-runner → Docker Container (pre-built dist)
    → agent-runner → Claude Agent SDK → Claude API
  → streaming output → SlackChannel.sendMessage → User
```

## 메시지 처리 흐름

1. **수신**: `slack.ts` — Slack Socket Mode로 이벤트 수신, `onMessage` 콜백으로 DB 저장
2. **감지**: `index.ts:notifyNewMessage()` — 이벤트 기반 즉시 wake (500ms 폴링은 fallback만)
3. **큐잉**: `group-queue.ts` — 그룹별 순차 처리, 동시 컨테이너 수 제한 (MAX_CONCURRENT_CONTAINERS=5)
4. **실행**: `container-runner.ts:runContainerAgent()` — Docker 컨테이너 스폰, 프롬프트/시크릿 stdin 전달
5. **Agent**: `container/agent-runner/src/index.ts` — Claude Agent SDK `query()` 호출, 결과 stdout 마커로 반환
6. **응답**: `index.ts:processGroupMessages()` — 스트리밍 결과를 Slack으로 즉시 전송

## 응답 타이밍 (Cold Start 기준)

| 구간 | 시간 | 참조 |
|------|------|------|
| Slack 이벤트 → 메시지 루프 wake | ~12ms | 이벤트 기반, 폴링 대기 없음 |
| 메시지 처리 → 컨테이너 spawn | ~550ms | DB 쿼리 + 시크릿 준비 |
| 컨테이너 시작 (Docker → agent-runner) | ~300ms | pre-built dist, pre-warm 적용 |
| Claude 추론 | 가변 | 내용 복잡도에 따라 |
| 응답 → Slack 전송 | ~500ms | Slack API 호출 |

## 싱글턴 가드

`index.ts:acquireSingletonLock()` — PID lock 파일(`data/host.pid`)로 호스트 프로세스 중복 방지.
- 기존 프로세스가 살아있으면 새 인스턴스가 exit(1)
- 죽은 프로세스의 stale lock은 자동 회수
- 워커 컨테이너에는 영향 없음

## 주요 파일별 역할

### src/index.ts (오케스트레이터)
- `acquireSingletonLock()`: PID lock으로 중복 실행 방지
- `main()`: Docker 확인 → DB 초기화 → 채널 연결 → 서브시스템 시작
- `startMessageLoop()`: 이벤트 기반 wake + 500ms fallback 폴링
- `notifyNewMessage()`: 메시지 수신 시 즉시 루프 깨우기
- `processGroupMessages()`: 그룹 메시지 수집 → 컨테이너 실행 → 결과 전송

### src/channels/slack.ts (Slack 채널)
- Socket Mode 연결 (`@slack/bolt`)
- `handleEvent()`: 메시지 수신 → 유저 이름 캐싱(1h TTL) → 즉시 DB 저장
- `setTyping()`: "_thinking..._" 임시 메시지로 타이핑 인디케이터 구현
- `sendMessage()`: `ASSISTANT_NAME: text` 형식으로 전송

### src/container-runner.ts (컨테이너 관리)
- `buildVolumeMounts()`: 그룹별 마운트 구성
  - `DEV_MOUNT=true`일 때만 호스트 소스 마운트 (재컴파일 트리거)
- `readSecrets()`: `.env`에서 API 키 + `oauth-refresh.ts`에서 OAuth 토큰
- `runContainerAgent()`: Docker 스폰, 레이턴시 계측 (`containerStartupMs`, `coldStartMs`)
- `prewarmContainer()`: 시작 시 이미지 프리로드

### container/entrypoint.sh (컨테이너 진입점)
- **Fast path**: pre-built `/app/dist` 직접 사용 (~0.3s)
- **Dev path**: `/app/src`가 `.build_stamp`보다 최신이면 `npx tsc` 재컴파일 (~2.3s)

### src/oauth-refresh.ts (토큰 자동 갱신)
- `ensureFreshToken()`: `~/.claude/.credentials.json` 읽기 → 만료 5분전 자동 갱신
- `refreshAccessToken()`: `https://claude.ai/oauth/token`으로 리프레시
- 실패 시 기존 토큰 fallback

### src/group-queue.ts (큐 관리)
- 그룹별 독립 큐, 동시 실행 수 제한
- IPC를 통한 실행 중 컨테이너에 메시지 파이핑 (`sendMessage()`)
- 에러 시 지수 백오프 재시도 (최대 5회)

### container/agent-runner/src/index.ts (컨테이너 내부)
- stdin에서 ContainerInput JSON 읽기 (프롬프트 + 시크릿)
- Claude Agent SDK `query()` 호출, MessageStream으로 프롬프트 전달
- IPC 폴링으로 추가 메시지 수신
- `OUTPUT_START_MARKER`/`OUTPUT_END_MARKER`로 결과 stdout 출력

## 컨테이너 마운트 구조

| 호스트 경로 | 컨테이너 경로 | 용도 |
|------------|--------------|------|
| `groups/{name}` | `/workspace/group` | 그룹 작업 디렉토리 |
| `data/sessions/{name}/.claude` | `/home/node/.claude` | Claude 세션/설정 |
| `data/sessions/{name}/.claude.json` | `/home/node/.claude.json` | Claude CLI 설정 (쓰기 필수!) |
| `data/ipc/{name}` | `/workspace/ipc` | IPC 메시지 교환 |
| `container/agent-runner/src` | `/app/src` (readonly) | DEV_MOUNT=true일 때만 |
| 프로젝트 루트 (main만) | `/workspace/project` | 전체 프로젝트 접근 |

## 인증 흐름

```
시작 시: ~/.claude/.credentials.json → ensureFreshToken() → 만료 확인
  → 유효: accessToken 반환
  → 만료 임박: claude.ai/oauth/token → 리프레시 → 파일 업데이트 → 새 토큰 반환
  → 실패: 기존 토큰 fallback

컨테이너 전달:
  readSecrets() → {CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY}
  → container stdin (JSON) → agent-runner → sdkEnv → SDK query() env 옵션
```

## 설정값 (src/config.ts)

| 상수 | 값 | 설명 |
|------|---|------|
| `POLL_INTERVAL` | 500ms | 메시지 폴링 fallback 간격 (이벤트 wake가 우선) |
| `SCHEDULER_POLL_INTERVAL` | 60000ms | 스케줄러 폴링 |
| `IPC_POLL_INTERVAL` | 1000ms | IPC 파일 감시 |
| `IDLE_TIMEOUT` | 1800000ms (30분) | 유휴 컨테이너 종료 |
| `CONTAINER_TIMEOUT` | 1800000ms (30분) | 컨테이너 최대 실행 시간 |
| `MAX_CONCURRENT_CONTAINERS` | 5 | 동시 컨테이너 수 |

## 데이터 저장소

- `store/messages.db` — SQLite: messages, chats, sessions, registered_groups, router_state, scheduled_tasks
- `data/sessions/{group}/.claude/` — Claude 세션 데이터 (트랜스크립트 등)
- `data/ipc/{group}/` — IPC 파일 (messages, tasks, input)
- `data/host.pid` — 호스트 프로세스 PID lock
- `groups/{name}/` — 그룹별 작업 디렉토리, CLAUDE.md, logs

## 트러블슈팅

| 증상 | 원인 | 해결 |
|------|------|------|
| 같은 메시지에 여러 번 응답 | 호스트 프로세스 중복 실행 | PID lock이 방지 (data/host.pid), `ps aux \| grep node.*index` 확인 |
| Container `Messages: 0, results: 0` | `/home/node/.claude.json` 쓰기 불가 | `.claude.json` 마운트 확인 |
| `EACCES: permission denied` debug dir | 컨테이너 uid(1000) vs 호스트 uid 불일치 | `sudo chmod -R 777` 세션 디렉토리 |
| 토큰 만료 | OAuth 토큰 수명 초과 | `oauth-refresh.ts`가 자동 처리, `~/.claude/.credentials.json` 확인 |
| Slack 메시지 미수신 | Bot token/App token 누락 | `.env`에 `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` 설정 |
| 응답 느림 (인프라) | DEV_MOUNT=true로 매번 tsc 재컴파일 | 프로덕션: DEV_MOUNT 미설정, systemd 서비스 사용 |
| 서비스 시작 안 됨 | Docker 미실행 | `sudo systemctl start docker` 후 `sudo systemctl start nanoclaw` |
