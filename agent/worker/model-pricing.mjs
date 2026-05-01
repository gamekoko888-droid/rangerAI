/**
 * model-pricing.mjs — RangerAI 模型定价模块 v1.1
 *
 * v1.1 (2026-04-10): 补全缺失模型定价，修复成本统计不准确问题
 *
 * 功能：
 * 1. 维护各 AI 模型的 input/output token 单价（$/1M tokens）
 * 2. 计算单次请求的美元成本
 * 3. 为 "unknown" 模型提供默认定价（使用 Gateway 默认模型的价格）
 *
 * 定价数据来源：OpenClaw Gateway openclaw.json providers 配置
 * 单位：美元 per 1M tokens
 */

// ─── 模型定价表（$/1M tokens）───────────────────────────────
const MODEL_PRICING = {
  // OpenAI
  "openai/gpt-5.5":        { input: 5.00,  output: 30.00 },
  "openai/gpt-5.4":        { input: 2.50,  output: 10.00 },
  "openai/gpt-5.2":        { input: 1.00,  output: 4.00  },
  "openai/gpt-4.1":        { input: 2.00,  output: 8.00  },
  "openai/gpt-4.1-mini":   { input: 0.40,  output: 1.60  },
  "openai/o4-mini":         { input: 1.10,  output: 4.40  },
  "openai/gpt-5-mini":     { input: 0.40,  output: 1.60  },
  "openai/gpt-5.4-mini":   { input: 0.75,  output: 4.50  },
  "openai/gpt-5.4-2026-03-05": { input: 2.50, output: 10.00 },

  // Anthropic
  "anthropic/claude-sonnet-4.6":       { input: 3.00, output: 15.00 },
  "anthropic/claude-sonnet-4-6":       { input: 3.00, output: 15.00 },
  "anthropic/claude-sonnet-4-20250514": { input: 3.00, output: 15.00 },
  "anthropic/claude-3-haiku-20240307": { input: 0.80, output: 4.00  },
  "claude-sonnet-4-20250514":          { input: 3.00, output: 15.00 },

  // DeepSeek (2026-04-28 官方定价, v4-pro 当前 75% 折扣至 2026/05/31)
  "deepseek/deepseek-v4-pro":   { input: 0.435, output: 0.87  },
  "deepseek/deepseek-v4-flash": { input: 0.14,  output: 0.28  },
  "deepseek/deepseek-chat":     { input: 0.14,  output: 0.28  },  // deprecated → v4-flash

  // Google — v1.1: 补全缺失模型
  "google/gemini-3.1-pro-preview": { input: 1.25, output: 10.00 },
  "google/gemini-2.5-pro":         { input: 1.25, output: 10.00 },
  "google/gemini-3.1-pro":         { input: 1.25, output: 10.00 },
  "google/gemini-3-flash-preview": { input: 0.15, output: 0.60  },
  "google/gemini-2.5-flash":       { input: 0.15, output: 0.60  },
  "google/gemini-3.1-flash-image-preview": { input: 0.15, output: 0.60 },
  "google/gemini-3-flash-preview-image":   { input: 0.15, output: 0.60 },
  "gemini-2.5-flash":              { input: 0.15, output: 0.60  },
  "gemini-3-flash-preview":        { input: 0.15, output: 0.60  },
};

// Gateway 默认模型（agents.defaults.model.primary）
const DEFAULT_MODEL = "deepseek/deepseek-v4-pro"; // R82: was anthropic/claude-sonnet-4-6 (not in gateway config)
const DEFAULT_PRICING = MODEL_PRICING[DEFAULT_MODEL] || { input: 3.00, output: 15.00 };

/**
 * 获取模型定价
 * @param {string} model - 模型 ID
 * @returns {{ input: number, output: number }} - $/1M tokens
 */
export function getModelPricing(model) {
  if (!model || model === "unknown") {
    return DEFAULT_PRICING;
  }
  if (MODEL_PRICING[model]) return MODEL_PRICING[model];
  
  // Try without provider prefix (e.g., "gemini-2.5-flash" from "google/gemini-2.5-flash")
  const shortName = model.includes('/') ? model.split('/').pop() : model;
  if (MODEL_PRICING[shortName]) return MODEL_PRICING[shortName];
  
  return DEFAULT_PRICING;
}

/**
 * 计算单次请求的美元成本
 * @param {string} model - 模型 ID
 * @param {number} promptTokens - 输入 token 数
 * @param {number} completionTokens - 输出 token 数
 * @returns {number} - 美元成本（精确到 8 位小数）
 */
export function calculateCostUsd(model, promptTokens, completionTokens) {
  const pricing = getModelPricing(model);
  const inputCost = (promptTokens / 1_000_000) * pricing.input;
  const outputCost = (completionTokens / 1_000_000) * pricing.output;
  return parseFloat((inputCost + outputCost).toFixed(8));
}

/**
 * 获取所有模型定价表
 */
export function getAllPricing() {
  return { ...MODEL_PRICING };
}

/**
 * 获取默认模型名称
 */
export function getDefaultModel() {
  return DEFAULT_MODEL;
}
