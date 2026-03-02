# OCI 정책서 — 운영 정책

**최종 업데이트**: 2026-03-02 11:00 KST

## 환경 정보

- **서버**: OCI (Oracle Cloud) Ubuntu 22.04 LTS
- **인스턴스명**: `j-instance-20260217-1351`
- **호스트명**: `j-instance-20260217-1351`
- **리전**: `ap-singapore-2` (싱가포르)
- **Shape**: `VM.Standard.A1.Flex` (ARM, 4 OCPU, 24GB RAM)
- **프로젝트 경로**: `/home/ubuntu/nanoclaw`
- **채널**: Discord (Gateway) — Slack은 비활성화 (토큰 유출로 갱신 안 함)
- **어시스턴트 이름**: J
- **트리거 패턴**: `@J` (멘션)
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
# Slack은 비활성화 (토큰 유출로 갱신 안 함)
#SLACK_BOT_TOKEN=xoxb-...
#SLACK_APP_TOKEN=xapp-...
DISCORD_BOT_TOKEN=MTQ3...      # Discord 봇 토큰 (없으면 Discord 비활성화)
ASSISTANT_NAME=J
TRIGGER_PATTERN=^@J
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
- **트리거**: `@나노봇` 멘션 → 자동으로 `@J` 트리거로 변환

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
| 나노클로 GitHub 백업 | 매일 | 05:00 (`nanoclaw-1` repo) |
| 오픈클로 GitHub 백업 | 매일 | 05:05 (`openclaw-backup` repo, private) |
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

## OpenClaw (별도 Docker 컨테이너)

NanoClaw와 독립적으로 운영되는 AI 에이전트 프레임워크. 별도 Docker Compose 스택으로 실행.

### 구성

| 항목 | 값 |
|------|------|
| **소스 경로** | `/home/ubuntu/openclaw` |
| **설정 경로** | `~/.openclaw/` |
| **컨테이너** | `openclaw-openclaw-gateway-1` |
| **이미지** | `openclaw:local` (소스 빌드) |
| **게이트웨이 포트** | 18789 (Control UI) |
| **브릿지 포트** | 18790 |
| **AI Provider** | OpenAI Codex OAuth (ChatGPT Plus) + GitHub Copilot Pro (폴백) |
| **기본 모델** | `openai-codex/gpt-5.1` |
| **폴백 모델** | `github-copilot/gpt-5-mini` |
| **Discord 봇** | `@오픈클로봇-J` (ID: 1476928870430277853) |
| **보안 플러그인** | SecureClaw v2.2.0 |
| **보안 점수** | 64/100 (Critical 0, HIGH 2, MED 3) |

### 실행 방법

```bash
cd /home/ubuntu/openclaw

# 시작
docker compose up -d openclaw-gateway

# 중지
docker compose down

# 재시작
docker compose restart openclaw-gateway

# 로그
docker logs --tail 30 openclaw-openclaw-gateway-1

# 채널 상태
docker exec openclaw-openclaw-gateway-1 openclaw channels status

# 모델 변경
docker exec openclaw-openclaw-gateway-1 openclaw models set github-copilot/<모델명>

# 설정 변경
docker exec openclaw-openclaw-gateway-1 openclaw config set <key> <value> --json
```

### Control UI 접근

- **외부 접근 (Cloudflare Tunnel)**: `https://openclawj.bfreeai.us` (HTTPS 자동, 기기 페어링 필요)
- **로컬 접근** (SSH 터널): `ssh -i <키파일> -L 18789:127.0.0.1:18789 ubuntu@140.245.55.36` → `http://localhost:18789/`
- **게이트웨이 토큰**: `.env`의 `OPENCLAW_GATEWAY_TOKEN` 값 사용 (브라우저에 저장됨)
- 새 기기 접속 시 페어링 승인 필요: `docker exec openclaw-openclaw-gateway-1 openclaw devices approve <requestId>`

### Cloudflare Tunnel

- **터널명**: `openclaw-j` (ID: `ac436799-05e5-4919-af98-cd79de204181`)
- **도메인**: `openclawj.bfreeai.us` → `localhost:18789`
- **서비스**: systemd `cloudflared.service` (서버 재부팅 시 자동 시작)
- **설정 파일**: `/etc/cloudflared/config.yml`
- **인증서**: `/home/ubuntu/.cloudflared/cert.pem`

```bash
sudo systemctl status cloudflared    # 상태 확인
sudo systemctl restart cloudflared   # 재시작
```

### OpenAI Codex OAuth 인증 (ChatGPT Plus)

```bash
# TTY 필요 — SSH 터미널에서 직접 실행
docker exec -it openclaw-openclaw-gateway-1 openclaw onboard --auth-choice openai-codex --accept-risk

# 토큰 확인
docker exec openclaw-openclaw-gateway-1 cat /home/node/.openclaw/agents/main/agent/auth-profiles.json
```

- ChatGPT Plus 구독 할당량 사용
- 브라우저 인증 필요 (VPS 환경에서는 URL 표시 → 로컬 브라우저에서 인증 → 리다이렉트 URL 붙여넣기)

### GitHub Copilot 토큰 갱신 (폴백용)

```bash
# TTY 필요 — SSH 터미널에서 직접 실행
docker exec -it openclaw-openclaw-gateway-1 openclaw models auth login-github-copilot

# 토큰 확인
docker exec openclaw-openclaw-gateway-1 cat /home/node/.openclaw/credentials/github-copilot.token.json
```

### Meta SNS Manager API (Threads + Instagram)

OpenClaw 전용 Meta 앱으로 Threads/Instagram API 연동.

| 항목 | Threads | Instagram |
|------|---------|-----------|
| **앱 ID** | `901486605996246` | `4244425462496039` |
| **User ID** | `25842836398677206` | `34086375891006594` |
| **계정** | `@ai.bfree` | `@ai.bfree` |
| **토큰 파일** | `~/.openclaw/threads/token-state.json` | `~/.openclaw/threads/instagram-token-state.json` |
| **컨테이너 마운트** | `/home/node/.threads-token-state.json` (ro) | `/home/node/.instagram-token-state.json` (ro) |
| **토큰 유효기간** | 60일 (장기 토큰) | 60일 (장기 토큰) |
| **OAuth 리디렉트 URI** | `https://localhost/` | `https://localhost/` |

3번째 이용사례 (콘텐츠 퍼가기/oEmbed)는 별도 토큰 불필요 (앱 ID + 시크릿으로 호출).

**토큰 갱신**: 만료 전 수동 OAuth 플로우 필요 (자동 갱신 미구현).
- Threads: `https://graph.threads.net/refresh_access_token?grant_type=th_refresh_token&access_token=<TOKEN>`
- Instagram: `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=<TOKEN>`

### Exec (Bash/Shell) 보안 설정

에이전트가 `curl`/`node`로 Threads/Instagram API를 직접 호출할 수 있도록 exec 도구 활성화.
Docker 컨테이너가 이미 1차 격리 레이어이므로 sandbox(DinD) 대신 gateway 모드 사용.

```json
{
  "tools.exec.host": "gateway",
  "tools.exec.security": "allowlist",
  "tools.exec.ask": "on-miss",
  "tools.exec.safeBins": ["curl", "node"],
  "tools.exec.safeBinTrustedDirs": ["/usr/bin", "/usr/local/bin"],
  "tools.exec.safeBinProfiles": {
    "curl": { "deniedFlags": ["-o", "--output", "-O", "--remote-name", "-T", "--upload-file"] },
    "node": { "deniedFlags": ["--eval-file"] }
  }
}
```

**보안 레이어:**
1. Docker 컨테이너 격리 (호스트 접근 불가)
2. `security=allowlist` (curl, node만 허용, rm/wget/ssh 등 차단)
3. `safeBinProfiles` (curl의 파일 쓰기 플래그 차단: `-o`, `-O`, `-T`)
4. `ask=on-miss` (첫 실행 시 Discord 승인 요청)
5. `safeBinTrustedDirs` (/usr/bin, /usr/local/bin의 바이너리만 신뢰)

**⚠️ 주의:**
- `security=full` 사용 금지 — 모든 명령 허용됨
- sandbox(DinD)는 docker.sock 마운트 필요 → 오히려 호스트 root 노출 위험
- `jq`는 컨테이너에 없으므로 JSON 파싱은 `node -e` 사용

### SecureClaw 보안 감사/강화

```bash
# 감사
docker exec openclaw-openclaw-gateway-1 bash /home/node/.openclaw/skills/secureclaw/scripts/quick-audit.sh

# 하드닝
docker exec openclaw-openclaw-gateway-1 bash /home/node/.openclaw/skills/secureclaw/scripts/quick-harden.sh
```

### Discord 설정

- **groupPolicy**: `allowlist` (허용된 서버/유저만 응답)
- **dmPolicy**: `pairing` (DM은 페어링 승인 필요)
- **허용 서버**: `1474960238900674892`
- **허용 유저**: `1277258344985264245`
- 서버 채널: `@오픈클로봇-J` 멘션 필요
- DM: 멘션 없이 응답

### 사용 가능한 GitHub Copilot 모델 (21종)

Claude (opus-4.6, opus-4.5, sonnet-4.6, sonnet-4.5, sonnet-4, haiku-4.5), GPT (5.2-codex, 5.2, 5.1-codex-max, 5.1-codex, 5.1, 5, 5-mini, 4.1, 4o), Gemini (3.1-pro, 3-pro, 3-flash, 2.5-pro), grok-code-fast-1

### ⚠️ 주의사항

- NanoClaw와 **포트 충돌 없음** (NanoClaw는 포트 미사용, Socket Mode)
- OpenClaw 게이트웨이는 **RAM ~1.5GB** 사용 (서버 23GB 중)
- 컨테이너 내부 uid=1000(node), 호스트 uid=1001 → 권한 문제 시 `sudo chown -R 1000:1000 ~/.openclaw`
- `openclaw.json`에 OpenClaw 스키마에 없는 키 추가 시 게이트웨이 시작 실패
- OCI Security List에서 포트 18789 인바운드 허용됨
- iptables에 18789 허용 규칙 추가됨 (`/etc/iptables/rules.v4`에 저장)

## 서버 스펙

| 항목 | 값 |
|------|------|
| OS | Ubuntu 22.04 LTS |
| RAM | 23GB |
| Swap | 2GB |
| Disk | 45GB (32% 사용) |
| Node.js | v20.20.0 |
| Docker | active |
| 방화벽 | OCI Security List + iptables (22, 18789) |
| Cloudflare Tunnel | `cloudflared.service` (openclawj.bfreeai.us → localhost:18789) |
