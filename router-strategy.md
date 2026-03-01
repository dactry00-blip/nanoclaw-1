# LLM Router Strategy for NanoClaw

## 구현 계획

### Phase 1: Heuristic Router (Week 1)
**목표:** 빠른 성과, 50% 비용 절감

**구현:**
```typescript
function calculateComplexity(prompt: string): number {
  let score = 0;

  // 길이 기반
  if (prompt.length > 200) score += 20;
  if (prompt.length > 500) score += 30;

  // 멀티스텝 감지
  const multiStepKeywords = ['그리고', '다음', '이후', '먼저', '그 다음'];
  score += multiStepKeywords.filter(k => prompt.includes(k)).length * 15;

  // 코드 관련
  if (/```|function|class|import|export/.test(prompt)) score += 30;
  if (/리팩토링|디버깅|최적화/.test(prompt)) score += 40;

  // 파일 작업
  const filePatterns = /\.(ts|js|py|java|go|rs)/;
  if (filePatterns.test(prompt)) score += 20;

  // 에이전트 스웜
  if (/스웜|팀|협력|나눠서|병렬/.test(prompt)) score += 50;

  // 추론 필요
  const reasoningKeywords = ['왜', '이유', '분석', '비교', '평가', '추천'];
  score += reasoningKeywords.filter(k => prompt.includes(k)).length * 10;

  // 단순 작업 (음수 점수)
  if (/날씨|뉴스|검색|번역|시간/.test(prompt)) score -= 20;

  return Math.max(0, score);
}

function routeMessage(prompt: string) {
  const score = calculateComplexity(prompt);

  // 임계값
  const SIMPLE_THRESHOLD = 30;
  const COMPLEX_THRESHOLD = 60;

  if (score < SIMPLE_THRESHOLD) {
    return { model: 'copilot', reason: 'simple', score };
  }

  if (score < COMPLEX_THRESHOLD) {
    return { model: 'claude', reason: 'medium', score };
  }

  return { model: 'claude', reason: 'complex', score };
}
```

**메트릭 수집:**
```typescript
interface RoutingLog {
  timestamp: string;
  prompt: string;
  score: number;
  routed_to: 'copilot' | 'claude';
  response_time_ms: number;
  cost_usd: number;
  user_satisfaction?: 1 | 2 | 3 | 4 | 5;
}

// /workspace/project/logs/routing.jsonl에 저장
```

---

### Phase 2: AI Classifier (Week 2-3)
**목표:** 정확도 90%+, 애매한 케이스 해결

**구현:**
```typescript
async function classifyWithAI(prompt: string): Promise<'simple' | 'complex'> {
  const response = await copilotAPI.chat({
    model: 'gpt-5-mini',
    messages: [
      {
        role: 'system',
        content: `You are a task complexity classifier for an AI assistant routing system.

SIMPLE tasks (route to GPT-5 mini):
- Information lookup (weather, news, time, definitions)
- Web search and summarization
- Translation
- Simple calculations
- Single file read/write
- Straightforward Q&A

COMPLEX tasks (route to Claude Code):
- Multi-step reasoning or planning
- Code refactoring or debugging
- Multi-file modifications
- Agent coordination or swarm tasks
- Strategic analysis or recommendations
- Tasks requiring tool orchestration

Respond with ONLY one word: "simple" or "complex"`
      },
      {
        role: 'user',
        content: `Classify: "${prompt}"`
      }
    ],
    temperature: 0,
    max_tokens: 10
  });

  const result = response.trim().toLowerCase();
  return result === 'simple' ? 'simple' : 'complex';
}

async function routeMessageV2(prompt: string) {
  // 1차: 휴리스틱 (빠른 필터)
  const heuristicScore = calculateComplexity(prompt);

  if (heuristicScore < 20) {
    // 명확히 단순
    return { model: 'copilot', method: 'heuristic-fast', score: heuristicScore };
  }

  if (heuristicScore > 80) {
    // 명확히 복잡
    return { model: 'claude', method: 'heuristic-fast', score: heuristicScore };
  }

  // 2차: AI 분류 (애매한 경우만)
  const aiClass = await classifyWithAI(prompt);
  return {
    model: aiClass === 'simple' ? 'copilot' : 'claude',
    method: 'ai-classifier',
    score: heuristicScore,
    ai_decision: aiClass
  };
}
```

**예상 성능:**
- 80% 요청 → 휴리스틱만 (< 1ms, 무료)
- 20% 요청 → AI 분류 추가 (50-100ms, $0.0001)

---

### Phase 3: Fine-tuned Model (Week 4+)
**목표:** 초고속, 도메인 특화

**데이터 수집:**
```bash
# routing.jsonl에서 학습 데이터 생성
cat /workspace/project/logs/routing.jsonl | \
  jq -r '[.prompt, .routed_to] | @csv' > training_data.csv
```

**Fine-tuning:**
```typescript
// OpenAI Fine-tuning API 사용
const trainingFile = await openai.files.create({
  file: fs.createReadStream('training_data.jsonl'),
  purpose: 'fine-tune'
});

const fineTune = await openai.fineTuning.jobs.create({
  training_file: trainingFile.id,
  model: 'gpt-5-mini',
  suffix: 'nanoclaw-router-v1'
});

// 이후 사용
const result = await openai.chat.completions.create({
  model: 'ft:gpt-5-mini:nanoclaw-router-v1',
  messages: [{ role: 'user', content: prompt }],
  max_tokens: 5
});
```

---

## 성능 목표

| Metric | Phase 1 | Phase 2 | Phase 3 |
|--------|---------|---------|---------|
| 정확도 | 70-80% | 90%+ | 95%+ |
| 응답속도 | < 1ms | < 50ms | < 1ms |
| 비용/요청 | $0 | $0.0001 | $0 |
| 비용절감 | 50% | 70% | 80% |

---

## 테스트 케이스

```typescript
const testCases = [
  // SIMPLE
  { prompt: "오늘 서울 날씨", expected: "copilot" },
  { prompt: "최신 뉴스 검색", expected: "copilot" },
  { prompt: "Hello를 한국어로 번역", expected: "copilot" },
  { prompt: "10 + 20은?", expected: "copilot" },

  // COMPLEX
  { prompt: "코드 리팩토링하고 테스트 작성", expected: "claude" },
  { prompt: "멀티 에이전트 스웜으로 프로젝트 분석", expected: "claude" },
  { prompt: "버그 원인 분석 후 수정 방안 제시", expected: "claude" },
  { prompt: "API 설계 후 구현까지 완료", expected: "claude" },

  // EDGE CASES (AI classifier 필요)
  { prompt: "날씨 API 만들어줘", expected: "claude" },
  { prompt: "뉴스 분석 리포트", expected: "claude" },
  { prompt: "간단한 계산기 함수", expected: "copilot" }
];
```

---

## 모니터링

```typescript
// Prometheus metrics
router_requests_total{model="copilot"} 8234
router_requests_total{model="claude"} 2156
router_accuracy_score 0.87
router_cost_savings_percent 73.2
```

---

## 구현 우선순위

1. ✅ Phase 1 휴리스틱 (1주) → 즉시 50% 절감
2. ✅ 메트릭 수집 인프라
3. ✅ Phase 2 AI 분류기 (2주) → 정확도 향상
4. ⏳ Phase 3 Fine-tuning (4주+) → 최적화
