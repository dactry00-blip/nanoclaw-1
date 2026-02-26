/**
 * Type definitions for NanoClaw Router
 * Based on OpenClaw iBlai 14-dimension router
 */

export interface RouterWeights {
  tokenCount: number;
  codePresence: number;
  reasoningMarkers: number;
  technicalTerms: number;
  creativeMarkers: number;
  simpleIndicators: number;
  multiStepPatterns: number;
  questionComplexity: number;
  imperativeVerbs: number;
  constraints: number;
  outputFormat: number;
  domainSpecificity: number;
  agenticTasks: number;
  relayIndicators: number;
}

export interface RouterConfig {
  enabled: boolean;
  strategy: 'hybrid' | 'claude-only' | 'openclaw-only';
  thresholds: {
    light: number; // < light = LIGHT (Copilot)
                  // >= light = HEAVY (Claude)
  };
  weights: RouterWeights;
  monitoring: {
    logRouting: boolean;
    logBreakdown: boolean;
    metricsPath: string;
  };
}

export interface RoutingResult {
  tier: 'LIGHT' | 'HEAVY';
  model: 'copilot' | 'claude';
  score: number;
  breakdown: Record<string, number>;
  timestamp: number;
}

export interface RoutingMetric {
  timestamp: string;
  prompt: string;
  tier: 'LIGHT' | 'HEAVY';
  model: 'copilot' | 'claude';
  score: number;
  breakdown?: Record<string, number>;
  cost?: number;
  latency?: number;
}
