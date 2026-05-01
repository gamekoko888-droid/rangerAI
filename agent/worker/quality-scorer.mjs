/**
 * quality-scorer.mjs — LLM-based Answer Quality Scoring (R44-T3 + R45-T3)
 * 
 * Replaces heuristic scoring with async LLM evaluation.
 * Runs asynchronously after answer delivery (fire-and-forget).
 * 
 * [R45-T3] Sampling rate: only QUALITY_SCORE_SAMPLE_RATE % of answers are scored.
 * Skipped answers emit 'answer_quality_skipped' event (no LLM call).
 * 
 * Scoring dimensions:
 *   - relevance (0-10): How well the answer addresses the user's question
 *   - completeness (0-10): Whether all aspects of the question are covered
 *   - accuracy (0-10): Factual correctness and precision
 *   - clarity (0-10): How clear and well-structured the response is
 *   - overall (0-10): Weighted composite score
 */
import { invokeLLM } from './llm-bridge.mjs';
import { emitEvent, EVENT_TYPES } from './event-stream.mjs';
import { logger } from '../lib/logger.mjs';

// Use a fast, cheap model for scoring to minimize cost
const SCORER_MODEL = 'google/gemini-2.5-flash';
const SCORER_TIMEOUT = 20000;

// [R45-T3] Import sample rate from agent-config
let SAMPLE_RATE = 0.2; // default 20%
try {
  const { QUALITY_SCORE_SAMPLE_RATE } = await import('./agent-config.mjs');
  if (typeof QUALITY_SCORE_SAMPLE_RATE === 'number' && !isNaN(QUALITY_SCORE_SAMPLE_RATE)) {
    SAMPLE_RATE = Math.max(0, Math.min(1, QUALITY_SCORE_SAMPLE_RATE));
  }
} catch (_) { /* use default */ }

logger.info(`[quality-scorer] [R45-T3] Sample rate: ${(SAMPLE_RATE * 100).toFixed(0)}%`);

// [R45-T3] Scoring stats for monitoring
let _scoringStats = { total: 0, scored: 0, skipped: 0 };
export function getScoringStats() { return { ..._scoringStats, sampleRate: SAMPLE_RATE }; }

// Register event types
if (!EVENT_TYPES.ANSWER_QUALITY_SCORED) {
  EVENT_TYPES.ANSWER_QUALITY_SCORED = 'answer_quality_scored';
}
if (!EVENT_TYPES.ANSWER_QUALITY_SKIPPED) {
  EVENT_TYPES.ANSWER_QUALITY_SKIPPED = 'answer_quality_skipped';
}

const SCORING_PROMPT = `You are an AI answer quality evaluator. Score the following answer on these dimensions (0-10 each):
1. **relevance**: How well does the answer address the user's question?
2. **completeness**: Are all aspects of the question covered?
3. **accuracy**: Is the information factually correct and precise?
4. **clarity**: Is the response clear, well-structured, and easy to understand?
Also provide a brief justification (1-2 sentences).
Respond in JSON format:
{
  "relevance": <0-10>,
  "completeness": <0-10>,
  "accuracy": <0-10>,
  "clarity": <0-10>,
  "overall": <0-10>,
  "justification": "<brief explanation>"
}`;

/**
 * Score an answer asynchronously.
 * [R45-T3] Applies sampling rate before LLM call.
 * Fire-and-forget: errors are logged but never thrown.
 */
export async function scoreAnswer({ sessionKey, taskId, userMessage, answer, model }) {
  try {
    _scoringStats.total++;
    
    // Skip scoring for very short answers or empty
    if (!answer || answer.trim().length < 10) {
      logger.info(`[quality-scorer] Skipping scoring for short answer (${answer?.length || 0} chars)`);
      _scoringStats.skipped++;
      return;
    }
    
    // [R45-T3] Sampling: only score SAMPLE_RATE % of answers
    const roll = Math.random();
    if (roll >= SAMPLE_RATE) {
      _scoringStats.skipped++;
      // Emit skipped event (no LLM call)
      emitEvent(sessionKey, taskId, 'answer_quality_skipped', {
        reason: 'sampling',
        sampleRate: SAMPLE_RATE,
        roll: parseFloat(roll.toFixed(4)),
        answeredByModel: model || 'unknown',
        answerLength: answer.length,
      }, model);
      logger.info(`[quality-scorer] [R45-T3] Skipped (sampling: roll=${roll.toFixed(3)} >= rate=${SAMPLE_RATE})`);
      return null;
    }
    
    _scoringStats.scored++;
    logger.info(`[quality-scorer] [R45-T3] Scoring (roll=${roll.toFixed(3)} < rate=${SAMPLE_RATE})`);
    
    // Truncate long messages to save tokens
    const truncatedUser = userMessage?.slice(0, 500) || '(unknown)';
    const truncatedAnswer = answer.slice(0, 2000);
    
    const startTime = Date.now();
    
    const response = await invokeLLM({
      messages: [
        { role: 'system', content: SCORING_PROMPT },
        { role: 'user', content: `## User Question\n${truncatedUser}\n\n## Answer\n${truncatedAnswer}` },
      ],
      model: SCORER_MODEL,
      temperature: 0.1,
      maxTokens: 500,
      responseFormat: { type: 'json_object' },
      timeout: SCORER_TIMEOUT,
    });
    
    const rawContent = response?.choices?.[0]?.message?.content || '';
    let scores;
    try {
      scores = JSON.parse(rawContent);
    } catch (parseErr) {
      logger.warn(`[quality-scorer] JSON parse failed: ${parseErr.message}`);
      return;
    }
    
    const latencyMs = Date.now() - startTime;
    
    // Validate scores
    const dims = ['relevance', 'completeness', 'accuracy', 'clarity', 'overall'];
    for (const dim of dims) {
      if (typeof scores[dim] !== 'number' || scores[dim] < 0 || scores[dim] > 10) {
        logger.warn(`[quality-scorer] Invalid score for ${dim}: ${scores[dim]}`);
        scores[dim] = -1;
      }
    }
    
    // Emit scored event
    const payload = {
      relevance: scores.relevance,
      completeness: scores.completeness,
      accuracy: scores.accuracy,
      clarity: scores.clarity,
      overall: scores.overall,
      justification: scores.justification || '',
      scorerModel: SCORER_MODEL,
      answeredByModel: model || 'unknown',
      latencyMs,
      answerLength: answer.length,
      userMessageLength: userMessage?.length || 0,
      sampleRate: SAMPLE_RATE,
    };
    
    emitEvent(sessionKey, taskId, EVENT_TYPES.ANSWER_QUALITY_SCORED, payload, model);
    
    logger.info(`[quality-scorer] Scored: overall=${scores.overall} relevance=${scores.relevance} completeness=${scores.completeness} accuracy=${scores.accuracy} clarity=${scores.clarity} latency=${latencyMs}ms`);
    
    return payload;
  } catch (err) {
    logger.warn(`[quality-scorer] Scoring failed (non-fatal): ${err.message}`);
    return null;
  }
}

export default { scoreAnswer, getScoringStats };
