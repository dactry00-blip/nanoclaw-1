/**
 * Test cases for OpenClaw Router
 */

import { OpenClawRouter } from './openclaw-router.js';

const router = new OpenClawRouter();

interface TestCase {
  prompt: string;
  expectedTier: 'LIGHT' | 'HEAVY';
  description: string;
}

const testCases: TestCase[] = [
  // LIGHT cases (Score < 0.2)
  {
    prompt: "오늘 서울 날씨",
    expectedTier: "LIGHT",
    description: "Simple weather query"
  },
  {
    prompt: "최신 뉴스 검색",
    expectedTier: "LIGHT",
    description: "Simple news search"
  },
  {
    prompt: "Hello를 한국어로 번역",
    expectedTier: "LIGHT",
    description: "Simple translation"
  },
  {
    prompt: "10 + 20은?",
    expectedTier: "LIGHT",
    description: "Simple calculation"
  },
  {
    prompt: "현재 시간",
    expectedTier: "LIGHT",
    description: "Time query"
  },

  // HEAVY cases (Score >= 0.2)
  {
    prompt: "코드 리팩토링하고 테스트 작성해줘",
    expectedTier: "HEAVY",
    description: "Code refactoring + testing"
  },
  {
    prompt: "멀티 에이전트 스웜으로 프로젝트 분석",
    expectedTier: "HEAVY",
    description: "Agent swarm task"
  },
  {
    prompt: "버그 원인 분석 후 수정 방안 제시",
    expectedTier: "HEAVY",
    description: "Analysis + solution"
  },
  {
    prompt: "API 설계하고 구현까지 완료",
    expectedTier: "HEAVY",
    description: "Multi-step API development"
  },
  {
    prompt: "복잡한 알고리즘 분석하고 최적화해줘",
    expectedTier: "HEAVY",
    description: "Algorithm analysis + optimization"
  },

  // Edge cases
  {
    prompt: "날씨 API 만들어줘",
    expectedTier: "HEAVY",
    description: "Weather API development (not simple weather query)"
  },
  {
    prompt: "뉴스 분석 리포트 작성",
    expectedTier: "HEAVY",
    description: "News analysis (not simple search)"
  },
  {
    prompt: "간단한 계산기 함수",
    expectedTier: "LIGHT",
    description: "Simple function creation"
  }
];

console.log('='.repeat(80));
console.log('OpenClaw Router Test Suite');
console.log('='.repeat(80));
console.log();

let passed = 0;
let failed = 0;

for (const testCase of testCases) {
  const result = router.route(testCase.prompt);
  const isPass = result.tier === testCase.expectedTier;

  if (isPass) {
    passed++;
    console.log(`✅ PASS: ${testCase.description}`);
  } else {
    failed++;
    console.log(`❌ FAIL: ${testCase.description}`);
    console.log(`   Expected: ${testCase.expectedTier}, Got: ${result.tier} (Score: ${result.score.toFixed(3)})`);
  }

  console.log(`   Prompt: "${testCase.prompt}"`);
  console.log(`   Score: ${result.score.toFixed(3)} → ${result.tier} (${result.model})`);
  console.log(`   Top factors:`);

  // Show top 3 contributing dimensions
  const sorted = Object.entries(result.breakdown)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3);

  for (const [dim, val] of sorted) {
    if (val > 0.1) {
      console.log(`     - ${dim}: ${val.toFixed(2)}`);
    }
  }

  console.log();
}

console.log('='.repeat(80));
console.log(`Results: ${passed} passed, ${failed} failed (${testCases.length} total)`);
console.log('='.repeat(80));

if (failed > 0) {
  console.log('\n⚠️  Some tests failed. Consider tuning weights or threshold.');
  process.exit(1);
} else {
  console.log('\n✅ All tests passed!');
  process.exit(0);
}
