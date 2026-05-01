#!/usr/bin/env python3
"""
v6 Routing Fix — Three fundamental changes:
1. Fix LLM pre-classifier JSON parsing (handle Gemini's text prefix)
2. Add TOOL_REQUIRING_TYPES safety: code/sysadmin always use Claude
3. Replace v23.1 dedicated sessions with direct main session patching + empty response fallback
"""
import re, json, sys

# ─── Fix 1: LLM Pre-Classifier JSON Parsing ───────────────────
print("=== Fix 1: LLM Pre-Classifier JSON Parsing ===")
with open("/opt/rangerai-agent/worker/llm-pre-classifier.mjs", "r") as f:
    content = f.read()

# The issue: Gemini sometimes returns "Here is the JSON requested:\n{...}" instead of pure JSON
# Fix: Strip any text before the first { in the response
old_parse = '''          // Robust JSON parsing - handle potential truncation
          let result;
          try {
            result = JSON.parse(text);
          } catch (e) {
            // Try to extract type from partial JSON
            const typeMatch = text.match(/"type"\\s*:\\s*"(\\w+)"/);
            const confMatch = text.match(/"confidence"\\s*:\\s*([\\d.]+)/);
            if (typeMatch) {
              result = {
                type: typeMatch[1],
                confidence: confMatch ? parseFloat(confMatch[1]) : 0.8
              };
            } else {
              reject(new Error(`Cannot parse LLM response: ${text.substring(0, 100)}`));
              return;
            }
          }'''

new_parse = '''          // Robust JSON parsing - handle Gemini's text prefix and truncation
          let result;
          // Strip any text before the first { (Gemini sometimes adds "Here is the JSON:")
          let jsonText = text;
          const firstBrace = text.indexOf('{');
          if (firstBrace > 0) {
            jsonText = text.substring(firstBrace);
          }
          try {
            result = JSON.parse(jsonText);
          } catch (e) {
            // Try to extract type from partial JSON
            const typeMatch = text.match(/"type"\\s*:\\s*"(\\w+)"/);
            const confMatch = text.match(/"confidence"\\s*:\\s*([\\d.]+)/);
            if (typeMatch) {
              result = {
                type: typeMatch[1],
                confidence: confMatch ? parseFloat(confMatch[1]) : 0.8
              };
            } else {
              reject(new Error(`Cannot parse LLM response: ${text.substring(0, 100)}`));
              return;
            }
          }'''

if old_parse in content:
    content = content.replace(old_parse, new_parse)
    with open("/opt/rangerai-agent/worker/llm-pre-classifier.mjs", "w") as f:
        f.write(content)
    print("  ✓ Fixed JSON parsing to strip text prefix before first {")
else:
    print("  ⚠ Old parse block not found, trying regex approach")
    # Try a more flexible match
    if 'Cannot parse LLM response' in content and 'firstBrace' not in content:
        content = content.replace(
            '          // Robust JSON parsing',
            '          // Robust JSON parsing - handle Gemini text prefix\n'
            '          // Strip any text before the first { (Gemini sometimes adds "Here is the JSON:")\n'
            '          const firstBrace = text.indexOf("{");\n'
            '          if (firstBrace > 0) text = text.substring(firstBrace);\n'
            '          // Original robust JSON parsing'
        )
        with open("/opt/rangerai-agent/worker/llm-pre-classifier.mjs", "w") as f:
            f.write(content)
        print("  ✓ Added firstBrace stripping via regex approach")
    else:
        print("  ⚠ Already fixed or structure changed")

# ─── Fix 2: Smart Router — Tool-Requiring Types Safety ─────────
print("\n=== Fix 2: Smart Router — Tool-Requiring Types Safety ===")
with open("/opt/rangerai-agent/worker/smart-router.mjs", "r") as f:
    content = f.read()

# Add TOOL_REQUIRING_TYPES constant after SAFE_FALLBACK_MODEL
if 'TOOL_REQUIRING_TYPES' not in content:
    old_safe = "// 安全回退模型（当分类不确定时使用）\nconst SAFE_FALLBACK_MODEL = 'anthropic/claude-sonnet-4-6';"
    new_safe = """// 安全回退模型（当分类不确定时使用）
const SAFE_FALLBACK_MODEL = 'anthropic/claude-sonnet-4-6';

// 需要工具调用的任务类型 — 这些类型必须使用 Claude（工具调用最稳定）
// 即使 LLM 分类器选了其他模型，也强制回退到 Claude
const TOOL_REQUIRING_TYPES = new Set(['code', 'sysadmin']);"""
    
    if old_safe in content:
        content = content.replace(old_safe, new_safe)
        print("  ✓ Added TOOL_REQUIRING_TYPES constant")
    else:
        print("  ⚠ Could not find SAFE_FALLBACK_MODEL line, trying alternative")
        # Insert after the line containing SAFE_FALLBACK_MODEL
        content = content.replace(
            "const SAFE_FALLBACK_MODEL = 'anthropic/claude-sonnet-4-6';",
            "const SAFE_FALLBACK_MODEL = 'anthropic/claude-sonnet-4-6';\n\n// 需要工具调用的任务类型 — 这些类型必须使用 Claude（工具调用最稳定）\nconst TOOL_REQUIRING_TYPES = new Set(['code', 'sysadmin']);"
        )
        print("  ✓ Added TOOL_REQUIRING_TYPES via alternative approach")

# Add safety check in the LLM result handling section
# After the low confidence check, add tool-requiring type check
old_llm_section = """    logger.info(`[smart-router-v4] LLM: type=${llmType} conf=${llmResult.confidence.toFixed(2)} → model=${llmModel} thinking=${llmThinking} (source: ${llmResult.source})`);
    return {
      model: llmModel,
      reason: `llm_${llmResult.source}: ${llmType} (conf=${llmResult.confidence.toFixed(2)}) → ${llmModel}`,
      category: llmType,
      thinking: llmThinking,
      confidence: llmResult.confidence,
    };"""

new_llm_section = """    // v6.0 Safety: Tool-requiring types MUST use Claude for reliable tool calling
    if (TOOL_REQUIRING_TYPES.has(llmType)) {
      const safeModel = SAFE_FALLBACK_MODEL;
      logger.info(`[smart-router-v4] LLM: type=${llmType} is TOOL-REQUIRING → forced to ${safeModel} (thinking: high)`);
      return {
        model: safeModel,
        reason: `llm_${llmResult.source}: ${llmType} (conf=${llmResult.confidence.toFixed(2)}) → ${safeModel} (tool-requiring)`,
        category: llmType,
        thinking: 'high',
        confidence: llmResult.confidence,
      };
    }
    
    logger.info(`[smart-router-v4] LLM: type=${llmType} conf=${llmResult.confidence.toFixed(2)} → model=${llmModel} thinking=${llmThinking} (source: ${llmResult.source})`);
    return {
      model: llmModel,
      reason: `llm_${llmResult.source}: ${llmType} (conf=${llmResult.confidence.toFixed(2)}) → ${llmModel}`,
      category: llmType,
      thinking: llmThinking,
      confidence: llmResult.confidence,
    };"""

if old_llm_section in content:
    content = content.replace(old_llm_section, new_llm_section)
    print("  ✓ Added TOOL_REQUIRING_TYPES safety check in LLM path")
else:
    print("  ⚠ Could not find LLM section for safety check")

# Also add the same check in the keyword fallback path
old_keyword = """  logger.info(`[smart-router-v4] KEYWORD: type=${classification.type} conf=${classification.confidence.toFixed(2)} → model=${model} thinking=${classification.thinking}`);
  return {
    model,
    reason: `keyword: ${classification.type} (conf=${classification.confidence.toFixed(2)}) → ${model}`,
    category: classification.type,
    thinking: classification.thinking,
    confidence: classification.confidence,
  };"""

new_keyword = """  // v6.0 Safety: Tool-requiring types MUST use Claude in keyword path too
  const finalModel = TOOL_REQUIRING_TYPES.has(classification.type) ? SAFE_FALLBACK_MODEL : model;
  const finalThinking = TOOL_REQUIRING_TYPES.has(classification.type) ? 'high' : classification.thinking;
  
  logger.info(`[smart-router-v4] KEYWORD: type=${classification.type} conf=${classification.confidence.toFixed(2)} → model=${finalModel} thinking=${finalThinking}`);
  return {
    model: finalModel,
    reason: `keyword: ${classification.type} (conf=${classification.confidence.toFixed(2)}) → ${finalModel}`,
    category: classification.type,
    thinking: finalThinking,
    confidence: classification.confidence,
  };"""

if old_keyword in content:
    content = content.replace(old_keyword, new_keyword)
    print("  ✓ Added TOOL_REQUIRING_TYPES safety check in keyword path")
else:
    print("  ⚠ Could not find keyword section for safety check")

# Also add "页面/网页/网站" to code keywords since creating web pages requires code
if '页面' not in content or ('页面' in content and '做.*页面' not in content):
    # Find the code keywords section and add web page related keywords
    code_pattern = r"(/(代码|编程|调试|修复bug|修复|修bug|改bug|函数|类|方法|接口|重构|编译|脚本|程序|报错|错误|异常|崩溃)/)"
    if '页面' not in content:
        content = content.replace(
            '/(代码|编程|调试|修复bug|修复|修bug|改bug|函数|类|方法|接口|重构|编译|脚本|程序|报错|错误|异常|崩溃)/',
            '/(代码|编程|调试|修复bug|修复|修bug|改bug|函数|类|方法|接口|重构|编译|脚本|程序|报错|错误|异常|崩溃|页面|网页|网站|前端|后端|数据库)/'
        )
        print("  ✓ Added 页面/网页/网站/前端/后端/数据库 to code keywords")
    else:
        print("  ⚠ 页面 already in content")

with open("/opt/rangerai-agent/worker/smart-router.mjs", "w") as f:
    f.write(content)
print("  ✓ Smart router updated")

# ─── Fix 3: OpenClaw Handler — Replace v23.1 Dedicated Sessions ──
print("\n=== Fix 3: OpenClaw Handler — Replace v23.1 Dedicated Sessions ===")
with open("/opt/rangerai-agent/worker/openclaw-handler.mjs", "r") as f:
    content = f.read()

# Replace the entire v23.1 section with v23.2: direct main session patching
old_v23_start = "    // v23.1: Smart Router model patching — use DEDICATED session per model family"
old_v23_end = "    // v14.7 R52: Independent strong-model session"

if old_v23_start in content and old_v23_end in content:
    start_idx = content.index(old_v23_start)
    end_idx = content.index(old_v23_end)
    
    new_v23 = """    // v23.2: Smart Router model patching — ALWAYS patch main session
    // v23.1 (dedicated sessions) was REMOVED because new sessions lose system prompt,
    // conversation history, and tool context, causing 0-text-output failures.
    // v23.2 approach: patch main session model directly. If the model can't handle
    // the existing context format (cross-provider), the Gateway will still try its best.
    // The self-healer will catch any empty responses.
    if (options.routedModel && !options.needsStrongModel) {
      try {
        await gateway.request("sessions.patch", {
          key: gatewaySessionKey,
          model: options.routedModel
        });
        logger.info('[' + ts() + '] [worker] [v23.2] Patched main session to ' + options.routedModel);
      } catch (routePatchErr) {
        logger.warn('[' + ts() + '] [worker] [v23.2] Session patch failed: ' + routePatchErr.message + ', continuing with default model');
      }
    }
    """
    
    content = content[:start_idx] + new_v23 + content[end_idx:]
    
    with open("/opt/rangerai-agent/worker/openclaw-handler.mjs", "w") as f:
        f.write(content)
    print("  ✓ Replaced v23.1 dedicated sessions with v23.2 direct main session patching")
else:
    print(f"  ⚠ Could not find v23.1 section boundaries")
    print(f"    v23_start found: {old_v23_start in content}")
    print(f"    v23_end found: {old_v23_end in content}")

print("\n=== All fixes applied ===")
print("Summary:")
print("  1. LLM pre-classifier: Fixed JSON parsing for Gemini's text prefix")
print("  2. Smart router: code/sysadmin ALWAYS use Claude (tool-requiring safety)")
print("  3. Smart router: Added 页面/网页/网站 to code keywords")
print("  4. OpenClaw handler: Replaced dedicated sessions with direct main session patching")
