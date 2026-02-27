/**
 * Router Service — loads config, routes messages, calls Copilot API
 */

import fs from 'fs';
import path from 'path';
import { OpenClawRouter } from './router/openclaw-router.js';
import type { RouterConfig, RoutingResult } from './router/types.js';
import { logger } from './logger.js';

const CONFIG_PATH = path.resolve(process.cwd(), 'router/config.json');
const DEFAULT_CONFIG: RouterConfig = {
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

/**
 * Load router config from router/config.json, falling back to defaults.
 */
export function loadRouterConfig(): RouterConfig {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    return JSON.parse(raw) as RouterConfig;
  } catch {
    logger.warn('Router config not found, using defaults');
    return DEFAULT_CONFIG;
  }
}

/**
 * Route a message through the 14-dimension OpenClaw router.
 */
export function routeMessage(prompt: string, config: RouterConfig): RoutingResult {
  const router = new OpenClawRouter(config.weights, config.thresholds.light);
  const result = router.route(prompt);

  // Log routing decision
  if (config.monitoring.logRouting) {
    logger.info(
      { tier: result.tier, score: result.score.toFixed(3), model: result.model },
      'Router decision',
    );
  }
  if (config.monitoring.logBreakdown) {
    logger.debug({ breakdown: result.breakdown }, 'Router breakdown');
  }

  // Append metric to JSONL file
  try {
    const metricsPath = path.resolve(process.cwd(), config.monitoring.metricsPath);
    const metric = {
      timestamp: new Date().toISOString(),
      prompt: prompt.slice(0, 200),
      tier: result.tier,
      model: result.model,
      score: result.score,
      breakdown: config.monitoring.logBreakdown ? result.breakdown : undefined,
    };
    fs.appendFileSync(metricsPath, JSON.stringify(metric) + '\n');
  } catch {
    // Non-fatal: metrics logging failure should not break routing
  }

  return result;
}

/**
 * Call the Copilot API (OpenAI-compatible /v1/chat/completions endpoint).
 * Returns the assistant's response text on success, or throws on failure.
 */
export async function callCopilotAPI(prompt: string): Promise<string> {
  const baseUrl = process.env.COPILOT_API_URL;
  const model = process.env.COPILOT_MODEL || 'gpt-4o-mini';
  const apiKey = process.env.COPILOT_API_KEY;

  if (!baseUrl) {
    throw new Error('COPILOT_API_URL not configured');
  }

  const url = `${baseUrl.replace(/\/+$/, '')}/v1/chat/completions`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 4096,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Copilot API error ${res.status}: ${body}`);
  }

  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = json.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('Copilot API returned empty response');
  }

  return content;
}
