# OCI 정책서 — 운영 정책

**최종 업데이트**: 2026-02-27 19:15 KST

## 환경 정보

- **서버**: OCI (Oracle Cloud) Ubuntu 22.04 LTS
- **프로젝트 경로**: `/home/ubuntu/nanoclaw`
- **채널**: Slack (Socket Mode) + Discord (Gateway)
- **어시스턴트 이름**: 폴
- **트리거 패턴**: `@폴` (멘션)
- **인증**: Claude Pro 구독 OAuth 토큰 (자동 갱신)
- **프로세스 관리**: systemd (`nanoclaw.service`)

## 실행 방법

### 프로덕션 (systemd 서비스)

```bash
sudo systemctl start nanoclaw     # 시작
sudo systemctl stop nanoclaw      # 중지
sudo systemctl restart nanoclaw   # 재시작
sudo systemctl status nanoclaw    # 상태 확인
sudo systemctl enable nanoclaw    # 부팅 시 자동 시작 (이미 설정됨)
```

서버 재부팅 시 자동 시작됩니다. 크래시 시 5초 후 자동 재시작됩니다.

### 개발 모드

```bash
cd /home/ubuntu/nanoclaw

# 소스 변경사항 즉시 반영 (컨테이너 내 tsc 재컴파일)
DEV_MOUNT=true npm run dev

# 프로덕션 빌드 테스트
npm run build && node dist/index.js
```

## 채널 설정

`.env` 파일에 다음 토큰이 필요합니다 (퍼미션 600):

```
# 선불 크레딧 API 키 (OAuth 실패 시 fallback 전용)
# ⚠️ ANTHROPIC_API_KEY로 하면 안 됨! OAuth보다 우선되어 크레딧 소진됨
ANTHROPIC_API_KEY_FALLBACK=sk-ant-api03-...

TZ=Asia/Seoul                    # 시간대 (호스트 + 컨테이너 모두 적용)
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
DISCORD_BOT_TOKEN=MTQ3...      # Discord 봇 토큰 (없으면 Discord 비활성화)
ASSISTANT_NAME=폴
TRIGGER_PATTERN=^@폴
COPILOT_API_URL=http://localhost:4141  # copilot-api 프록시 (GitHub Copilot → OpenAI-compatible)
COPILOT_MODEL=gpt-4o-mini             # Copilot API 모델명 (gpt-4o-mini, gpt-4.1, gpt-5-mini 등 선택 가능)
COPILOT_API_KEY=dummy                 # copilot-api 프록시는 자체 인증, 값은 아무거나
THREADS_ACCESS_TOKEN=...       # Threads API 장기 토큰 (threads 그룹용, 60일 유효)
THREADS_USER_ID=...            # Threads 사용자 ID
THREADS_APP_ID=...             # Threads 앱 ID (토큰 갱신용)
THREADS_APP_SECRET=...         # Threads 앱 시크릿 (토큰 갱신용)
```

### Slack 앱 권한
- **Bot Token Scopes**: `chat:write`, `app_mentions:read`, `channels:history`, `users:read`
- **Socket Mode**: 활성화 필수
- **Event Subscriptions**: `message.channels`, `app_mention`

### Discord 봇 설정
- **Intents**: `Guilds`, `GuildMessages`, `MessageContent`, `DirectMessages`
- **Privileged Gateway Intents**: Message Content Intent 활성화 필수 (Discord Developer Portal)
- **JID 형식**: `dc:<channelId>` (그룹 등록 시 이 형식 사용)
- **봇 이름**: 나노봇 (Discord 서버 내 표시명)
- **트리거**: `@나노봇` 멘션 → 자동으로 `@폴` 트리거로 변환

## 토큰 관리

### Claude OAuth 자동 갱신
- Claude Pro 구독 토큰은 `~/.claude/.credentials.json`에 저장됨
- `oauth-refresh.ts`가 만료 5분 전에 `platform.claude.com/v1/oauth/token`으로 자동 갱신
- ⚠️ `claude.ai/oauth/token`은 Cloudflare가 서버에서 차단 → 사용 불가
- 갱신 실패 시 기존 토큰 → fallback API 키 순서로 시도
- Access token 유효기간: 8시간, Refresh token으로 자동 재발급

### Threads API 토큰 자동 갱신
- `threads-refresh.ts`가 장기 토큰(60일) 만료 7일 전에 자동 갱신
- 상태 파일: `data/threads-token-state.json` (만료일 추적)
- 갱신 성공 시 `.env`의 `THREADS_ACCESS_TOKEN`도 자동 업데이트
- 매 컨테이너 스폰 시 `ensureFreshThreadsToken()` 호출
- **토큰 발급 시 주의**: Developer Portal의 User Token Generator 토큰은 장기 교환 불가 → 정식 OAuth 플로우 필수
- OAuth 플로우 스크립트: `scripts/threads-oauth.sh`
- 리다이렉트 URI: `https://localhost:3000/callback` (Meta 앱 설정에 화이트리스트 등록 필수)

### 인증 우선순위 (⚠️ 중요)
```
1순위: OAuth Access Token (Pro 구독, 무료 할당량)
2순위: Prepaid API Key (선불 크레딧, 토큰당 과금)
```
- `ANTHROPIC_API_KEY` 환경변수가 있으면 Claude Code가 OAuth를 **무시**하고 API키 사용
- 반드시 `.env`에 `ANTHROPIC_API_KEY_FALLBACK`으로 저장 (ANTHROPIC_API_KEY 아님!)
- `readSecrets()`가 OAuth 유효 시 OAuth만, 실패 시 API키만 전달

### 수동 토큰 갱신 (PKCE 플로우)
Refresh token까지 만료된 경우 수동 인증 필요:

```bash
# 1. PKCE 챌린지 생성
python3 -c "
import hashlib, base64, os, json
v = base64.urlsafe_b64encode(os.urandom(32)).rstrip(b'=').decode()
c = base64.urlsafe_b64encode(hashlib.sha256(v.encode()).digest()).rstrip(b'=').decode()
s = base64.urlsafe_b64encode(os.urandom(32)).rstrip(b'=').decode()
json.dump({'v':v,'c':c,'s':s}, open('/tmp/pkce.json','w'))
print(f'Verifier: {v}')
print(f'Auth URL: https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference+user%3Asessions%3Aclaude_code+user%3Amcp_servers&code_challenge={c}&code_challenge_method=S256&state={s}')
"

# 2. 브라우저에서 Auth URL 열고 인증 → 코드 복사 (code#state 형식)

# 3. 토큰 교환 (서버에서 실행)
CODE="<인증코드>"  # # 앞부분만
VERIFIER=$(python3 -c "import json; print(json.load(open('/tmp/pkce.json'))['v'])")
STATE=$(python3 -c "import json; print(json.load(open('/tmp/pkce.json'))['s'])")

node -e "
fetch('https://platform.claude.com/v1/oauth/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    grant_type: 'authorization_code',
    client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
    code: '$CODE',
    redirect_uri: 'https://platform.claude.com/oauth/code/callback',
    code_verifier: '$VERIFIER',
    state: '$STATE'
  })
}).then(r=>r.json()).then(d=>console.log(JSON.stringify(d,null,2))).catch(console.error);
"

# 4. 결과에서 credentials.json 업데이트
# access_token, refresh_token, expires_in 값을 ~/.claude/.credentials.json에 저장
```

### ⚠️ 절대 하지 말 것
- `.env`에 `ANTHROPIC_API_KEY=...` 설정 → Pro 구독 무시되고 크레딧 소진
- `claude.ai/oauth/token`으로 토큰 갱신 → Cloudflare 차단 (403)
- `curl`로 토큰 교환 → Cloudflare 차단. Node.js `fetch` 사용 필수

## 로그 확인

### systemd 서비스 로그 (추천)
```bash
sudo journalctl -u nanoclaw -f           # 실시간
sudo journalctl -u nanoclaw --since "1h ago"  # 최근 1시간
sudo journalctl -u nanoclaw -n 100       # 최근 100줄
```

### 그룹별 컨테이너 로그
```bash
ls groups/main/logs/
cat groups/main/logs/<latest-log>.log
```

### Claude CLI 디버그 로그 (컨테이너 내부)
```bash
docker exec <container> cat /home/node/.claude/debug/latest
```

### 로그 로테이션
- logrotate가 매일 자동으로 로그 파일 로테이션 (7일 보관, 압축)
- cron이 14일 이상 된 로그 자동 삭제 (매일 03:00)

## 컨테이너 관리

### 실행 중 컨테이너 확인
```bash
docker ps --filter "name=nanoclaw-"
```

### 모든 컨테이너 정지
```bash
docker ps --filter "name=nanoclaw-" -q | xargs -r docker stop
```

### 컨테이너 시간대
- `container/Dockerfile`에 `ENV TZ=Asia/Seoul` 기본값 설정
- `container-runner.ts`가 호스트의 `TZ` 환경변수를 `-e TZ=...`로 컨테이너에 전달
- 호스트·컨테이너 모두 KST로 통일 (로그 타임스탬프, cron 스케줄, Date 출력 등)

### 컨테이너 이미지 재빌드
```bash
docker builder prune -af    # 캐시 정리 (선택)
./container/build.sh         # 재빌드
```

Docker 빌드 캐시는 매주 일요일 04:00에 자동 정리됩니다.

## Copilot API 프록시 서비스

GitHub Copilot 구독을 OpenAI-compatible API로 노출하는 `copilot-api` 프록시 서버.
Router의 LIGHT tier 요청을 처리합니다.

```bash
sudo systemctl status copilot-api    # 상태 확인
sudo systemctl restart copilot-api   # 재시작
sudo journalctl -u copilot-api -f    # 실시간 로그
```

- **포트**: 4141 (`http://localhost:4141`)
- **인증**: GitHub Copilot 토큰 (`~/.local/share/copilot-api/github_token`)
- **Rate limit**: `--rate-limit 10 --wait` (10초 간격, 초과 시 대기)
- **사용 가능 모델**: gpt-4o-mini, gpt-4.1, gpt-5-mini, claude-haiku-4.5 등 30종
- **서비스 파일**: `copilot-api.service`
- **GitHub 인증 재설정**: `copilot-api auth` (디바이스 플로우)

## 싱글턴 가드

호스트 프로세스가 중복 실행되면 슬랙 메시지에 여러 번 응답하는 문제가 발생합니다.
PID lock(`data/host.pid`)이 자동으로 중복 실행을 방지합니다.

- 이미 실행 중인 인스턴스가 있으면 새 인스턴스 자동 종료
- 죽은 프로세스의 stale lock은 자동 회수
- 워커 컨테이너에는 영향 없음

수동 확인:
```bash
cat data/host.pid                        # 현재 PID
ps aux | grep 'node.*index' | grep -v grep  # 실행 중인 프로세스
```

## 응답 시간

| 구간 | 시간 |
|------|------|
| Slack/Discord 이벤트 → 메시지 감지 | ~12ms |
| 컨테이너 시작 (cold start) | ~300ms |
| Claude 추론 | 가변 (내용에 따라) |
| Slack/Discord 전송 | ~500ms |
| **총 인프라 오버헤드** | **~1초** |

## 자동화된 유지보수

| 작업 | 주기 | 시간 |
|------|------|------|
| 로그 로테이션 | 매일 | logrotate |
| 오래된 로그 삭제 (14일+) | 매일 | 03:00 |
| Docker 빌드 캐시 정리 | 매주 일요일 | 04:00 |
| 서비스 크래시 재시작 | 즉시 | 5초 후 자동 |
| OAuth 토큰 갱신 | 만료 5분 전 | 자동 (platform.claude.com) |
| Threads 토큰 갱신 | 만료 7일 전 | 자동 (graph.threads.net, 60일 주기) |
| 라우팅 메트릭 기록 | 매 메시지 | `logs/routing-metrics.jsonl` |
| Copilot 프록시 서비스 | 상시 | `copilot-api.service` (port 4141) |

## 주의사항

1. **서비스 관리**: `nohup` 대신 `sudo systemctl` 사용 (재부팅/크래시 시 자동 복구)
2. **밀린 메시지**: 서비스 재시작 후 밀린 메시지는 자동 처리됨 (Recovery 로직)
3. **동시 접속**: 최대 5개 컨테이너 동시 실행 (`MAX_CONCURRENT_CONTAINERS`)
4. **유휴 종료**: 30분 무응답 시 컨테이너 자동 종료 (`IDLE_TIMEOUT`)
5. **파일 권한**: 컨테이너 uid(1000)과 호스트 uid(1001)가 다를 수 있음 → `sudo chmod -R 777 data/sessions/` 필요할 수 있음
6. **Swap**: 2GB swap 설정됨 (OOM 방지)
7. **.env 보안**: 퍼미션 600 (소유자만 읽기)

## Git 설정

```
user.name: dactry00-blip
user.email: dactry00@gmail.com
remote: https://github.com/dactry00-blip/nanoclaw-1.git (fork)
upstream: https://github.com/gavrielc/nanoclaw.git (원본)
```

## 서버 스펙

| 항목 | 값 |
|------|------|
| OS | Ubuntu 22.04 LTS |
| RAM | 23GB |
| Swap | 2GB |
| Disk | 45GB (17% 사용) |
| Node.js | v20.20.0 |
| Docker | active |
| 방화벽 | OCI Security List |
