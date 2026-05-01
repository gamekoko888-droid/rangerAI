#!/bin/bash
# Phase 6b: Migrate all components from useChatStore() to direct Zustand store imports
# This script applies precise sed patches to each consumer component on the server.

set -e
cd /opt/rangerai-web/client/src

echo "=== Phase 6b: Direct Store Migration ==="

# ─── 1. MessageList (pure MessageStore) ───────────────────
echo "[1/9] Migrating MessageList..."
sed -i "s|import { useChatStore } from '../../hooks/useChatStore';|import { useMessageStore } from '../../stores/useMessageStore';|" components/chat/MessageList.tsx
sed -i "s|const { state, dispatch } = useChatStore();|const messageStore = useMessageStore();|" components/chat/MessageList.tsx
sed -i "s|const { messages, isStreaming, streamingContent, thinkingContent, activeTools, executionSteps, isLoadingMessages, error, currentRoutingInfo, messageRoutingMap } = state;|const { messages, isStreaming, streamingContent, thinkingContent, activeTools, executionSteps, isLoadingMessages, error, currentRoutingInfo, messageRoutingMap } = messageStore;|" components/chat/MessageList.tsx
# Replace dispatch calls with direct store calls
sed -i "s|dispatch({ type: 'SET_ERROR', error: null })|useMessageStore.getState().setError(null)|g" components/chat/MessageList.tsx

# ─── 2. FilePanel (pure WorkspaceStore) ───────────────────
echo "[2/9] Migrating FilePanel..."
sed -i "s|import { useChatStore } from '../../hooks/useChatStore';|import { useWorkspaceStore } from '../../stores/useWorkspaceStore';|" components/chat/FilePanel.tsx
sed -i "s|const { state, loadWorkspaceFiles, selectFile, toggleFilePanel } = useChatStore();|const workspaceStore = useWorkspaceStore();|" components/chat/FilePanel.tsx
sed -i 's|const {\n\s*workspaceFiles,|// destructured below|' components/chat/FilePanel.tsx
# Replace the multi-line destructuring of state with workspaceStore
python3 -c "
import re
with open('components/chat/FilePanel.tsx', 'r') as f:
    content = f.read()
old = '''  const {
    workspaceFiles,
    selectedFilePath,
    fileContent,
    isFilePanelOpen,
    isLoadingFiles,
    changedFiles,
  } = state;'''
new = '''  const {
    workspaceFiles,
    selectedFilePath,
    fileContent,
    isFilePanelOpen,
    isLoadingFiles,
    changedFiles,
    loadWorkspaceFiles,
    selectFile: selectFileAction,
    toggleFilePanel,
  } = workspaceStore;'''
content = content.replace(old, new)
# Replace selectFile references (avoid conflict with local alias)
content = content.replace('selectFile(', 'selectFileAction(')
content = content.replace('selectFile)', 'selectFileAction)')
content = content.replace('[selectFile]', '[selectFileAction]')
content = content.replace(', selectFile,', ', selectFileAction,')
# But fix the prop name if it's passed as a prop
with open('components/chat/FilePanel.tsx', 'w') as f:
    f.write(content)
"

# ─── 3. TagManager (pure ChatListStore) ───────────────────
echo "[3/9] Migrating TagManager..."
sed -i "s|import { useChatStore } from '../../hooks/useChatStore';|import { useChatListStore } from '../../stores/useChatListStore';|" components/chat/TagManager.tsx
python3 -c "
with open('components/chat/TagManager.tsx', 'r') as f:
    content = f.read()
content = content.replace(
    'const { state, updateChatTags, loadTags } = useChatStore();',
    'const chatListStore = useChatListStore();'
)
content = content.replace('state.chats.find', 'chatListStore.chats.find')
content = content.replace('state.allTags.filter', 'chatListStore.allTags.filter')
content = content.replace('updateChatTags(', 'chatListStore.updateChatTags(')
content = content.replace('loadTags()', 'chatListStore.loadTags()')
content = content.replace('[loadTags]', '[chatListStore.loadTags]')
with open('components/chat/TagManager.tsx', 'w') as f:
    f.write(content)
"

# ─── 4. RecoveryBanner (uses non-existent state — make it a no-op or use ConnectionStore) ───
echo "[4/9] Migrating RecoveryBanner..."
cat > components/chat/RecoveryBanner.tsx << 'RECEOF'
/**
 * RecoveryBanner — Shows a banner when the system is recovering a task after reconnection.
 * Auto-dismisses when recovery completes.
 * 
 * NOTE: isRecovering/recoveryStatus were never part of the actual state.
 * This component now uses useConnectionStore to show reconnection status.
 */
import { useConnectionStore } from '../../stores/useConnectionStore';
import { Loader2, Wifi } from 'lucide-react';

export function RecoveryBanner() {
  const wsReconnecting = useConnectionStore(s => s.wsReconnecting);
  const wsReconnectAttempt = useConnectionStore(s => s.wsReconnectAttempt);

  if (!wsReconnecting) return null;

  return (
    <div className="mx-auto max-w-3xl px-4 py-2">
      <div className="flex items-center gap-2 rounded-lg bg-blue-500/10 border border-blue-500/20 px-3 py-2 text-sm text-blue-400">
        <Wifi size={14} className="shrink-0" />
        <Loader2 size={14} className="animate-spin shrink-0" />
        <span>
          {wsReconnectAttempt > 0
            ? `正在重新连接... (${wsReconnectAttempt})`
            : '正在恢复连接...'}
        </span>
      </div>
    </div>
  );
}
RECEOF

# ─── 5. PromptTemplates (needs useChatActions for cross-store ops) ───
echo "[5/9] Migrating PromptTemplates..."
sed -i "s|import { useChatStore } from '../hooks/useChatStore';|import { useChatActions } from '../hooks/useChatActions';|" pages/PromptTemplates.tsx
sed -i "s|const { createNewChat, sendMessage } = useChatStore();|const { createNewChat, sendMessage } = useChatActions();|" pages/PromptTemplates.tsx

# ─── 6. MessageInput (MessageStore + ConnectionStore + ChatListStore + useChatActions) ───
echo "[6/9] Migrating MessageInput..."
python3 -c "
with open('components/chat/MessageInput.tsx', 'r') as f:
    content = f.read()

# Replace import
content = content.replace(
    \"import { useChatStore } from '../../hooks/useChatStore';\",
    \"\"\"import { useMessageStore } from '../../stores/useMessageStore';
import { useConnectionStore } from '../../stores/useConnectionStore';
import { useChatListStore } from '../../stores/useChatListStore';
import { useChatActions } from '../../hooks/useChatActions';\"\"\"
)

# Replace the useChatStore() call
content = content.replace(
    'const { state, sendMessage, setSelectedModel, setSelectedRole } = useChatStore();',
    '''const { sendMessage } = useChatActions();
  const { isStreaming, suggestions, selectedModel, selectedRole, setSelectedModel, setSelectedRole } = useMessageStore();
  const wsConnected = useConnectionStore(s => s.wsConnected);'''
)

# Remove the state destructuring line (it's now inline above)
content = content.replace(
    \"const { isStreaming, suggestions, wsConnected, selectedModel, selectedRole } = state;\",
    '// state destructured above via individual stores'
)

# Replace state.currentChatId with direct store access
content = content.replace('state.currentChatId', 'useChatListStore.getState().currentChatId')

with open('components/chat/MessageInput.tsx', 'w') as f:
    f.write(content)
"

# ─── 7. CapabilitiesPanel (WorkspaceStore + useChatActions) ───
echo "[7/9] Migrating CapabilitiesPanel..."
python3 -c "
with open('components/chat/CapabilitiesPanel.tsx', 'r') as f:
    content = f.read()

content = content.replace(
    \"import { useChatStore } from '../../hooks/useChatStore';\",
    \"\"\"import { useWorkspaceStore } from '../../stores/useWorkspaceStore';
import { useChatActions } from '../../hooks/useChatActions';\"\"\"
)

content = content.replace(
    'const { state, createNewChat, sendMessage } = useChatStore();',
    '''const { createNewChat, sendMessage } = useChatActions();
  const { aiSkills, aiTools, aiCapabilities } = useWorkspaceStore();'''
)

# Remove the old destructuring of aiSkills from state
content = content.replace(
    \"const { aiSkills = [], aiTools = [], aiCapabilities = [] } = state as any;\",
    '// AI capabilities destructured above from useWorkspaceStore'
)

with open('components/chat/CapabilitiesPanel.tsx', 'w') as f:
    f.write(content)
"

# ─── 8. Sidebar (AuthStore + ChatListStore + ConnectionStore + useChatActions) ───
echo "[8/9] Migrating Sidebar..."
python3 -c "
with open('components/chat/Sidebar.tsx', 'r') as f:
    content = f.read()

content = content.replace(
    \"import { useChatStore } from '../../hooks/useChatStore';\",
    \"\"\"import { useAuthStore } from '../../stores/useAuthStore';
import { useChatListStore } from '../../stores/useChatListStore';
import { useConnectionStore } from '../../stores/useConnectionStore';
import { useChatActions } from '../../hooks/useChatActions';\"\"\"
)

content = content.replace(
    '''  const {
    state, selectChat, createNewChat, deleteChat, batchDeleteChats, renameChat,
    searchChats, filterByTag, logout,
  } = useChatStore();''',
    '''  const { selectChat, createNewChat, logout } = useChatActions();
  const chatListStore = useChatListStore();
  const { chats, currentChatId, isLoadingChats, searchQuery, filterTag, allTags,
          deleteChat, batchDeleteChats, renameChat, searchChats, filterByTag } = chatListStore;
  const user = useAuthStore(s => s.user);
  const { wsConnected, wsReconnecting, wsReconnectAttempt, gatewayConnected } = useConnectionStore();'''
)

# Remove the old state destructuring
content = content.replace(
    'const { chats, currentChatId, isLoadingChats, user, allTags, searchQuery, filterTag } = state;',
    '// state destructured above via individual stores'
)

# Replace state.wsConnected, state.gatewayConnected, state.wsReconnecting, state.wsReconnectAttempt
content = content.replace('state.wsConnected', 'wsConnected')
content = content.replace('state.gatewayConnected', 'gatewayConnected')
content = content.replace('state.wsReconnecting', 'wsReconnecting')
content = content.replace('state.wsReconnectAttempt', 'wsReconnectAttempt')

with open('components/chat/Sidebar.tsx', 'w') as f:
    f.write(content)
"

# ─── 9. ChatPage (AuthStore + ChatListStore + ConnectionStore + WorkspaceStore + useChatActions) ───
echo "[9/9] Migrating ChatPage..."
python3 -c "
with open('pages/ChatPage.tsx', 'r') as f:
    content = f.read()

# Update import — keep ChatProvider, remove useChatStore
content = content.replace(
    \"import { ChatProvider, useChatStore } from '../hooks/useChatStore';\",
    \"\"\"import { ChatProvider } from '../hooks/useChatStore';
import { useAuthStore } from '../stores/useAuthStore';
import { useChatListStore } from '../stores/useChatListStore';
import { useConnectionStore } from '../stores/useConnectionStore';
import { useWorkspaceStore } from '../stores/useWorkspaceStore';
import { useChatActions } from '../hooks/useChatActions';\"\"\"
)

# ChatLayout component (line ~94)
content = content.replace(
    'const { state, wsConnected, toggleFilePanel, createNewChat } = useChatStore();',
    '''const { createNewChat, wsConnected } = useChatActions();
  const { user, isAuthLoading } = useAuthStore();
  const { currentChatId, chats } = useChatListStore();
  const { isFilePanelOpen, changedFiles, toggleFilePanel } = useWorkspaceStore();
  const { gatewayConnected } = useConnectionStore();'''
)

# Remove the state destructuring lines
content = content.replace(
    'const { user, isAuthLoading, isFilePanelOpen, changedFiles } = state;',
    '// state destructured above via individual stores'
)
content = content.replace(
    'const gatewayConnected = state.gatewayConnected;',
    '// gatewayConnected destructured above from useConnectionStore'
)

# Replace state.currentChatId with currentChatId
content = content.replace('state.currentChatId', 'currentChatId')
# Replace state.chats with chats
content = content.replace('state.chats.find', 'chats.find')

# MobileFilePanel component (line ~428)
content = content.replace(
    'const { state, loadWorkspaceFiles, selectFile } = useChatStore();',
    'const workspaceStore = useWorkspaceStore();'
)
content = content.replace(
    'const { workspaceFiles, selectedFilePath, fileContent, isLoadingFiles, changedFiles } = state;',
    'const { workspaceFiles, selectedFilePath, fileContent, isLoadingFiles, changedFiles, loadWorkspaceFiles, selectFile } = workspaceStore;'
)

with open('pages/ChatPage.tsx', 'w') as f:
    f.write(content)
"

echo ""
echo "=== All 9 components migrated ==="
echo "Checking for any remaining useChatStore() references..."
grep -rn 'useChatStore()' --include='*.tsx' --include='*.ts' . || echo "✅ No remaining useChatStore() calls!"
echo ""
echo "Checking for remaining useChatStore imports..."
grep -rn "from.*useChatStore" --include='*.tsx' --include='*.ts' . | grep -v 'ChatProvider\|useOrchestrator' || echo "✅ Clean!"
