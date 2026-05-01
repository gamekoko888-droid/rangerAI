---
name: data-analysis
description: 数据分析与可视化技能。数据处理、统计分析、图表生成、报告撰写。当用户提到数据分析、Excel、CSV、图表、统计、报告、可视化、pandas、matplotlib 等关键词时使用。
---

# 数据分析 (Data Analysis)

## 工具选择

| 任务 | 工具 |
|------|------|
| 结构化数据处理 | Python + pandas |
| 静态可视化 | matplotlib |
| 交互可视化 | plotly |
| Excel 读写 | openpyxl |
| 统计分析 | scipy / statsmodels |

## 标准流程

### 1. 加载与探索
```python
import pandas as pd
df = pd.read_csv("data.csv")
print(f"形状: {df.shape}")
print(df.dtypes)
print(df.describe())
print(df.isnull().sum())
```

### 2. 清洗
```python
df = df.dropna(subset=["关键列"])
df["日期"] = pd.to_datetime(df["日期"])
df = df.drop_duplicates(subset=["唯一标识"])
```

### 3. 可视化
```python
import matplotlib.pyplot as plt
matplotlib.rcParams["font.sans-serif"] = ["SimHei", "DejaVu Sans"]
fig, ax = plt.subplots(figsize=(10, 6))
df.groupby("类别")["金额"].sum().plot(kind="bar", ax=ax)
plt.tight_layout()
plt.savefig("chart.png", dpi=150)
```

### 4. 输出
```python
with pd.ExcelWriter("report.xlsx") as writer:
    summary.to_excel(writer, sheet_name="汇总", index=False)
```

## 回复格式
1. **执行摘要**（3-5 个要点）
2. **关键数据**（表格形式）
3. **可视化图表**
4. **建议/下一步**
