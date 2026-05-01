/**
 * skill-tool.mjs — Iter-F: SkillTool Extension System
 * 
 * Unified execution engine for Skills. Each Skill is a directory with:
 *   - SKILL.md (first line = description)
 *   - run.mjs (execution entry: export async function run(input))
 * 
 * Registered as `skill_tool` in the tool registry (tools/index.mjs).
 * Permission level: HIGH (requires approval before execution).
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, basename } from 'path';
import { logger } from '../lib/logger.mjs';
import { recordSkillExecution } from './observability.mjs';


const ts = () => new Date().toISOString();

const SKILLS_DIR = '/opt/rangerai-agent/skills';

// ─── Skill Registry Cache ─────────────────────────────────
let _registry = null;
let _registryLoadedAt = 0;
const CACHE_TTL = 60_000; // 1 minute

/**
 * Load all available Skills from the skills/ directory.
 * Returns an array of { name, description, hasRunner, path }.
 */
export function loadSkillRegistry() {
  const now = Date.now();
  if (_registry && (now - _registryLoadedAt) < CACHE_TTL) {
    return _registry;
  }
  
  if (!existsSync(SKILLS_DIR)) {
    logger.warn(`[${ts()}] [skill-tool] Skills directory not found: ${SKILLS_DIR}`);
    return [];
  }
  
  const entries = readdirSync(SKILLS_DIR);
  const skills = [];
  
  for (const entry of entries) {
    const skillPath = join(SKILLS_DIR, entry);
    if (!statSync(skillPath).isDirectory()) continue;
    
    const skillMd = join(skillPath, 'SKILL.md');
    const runMjs = join(skillPath, 'run.mjs');
    
    if (!existsSync(skillMd)) continue;
    
    // Extract description from first line of SKILL.md (after frontmatter)
    let description = '';
    try {
      const content = readFileSync(skillMd, 'utf-8');
      const lines = content.split('\n');
      
      // Try to extract from frontmatter description field
      let inFrontmatter = false;
      for (const line of lines) {
        if (line.trim() === '---') {
          inFrontmatter = !inFrontmatter;
          continue;
        }
        if (inFrontmatter && line.startsWith('description:')) {
          description = line.replace('description:', '').trim();
          break;
        }
      }
      
      // Fallback: first non-empty, non-frontmatter line
      if (!description) {
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed && trimmed !== '---' && !trimmed.startsWith('#')) {
            description = trimmed.substring(0, 100);
            break;
          }
        }
      }
    } catch (err) {
      description = `Skill: ${entry}`;
    }
    
    skills.push({
      name: entry,
      description,
      hasRunner: existsSync(runMjs),
      path: skillPath,
    });
  }
  
  _registry = skills;
  _registryLoadedAt = now;
  
  logger.info(`[${ts()}] [skill-tool] Registry loaded: ${skills.length} skills (${skills.filter(s => s.hasRunner).length} with runners)`);
  return skills;
}

/**
 * Execute a Skill by name with given input.
 * 
 * @param {string} skillName - Name of the skill (directory name)
 * @param {Object} input - Input parameters for the skill
 * @returns {Object} { success, result?, error? }
 */
export async function executeSkill(skillName, input = {}) {
  const startTime = Date.now();
  
  logger.info(`[${ts()}] [skill-tool] Executing skill: ${skillName}`);
  
  const skillPath = join(SKILLS_DIR, skillName);
  const runMjs = join(skillPath, 'run.mjs');
  
  if (!existsSync(runMjs)) {
    // Skill exists but has no runner → return SKILL.md content as instructions
    const skillMd = join(skillPath, 'SKILL.md');
    if (existsSync(skillMd)) {
      const content = readFileSync(skillMd, 'utf-8');
      return {
        success: true,
        type: 'instructions',
        content,
        message: `Skill "${skillName}" has no automated runner. Follow the instructions in SKILL.md.`,
      };
    }
    recordSkillExecution(skillName, false, 0);
      return { success: false, error: `Skill not found: ${skillName}` };
  }
  
  try {
    // Dynamic import of the skill runner
    const module = await import(runMjs);
    
    if (typeof module.run !== 'function') {
      recordSkillExecution(skillName, false, 0);
      return { success: false, error: `Skill "${skillName}" has no run() export` };
    }
    
    const result = await module.run(input);
    const elapsed = Date.now() - startTime;
    
    logger.info(`[${ts()}] [skill-tool] Skill "${skillName}" completed in ${elapsed}ms`);
    
    return {
      success: true,
      type: 'result',
      result,
      elapsed,
    };
  } catch (err) {
    const elapsed = Date.now() - startTime;
    logger.error(`[${ts()}] [skill-tool] Skill "${skillName}" failed after ${elapsed}ms: ${err.message}`);
    
    return {
      success: false,
      error: err.message,
      elapsed,
    };
  }
}

/**
 * Generate system prompt injection listing available Skills.
 * Appended to the system prompt so the LLM knows what Skills are available.
 * 
 * @returns {string} Markdown-formatted skill list
 */
export function getSkillPromptInjection() {
  const skills = loadSkillRegistry();
  
  if (skills.length === 0) {
    return '';
  }
  
  let prompt = '\n\n## 可用 Skills（通过 skill_tool 调用）\n\n';
  prompt += '| Skill | 描述 | 可自动执行 |\n';
  prompt += '|-------|------|-----------|\n';
  
  for (const skill of skills) {
    const autoExec = skill.hasRunner ? '✅' : '📖 仅指令';
    prompt += `| ${skill.name} | ${skill.description} | ${autoExec} |\n`;
  }
  
  prompt += '\n调用方式：`skill_tool({ name: "skill-name", input: { ... } })`\n';
  
  return prompt;
}

/**
 * Invalidate the registry cache (e.g., after adding new skills).
 */
export function invalidateSkillCache() {
  _registry = null;
  _registryLoadedAt = 0;
}
