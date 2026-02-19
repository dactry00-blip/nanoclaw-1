# NanoClaw 유저 가이드

## 환경 정보

- **서버**: OCI (Oracle Cloud) Ubuntu 인스턴스
- **프로젝트 경로**: `/home/ubuntu/nanoclaw`
- **채널**: Slack (Socket Mode)
- **어시스턴트 이름**: 폴
- **트리거 패턴**: `@폴` (멘션)
- **인증**: Claude Pro 구독 OAuth 토큰 (자동 갱신)

## 실행 방법

```bash
cd /home/ubuntu/nanoclaw

# 개발 모드 (hot reload)
npm run dev

# 프로덕션 빌드 후 실행
npm run build && node dist/index.js
```

## Slack 설정

`.env` 파일에 다음 토큰이 필요합니다:

```
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
ASSISTANT_NAME=폴
TRIGGER_PATTERN=^@폴
```

### Slack 앱 권한
- **Bot Token Scopes**: `chat:write`, `app_mentions:read`, `channels:history`, `users:read`
- **Socket Mode**: 활성화 필수
- **Event Subscriptions**: `message.channels`, `app_mention`

## 토큰 관리

### 자동 갱신
- Claude Pro 구독 토큰은 `~/.claude/.credentials.json`에 저장됨
- `oauth-refresh.ts`가 만료 5분 전에 자동 갱신
- 갱신 실패 시 기존 토큰으로 fallback

### 수동 토큰 갱신
토큰이 완전히 만료된 경우:
```bash
claude setup-token  # Claude CLI로 재인증
```

## 그룹 관리

### 등록된 그룹 확인
```bash
node -e "
const db = require('better-sqlite3')('store/messages.db');
console.log(JSON.stringify(db.prepare('SELECT * FROM registered_groups').all(), null, 2));
"
```

### 세션 초기화
Agent가 이상하게 동작할 때:
```bash
node -e "
const db = require('better-sqlite3')('store/messages.db');
db.prepare('DELETE FROM sessions').run();
console.log('Sessions cleared');
"
```

## 컨테이너 관리

### 실행 중 컨테이너 확인
```bash
docker ps --filter "name=nanoclaw-"
```

### 모든 컨테이너 정지
```bash
docker ps --filter "name=nanoclaw-" -q | xargs -r docker stop
```

### 컨테이너 로그 확인
```bash
docker logs <container-name> 2>&1
```

### 컨테이너 이미지 재빌드
```bash
docker builder prune -af
./container/build.sh
```

## 로그 확인

### 호스트 로그
`npm run dev` 실행 시 stdout으로 출력됩니다.

### 그룹별 컨테이너 로그
```bash
ls groups/main/logs/
cat groups/main/logs/<latest-log>.log
```

### Claude CLI 디버그 로그 (컨테이너 내부)
```bash
docker exec <container> cat /home/node/.claude/debug/latest
```

## 주의사항

1. **서버 재시작 시**: Docker가 실행 중인지 확인 (`sudo systemctl start docker`)
2. **밀린 메시지**: 서버 재시작 후 밀린 메시지가 있으면 자동 처리됨 (Recovery 로직)
3. **동시 접속**: 최대 5개 컨테이너 동시 실행 (config.ts `MAX_CONCURRENT_CONTAINERS`)
4. **유휴 종료**: 30분 무응답 시 컨테이너 자동 종료 (`IDLE_TIMEOUT`)
5. **파일 권한**: 컨테이너 uid(1000)과 호스트 uid(1001)가 다를 수 있음 → `sudo chmod -R 777 data/sessions/` 필요할 수 있음

## Git 설정

```
user.name: dactry00-blip
user.email: dactry00@gmail.com
remote: https://github.com/dactry00-blip/nanoclaw-1.git (fork)
upstream: https://github.com/gavrielc/nanoclaw.git (원본)
```
