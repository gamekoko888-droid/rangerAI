// image-generator.mjs — R105: delegates to Gateway openai-image-gen skill (gen.py)
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';

const execFileP = promisify(execFile);
const GEN = '/opt/openclaw/skills/openai-image-gen/scripts/gen.py';
const DIR = '/opt/rangerai-agent/files/';

export async function handleGenerateImage(args = {}) {
  const { prompt, size = '1024x1024' } = args;
  if (!prompt?.trim()) return { phase: 'failed', error: 'prompt required' };
  fs.mkdirSync(DIR, { recursive: true });
  try {
    await execFileP('python3', [GEN, '--prompt', prompt.trim(), '--count', '1',
      '--size', size, '--out-dir', DIR], { timeout: 180000 });
    const m = JSON.parse(fs.readFileSync(path.join(DIR, 'prompts.json'), 'utf-8'));
    const fn = m?.[0]?.file;
    if (!fn) return { phase: 'failed', error: 'No output file' };
    return { phase: 'done', url: `https://ranger.voyage/files/${fn}`,
      model: 'gpt-image-1', prompt, servedUrl: `https://ranger.voyage/files/${fn}`, filename: fn };
  } catch (e) { return { phase: 'failed', error: e.message }; }
}
