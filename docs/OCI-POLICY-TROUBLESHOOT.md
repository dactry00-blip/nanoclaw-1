# OCI 정책서 — 트러블슈팅 정책

**최종 업데이트**: 2026-02-27 08:40 KST

## Known Issues

### 1. [FIXED] Resume branches from stale tree position
When agent teams spawns subagent CLI processes, they write to the same session JSONL. On subsequent `query()` resumes, the CLI reads the JSONL but may pick a stale branch tip (from before the subagent activity), causing the agent's response to land on a branch the host never receives a `result` for. **Fix**: pass `resumeSessionAt` with the last assistant message UUID to explicitly anchor each resume.

### 2. IDLE_TIMEOUT == CONTAINER_TIMEOUT (both 30 min)
Both timers fire at the same time, so containers always exit via hard SIGKILL (code 137) instead of graceful `_close` sentinel shutdown. The idle timeout should be shorter (e.g., 5 min) so containers wind down between messages, while container timeout stays at 30 min as a safety net for stuck agents.

### 3. Cursor advanced before agent succeeds
`processGroupMessages` advances `lastAgentTimestamp` before the agent runs. If the container times out, retries find no messages (cursor already past them). Messages are permanently lost on timeout.

### 4. [FIXED] OAuth 토큰 갱신 Cloudflare 차단
`claude.ai/oauth/token` 엔드포인트는 Cloudflare가 서버 요청을 차단 (403). **Fix**: `platform.claude.com/v1/oauth/token` 사용, `Content-Type: application/json`, Node.js `fetch` 사용 (curl 불가).

### 5. [FIXED] Threads API 토큰 1시간 만에 만료
Developer Portal의 User Token Generator로 발급한 토큰은 단기 토큰(1시간 유효). 장기 토큰(60일)으로 교환하려면 정식 OAuth 플로우를 거쳐야 함. User Token Generator 토큰은 `th_exchange_token` 교환이 거부됨 (`Session key invalid`). **Fix**: `scripts/threads-oauth.sh`로 정식 OAuth 인증 → 단기 토큰 발급 → `th_exchange_token`으로 장기 토큰 교환. 리다이렉트 URI(`https://localhost:3000/callback`)를 Meta 앱 설정에 화이트리스트 등록 필수.

### 6. [FIXED] API 키 우선순위로 Pro 크레딧 소진
`ANTHROPIC_API_KEY` 환경변수가 설정되면 Claude Code가 OAuth(Pro 구독)를 무시하고 API 키를 우선 사용. **Fix**: `.env`에 `ANTHROPIC_API_KEY_FALLBACK`으로 저장, `readSecrets()`에서 OAuth/API키 중 하나만 전달.

### 7. [FIXED] registered_groups folder UNIQUE 제약으로 멀티채널 등록 불가
Slack과 Discord가 같은 그룹 폴더(`main`)를 공유하려 할 때 `folder` 컬럼의 UNIQUE 제약으로 인해 두 번째 채널 등록 실패. **Fix**: `src/db.ts`에서 `folder TEXT NOT NULL UNIQUE` → `folder TEXT NOT NULL`로 변경. JID가 PRIMARY KEY이므로 중복 방지는 유지되며, 여러 채널이 동일 폴더 공유 가능. (커밋: 0d11575, 2026-02-22 16:25 UTC)

### 9. [FIXED] IPC `send_message`가 단일 채널에만 발송 (Discord 누락)
IPC `send_message` 핸들러가 발신 `chatJid`(주로 Slack)에만 메시지를 전송하고, 동일 `group_folder`의 다른 채널(Discord)에는 전달하지 않음. `task-scheduler.ts`는 이미 멀티채널 브로드캐스트를 구현했으나, `ipc.ts`의 `send_message` 경로는 누락. newsbot, threads daily 등 스케줄 태스크가 에이전트 내부에서 `send_message` IPC로 결과를 발송할 때 Discord 채널이 메시지를 받지 못함. **Fix**: `src/ipc.ts`의 `send_message` 핸들러를 동일 folder의 모든 JID에 브로드캐스트하도록 수정 (`task-scheduler.ts`와 동일 패턴).

### 8. [FIXED] Pro 구독 한도 초과 메시지 미감지로 fallback 실패
"You've hit your limit · resets 7am (UTC)" 같은 Pro 구독 한도 초과 메시지가 기존 rate limit 패턴(`/\b(429|rate.?limit|...)\b/i`)에 매칭되지 않아 API key fallback이 트리거되지 않음. **Fix**: `src/container-runner.ts`의 `RATE_LIMIT_PATTERN`에 `hit your limit`, `hit .+ limit`, `resets \d+\w+\s*\(UTC\)` 패턴 추가. (커밋: d9384ea, 2026-02-24 23:12 KST)

### 10. Router LIGHT 판정이지만 Copilot 미응답
- **상태**: 정상 (현재 Copilot API 서버 미구축)
- `COPILOT_API_URL=http://localhost:8080` 설정이지만 서버 미실행 → `callCopilotAPI()` 실패 → Claude HEAVY fallthrough
- 로그에 `Copilot API failed, falling through to HEAVY (Claude)` 경고가 나타남
- Copilot 서버를 구축하면 자동으로 LIGHT 응답 활성화

### 11. Delegation 30초 타임아웃
- 컨테이너의 `delegate_to_cheap_model` MCP 도구가 `delegation_result.json`을 30초간 polling
- 호스트 IPC 처리(`ipc.ts`)가 지연되면 타임아웃 발생 가능
- IPC_POLL_INTERVAL(1초)을 감안하면 정상적으로는 2~5초 내 완료

## 교훈 (실수 반복 방지)

### 🔴 토큰/인증 관련
| 실수 | 결과 | 올바른 방법 |
|------|------|------------|
| `.env`에 `ANTHROPIC_API_KEY=...` 설정 | OAuth 무시, 선불 크레딧 소진 | `ANTHROPIC_API_KEY_FALLBACK`으로 저장 |
| `claude.ai/oauth/token`으로 갱신 | Cloudflare 403 차단 | `platform.claude.com/v1/oauth/token` 사용 |
| `curl`로 토큰 교환 | Cloudflare 차단 | Node.js `fetch` 사용 |
| `Content-Type: application/x-www-form-urlencoded`로 토큰 교환 | 404 Not Found | `Content-Type: application/json` + JSON body |
| OAuth + API키 동시 전달 | API키가 우선, Pro 할당량 낭비 | 하나만 전달 (OAuth 우선) |
| `sk-ant-api03-`를 Pro 구독 키로 착각 | 선불 크레딧 소진 인지 못함 | `api03` = prepaid, `oat01` = OAuth |
| Threads User Token Generator로 토큰 발급 | 1시간 후 만료, 장기 교환 불가 | 정식 OAuth 플로우(`scripts/threads-oauth.sh`) 사용 |
| Threads 리다이렉트 URI 미등록 | OAuth 인증 시 "차단된 URL" 에러 | Meta 앱 설정에서 리다이렉트 URI 화이트리스트 등록 |
| `앱ID\|시크릿해시` 형태 토큰 사용 | API 호출 불가 (앱 토큰 ≠ 사용자 토큰) | `THAASI...`로 시작하는 사용자 토큰 사용 |

### 🔴 컨테이너 관련
| 실수 | 결과 | 올바른 방법 |
|------|------|------------|
| `.claude.json` 미마운트 | CLI exit 0, 메시지 0개, 에러 없음 | 반드시 마운트 + 쓰기 가능 확인 |
| credentials.json 미복사 | 인증 실패 | 컨테이너 `/home/node/.claude/`에 복사 |
| UID 불일치 (host 1001, container 1000) | EACCES permission denied | `sudo chmod -R 777 data/sessions/` |

### 🔴 시간대/스케줄 관련
| 실수 | 결과 | 올바른 방법 |
|------|------|------------|
| `TZ` 미설정 (UTC 서버) | cron `0 9 * * *`가 KST 18:00에 실행 | `.env`에 `TZ=Asia/Seoul` 설정 (Dockerfile 기본값 + container-runner가 호스트 TZ를 컨테이너에 전달) |
| 스케줄 태스크 `chat_jid` 단일 채널 | Slack만 발송, Discord 누락 | `task-scheduler.ts`에서 동일 folder의 모든 JID에 브로드캐스트 |
| Discord 채널 folder를 별도로 설정 (`main-dc`) | 브로드캐스트 대상에서 제외 | Slack과 같은 folder 사용 (`main`) |
| IPC `send_message`에서 `chatJid` 단일 발송 | Discord가 IPC 메시지 미수신 | 동일 folder의 모든 JID에 브로드캐스트 (`task-scheduler.ts`와 동일 패턴) |

### 🔴 라우터 관련
| 실수 | 결과 | 올바른 방법 |
|------|------|------------|
| `COPILOT_API_URL` 미설정 | `callCopilotAPI()` 즉시 에러 → HEAVY fallthrough | `.env`에 URL 설정 또는 `router/config.json`에서 `enabled: false` |
| `router/config.json` 삭제 | 기본 가중치로 fallback (동작은 함) | 삭제하지 말고 `enabled: false`로 비활성화 |
| Delegation result 파일 미삭제 | 다음 delegation에서 이전 결과 읽음 | 컨테이너가 읽은 후 `fs.unlinkSync`로 삭제 (이미 구현됨) |

### 🔴 DB/스키마 관련
| 실수 | 결과 | 올바른 방법 |
|------|------|------------|
| `folder` UNIQUE 제약 유지 | Slack/Discord가 같은 폴더 공유 불가 | `folder TEXT NOT NULL` (UNIQUE 제거), JID로 중복 방지 |

## Threads API 토큰 트러블슈팅

### 증상: "API access blocked" 또는 "Invalid OAuth 2.0 Access Token"

```bash
# 1. 현재 토큰 유효성 확인
source /home/ubuntu/nanoclaw/.env
curl -s "https://graph.threads.net/v1.0/me?fields=id,username&access_token=$THREADS_ACCESS_TOKEN"

# 2. 토큰 상태 파일 확인
cat /home/ubuntu/nanoclaw/data/threads-token-state.json

# 3. 토큰 만료됐으면 → OAuth 플로우로 재발급
bash /home/ubuntu/nanoclaw/scripts/threads-oauth.sh

# 4. 서비스 재시작
sudo systemctl restart nanoclaw
```

### 토큰 유형 구분
| 형태 | 유형 | 유효기간 |
|------|------|----------|
| `THAASI...` (짧음) | 단기 토큰 | 1시간 |
| `THAASI...` (긴 것) | 장기 토큰 | 60일 |
| `앱ID\|해시` | 앱 토큰 | API 호출 불가 |

## Quick Status Check (OCI / Linux)

```bash
# 1. 서비스 상태 확인
sudo systemctl status nanoclaw

# 2. 실시간 로그
sudo journalctl -u nanoclaw -f

# 3. 최근 에러 확인
sudo journalctl -u nanoclaw --since "1h ago" | grep -E 'ERROR|WARN|error|fail'

# 4. 실행 중인 컨테이너
docker ps --filter "name=nanoclaw-"

# 5. OAuth 토큰 만료 확인
node -e "
const c = require('/home/ubuntu/.claude/.credentials.json');
const exp = c.claudeAiOauth.expiresAt;
const now = Date.now();
const hours = ((exp - now) / 3600000).toFixed(1);
console.log(now < exp ? 'Valid: ' + hours + 'h remaining' : 'EXPIRED ' + Math.abs(hours) + 'h ago');
"

# 6. 그룹 로드 확인
sudo journalctl -u nanoclaw -n 20 | grep -E 'groupCount|NanoClaw running'

# 7. Slack 연결 확인
sudo journalctl -u nanoclaw -n 30 | grep -E 'Slack.*connected|Socket Mode'
```

## OAuth 토큰 트러블슈팅

### 증상: "401 authentication_error: OAuth token has expired"

```bash
# 1. credentials.json 만료 시간 확인
node -e "
const c = require('/home/ubuntu/.claude/.credentials.json');
const o = c.claudeAiOauth;
console.log('Access:', o.accessToken.substring(0,30) + '...');
console.log('Expires:', new Date(o.expiresAt).toISOString());
console.log('Sub type:', o.subscriptionType);
"

# 2. Refresh token으로 갱신 시도
node -e "
fetch('https://platform.claude.com/v1/oauth/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    grant_type: 'refresh_token',
    refresh_token: require('/home/ubuntu/.claude/.credentials.json').claudeAiOauth.refreshToken,
    client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
    scope: 'user:inference user:mcp_servers user:profile user:sessions:claude_code'
  })
}).then(r => r.json()).then(d => {
  if (d.access_token) {
    const fs = require('fs');
    const creds = { claudeAiOauth: {
      accessToken: d.access_token,
      refreshToken: d.refresh_token,
      expiresAt: Date.now() + d.expires_in * 1000,
      scopes: d.scope.split(' '),
      subscriptionType: 'pro',
      rateLimitTier: 'default_claude_ai'
    }};
    fs.writeFileSync('/home/ubuntu/.claude/.credentials.json', JSON.stringify(creds));
    console.log('Token refreshed! Expires in', (d.expires_in/3600).toFixed(1), 'hours');
  } else {
    console.log('Refresh failed:', JSON.stringify(d));
    console.log('→ 수동 PKCE 인증 필요 (OCI-POLICY-OPS.md 참조)');
  }
}).catch(console.error);
"

# 3. 서비스 재시작
sudo systemctl restart nanoclaw
```

### 증상: "Credit balance is too low"
- **원인**: Prepaid API 키 크레딧 소진 또는 OAuth 대신 API 키 사용 중
- **확인**: 로그에서 `Auth: using fallback prepaid API key` 메시지 확인
- **해결**: OAuth 토큰 갱신 후 서비스 재시작 (로그에 `Auth: using Pro subscription OAuth token` 확인)

### 증상: "You've hit your limit · resets 7am (UTC)" 에러 후 계속 실패
- **원인**: Pro 구독 일일 한도 초과 후 API key fallback이 트리거되지 않음 (2026-02-24 이전 버전)
- **확인**: 로그에 한도 초과 메시지가 있지만 fallback으로 전환되지 않음
- **해결**: `src/container-runner.ts`의 rate limit 패턴 개선 필요 (d9384ea 커밋 이후 버전에서는 자동 fallback됨)

### 증상: Refresh token도 만료
- Refresh token 수명은 약 30일 (추정)
- 수동 PKCE 인증 필요 → OCI-POLICY-OPS.md "수동 토큰 갱신" 섹션 참조

## Container Timeout Investigation

```bash
# 최근 타임아웃 확인
sudo journalctl -u nanoclaw --since "1h ago" | grep -E 'timeout|timed out|SIGKILL'

# 최근 컨테이너 로그
ls -lt groups/*/logs/container-*.log | head -10

# 가장 최근 컨테이너 로그 읽기
cat $(ls -t groups/main/logs/container-*.log | head -1)

# 재시도 확인
sudo journalctl -u nanoclaw --since "1h ago" | grep -E 'retry|Max retries'
```

## Agent Not Responding

```bash
# 메시지 수신 확인
sudo journalctl -u nanoclaw --since "30m ago" | grep -E 'New message|Incoming'

# 컨테이너 스폰 확인
sudo journalctl -u nanoclaw --since "30m ago" | grep -E 'Processing|Spawning|container'

# 큐 상태 확인
sudo journalctl -u nanoclaw --since "30m ago" | grep -E 'Starting|active|concurrency'

# lastAgentTimestamp vs 최신 메시지
sqlite3 /home/ubuntu/nanoclaw/store/messages.db \
  "SELECT chat_jid, MAX(timestamp) as latest FROM messages GROUP BY chat_jid ORDER BY latest DESC LIMIT 5;"
```

## Container Mount Issues

```bash
# 마운트 검증 로그
sudo journalctl -u nanoclaw --since "1h ago" | grep -E 'Mount|mount|REJECTED'

# 그룹 container_config 확인
sqlite3 /home/ubuntu/nanoclaw/store/messages.db \
  "SELECT name, container_config FROM registered_groups;"

# 컨테이너 내부 마운트 테스트
docker run -i --rm --entrypoint ls nanoclaw-agent:latest /workspace/
```

## Discord 연결 문제

```bash
# Discord 연결 상태
sudo journalctl -u nanoclaw --since "1h ago" | grep -E 'Discord|discord'

# 봇 연결 확인
sudo journalctl -u nanoclaw -n 30 | grep -E 'Discord bot connected|Discord channel connected'

# 등록된 Discord 채널 확인
node -e "
const Database = require('better-sqlite3');
const db = new Database('/home/ubuntu/nanoclaw/store/messages.db');
const rows = db.prepare(\"SELECT * FROM registered_groups WHERE jid LIKE 'dc:%'\").all();
console.log(rows);
db.close();
"
```

### 증상: Discord 메시지 미수신
- **Message Content Intent** 비활성화: Discord Developer Portal → Bot → Privileged Gateway Intents → Message Content Intent 활성화
- `DISCORD_BOT_TOKEN` 미설정: `.env`에 토큰 추가 후 서비스 재시작
- 채널 미등록: DB에 `dc:<channelId>` JID로 그룹 등록 필요

## Slack 연결 문제

```bash
# Socket Mode 연결 상태
sudo journalctl -u nanoclaw --since "1h ago" | grep -E 'Slack|Socket|connected|disconnect'

# Bot token 유효 확인 (auth.test)
curl -s -H "Authorization: Bearer $(grep SLACK_BOT_TOKEN /home/ubuntu/nanoclaw/.env | cut -d= -f2)" \
  https://slack.com/api/auth.test | python3 -m json.tool

# App token 유효 확인
curl -s -H "Authorization: Bearer $(grep SLACK_APP_TOKEN /home/ubuntu/nanoclaw/.env | cut -d= -f2)" \
  https://slack.com/api/apps.connections.open -X POST | python3 -m json.tool
```

## Service Management (OCI / Linux)

```bash
# 재시작
sudo systemctl restart nanoclaw

# 실시간 로그
sudo journalctl -u nanoclaw -f

# 중지 (주의: 실행 중인 컨테이너는 detach됨)
sudo systemctl stop nanoclaw

# 시작
sudo systemctl start nanoclaw

# 코드 변경 후 재빌드 + 재시작
cd /home/ubuntu/nanoclaw && npm run build && sudo systemctl restart nanoclaw

# 컨테이너 이미지도 변경한 경우
cd /home/ubuntu/nanoclaw && npm run build && ./container/build.sh && sudo systemctl restart nanoclaw
```

## Session Transcript Branching

```bash
# 세션 디버그 로그에서 동시 CLI 프로세스 확인
ls -la data/sessions/<group>/.claude/debug/

# 트랜스크립트의 parentUuid 분기 확인
python3 -c "
import json
lines = open('data/sessions/<group>/.claude/projects/-workspace-group/<session>.jsonl').read().strip().split('\n')
for i, line in enumerate(lines):
  try:
    d = json.loads(line)
    if d.get('type') == 'user' and d.get('message'):
      parent = d.get('parentUuid', 'ROOT')[:8]
      content = str(d['message'].get('content', ''))[:60]
      print(f'L{i+1} parent={parent} {content}')
  except: pass
"
```
