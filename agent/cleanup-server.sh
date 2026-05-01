#!/bin/bash
# Backup first
cp /opt/rangerai-agent/server.mjs /opt/rangerai-agent/server.mjs.bak-v69

# Create a Python script to do the cleanup
cat > /tmp/cleanup_server.py << 'PYEOF'
import re

with open("/opt/rangerai-agent/server.mjs", "r") as f:
    content = f.read()

lines = content.split("\n")
result = []
skip_until_close = 0
in_block_delete = False
block_delete_indent = 0

i = 0
while i < len(lines):
    line = lines[i]
    stripped = line.strip()
    
    # Skip taskMemory import block (lines ~29-38)
    if "let taskMemory;" in line:
        # Skip until the closing of the try/catch block
        brace_count = 0
        started = False
        while i < len(lines):
            if "{" in lines[i]: brace_count += lines[i].count("{"); started = True
            if "}" in lines[i]: brace_count -= lines[i].count("}")
            i += 1
            if started and brace_count <= 0:
                # Also skip the catch block
                while i < len(lines) and lines[i].strip():
                    if "{" in lines[i]: brace_count += lines[i].count("{")
                    if "}" in lines[i]: brace_count -= lines[i].count("}")
                    i += 1
                    if brace_count <= 0:
                        break
                break
        # Add stub
        result.append("// [v70] taskMemory removed — handled by OpenClaw Gateway")
        result.append("const taskMemory = { storeSummary() { return false; }, getRelevantSummaries() { return \"\"; }, ready: false };")
        continue
    
    # Skip experienceCompressor import block
    if "let experienceCompressor;" in line:
        brace_count = 0
        started = False
        while i < len(lines):
            if "{" in lines[i]: brace_count += lines[i].count("{"); started = True
            if "}" in lines[i]: brace_count -= lines[i].count("}")
            i += 1
            if started and brace_count <= 0:
                while i < len(lines) and lines[i].strip():
                    if "{" in lines[i]: brace_count += lines[i].count("{")
                    if "}" in lines[i]: brace_count -= lines[i].count("}")
                    i += 1
                    if brace_count <= 0:
                        break
                break
        result.append("// [v70] experienceCompressor removed — handled by OpenClaw Gateway")
        result.append("const experienceCompressor = { compressExperience() { return null; } };")
        continue
    
    # Skip vectorMemory import block
    if "let vectorMemory;" in line:
        brace_count = 0
        started = False
        while i < len(lines):
            if "{" in lines[i]: brace_count += lines[i].count("{"); started = True
            if "}" in lines[i]: brace_count -= lines[i].count("}")
            i += 1
            if started and brace_count <= 0:
                while i < len(lines) and lines[i].strip():
                    if "{" in lines[i]: brace_count += lines[i].count("{")
                    if "}" in lines[i]: brace_count -= lines[i].count("}")
                    i += 1
                    if brace_count <= 0:
                        break
                break
        result.append("// [v70] vectorMemory removed — handled by OpenClaw Gateway")
        result.append("const vectorMemory = { ready: false, storeMidterm() {}, storeLongterm() { return null; }, searchLongterm() { return []; }, getMemoryContext() { return \"\"; }, getStats() { return {}; } };")
        continue
    
    # Skip orchestrator import block
    if "let orchestrator;" in line:
        brace_count = 0
        started = False
        while i < len(lines):
            if "{" in lines[i]: brace_count += lines[i].count("{"); started = True
            if "}" in lines[i]: brace_count -= lines[i].count("}")
            i += 1
            if started and brace_count <= 0:
                while i < len(lines) and lines[i].strip():
                    if "{" in lines[i]: brace_count += lines[i].count("{")
                    if "}" in lines[i]: brace_count -= lines[i].count("}")
                    i += 1
                    if brace_count <= 0:
                        break
                break
        result.append("// [v70] orchestrator removed — handled by OpenClaw Gateway")
        result.append("const orchestrator = { shouldOrchestrate() { return { needsOrchestration: false }; }, orchestrate() { return { enrichedContext: \"\" }; } };")
        continue
    
    # Skip moduleRegistry import block
    if "let moduleRegistry;" in line:
        brace_count = 0
        started = False
        while i < len(lines):
            if "{" in lines[i]: brace_count += lines[i].count("{"); started = True
            if "}" in lines[i]: brace_count -= lines[i].count("}")
            i += 1
            if started and brace_count <= 0:
                while i < len(lines) and lines[i].strip():
                    if "{" in lines[i]: brace_count += lines[i].count("{")
                    if "}" in lines[i]: brace_count -= lines[i].count("}")
                    i += 1
                    if brace_count <= 0:
                        break
                break
        result.append("// [v70] moduleRegistry removed — handled by OpenClaw Gateway")
        result.append("const moduleRegistry = { get() { return { ready: false }; }, has() { return false; }, healthCheck() { return { totalModules: 0, modules: {} }; } };")
        continue
    
    result.append(line)
    i += 1

output = "\n".join(result)
with open("/opt/rangerai-agent/server.mjs", "w") as f:
    f.write(output)

print(f"Cleaned server.mjs: {len(lines)} -> {len(result)} lines")
PYEOF

python3 /tmp/cleanup_server.py
