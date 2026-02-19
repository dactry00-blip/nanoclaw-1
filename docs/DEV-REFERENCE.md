# NanoClaw 개발 참조 문서

이 문서는 전체 코드를 읽지 않고도 빠르게 작업할 수 있도록 핵심 구조와 흐름을 정리합니다.

## 아키텍처 개요

```
User (Slack) → SlackChannel → DB(storeMessage) → MessageLoop(500ms poll)
  → GroupQueue → container-runner → Docker Container
    → agent-runner → Claude Agent SDK → Claude API
  → response → SlackChannel.sendMessage → User
```

## 메시지 처리 흐름

1. **수신**: `slack.ts` — Slack Socket Mode로 이벤트 수신, `onMessage` 콜백으로 DB 저장
2. **감지**: `index.ts:startMessageLoop()` — 500ms 간격으로 새 메시지 폴링
3. **큐잉**: `group-queue.ts` — 그룹별 순차 처리, 동시 컨테이너 수 제한 (MAX_CONCURRENT_CONTAINERS=5)
4. **실행**: `container-runner.ts:runContainerAgent()` — Docker 컨테이너 스폰, 프롬프트/시크릿 stdin 전달
5. **Agent**: `container/agent-runner/src/index.ts` — Claude Agent SDK `query()` 호출, 결과 stdout 마커로 반환
6. **응답**: `index.ts:processGroupMessages()` — 스트리밍 결과를 Slack으로 전송

## 주요 파일별 역할

### src/index.ts (오케스트레이터)
- `main()`: Docker 확인 → DB 초기화 → 채널 연결 → 서브시스템 시작
- `startMessageLoop()`: 500ms 폴링, 새 메시지 감지 → 큐에 추가
- `processGroupMessages()`: 그룹 메시지 수집 → 컨테이너 실행 → 결과 전송
- `runAgent()`: 세션 관리, 컨테이너 실행 래퍼

### src/channels/slack.ts (Slack 채널)
- Socket Mode 연결 (`@slack/bolt`)
- `handleEvent()`: 메시지 수신 → 유저 이름 캐싱(1h TTL) → 즉시 DB 저장
- `setTyping()`: "_thinking..._" 임시 메시지로 타이핑 인디케이터 구현
- `sendMessage()`: `ASSISTANT_NAME: text` 형식으로 전송

### src/container-runner.ts (컨테이너 관리)
- `buildVolumeMounts()`: 그룹별 마운트 구성 (프로젝트, 그룹폴더, IPC, 세션, .claude.json)
- `readSecrets()`: `.env`에서 API 키 + `oauth-refresh.ts`에서 OAuth 토큰
- `runContainerAgent()`: Docker 스폰, stdin으로 시크릿 전달, stdout 스트리밍 파싱
- `prewarmContainer()`: 시작 시 이미지 프리로드

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
| `container/agent-runner/src` | `/app/src` (readonly) | Agent runner 소스 |
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
| `POLL_INTERVAL` | 500ms | 메시지 폴링 간격 |
| `SCHEDULER_POLL_INTERVAL` | 60000ms | 스케줄러 폴링 |
| `IPC_POLL_INTERVAL` | 1000ms | IPC 파일 감시 |
| `IDLE_TIMEOUT` | 1800000ms (30분) | 유휴 컨테이너 종료 |
| `CONTAINER_TIMEOUT` | 1800000ms (30분) | 컨테이너 최대 실행 시간 |
| `MAX_CONCURRENT_CONTAINERS` | 5 | 동시 컨테이너 수 |

## 데이터 저장소

- `store/messages.db` — SQLite: messages, chats, sessions, registered_groups, router_state, scheduled_tasks
- `data/sessions/{group}/.claude/` — Claude 세션 데이터 (트랜스크립트 등)
- `data/ipc/{group}/` — IPC 파일 (messages, tasks, input)
- `groups/{name}/` — 그룹별 작업 디렉토리, CLAUDE.md, logs

## 트러블슈팅

| 증상 | 원인 | 해결 |
|------|------|------|
| Container `Messages: 0, results: 0` | `/home/node/.claude.json` 쓰기 불가 | `.claude.json` 마운트 확인 |
| `EACCES: permission denied` debug dir | 컨테이너 uid(1000) vs 호스트 uid 불일치 | `sudo chmod -R 777` 세션 디렉토리 |
| 토큰 만료 | OAuth 토큰 수명 초과 | `oauth-refresh.ts`가 자동 처리, `~/.claude/.credentials.json` 확인 |
| Slack 메시지 미수신 | Bot token/App token 누락 | `.env`에 `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` 설정 |
| 응답 지연 | 폴링 간격, 컨테이너 시작 시간 | `POLL_INTERVAL` 확인, pre-warm 동작 확인 |
