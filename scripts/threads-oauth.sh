#!/bin/bash
# Threads OAuth 토큰 발급 스크립트
# 정식 OAuth 플로우 → 단기 토큰 → 장기 토큰(60일) 자동 교환

set -e
source /home/ubuntu/nanoclaw/.env

REDIRECT_URI="https://localhost/"
SCOPES="threads_basic,threads_content_publish,threads_manage_insights,threads_manage_replies,threads_read_replies"

echo "============================================"
echo "  Threads API OAuth 토큰 발급"
echo "============================================"
echo ""
echo "1단계: 아래 URL을 브라우저에 붙여넣고 인증하세요"
echo ""
echo "https://threads.net/oauth/authorize?client_id=${THREADS_APP_ID}&redirect_uri=$(python3 -c "import urllib.parse; print(urllib.parse.quote('${REDIRECT_URI}'))")&scope=${SCOPES}&response_type=code"
echo ""
echo "2단계: 인증 후 리다이렉트된 URL을 복사하세요"
echo "  (https://localhost/?code=XXXXX... 형태)"
echo ""
read -p "리다이렉트된 전체 URL을 붙여넣으세요: " REDIRECT_URL

# code 파라미터 추출
CODE=$(echo "$REDIRECT_URL" | python3 -c "
import sys, urllib.parse
url = sys.stdin.read().strip()
parsed = urllib.parse.urlparse(url)
params = urllib.parse.parse_qs(parsed.query)
code = params.get('code', [''])[0]
# Threads adds #_ at the end sometimes
code = code.rstrip('#_').rstrip('#')
print(code)
")

if [ -z "$CODE" ]; then
    echo "ERROR: code를 추출할 수 없습니다."
    exit 1
fi
echo ""
echo "코드 추출 완료: ${CODE:0:20}..."

# 3단계: code → 단기 토큰 교환
echo ""
echo "3단계: 단기 토큰 교환 중..."
SHORT_RESPONSE=$(curl -s -X POST "https://graph.threads.net/oauth/access_token" \
    -d "client_id=${THREADS_APP_ID}" \
    -d "client_secret=${THREADS_APP_SECRET}" \
    -d "grant_type=authorization_code" \
    -d "redirect_uri=${REDIRECT_URI}" \
    -d "code=${CODE}")

SHORT_TOKEN=$(echo "$SHORT_RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('access_token',''))" 2>/dev/null)
USER_ID=$(echo "$SHORT_RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('user_id',''))" 2>/dev/null)

if [ -z "$SHORT_TOKEN" ]; then
    echo "ERROR: 단기 토큰 교환 실패"
    echo "$SHORT_RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$SHORT_RESPONSE"
    exit 1
fi
echo "단기 토큰 발급 성공 (user_id: ${USER_ID})"

# 4단계: 단기 토큰 → 장기 토큰 교환
echo ""
echo "4단계: 장기 토큰(60일) 교환 중..."
LONG_RESPONSE=$(curl -s "https://graph.threads.net/access_token?grant_type=th_exchange_token&client_secret=${THREADS_APP_SECRET}&access_token=${SHORT_TOKEN}")

LONG_TOKEN=$(echo "$LONG_RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('access_token',''))" 2>/dev/null)
EXPIRES_IN=$(echo "$LONG_RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('expires_in',''))" 2>/dev/null)

if [ -z "$LONG_TOKEN" ]; then
    echo "ERROR: 장기 토큰 교환 실패"
    echo "$LONG_RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$LONG_RESPONSE"
    exit 1
fi

EXPIRES_DAYS=$((EXPIRES_IN / 86400))
echo "장기 토큰 발급 성공! (유효기간: ${EXPIRES_DAYS}일)"

# 5단계: .env 업데이트
echo ""
echo "5단계: .env 업데이트 중..."
sed -i "s|^THREADS_ACCESS_TOKEN=.*|THREADS_ACCESS_TOKEN=${LONG_TOKEN}|" /home/ubuntu/nanoclaw/.env
if [ -n "$USER_ID" ]; then
    sed -i "s|^THREADS_USER_ID=.*|THREADS_USER_ID=${USER_ID}|" /home/ubuntu/nanoclaw/.env
fi

# 6단계: API 테스트
echo ""
echo "6단계: API 테스트..."
TEST=$(curl -s "https://graph.threads.net/v1.0/${USER_ID}/threads?fields=text,timestamp&limit=1&access_token=${LONG_TOKEN}")
if echo "$TEST" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'data' in d" 2>/dev/null; then
    echo "API 테스트 성공!"
else
    echo "API 테스트 실패:"
    echo "$TEST" | python3 -m json.tool 2>/dev/null || echo "$TEST"
fi

# 7단계: 서비스 재시작
echo ""
echo "7단계: 서비스 재시작..."
sudo systemctl restart nanoclaw
sleep 2
if sudo systemctl is-active --quiet nanoclaw; then
    echo "서비스 재시작 완료!"
else
    echo "ERROR: 서비스 재시작 실패"
    sudo systemctl status nanoclaw --no-pager | head -10
fi

echo ""
echo "============================================"
echo "  완료! 장기 토큰 (${EXPIRES_DAYS}일 유효)"
echo "  만료 예정: $(date -d "+${EXPIRES_DAYS} days" '+%Y-%m-%d')"
echo "============================================"
