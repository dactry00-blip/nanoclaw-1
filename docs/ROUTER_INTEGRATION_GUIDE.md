# Router 통합 가이드

## 개요

OpenClaw 14차원 Router를 나노클로 호스트에 통합하는 가이드입니다.

**전략:** 2-tier (Option B)
- Score < 0.2 → LIGHT (Copilot) — 컨테이너 없이 호스트에서 직접 처리
- Score >= 0.2 → HEAVY (Claude 컨테이너) — 기존 Docker 기반 에이전트

**라우팅 분기 위치:** `src/index.ts`의 `runAgent()` — 컨테이너 스폰 전에 판단

---

## 라우팅 플로우

```
사용자 메시지 (Slack/Discord)
       │
       ▼
  processGroupMessages()          ← src/index.ts
  트리거 패턴 확인, 메시지 포맷팅
       │
       ▼
  runAgent(group, prompt, ...)    ← src/index.ts
       │
       ▼
  routeMessage(prompt, config)    ← src/router.service.ts (NEW)
  14차원 가중치 점수 산출
       │
       ├── score < 0.2 (LIGHT)
       │      │
       │      ▼
       │   callCopilotAPI(prompt)
       │      │
       │      ├── 성공 → onOutput 콜백으로 결과 전달 → Slack/Discord 전송
       │      └── 실패 → Claude fallback (HEAVY 경로로)
       │
       └── score >= 0.2 (HEAVY)
              │
              ▼
         runContainerAgent(...)    ← src/container-runner.ts (기존 로직 그대로)
         Docker 컨테이너 스폰
         Claude Agent SDK 실행
```

---

## 1️⃣ 사전 준비

### Copilot API 설정

```bash
# 1. GitHub Copilot Pro 구독 ($10/월)
# https://github.com/features/copilot/plans

# 2. copilot-api 설치
npm install -g copilot-api

# 3. 인증
copilot-api auth login-github-copilot
# → GitHub 기기 로그인 URL 방문, 코드 입력

# 4. 프록시 서버 시작 (백그라운드)
copilot-api start --port 8080 &
# → http://localhost:8080
```

### 환경 변수 추가

`.env` 파일에 추가:

```bash
# Copilot API
COPILOT_API_URL=http://localhost:8080
COPILOT_MODEL=gpt-5-mini
```

---

## 2️⃣ 라우터 파일 이동

`router/` 디렉토리의 파일을 `src/router/`로 이동합니다.
(`tsconfig.json`의 `rootDir`이 `./src`이므로, `src/` 밖의 파일은 import 불가)

```bash
mkdir -p src/router
cp router/openclaw-router.ts src/router/
cp router/types.ts src/router/
```

`router/config.json`과 `router/test.ts`는 그대로 유지합니다 (런타임에 `fs`로 읽기).

---

## 3️⃣ 호스트 코드 통합

### Step 1: `src/router.service.ts` 생성 (새 파일)

Router 로직을 별도 서비스 파일로 분리합니다.

```typescript
/**
 * Router Service for NanoClaw
 * Routes messages to Copilot (LIGHT) or Claude container (HEAVY)
 */
import fs from 'fs';
import path from 'path';

import { OpenClawRouter } from './router/openclaw-router.js';
import type { RouterConfig, RoutingResult } from './router/types.js';
import { logger } from './logger.js';

/**
 * Load router configuration from router/config.json
 */
export function loadRouterConfig(): RouterConfig {
  const configPath = path.join(process.cwd(), 'router', 'config.json');

  if (!fs.existsSync(configPath)) {
    return {
      enabled: true,
      strategy: 'hybrid',
      thresholds: { light: 0.2 },
      weights: {
        tokenCount: 0.08,
        codePresence: 0.14,
        reasoningMarkers: 0.18,
        technicalTerms: 0.10,
        creativeMarkers: 0.08,
        simpleIndicators: -0.06,
        multiStepPatterns: 0.12,
        questionComplexity: 0.09,
        imperativeVerbs: 0.05,
        constraints: 0.04,
        outputFormat: 0.03,
        domainSpecificity: 0.07,
        agenticTasks: 0.11,
        relayIndicators: 0.05,
      },
      monitoring: {
        logRouting: true,
        logBreakdown: true,
        metricsPath: './logs/routing-metrics.jsonl',
      },
    };
  }

  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

/**
 * Route message using OpenClaw Router
 */
export function routeMessage(prompt: string, config: RouterConfig): RoutingResult {
  if (!config.enabled || config.strategy === 'claude-only') {
    return {
      tier: 'HEAVY',
      model: 'claude',
      score: 1.0,
      breakdown: {},
      timestamp: Date.now(),
    };
  }

  const router = new OpenClawRouter(config.weights, config.thresholds.light);
  const result = router.route(prompt);

  if (config.monitoring.logRouting) {
    logRoutingDecision(prompt, result, config);
  }

  return result;
}

/**
 * Log routing decision to metrics file
 */
function logRoutingDecision(
  prompt: string,
  result: RoutingResult,
  config: RouterConfig,
): void {
  if (!config.monitoring.metricsPath) return;

  const logDir = path.dirname(config.monitoring.metricsPath);
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  const logEntry = {
    timestamp: new Date(result.timestamp).toISOString(),
    prompt: prompt.slice(0, 100),
    tier: result.tier,
    model: result.model,
    score: result.score,
    breakdown: config.monitoring.logBreakdown ? result.breakdown : undefined,
  };

  fs.appendFileSync(
    config.monitoring.metricsPath,
    JSON.stringify(logEntry) + '\n',
  );
}

/**
 * Call Copilot API (OpenAI-compatible endpoint)
 */
export async function callCopilotAPI(prompt: string): Promise<string> {
  const baseUrl = process.env.COPILOT_API_URL || 'http://localhost:8080';
  const model = process.env.COPILOT_MODEL || 'gpt-5-mini';

  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      max_tokens: 2000,
    }),
  });

  if (!response.ok) {
    throw new Error(`Copilot API error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
  };
  return data.choices[0].message.content;
}
```

### Step 2: `src/index.ts`의 `runAgent()` 수정

`container-runner.ts`는 수정하지 않습니다. 라우팅 분기는 `runAgent()`에서 합니다.

```typescript
// 파일 상단에 import 추가
import { loadRouterConfig, routeMessage, callCopilotAPI } from './router.service.js';
```

`runAgent()` 함수를 수정:

```typescript
async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.folder === MAIN_GROUP_FOLDER;
  const sessionId = sessions[group.folder];

  // ── Router 판단 ──────────────────────────────────────────
  const routerConfig = loadRouterConfig();
  const routingResult = routeMessage(prompt, routerConfig);

  logger.info(
    {
      group: group.name,
      tier: routingResult.tier,
      score: routingResult.score.toFixed(3),
      model: routingResult.model,
    },
    'Router decision',
  );

  // ── LIGHT: Copilot으로 처리 (컨테이너 없음) ──────────────
  if (routingResult.tier === 'LIGHT') {
    try {
      const response = await callCopilotAPI(prompt);

      // onOutput 콜백으로 결과 전달 (Slack/Discord 전송)
      if (onOutput) {
        await onOutput({
          status: 'success',
          result: response,
        });
      }

      return 'success';
    } catch (err) {
      logger.warn(
        { group: group.name, err },
        'Copilot failed, falling back to Claude',
      );
      // Fallback: 아래 HEAVY 경로로 계속 진행
    }
  }

  // ── HEAVY: Claude 컨테이너 (기존 로직 그대로) ─────────────

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    // ... 기존 코드 그대로 ...
  );

  // ... 기존 writeGroupsSnapshot, wrappedOnOutput, runContainerAgent 코드 그대로 ...
}
```

**핵심 변경점:**
- LIGHT 경로는 `onOutput` 콜백을 직접 호출하여 결과를 전달 → 호출자(`processGroupMessages`)가 Slack/Discord에 전송
- 컨테이너 스폰, IPC, 마운트 등은 일절 건드리지 않음
- Copilot 실패 시 자연스럽게 HEAVY 경로로 fallback

### Step 3: 스케줄 태스크는 항상 HEAVY

`src/task-scheduler.ts`의 `runTask()`는 수정 불요. 스케줄 태스크는 에이전트 도구(파일 읽기, IPC 등)가 필요하므로 항상 Claude 컨테이너를 사용합니다.

라우팅 분기가 `src/index.ts`의 `runAgent()`에만 있으므로, `task-scheduler.ts`가 직접 `runContainerAgent()`를 호출하는 기존 경로는 영향받지 않습니다.

---

## 4️⃣ Delegation Tool 추가 (Optional)

HEAVY 케이스에서 Claude가 Copilot에게 단순 하위 작업을 위임하는 MCP 도구.

### 컨테이너 내부: `container/agent-runner/src/ipc-mcp-stdio.ts`에 추가

```typescript
server.tool(
  'delegate_to_cheap_model',
  `단순 작업을 GPT-5 mini에게 위임합니다.

사용 시점:
- 정보 검색만 필요
- 웹 검색 후 간단 요약
- 단순 계산, 번역
- 파일 내용 요약

사용하지 말아야 할 시점:
- 복잡한 추론 필요
- 멀티스텝 작업
- 코드 리팩토링
- 에이전트 조율`,
  {
    subtask: z.string().describe('GPT-5 mini에게 위임할 작업'),
    reason: z.string().optional().describe('위임 사유 (디버깅용)'),
  },
  async (args) => {
    // IPC를 통해 호스트에 delegation 요청
    const data = {
      type: 'delegate',
      subtask: args.subtask,
      reason: args.reason || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    // 호스트가 결과를 IPC로 돌려줄 때까지 polling
    const resultFile = path.join(IPC_DIR, 'delegation_result.json');
    const maxWait = 30000; // 30초 타임아웃
    const start = Date.now();

    while (Date.now() - start < maxWait) {
      if (fs.existsSync(resultFile)) {
        const result = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
        fs.unlinkSync(resultFile);
        return {
          content: [{ type: 'text' as const, text: result.response }],
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    return {
      content: [{ type: 'text' as const, text: 'Delegation timed out.' }],
      isError: true,
    };
  },
);
```

### 호스트: `src/ipc.ts`에 delegation 핸들러 추가

IPC watcher의 tasks 처리 부분에 `delegate` 타입 추가:

```typescript
case 'delegate':
  if (data.subtask) {
    try {
      const { callCopilotAPI } = await import('./router.service.js');
      const response = await callCopilotAPI(data.subtask);

      // 결과를 IPC 파일로 컨테이너에 반환
      const resultFile = path.join(
        DATA_DIR, 'ipc', sourceGroup, 'delegation_result.json'
      );
      fs.writeFileSync(resultFile, JSON.stringify({ response }));

      logger.info(
        { sourceGroup, subtask: data.subtask.slice(0, 50) },
        'Delegation completed via Copilot',
      );
    } catch (err) {
      logger.error({ sourceGroup, err }, 'Delegation failed');
      const resultFile = path.join(
        DATA_DIR, 'ipc', sourceGroup, 'delegation_result.json'
      );
      fs.writeFileSync(resultFile, JSON.stringify({
        response: `Delegation failed: ${err instanceof Error ? err.message : String(err)}`,
      }));
    }
  }
  break;
```

---

## 5️⃣ 빌드 & 테스트

### Router 단독 테스트

```bash
npx tsx router/test.ts
```

### 빌드

```bash
npm run build
```

### Copilot API 연결 테스트

```bash
# 프록시 서버 상태 확인
curl http://localhost:8080/v1/models

# 직접 호출 테스트
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5-mini","messages":[{"role":"user","content":"Hello"}]}'
```

---

## 6️⃣ 나노클로 재시작

```bash
npm run build && sudo systemctl restart nanoclaw
```

---

## 7️⃣ 동작 확인

### Slack/Discord에서 테스트

**LIGHT 테스트:**
```
@폴 오늘 날씨
```
→ 로그: `Router decision tier=LIGHT score=0.085 model=copilot`
→ 컨테이너 스폰 없이 즉시 응답

**HEAVY 테스트:**
```
@폴 코드 리팩토링해줘
```
→ 로그: `Router decision tier=HEAVY score=0.421 model=claude`
→ Docker 컨테이너 스폰 → Claude Agent SDK 실행

### 메트릭 확인

```bash
tail -f logs/routing-metrics.jsonl
```

---

## 8️⃣ 튜닝

### 임계값 조정

`router/config.json` 수정:

```json
{
  "thresholds": {
    "light": 0.15
  }
}
```

0.15로 낮추면 더 많은 요청이 Copilot으로 라우팅됩니다.

### 가중치 조정

코드 작업이 많은 환경이라면:

```json
{
  "weights": {
    "codePresence": 0.20,
    "technicalTerms": 0.15
  }
}
```

---

## 9️⃣ 트러블슈팅

### Copilot API 연결 실패

```bash
# 프록시 서버 상태 확인
curl http://localhost:8080/v1/models

# 재시작
pkill -f copilot-api
copilot-api start --port 8080 &
```

### Router 비활성화 (긴급)

`router/config.json`:

```json
{
  "enabled": false
}
```

또는

```json
{
  "strategy": "claude-only"
}
```

→ 모든 요청이 Claude 컨테이너로 라우팅 (기존 동작과 동일)

---

## 변경 파일 요약

| 파일 | 변경 유형 | 설명 |
|------|-----------|------|
| `src/router/openclaw-router.ts` | 이동 | `router/` → `src/router/` |
| `src/router/types.ts` | 이동 | `router/` → `src/router/` |
| `src/router.service.ts` | 신규 | Router 서비스 (설정 로드, 라우팅, Copilot API) |
| `src/index.ts` | 수정 | `runAgent()`에 라우팅 분기 추가 |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | 수정 | Delegation Tool 추가 (Optional) |
| `src/ipc.ts` | 수정 | Delegation IPC 핸들러 추가 (Optional) |
| `router/config.json` | 수정 | `metricsPath`를 호스트 경로로 변경 |
| `.env` | 수정 | `COPILOT_API_URL`, `COPILOT_MODEL` 추가 |
