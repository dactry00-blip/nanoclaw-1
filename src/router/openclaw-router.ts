/**
 * OpenClaw-inspired 14-dimension Router for NanoClaw
 * Based on: https://github.com/iblai/iblai-openclaw-router
 *
 * Strategy: 2-tier (Option B)
 * - Score < 0.2 → LIGHT (Copilot)
 * - Score >= 0.2 → HEAVY (Claude with delegation tool)
 */

import type { RouterWeights, RoutingResult } from './types.js';

const DEFAULT_WEIGHTS: RouterWeights = {
  tokenCount: 0.08,
  codePresence: 0.14,
  reasoningMarkers: 0.18,
  technicalTerms: 0.10,
  creativeMarkers: 0.08,
  simpleIndicators: -0.06, // Negative weight
  multiStepPatterns: 0.12,
  questionComplexity: 0.09,
  imperativeVerbs: 0.05,
  constraints: 0.04,
  outputFormat: 0.03,
  domainSpecificity: 0.07,
  agenticTasks: 0.11,
  relayIndicators: 0.05
};

export class OpenClawRouter {
  private weights: RouterWeights;
  private threshold: number;

  constructor(weights: RouterWeights = DEFAULT_WEIGHTS, threshold = 0.2) {
    this.weights = weights;
    this.threshold = threshold;
  }

  /**
   * Main routing function
   */
  route(prompt: string, systemPrompt?: string, history?: string[]): RoutingResult {
    const context = this.extractContext(prompt, systemPrompt, history);
    const breakdown = this.calculateDimensions(context);
    const score = this.aggregateScore(breakdown);
    const tier = score < this.threshold ? 'LIGHT' : 'HEAVY';
    const model = tier === 'LIGHT' ? 'copilot' : 'claude';

    return {
      tier,
      model,
      score,
      breakdown,
      timestamp: Date.now()
    };
  }

  /**
   * Extract context from system prompt + last 3 messages
   */
  private extractContext(
    prompt: string,
    systemPrompt?: string,
    history?: string[]
  ): string {
    const parts = [prompt];

    if (systemPrompt) {
      parts.unshift(systemPrompt);
    }

    if (history && history.length > 0) {
      const recent = history.slice(-3);
      parts.push(...recent);
    }

    return parts.join('\n').toLowerCase();
  }

  /**
   * Calculate all 14 dimensions
   */
  private calculateDimensions(context: string): Record<string, number> {
    return {
      tokenCount: this.evalTokenCount(context),
      codePresence: this.evalCodePresence(context),
      reasoningMarkers: this.evalReasoningMarkers(context),
      technicalTerms: this.evalTechnicalTerms(context),
      creativeMarkers: this.evalCreativeMarkers(context),
      simpleIndicators: this.evalSimpleIndicators(context),
      multiStepPatterns: this.evalMultiStepPatterns(context),
      questionComplexity: this.evalQuestionComplexity(context),
      imperativeVerbs: this.evalImperativeVerbs(context),
      constraints: this.evalConstraints(context),
      outputFormat: this.evalOutputFormat(context),
      domainSpecificity: this.evalDomainSpecificity(context),
      agenticTasks: this.evalAgenticTasks(context),
      relayIndicators: this.evalRelayIndicators(context)
    };
  }

  /**
   * Dimension 1: Token Count
   */
  private evalTokenCount(text: string): number {
    const approxTokens = text.length / 4;
    if (approxTokens < 50) return 0;
    if (approxTokens < 200) return 0.3;
    if (approxTokens < 500) return 0.6;
    return 1.0;
  }

  /**
   * Dimension 2: Code Presence
   */
  private evalCodePresence(text: string): number {
    const patterns = [
      /```/g,
      /function\s+\w+/g,
      /class\s+\w+/g,
      /import\s+/g,
      /export\s+/g,
      /const\s+\w+\s*=/g,
      /let\s+\w+\s*=/g,
      /def\s+\w+/g,
      /public\s+\w+/g,
      /private\s+\w+/g
    ];

    let score = 0;
    for (const pattern of patterns) {
      const matches = text.match(pattern);
      if (matches) {
        score += matches.length * 0.15;
      }
    }

    return Math.min(1.0, score);
  }

  /**
   * Dimension 3: Reasoning Markers
   */
  private evalReasoningMarkers(text: string): number {
    const markers = [
      '왜', '이유', '분석', '비교', '평가', '판단', '추론', '고려',
      'why', 'reason', 'analyze', 'compare', 'evaluate', 'consider'
    ];

    let count = 0;
    for (const marker of markers) {
      if (text.includes(marker)) count++;
    }

    return Math.min(1.0, count * 0.12);
  }

  /**
   * Dimension 4: Technical Terms
   */
  private evalTechnicalTerms(text: string): number {
    const terms = [
      'api', 'database', 'db', 'server', 'endpoint', 'authentication', 'auth',
      'algorithm', 'async', 'await', 'promise', 'callback', 'container', 'docker',
      'kubernetes', 'k8s', 'microservice', 'rest', 'graphql', 'sql', 'query',
      'cache', 'redis', 'mongodb', 'postgres', 'mysql', 'framework', 'library'
    ];

    let count = 0;
    for (const term of terms) {
      if (text.includes(term)) count++;
    }

    return Math.min(1.0, count * 0.08);
  }

  /**
   * Dimension 5: Creative Markers
   */
  private evalCreativeMarkers(text: string): number {
    const markers = [
      '창의적', '아이디어', '브레인스토밍', '디자인', '기획',
      'creative', 'brainstorm', 'design', 'innovative', 'ideate'
    ];

    let count = 0;
    for (const marker of markers) {
      if (text.includes(marker)) count++;
    }

    return Math.min(1.0, count * 0.18);
  }

  /**
   * Dimension 6: Simple Indicators (negative weight)
   */
  private evalSimpleIndicators(text: string): number {
    const indicators = [
      '날씨', '시간', '뉴스', '검색', '번역', '계산',
      'weather', 'time', 'news', 'search', 'translate', 'calculate'
    ];

    let count = 0;
    for (const indicator of indicators) {
      if (text.includes(indicator)) count++;
    }

    return Math.min(1.0, count * 0.22);
  }

  /**
   * Dimension 7: Multi-Step Patterns
   */
  private evalMultiStepPatterns(text: string): number {
    const patterns = [
      '그리고', '다음', '이후', '먼저', '그 다음', '그런 다음',
      'then', 'next', 'after', 'first', 'second', 'finally', 'subsequently'
    ];

    let count = 0;
    for (const pattern of patterns) {
      if (text.includes(pattern)) count++;
    }

    return Math.min(1.0, count * 0.18);
  }

  /**
   * Dimension 8: Question Complexity
   */
  private evalQuestionComplexity(text: string): number {
    const simplePattern = /^(what|when|where|who)\s/i;
    const complexPattern = /(how|why|explain|describe|analyze)/i;

    if (simplePattern.test(text)) return 0.15;
    if (complexPattern.test(text)) return 0.75;

    const questionCount = (text.match(/\?/g) || []).length;
    return Math.min(1.0, questionCount * 0.25);
  }

  /**
   * Dimension 9: Imperative Verbs
   */
  private evalImperativeVerbs(text: string): number {
    const verbs = [
      '만들어', '생성', '작성', '구현', '수정', '리팩토링', '최적화', '개선',
      'create', 'build', 'implement', 'refactor', 'optimize', 'improve', 'develop'
    ];

    let count = 0;
    for (const verb of verbs) {
      if (text.includes(verb)) count++;
    }

    return Math.min(1.0, count * 0.14);
  }

  /**
   * Dimension 10: Constraints
   */
  private evalConstraints(text: string): number {
    const constraints = [
      '반드시', '꼭', '필수', '제약', '조건', '요구사항',
      'must', 'required', 'constraint', 'condition', 'requirement'
    ];

    let count = 0;
    for (const constraint of constraints) {
      if (text.includes(constraint)) count++;
    }

    return Math.min(1.0, count * 0.22);
  }

  /**
   * Dimension 11: Output Format
   */
  private evalOutputFormat(text: string): number {
    const formats = [
      'json', 'markdown', 'md', 'table', '표', '목록', 'list',
      'format', 'structure', 'template'
    ];

    let count = 0;
    for (const format of formats) {
      if (text.includes(format)) count++;
    }

    return Math.min(1.0, count * 0.18);
  }

  /**
   * Dimension 12: Domain Specificity
   */
  private evalDomainSpecificity(text: string): number {
    const domains = [
      'machine learning', 'ml', 'ai', 'blockchain', 'quantum',
      'cybersecurity', 'devops', 'frontend', 'backend', 'fullstack'
    ];

    let count = 0;
    for (const domain of domains) {
      if (text.includes(domain)) count++;
    }

    return Math.min(1.0, count * 0.28);
  }

  /**
   * Dimension 13: Agentic Tasks
   */
  private evalAgenticTasks(text: string): number {
    const agentic = [
      '스웜', '에이전트', '팀', '협력', '나눠서', '병렬', '분산',
      'swarm', 'agent', 'team', 'collaborate', 'parallel', 'distribute'
    ];

    let count = 0;
    for (const keyword of agentic) {
      if (text.includes(keyword)) count++;
    }

    return Math.min(1.0, count * 0.25);
  }

  /**
   * Dimension 14: Relay Indicators
   */
  private evalRelayIndicators(text: string): number {
    const relay = [
      '위임', '전달', '넘겨', '맡겨', '대신',
      'delegate', 'forward', 'relay', 'pass', 'hand off'
    ];

    let count = 0;
    for (const indicator of relay) {
      if (text.includes(indicator)) count++;
    }

    return Math.min(1.0, count * 0.22);
  }

  /**
   * Aggregate weighted score
   */
  private aggregateScore(breakdown: Record<string, number>): number {
    let total = 0;

    for (const [dimension, value] of Object.entries(breakdown)) {
      const weight = this.weights[dimension as keyof RouterWeights];
      total += value * weight;
    }

    return Math.max(0, total);
  }

  /**
   * Update weights (for tuning)
   */
  updateWeights(newWeights: Partial<RouterWeights>): void {
    this.weights = { ...this.weights, ...newWeights };
  }

  /**
   * Update threshold
   */
  updateThreshold(threshold: number): void {
    this.threshold = threshold;
  }
}
