# OCI 정책서 — 개발 정책

**최종 업데이트**: 2026-02-26 00:05 KST

이 문서는 전체 코드를 읽지 않고도 빠르게 작업할 수 있도록 핵심 구조와 흐름을 정리합니다.

## 아키텍처 개요

```
User (Slack/Discord) → Channel → DB(storeMessage) → notifyNewMessage() [즉시 wake]
  → GroupQueue → container-runner → Docker Container (pre-built dist)
    → agent-runner → Claude Agent SDK → Claude API
  → streaming output → Channel.sendMessage → User
```

## 메시지 처리 흐름

1. **수신**: `slack.ts` / `discord.ts` — Slack Socket Mode 또는 Discord Gateway로 이벤트 수신, `onMessage` 콜백으로 DB 저장
2. **감지**: `index.ts:notifyNewMessage()` — 이벤트 기반 즉시 wake (500ms 폴링은 fallback만)
3. **큐잉**: `group-queue.ts` — 그룹별 순차 처리, 동시 컨테이너 수 제한 (MAX_CONCURRENT_CONTAINERS=5)
4. **실행**: `container-runner.ts:runContainerAgent()` — Docker 컨테이너 스폰, 프롬프트/시크릿 stdin 전달
5. **Agent**: `container/agent-runner/src/index.ts` — Claude Agent SDK `query()` 호출, 결과 stdout 마커로 반환
6. **응답**: `index.ts:processGroupMessages()` — 스트리밍 결과를 해당 채널(Slack/Discord)로 즉시 전송

## 응답 타이밍 (Cold Start 기준)

| 구간 | 시간 | 참조 |
|------|------|------|
| Slack/Discord 이벤트 → 메시지 루프 wake | ~12ms | 이벤트 기반, 폴링 대기 없음 |
| 메시지 처리 → 컨테이너 spawn | ~550ms | DB 쿼리 + 시크릿 준비 |
| 컨테이너 시작 (Docker → agent-runner) | ~300ms | pre-built dist, pre-warm 적용 |
| Claude 추론 | 가변 | 내용 복잡도에 따라 |
| 응답 → Slack/Discord 전송 | ~500ms | 채널 API 호출 |

## 싱글턴 가드

`index.ts:acquireSingletonLock()` — PID lock 파일(`data/host.pid`)로 호스트 프로세스 중복 방지.
- 기존 프로세스가 살아있으면 새 인스턴스가 exit(1)
- 죽은 프로세스의 stale lock은 자동 회수
- 워커 컨테이너에는 영향 없음

## 최근 변경사항 (2026-02-24)

### TZ=Asia/Seoul 설정 및 스케줄 태스크 멀티채널 브로드캐스트
- `.env`에 `TZ=Asia/Seoul` 추가 → cron 스케줄러가 한국시간(KST) 기준으로 동작
- `config.ts`의 `TIMEZONE`이 `process.env.TZ`를 읽으므로 모든 시간 관련 로직에 반영
- `container/Dockerfile`에 `ENV TZ=Asia/Seoul` 기본값 설정, `container-runner.ts`에서 호스트 TZ를 `-e TZ=...`로 컨테이너에 전달 → 호스트·컨테이너 모두 KST 통일
- `task-scheduler.ts`: 스케줄 태스크 결과를 동일 `group_folder`의 **모든 등록 채널**(Slack + Discord)에 브로드캐스트
  - 기존: `deps.sendMessage(task.chat_jid, ...)` → 단일 채널만 발송
  - 변경: `allGroupJids` 배열로 같은 folder의 모든 JID에 순회 발송
  - 개별 채널 실패 시 `logger.warn`으로 기록, 다른 채널 발송은 계속 진행
- DB: `나노클로-운영자(DC)` 채널의 folder를 `main-dc` → `main`으로 통합

## 이전 변경사항 (2026-02-22)

### registered_groups DB 스키마 수정 (16:25 UTC)
- `src/db.ts`: `folder` 컬럼의 UNIQUE 제약 제거
- Slack과 Discord 채널이 같은 그룹 폴더를 공유할 수 있도록 개선
- JID가 PRIMARY KEY이므로 중복 방지는 유지
- 멀티채널 운영 시 유연성 향상

### Discord 채널 연동 (Slack 병행) — 07:28 UTC
- `src/channels/discord.ts` 추가: Discord Gateway로 메시지 수신/발신
- `src/config.ts`에 `DISCORD_BOT_TOKEN` 추가
- `src/index.ts`에 Discord 채널 초기화 블록 추가 (Slack 뒤에 조건부 연결)
- 디스코드 JID 형식: `dc:<channelId>` — `ownsJid()`로 Slack과 자동 구분
- `나노클로-운영자(DC)` 채널 등록 (folder: `main-dc`, requires_trigger: 0)
- Slack과 Discord 동시 운영 가능 (멀티채널 구조)

### 스케줄 태스크 중복 실행 방지 — 02:24 UTC
- `src/group-queue.ts`: GroupState에 `activeTaskId` 필드 추가
- 실행 중인 태스크가 30분간 진행되는 동안 스케줄러 폴링이 next_run 미갱신 상태의 같은 태스크를 다시 enqueue하는 버그 수정
- 실행 중 태스크도 중복 체크하여 동일 태스크가 동시에 여러 번 실행되지 않도록 보장

## 이전 변경사항 (2026-02-21)

### 대화 인덱스 자동 생성 (RAG 1단계) — 17:55 UTC
- PreCompact 훅에서 `conversations/index.json`을 자동 생성하여 에이전트가 과거 대화를 키워드로 검색 가능
- `extractKeywords()` 함수: 사용자 메시지에서 빈도 기반 상위 10개 키워드 추출 (LLM 호출 없음)
- 불용어(stopwords) 필터링: 한영 조사/관사 제거 (예: '그리고', 'the', 'and' 등)
- 인덱스 엔트리 형식: `{ file, date, summary, keywords[] }`
- `groups/global/CLAUDE.md`에 대화 검색 지시 추가: "사용자 질문이 과거 맥락을 필요로 할 때 index.json을 읽어 관련 대화를 찾고 해당 파일을 Read로 열어 참고"
- 커밋: `51809f9f` "feat: 대화 인덱스 자동 생성 (RAG 1단계)"

### 에이전트 자동 학습 시스템 (3단계 구조)
- `container/agent-runner/src/index.ts`에 `extractLearnings()` 함수 추가
- PreCompact hook에서 대화 종료 시 학습 포인트 자동 추출 (LLM 호출 없이 정규식 기반)
- 감지 패턴: 수정/교정(`아니야`, `수정해`), 선호(`이게 더`, `이렇게 해줘`), 기억 요청(`기억해`, `기록해`)
- 학습 내용을 `/workspace/group/LEARNINGS.md`에 자동 기록 (최대 5개/세션)
- 3단계 학습 구조:
  1. **실시간 감지**: CLAUDE.md 지침으로 에이전트가 실시간 학습 기록
  2. **PreCompact 자동 추출**: 대화 종료 시 패턴 매칭으로 학습 포인트 추출
  3. **CLAUDE.md 승격**: 사용자가 명시적으로 요청 시에만 지침에 추가
- Purpose Tags로 그룹별 학습 스코프 제한 (목적 외 학습 오염 방지)

### Threads API 장기 토큰 자동 갱신
- `src/threads-refresh.ts` 추가: Meta 장기 토큰(60일) 만료 7일 전 자동 갱신
- `container-runner.ts`에서 `ensureFreshThreadsToken()` 호출하여 매 컨테이너 스폰 시 토큰 체크
- 상태 파일: `data/threads-token-state.json` (만료일, 마지막 갱신 시각 추적)
- 토큰 발급 시 정식 OAuth 플로우 필수 (Developer Portal의 User Token Generator 토큰은 교환 불가)

### 이전 변경사항 (2026-02-20)

### 진행 상태 표시 기능
- 에이전트가 도구를 사용할 때 한글로 진행 상태 표시
- Slack 타이핑 메시지가 "_thinking..._"에서 "_웹 검색 중..._", "_파일 읽는 중..._" 등으로 업데이트
- 3초 간격으로 progress 이벤트 전송하여 사용자에게 실시간 피드백 제공

### Threads API 통합
- `THREADS_ACCESS_TOKEN`, `THREADS_USER_ID` 시크릿 추가
- 이 토큰들은 `process.env`에 노출되어 Bash 스크립트에서 curl로 Threads API 호출 가능
- threads 그룹에서 Threads 발행 작업 수행 시 사용

## 주요 파일별 역할

### src/index.ts (오케스트레이터)
- `acquireSingletonLock()`: PID lock으로 중복 실행 방지
- `main()`: Docker 확인 → DB 초기화 → 채널 연결 → 서브시스템 시작
- `startMessageLoop()`: 이벤트 기반 wake + 500ms fallback 폴링
- `notifyNewMessage()`: 메시지 수신 시 즉시 루프 깨우기
- `processGroupMessages()`: 그룹 메시지 수집 → 컨테이너 실행 → 결과 전송
  - **진행 상태 처리**: `result.progress`가 있으면 `channel.updateTyping()` 호출하여 타이핑 메시지 업데이트

### src/channels/slack.ts (Slack 채널)
- Socket Mode 연결 (`@slack/bolt`)
- `handleEvent()`: 메시지 수신 → 유저 이름 캐싱(1h TTL) → 즉시 DB 저장
- `setTyping()`: "_thinking..._" 임시 메시지로 타이핑 인디케이터 구현
- `updateTyping(jid, text)`: 타이핑 메시지 텍스트 업데이트 (진행 상태 표시용)
- `sendMessage()`: `ASSISTANT_NAME: text` 형식으로 전송

### src/channels/discord.ts (Discord 채널)
- Discord Gateway 연결 (`discord.js`)
- JID 형식: `dc:<channelId>` (Slack과 구분)
- `@봇` 멘션 → `@ASSISTANT_NAME` 트리거로 자동 변환
- 첨부파일: `[Image: name]`, `[File: name]` 등 플레이스홀더
- 답장 컨텍스트: `[Reply to 사용자] 메시지` 형식
- `sendMessage()`: `ASSISTANT_NAME: text` 형식, 2000자 분할 전송
- `setTyping()`: 네이티브 Discord 타이핑 인디케이터 사용

### src/container-runner.ts (컨테이너 관리)
- `buildVolumeMounts()`: 그룹별 마운트 구성
  - `DEV_MOUNT=true`일 때만 호스트 소스 마운트 (재컴파일 트리거)
- `readSecrets()`: `.env`에서 API 키 + Threads 토큰 + `oauth-refresh.ts`에서 OAuth 토큰
- `runContainerAgent()`: Docker 스폰, 레이턴시 계측 (`containerStartupMs`, `coldStartMs`), 호스트 TZ를 `-e TZ=...`로 컨테이너에 전달
- `prewarmContainer()`: 시작 시 이미지 프리로드
- `ContainerOutput` 인터페이스에 `progress` 필드 추가 (진행 상태 전달용)

### container/entrypoint.sh (컨테이너 진입점)
- **Fast path**: pre-built `/app/dist` 직접 사용 (~0.3s)
- **Dev path**: `/app/src`가 `.build_stamp`보다 최신이면 `npx tsc` 재컴파일 (~2.3s)

### src/oauth-refresh.ts (Claude 토큰 자동 갱신)
- `ensureFreshToken()`: `~/.claude/.credentials.json` 읽기 → 만료 5분전 자동 갱신
- `refreshAccessToken()`: `https://platform.claude.com/v1/oauth/token`으로 리프레시 (JSON 형식)
- ⚠️ `claude.ai/oauth/token`은 Cloudflare 차단됨 → 반드시 `platform.claude.com` 사용
- 실패 시 기존 토큰 fallback

### src/threads-refresh.ts (Threads API 토큰 자동 갱신)
- `ensureFreshThreadsToken()`: `data/threads-token-state.json`에서 만료 추적
- Meta 장기 토큰(60일) 만료 7일 전에 자동 갱신
- 갱신 엔드포인트: `GET https://graph.threads.net/refresh_access_token?grant_type=th_refresh_token&access_token=<token>`
- 갱신 성공 시 `.env`의 `THREADS_ACCESS_TOKEN`도 자동 업데이트 (재시작 시에도 유지)
- `container-runner.ts:readSecrets()`에서 매 컨테이너 스폰 시 호출

### src/group-queue.ts (큐 관리)
- 그룹별 독립 큐, 동시 실행 수 제한
- IPC를 통한 실행 중 컨테이너에 메시지 파이핑 (`sendMessage()`)
- 에러 시 지수 백오프 재시도 (최대 5회)

### container/agent-runner/src/index.ts (컨테이너 내부)
- stdin에서 ContainerInput JSON 읽기 (프롬프트 + 시크릿)
- Claude Agent SDK `query()` 호출, MessageStream으로 프롬프트 전달
- IPC 폴링으로 추가 메시지 수신
- `OUTPUT_START_MARKER`/`OUTPUT_END_MARKER`로 결과 stdout 출력
- **진행 상태 업데이트**: 도구 사용 감지 시 한글 라벨로 progress 이벤트 전송 (3초 간격)
  - `TOOL_LABELS` 맵: WebSearch → "웹 검색 중", Bash → "명령어 실행 중" 등
- **Threads API 토큰**: `THREADS_ACCESS_TOKEN`, `THREADS_USER_ID`는 `process.env`에 노출 (Bash에서 curl 사용 가능)
- **PreCompact Hook**: 대화 종료 시 트랜스크립트를 `conversations/` 폴더에 아카이빙
  - `extractLearnings()`: 정규식 기반 학습 포인트 추출 (LLM 호출 없음, 성능 오버헤드 0)
  - 감지 패턴: 수정/교정, 선호 표현, 기억 요청 등
  - 추출된 학습을 `/workspace/group/LEARNINGS.md`에 자동 추가 (Context 포함)
  - `extractKeywords()`: 사용자 메시지에서 빈도 기반 상위 10개 키워드 추출 (불용어 필터링)
  - `conversations/index.json` 자동 업데이트: 각 대화에 대해 `{file, date, summary, keywords[]}` 인덱스 생성

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
  → 만료 임박: platform.claude.com/v1/oauth/token → 리프레시 → 파일 업데이트 → 새 토큰 반환
  → 실패: 기존 토큰 fallback (만료된 토큰이라도 반환)

컨테이너 전달 (readSecrets — 반드시 하나만 전달):
  OAuth 유효 → {CLAUDE_CODE_OAUTH_TOKEN}만 전달 (ANTHROPIC_API_KEY 없이)
  OAuth 실패 → {ANTHROPIC_API_KEY}만 전달 (fallback prepaid key)
  → container stdin (JSON) → agent-runner → sdkEnv → SDK query() env 옵션
```

### ⚠️ 인증 우선순위 주의사항
- `ANTHROPIC_API_KEY` 환경변수가 설정되면 Claude Code는 **OAuth를 무시**하고 API키를 우선 사용
- Pro 구독(무료 할당량) 대신 선불 크레딧이 소진됨 → 반드시 하나만 전달
- `.env`에서 `ANTHROPIC_API_KEY_FALLBACK`으로 저장하고, `readSecrets()`에서 조건부 전달

### 토큰 유형 구분
| 접두사 | 유형 | 설명 |
|--------|------|------|
| `sk-ant-oat01-` | OAuth Access Token | Pro 구독, 8시간 유효, 자동 갱신 가능 |
| `sk-ant-ort01-` | OAuth Refresh Token | Access token 재발급용 |
| `sk-ant-api03-` | Prepaid API Key | 선불 크레딧, 토큰당 과금, 만료 없음 |

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
| Discord 메시지 미수신 | Bot token 누락 또는 Message Content Intent 비활성화 | `.env`에 `DISCORD_BOT_TOKEN` 설정, Developer Portal에서 Intent 활성화 |
| 응답 느림 (인프라) | DEV_MOUNT=true로 매번 tsc 재컴파일 | 프로덕션: DEV_MOUNT 미설정, systemd 서비스 사용 |
| 서비스 시작 안 됨 | Docker 미실행 | `sudo systemctl start docker` 후 `sudo systemctl start nanoclaw` |
