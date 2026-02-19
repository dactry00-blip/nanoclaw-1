# NanoClaw 유저 가이드

## 환경 정보

- **서버**: OCI (Oracle Cloud) Ubuntu 22.04 LTS
- **프로젝트 경로**: `/home/ubuntu/nanoclaw`
- **채널**: Slack (Socket Mode)
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

## Slack 설정

`.env` 파일에 다음 토큰이 필요합니다 (퍼미션 600):

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

### 컨테이너 이미지 재빌드
```bash
docker builder prune -af    # 캐시 정리 (선택)
./container/build.sh         # 재빌드
```

Docker 빌드 캐시는 매주 일요일 04:00에 자동 정리됩니다.

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
| Slack 이벤트 → 메시지 감지 | ~12ms |
| 컨테이너 시작 (cold start) | ~300ms |
| Claude 추론 | 가변 (내용에 따라) |
| Slack 전송 | ~500ms |
| **총 인프라 오버헤드** | **~1초** |

## 자동화된 유지보수

| 작업 | 주기 | 시간 |
|------|------|------|
| 로그 로테이션 | 매일 | logrotate |
| 오래된 로그 삭제 (14일+) | 매일 | 03:00 |
| Docker 빌드 캐시 정리 | 매주 일요일 | 04:00 |
| 서비스 크래시 재시작 | 즉시 | 5초 후 자동 |
| OAuth 토큰 갱신 | 만료 5분 전 | 자동 |

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
