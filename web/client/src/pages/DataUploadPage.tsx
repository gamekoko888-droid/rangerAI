/**
 * DataUploadPage.tsx — 零配置 AI 数据摄食页面
 * 上传任意文件，AI自动识别并注入对应模块
 */
import { useState, useRef, useCallback } from "react";
import { getAuthToken } from "../lib/api";

interface IngestionResult {
  table: string;
  reason: string;
  inserted: number;
  skipped: number;
  errors: string[];
}

interface UploadResult {
  success: boolean;
  filename?: string;
  aiAnalysis?: {
    dataType: string;
    confidence: number;
    summary: string;
    warnings: string[];
  };
  results?: IngestionResult[];
  totalRows?: number;
  totalInserted?: number;
  mappedTables?: string[];
  elapsedMs?: number;
  error?: string;
}

interface HistoryItem {
  id: number;
  filename: string;
  file_type: string;
  uploaded_by: string;
  row_count: number;
  mapped_tables: string;
  status: string;
  created_at: string;
}

const TABLE_LABELS: Record<string, string> = {
  kol_weekly_stats: "KOL周绩效",
  inventory_items: "库存数据",
  daily_metrics: "日度指标",
  kols: "KOL基础信息",
  tickets: "工单数据",
  knowledge_docs: "知识文档",
};

const TABLE_MODULES: Record<string, string> = {
  kol_weekly_stats: "→ KOL绩效对比模块",
  inventory_items: "→ 库存监控模块",
  daily_metrics: "→ CEO看板 / 数据分析",
  kols: "→ KOL管理列表",
  tickets: "→ 工单系统",
  knowledge_docs: "→ 知识库（AI可检索）",
};

export default function DataUploadPage() {
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch("/api/data/upload/history", {
        headers: { Authorization: `Bearer ${getAuthToken()}` },
      });
      const d = await res.json();
      if (d.success) setHistory(d.data);
    } catch {}
  }, []);

  const handleFile = async (file: File) => {
    if (!file) return;
    setUploading(true);
    setResult(null);

    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await fetch("/api/data/upload", {
        method: "POST",
        headers: { Authorization: `Bearer ${getAuthToken()}` },
        body: formData,
      });
      const data: UploadResult = await res.json();
      setResult(data);
      if (data.success) loadHistory();
    } catch (e: any) {
      setResult({ success: false, error: e.message });
    } finally {
      setUploading(false);
    }
  };

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, []);

  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
    e.target.value = "";
  };

  const confidenceColor = (c: number) =>
    c >= 80 ? "#22c55e" : c >= 60 ? "#f59e0b" : "#ef4444";

  return (
    <div style={{ maxWidth: 800, margin: "0 auto", padding: "24px 16px" }}>
      {/* 标题 */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 22, fontWeight: 700, color: "#f1f5f9" }}>
          ⚡ AI 数据摄食中心
        </div>
        <div style={{ fontSize: 13, color: "#94a3b8", marginTop: 4 }}>
          上传任意文件，AI 自动识别数据类型并注入对应模块，无需手动配置
        </div>
      </div>

      {/* 上传区域 */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => !uploading && fileInputRef.current?.click()}
        style={{
          border: `2px dashed ${dragging ? "#6366f1" : "#334155"}`,
          borderRadius: 12,
          padding: "40px 24px",
          textAlign: "center",
          cursor: uploading ? "not-allowed" : "pointer",
          background: dragging ? "rgba(99,102,241,0.08)" : "rgba(15,23,42,0.6)",
          transition: "all 0.2s",
          marginBottom: 20,
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".xlsx,.xls,.csv,.pdf,.doc,.docx,.txt,.md"
          onChange={onInputChange}
          style={{ display: "none" }}
        />
        {uploading ? (
          <div>
            <div style={{ fontSize: 32, marginBottom: 8 }}>🔄</div>
            <div style={{ color: "#94a3b8", fontSize: 14 }}>AI 正在分析文件...</div>
            <div style={{ color: "#64748b", fontSize: 12, marginTop: 4 }}>通常需要 3-8 秒</div>
          </div>
        ) : (
          <div>
            <div style={{ fontSize: 36, marginBottom: 8 }}>📂</div>
            <div style={{ color: "#e2e8f0", fontSize: 15, fontWeight: 500 }}>
              拖拽文件到这里，或点击选择
            </div>
            <div style={{ color: "#64748b", fontSize: 12, marginTop: 6 }}>
              支持 Excel / CSV / PDF / Word / 文本文档
            </div>
            <div style={{ color: "#475569", fontSize: 11, marginTop: 4 }}>
              无需定义格式，AI 自动识别内容并写入对应模块
            </div>
          </div>
        )}
      </div>

      {/* 摄食结果 */}
      {result && (
        <div style={{
          background: result.success ? "rgba(15,23,42,0.8)" : "rgba(127,29,29,0.3)",
          border: `1px solid ${result.success ? "#1e3a5f" : "#7f1d1d"}`,
          borderRadius: 10,
          padding: 20,
          marginBottom: 20,
        }}>
          {result.success ? (
            <>
              {/* 成功头部 */}
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
                <span style={{ fontSize: 20 }}>✅</span>
                <div>
                  <div style={{ color: "#f1f5f9", fontWeight: 600, fontSize: 15 }}>
                    摄食完成：{result.filename}
                  </div>
                  <div style={{ color: "#64748b", fontSize: 12 }}>
                    耗时 {((result.elapsedMs || 0) / 1000).toFixed(1)}s ·
                    共 {result.totalRows} 行 ·
                    写入 {result.totalInserted} 行
                  </div>
                </div>
              </div>

              {/* AI分析结果 */}
              {result.aiAnalysis && (
                <div style={{
                  background: "rgba(99,102,241,0.1)",
                  border: "1px solid rgba(99,102,241,0.2)",
                  borderRadius: 8,
                  padding: "12px 14px",
                  marginBottom: 14,
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    <span style={{ fontSize: 13, color: "#818cf8", fontWeight: 600 }}>🤖 AI 分析</span>
                    <span style={{
                      fontSize: 11,
                      padding: "1px 6px",
                      borderRadius: 4,
                      background: "rgba(0,0,0,0.3)",
                      color: confidenceColor(result.aiAnalysis.confidence),
                    }}>
                      置信度 {result.aiAnalysis.confidence}%
                    </span>
                  </div>
                  <div style={{ color: "#e2e8f0", fontSize: 13 }}>{result.aiAnalysis.summary}</div>
                  {result.aiAnalysis.warnings?.length > 0 && (
                    <div style={{ marginTop: 8 }}>
                      {result.aiAnalysis.warnings.map((w, i) => (
                        <div key={i} style={{ color: "#fbbf24", fontSize: 11, marginTop: 2 }}>
                          ⚠️ {w}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* 写入结果 */}
              {result.results?.map((r, i) => (
                <div key={i} style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "8px 12px",
                  background: r.inserted > 0 ? "rgba(34,197,94,0.08)" : "rgba(100,116,139,0.1)",
                  border: `1px solid ${r.inserted > 0 ? "rgba(34,197,94,0.2)" : "rgba(100,116,139,0.15)"}`,
                  borderRadius: 6,
                  marginBottom: 6,
                }}>
                  <div>
                    <span style={{ color: "#f1f5f9", fontWeight: 500, fontSize: 13 }}>
                      {TABLE_LABELS[r.table] || r.table}
                    </span>
                    <span style={{ color: "#475569", fontSize: 11, marginLeft: 6 }}>
                      {TABLE_MODULES[r.table] || ""}
                    </span>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <span style={{ color: "#22c55e", fontSize: 13, fontWeight: 600 }}>
                      +{r.inserted} 行
                    </span>
                    {r.skipped > 0 && (
                      <span style={{ color: "#64748b", fontSize: 11, marginLeft: 6 }}>
                        跳过 {r.skipped}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </>
          ) : (
            <div style={{ color: "#fca5a5" }}>
              ❌ 摄食失败：{result.error}
            </div>
          )}
        </div>
      )}

      {/* 支持的模块说明 */}
      <div style={{
        background: "rgba(15,23,42,0.5)",
        border: "1px solid #1e293b",
        borderRadius: 10,
        padding: 16,
        marginBottom: 20,
      }}>
        <div style={{ color: "#94a3b8", fontSize: 12, fontWeight: 600, marginBottom: 10 }}>
          📋 支持的数据类型（AI 自动判断，无需指定）
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
          {Object.entries(TABLE_LABELS).map(([table, label]) => (
            <div key={table} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ color: "#6366f1", fontSize: 11 }}>▸</span>
              <span style={{ color: "#cbd5e1", fontSize: 12, fontWeight: 500 }}>{label}</span>
              <span style={{ color: "#475569", fontSize: 11 }}>{TABLE_MODULES[table]}</span>
            </div>
          ))}
        </div>
      </div>

      {/* 上传历史 */}
      <div>
        <button
          onClick={() => { setShowHistory(!showHistory); if (!showHistory) loadHistory(); }}
          style={{
            background: "transparent",
            border: "1px solid #334155",
            color: "#94a3b8",
            padding: "6px 14px",
            borderRadius: 6,
            cursor: "pointer",
            fontSize: 13,
          }}
        >
          {showHistory ? "▲ 隐藏" : "▼ 上传历史"}
        </button>

        {showHistory && (
          <div style={{ marginTop: 12 }}>
            {history.length === 0 ? (
              <div style={{ color: "#475569", fontSize: 13, padding: "12px 0" }}>暂无上传记录</div>
            ) : (
              history.map(item => (
                <div key={item.id} style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "8px 12px",
                  borderBottom: "1px solid #1e293b",
                  fontSize: 13,
                }}>
                  <div>
                    <span style={{ color: "#e2e8f0" }}>{item.filename}</span>
                    <span style={{ color: "#475569", fontSize: 11, marginLeft: 8 }}>
                      {item.mapped_tables}
                    </span>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <span style={{ color: "#22c55e", fontSize: 12 }}>
                      {item.row_count} 行
                    </span>
                    <span style={{ color: "#475569", fontSize: 11, marginLeft: 8 }}>
                      {item.created_at?.slice(0, 16).replace("T", " ")}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
