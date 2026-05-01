/**
 * data-analysis/run.mjs — Skill execution entry point
 * 
 * Accepts structured input and returns analysis results.
 * This is a lightweight wrapper that generates a Python analysis script
 * and executes it in the sandbox.
 */

import { execSync } from 'child_process';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';

/**
 * @param {Object} input
 * @param {string} input.dataPath - Path to data file (CSV/Excel/JSON)
 * @param {string} input.task - Analysis task description
 * @param {string} [input.outputDir] - Output directory for charts/reports
 * @returns {Object} { success, summary, files }
 */
export async function run(input) {
  const { dataPath, task, outputDir = '/tmp/analysis-output' } = input;
  
  if (!dataPath || !existsSync(dataPath)) {
    return { success: false, error: `Data file not found: ${dataPath}` };
  }
  
  // Generate Python analysis script based on task
  const scriptPath = '/tmp/skill-data-analysis.py';
  const script = `
import pandas as pd
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import os, json, sys

matplotlib.rcParams["font.sans-serif"] = ["SimHei", "DejaVu Sans"]
matplotlib.rcParams["axes.unicode_minus"] = False

data_path = "${dataPath}"
output_dir = "${outputDir}"
os.makedirs(output_dir, exist_ok=True)

# Load data
ext = os.path.splitext(data_path)[1].lower()
if ext == '.csv':
    df = pd.read_csv(data_path)
elif ext in ('.xlsx', '.xls'):
    df = pd.read_excel(data_path)
elif ext == '.json':
    df = pd.read_json(data_path)
else:
    print(json.dumps({"success": False, "error": f"Unsupported format: {ext}"}))
    sys.exit(0)

# Basic analysis
summary = {
    "shape": list(df.shape),
    "columns": list(df.columns),
    "dtypes": {str(k): str(v) for k, v in df.dtypes.items()},
    "missing": {str(k): int(v) for k, v in df.isnull().sum().items() if v > 0},
    "describe": df.describe().to_dict(),
}

# Save summary
summary_path = os.path.join(output_dir, "summary.json")
with open(summary_path, 'w', encoding='utf-8') as f:
    json.dump(summary, f, ensure_ascii=False, indent=2, default=str)

files = [summary_path]

# Auto-generate chart for numeric columns
numeric_cols = df.select_dtypes(include='number').columns[:5]
if len(numeric_cols) > 0:
    fig, ax = plt.subplots(figsize=(10, 6))
    df[numeric_cols].plot(kind='bar' if len(df) <= 20 else 'line', ax=ax)
    plt.title("Data Overview")
    plt.tight_layout()
    chart_path = os.path.join(output_dir, "overview_chart.png")
    plt.savefig(chart_path, dpi=150)
    files.append(chart_path)
    plt.close()

print(json.dumps({"success": True, "summary": summary, "files": files}, default=str))
`;
  
  writeFileSync(scriptPath, script);
  
  try {
    const result = execSync(`python3 ${scriptPath}`, {
      timeout: 60000,
      encoding: 'utf-8',
    });
    return JSON.parse(result.trim());
  } catch (err) {
    return { success: false, error: err.message };
  }
}
