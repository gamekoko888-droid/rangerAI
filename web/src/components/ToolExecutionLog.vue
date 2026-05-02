<!-- web/src/components/ToolExecutionLog.vue — Real-time tool execution display -->
<!-- Q12: Shows tool execution progress in the chat interface -->
<template>
  <div v-if="toolEvents.length > 0" class="tool-execution-log">
    <div class="tool-log-header" @click="expanded = !expanded">
      <span class="tool-log-icon">⚙️</span>
      <span class="tool-log-title">Tool Execution ({{ toolEvents.length }})</span>
      <span class="tool-log-toggle">{{ expanded ? '▼' : '▶' }}</span>
    </div>
    
    <transition name="slide">
      <div v-if="expanded" class="tool-log-body">
        <div
          v-for="event in toolEvents"
          :key="event.toolId || event.timestamp"
          class="tool-event"
          :class="eventClass(event)"
        >
          <div class="tool-event-header">
            <span class="tool-name">{{ formatToolName(event.toolName) }}</span>
            <span class="tool-status" :class="statusClass(event)">
              {{ statusText(event) }}
            </span>
            <span v-if="event.durationMs" class="tool-duration">
              {{ event.durationMs }}ms
            </span>
          </div>
          
          <!-- Progress bar for in-progress tools -->
          <div v-if="event.type === 'tool:progress'" class="tool-progress">
            <div class="progress-bar" :style="{ width: (event.progress || 0) + '%' }"></div>
            <span class="progress-text">{{ event.message || '' }}</span>
          </div>
          
          <!-- Result preview -->
          <div v-if="event.type === 'tool:result' && event.result" class="tool-result-preview">
            <pre>{{ formatResult(event.result) }}</pre>
          </div>
          
          <!-- Error display -->
          <div v-if="event.type === 'tool:error'" class="tool-error">
            <span class="error-icon">❌</span>
            <span>{{ event.error }}</span>
            <span v-if="event.willRetry" class="retry-badge">Will retry</span>
          </div>
        </div>
      </div>
    </transition>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue';

const props = defineProps({
  toolEvents: { type: Array, default: () => [] }
});

const expanded = ref(true);

function formatToolName(name) {
  if (!name) return 'Unknown';
  return name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function eventClass(event) {
  return {
    'event-start': event.type === 'tool:start',
    'event-progress': event.type === 'tool:progress',
    'event-result': event.type === 'tool:result',
    'event-error': event.type === 'tool:error',
    'event-retry': event.type === 'tool:retry',
  };
}

function statusClass(event) {
  if (event.type === 'tool:result') return 'status-success';
  if (event.type === 'tool:error') return 'status-error';
  if (event.type === 'tool:retry') return 'status-retry';
  return 'status-running';
}

function statusText(event) {
  switch (event.type) {
    case 'tool:start': return '⏳ Running';
    case 'tool:progress': return `${event.progress || 0}%`;
    case 'tool:result': return '✅ Done';
    case 'tool:error': return '❌ Failed';
    case 'tool:retry': return `🔄 Retry ${event.attempt}/${event.maxAttempts}`;
    default: return '';
  }
}

function formatResult(result) {
  if (typeof result === 'string') return result.slice(0, 200);
  try {
    return JSON.stringify(result, null, 2).slice(0, 200);
  } catch {
    return String(result).slice(0, 200);
  }
}
</script>

<style scoped>
.tool-execution-log {
  margin: 8px 0;
  border: 1px solid var(--border-color, #e2e8f0);
  border-radius: 8px;
  overflow: hidden;
  font-size: 13px;
}
.tool-log-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--bg-secondary, #f8fafc);
  cursor: pointer;
  user-select: none;
}
.tool-log-title { font-weight: 600; flex: 1; }
.tool-log-body { padding: 8px 12px; }
.tool-event {
  padding: 6px 0;
  border-bottom: 1px solid var(--border-color, #e2e8f0);
}
.tool-event:last-child { border-bottom: none; }
.tool-event-header {
  display: flex;
  align-items: center;
  gap: 8px;
}
.tool-name { font-weight: 500; }
.tool-duration { color: var(--text-muted, #94a3b8); font-size: 12px; }
.status-success { color: #22c55e; }
.status-error { color: #ef4444; }
.status-retry { color: #f59e0b; }
.status-running { color: #3b82f6; }
.tool-progress {
  margin-top: 4px;
  background: var(--bg-secondary, #f1f5f9);
  border-radius: 4px;
  overflow: hidden;
  position: relative;
  height: 20px;
}
.progress-bar {
  height: 100%;
  background: #3b82f6;
  transition: width 0.3s ease;
}
.progress-text {
  position: absolute;
  top: 2px;
  left: 8px;
  font-size: 11px;
}
.tool-result-preview pre {
  margin: 4px 0;
  padding: 6px;
  background: var(--bg-secondary, #f1f5f9);
  border-radius: 4px;
  font-size: 11px;
  overflow-x: auto;
  max-height: 80px;
}
.tool-error {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
  color: #ef4444;
  font-size: 12px;
}
.retry-badge {
  background: #fef3c7;
  color: #92400e;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 11px;
}
.slide-enter-active, .slide-leave-active {
  transition: all 0.2s ease;
}
.slide-enter-from, .slide-leave-to {
  opacity: 0;
  max-height: 0;
}
</style>
