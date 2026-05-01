/**
 * i18n — Lightweight internationalization framework for RangerAI
 * 
 * Supports: zh-CN (简体中文), zh-TW (繁體中文), en (English)
 * 
 * Usage:
 *   import { useI18n } from '../lib/i18n';
 *   const { t, locale, setLocale } = useI18n();
 *   <span>{t('sidebar.newChat')}</span>
 */

import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react';

// ─── Supported locales ──────────────────────────────────────
export type Locale = 'zh-CN' | 'zh-TW' | 'en';

export const LOCALE_LABELS: Record<Locale, string> = {
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
  'en': 'English',
};

export const LOCALE_FLAGS: Record<Locale, string> = {
  'zh-CN': '中文',
  'zh-TW': '繁體',
  'en': 'English',
};

// ─── Translation keys ──────────────────────────────────────
// Flat key structure for simplicity. Add keys as needed.
export type TranslationKeys = {
  // Sidebar
  'sidebar.newChat': string;
  'sidebar.searchPlaceholder': string;
  'sidebar.sharedChats': string;
  'sidebar.batchManage': string;
  'sidebar.promptTemplates': string;
  'sidebar.aiCapabilities': string;
  'sidebar.stats': string;
  'sidebar.inviteCodes': string;
  'sidebar.logout': string;
  'sidebar.admin': string;
  'sidebar.member': string;
  'sidebar.collapseSidebar': string;
  'sidebar.expandSidebar': string;
  'sidebar.aiReady': string;
  'sidebar.aiOffline': string;
  'sidebar.connected': string;
  'sidebar.disconnected': string;
  'sidebar.deleteConfirm': string;
  'sidebar.rename': string;
  'sidebar.delete': string;

  // Chat
  'chat.inputPlaceholder': string;
  'chat.send': string;
  'chat.uploadFile': string;
  'chat.currentModel': string;
  'chat.manageTags': string;
  'chat.exportChat': string;
  'chat.openFilePanel': string;
  'chat.copyMessage': string;
  'chat.regenerate': string;
  'chat.thinking': string;
  'chat.toolCalls': string;
  'chat.allSuccess': string;
  'chat.steps': string;

  // Capabilities Panel
  'capabilities.title': string;
  'capabilities.skills': string;
  'capabilities.tools': string;
  'capabilities.caps': string;
  'capabilities.searchSkills': string;
  'capabilities.searchTools': string;
  'capabilities.noResults': string;

  // Prompt Templates
  'prompts.title': string;
  'prompts.searchPlaceholder': string;
  'prompts.usePrompt': string;
  'prompts.noPrompts': string;
  'prompts.category': string;
  'prompts.allCategories': string;

  // Stats
  'stats.title': string;
  'stats.refresh': string;
  'stats.totalChats': string;
  'stats.totalMessages': string;
  'stats.totalUsers': string;
  'stats.database': string;
  'stats.messageTrend': string;
  'stats.roleDistribution': string;
  'stats.modelUsage': string;
  'stats.routingComplexity': string;
  'stats.hotTags': string;
  'stats.userActivity': string;
  'stats.recentRouting': string;
  'stats.user': string;
  'stats.role': string;
  'stats.chatCount': string;
  'stats.messageCount': string;
  'stats.lastLogin': string;
  'stats.userMessages': string;
  'stats.aiReplies': string;
  'stats.fetchError': string;
  'workflow.loadError': string;
  'workflow.saveError': string;
  'workflow.deleteError': string;
  'workflow.duplicateError': string;
  'taskQueue.loadError': string;
  'prompt.loadError': string;
  'chatPage.exportError': string;

  // Common
  'common.loading': string;
  'common.error': string;
  'common.retry': string;
  'common.cancel': string;
  'common.confirm': string;
  'common.save': string;
  'common.back': string;
  'common.noData': string;
  'common.copied': string;
  'common.featureComingSoon': string;
  'common.language': string;

  // Sidebar Navigation
  'sidebar.conversations': string;
  'sidebar.capabilities': string;
  'sidebar.knowledge': string;
  'sidebar.workflows': string;
  'sidebar.tasks': string;
  'sidebar.tickets': string;
  'sidebar.kol': string;
  'sidebar.notifications': string;
  'sidebar.console': string;
  'sidebar.navGroupTools': string;
  'sidebar.navGroupAdmin': string;
  'sidebar.team': string;
  'sidebar.globalSearch': string;
  'sidebar.tagFilter': string;
  'sidebar.noSharedChats': string;
  'sidebar.from': string;
  'sidebar.selected': string;
  'sidebar.selectAll': string;
  'sidebar.deselectAll': string;
  'sidebar.noMatchingChats': string;
  'sidebar.noTagChats': string;
  'sidebar.noChatsYet': string;
  'sidebar.chatList': string;
  'sidebar.clickNewToStart': string;
  'sidebar.noKnowledgeOrWorkflow': string;
  'sidebar.foundChats': string;
  'sidebar.searching': string;
  'sidebar.aiStarting': string;
  'sidebar.reconnecting': string;
  'sidebar.disconnectedShort': string;
  'sidebar.newConversation': string;
  'sidebar.exitBatchMode': string;

  // ChatPage
  'chatPage.exportConversation': string;
  'chatPage.exportMarkdown': string;
  'chatPage.exportJson': string;
  'chatPage.collapseSidebar': string;
  'chatPage.expandSidebar': string;
  'chatPage.aiConnected': string;
  'chatPage.wsConnectedAiConnecting': string;
  'chatPage.disconnectedReconnecting': string;
  'chatPage.connected': string;
  'chatPage.aiConnecting': string;
  'chatPage.reconnecting': string;
  'chatPage.manageTags': string;
  'chatPage.openFilePanel': string;
  'chatPage.closeFilePanel': string;
  'chatPage.viewFiles': string;
  'chatPage.workspaceFiles': string;
  'chatPage.changes': string;
  'chatPage.backToList': string;
  'chatPage.binaryFile': string;
  'chatPage.noWorkspaceFiles': string;
  'chatPage.filesAppearHere': string;

  // Toast messages
  'toast.createChatFailed': string;
  'toast.renameFailed': string;
  'toast.renameSuccess': string;
  'toast.deleteFailed': string;
  'toast.deleteSuccess': string;
  'toast.batchDeleteFailed': string;
  'toast.batchDeleteSuccess': string;
  'toast.exportFailed': string;
  'toast.copySuccess': string;
  'toast.copyFailed': string;

  // LoginPage
  'login.subtitle': string;
  'login.loginTab': string;
  'login.registerTab': string;
  'login.username': string;
  'login.usernamePlaceholder': string;
  'login.password': string;
  'login.passwordPlaceholder': string;
  'login.passwordMinLength': string;
  'login.confirmPassword': string;
  'login.confirmPasswordPlaceholder': string;
  'login.inviteCode': string;
  'login.inviteCodeHint': string;
  'login.loggingIn': string;
  'login.registering': string;
  'login.loginButton': string;
  'login.registerButton': string;
  'login.noAccountHint': string;
  'login.hasAccountHint': string;
  'login.errorEmptyFields': string;
  'login.errorPasswordMismatch': string;
  'login.errorPasswordTooShort': string;
  'login.errorNoInviteCode': string;
  'login.errorLoginFailed': string;
  'login.errorRegisterFailed': string;

  // Validation
  'validation.usernameTooShort': string;
  'validation.usernameTooLong': string;
  'validation.fieldRequired': string;
  'validation.nameTooLong': string;

  // MessageInput
  'input.imageAttachment': string;
  'input.fileAttachment': string;
  'input.dropFilesHere': string;
  'input.supportsImagesAndDocs': string;
  'input.connecting': string;
  'input.aiReplying': string;
  'input.placeholder': string;
  'input.placeholderMobile': string;
  'input.ariaLabel': string;
  'input.processing': string;
  'input.uploading': string;
  'input.send': string;
  'input.sendMessage': string;
  'input.stopGeneration': string;
  'input.footer': string;

  // Model names (keep original, just for display labels)
  'model.smartRouter': string;

  // MessageList — Task types
  'msg.taskType.code': string;
  'msg.taskType.reasoning': string;
  'msg.taskType.creative': string;
  'msg.taskType.research': string;
  'msg.taskType.imageGeneration': string;
  'msg.taskType.chat': string;

  // MessageList — Thinking levels
  'msg.thinking.low': string;
  'msg.thinking.medium': string;
  'msg.thinking.high': string;
  'msg.thinking.xhigh': string;
  'msg.thinkingSuffix': string;

  // MessageList — Skill categories
  'msg.skillCat.ops': string;
  'msg.skillCat.security': string;
  'msg.skillCat.network': string;
  'msg.skillCat.monitoring': string;
  'msg.skillCat.deploy': string;
  'msg.skillCat.backup': string;
  'msg.skillCat.log': string;
  'msg.skillCat.cost': string;
  'msg.skillCat.env': string;
  'msg.skillCat.cron': string;
  'msg.skillCat.evolve': string;
  'msg.skillCat.creation': string;
  'msg.skillCat.query': string;
  'msg.skillCat.dev': string;
  'msg.skillCat.mgmt': string;

  // MessageList — Tool labels
  'msg.tool.webSearch': string;
  'msg.tool.webFetch': string;
  'msg.tool.browser': string;
  'msg.tool.terminal': string;
  'msg.tool.readFile': string;
  'msg.tool.writeFile': string;
  'msg.tool.editFile': string;
  'msg.tool.genImage': string;
  'msg.tool.canvas': string;
  'msg.tool.tts': string;
  'msg.tool.codeExec': string;
  'msg.tool.memorySearch': string;
  'msg.tool.memoryGet': string;

  // MessageList — Tool display titles
  'msg.toolTitle.search': string;
  'msg.toolTitle.fetch': string;
  'msg.toolTitle.browserAction': string;
  'msg.toolTitle.execCmd': string;
  'msg.toolTitle.read': string;
  'msg.toolTitle.write': string;
  'msg.toolTitle.edit': string;
  'msg.toolTitle.genImage': string;
  'msg.toolTitle.canvasOp': string;
  'msg.toolTitle.tts': string;
  'msg.toolTitle.memSearch': string;
  'msg.toolTitle.memGet': string;
  'msg.toolTitle.file': string;

  // MessageList — Execution timeline
  'msg.exec.running': string;
  'msg.exec.done': string;
  'msg.exec.steps': string;

  // MessageList — Tool card labels
  'msg.card.params': string;
  'msg.card.result': string;
  'msg.card.browserScreenshot': string;
  'msg.card.generatedImage': string;
  'msg.card.imageGenerating': string;

  // MessageList — Image preview
  'msg.preview.imagePreview': string;
  'msg.preview.closePreview': string;
  'msg.preview.viewLarger': string;
  'msg.preview.browserScreenshot': string;
  'msg.preview.closeSsPreview': string;

  // MessageList — Persisted tool summary
  'msg.summary.toolCalls': string;
  'msg.summary.success': string;
  'msg.summary.fail': string;
  'msg.summary.allSuccess': string;
  'msg.summary.stepsCount': string;
  'msg.summary.expandAll': string;
  'msg.summary.collapse': string;
  'msg.summary.viewTerminal': string;

  // MessageList — Message actions
  'msg.action.copied': string;
  'msg.action.copyMsg': string;
  'msg.action.copy': string;
  'msg.action.regenerate': string;

  // MessageList — Streaming / thinking
  'msg.stream.deepThinking': string;
  'msg.stream.thinking': string;
  'msg.stream.analyzing': string;
  'msg.stream.close': string;
  // v25.0: Phase indicators
  'msg.phase.executing': string;
  'msg.phase.outputting': string;
  'msg.scrollToBottom': string;

  // MessageList — Welcome page
  'msg.welcome.subtitle': string;
  'msg.welcome.modelRoute': string;
  'msg.welcome.describeNeeds': string;
  'msg.welcome.cap.webSearch': string;
  'msg.welcome.cap.webSearchDesc': string;
  'msg.welcome.cap.codeDev': string;
  'msg.welcome.cap.codeDevDesc': string;
  'msg.welcome.cap.dataViz': string;
  'msg.welcome.cap.dataVizDesc': string;
  'msg.welcome.cap.securityOps': string;
  'msg.welcome.cap.securityOpsDesc': string;
  'msg.welcome.cap.contentDesign': string;
  'msg.welcome.cap.contentDesignDesc': string;
  'msg.welcome.cap.fileMgmt': string;
  'msg.welcome.cap.fileMgmtDesc': string;
  'msg.welcome.cap.aiModel': string;
  'msg.welcome.cap.aiModelDesc': string;
  'msg.welcome.cap.sysIntegration': string;
  'msg.welcome.cap.sysIntegrationDesc': string;
  'msg.welcome.cap.docReport': string;
  'msg.welcome.cap.docReportDesc': string;
  'msg.welcome.cap.multiLang': string;
  'msg.welcome.cap.multiLangDesc': string;
  'msg.welcome.cap.browserAuto': string;
  'msg.welcome.cap.browserAutoDesc': string;
  'msg.welcome.cap.taskOrch': string;
  'msg.welcome.cap.taskOrchDesc': string;
  'msg.welcome.cap.smartChat': string;
  'msg.welcome.cap.smartChatDesc': string;
  'msg.welcome.cap.research': string;
  'msg.welcome.cap.researchDesc': string;
  'msg.welcome.cap.projectMgmt': string;
  'msg.welcome.cap.projectMgmtDesc': string;
  // Admin Dashboard
  'admin.title': string;
  'admin.running': string;
  'admin.version': string;
  'admin.tab.overview': string;
  'admin.tab.system': string;
  'admin.tab.users': string;
  'admin.tab.config': string;
  'admin.tab.roles': string;
  'admin.tab.audit': string;
  'admin.tab.assignRules': string;
  'admin.tab.openPlatform': string;
  'admin.tab.services': string;
  'admin.nav.monitor': string;
  'admin.nav.manage': string;
  'admin.nav.ops': string;
  'admin.nav.ai': string;
  'admin.tab.toolMemory': string;
  'admin.toolMemory.title': string;
  'admin.toolMemory.totalRecords': string;
  'admin.toolMemory.subTypeStats': string;
  'admin.toolMemory.topTools': string;
  'admin.toolMemory.recentPatterns': string;
  'admin.toolMemory.hitCount': string;
  'admin.toolMemory.successRate': string;
  'admin.toolMemory.avgDuration': string;
  'admin.toolMemory.noData': string;
  'admin.refresh': string;
  'admin.collapse': string;
  // Admin - ACP Open Platform
  'admin.acp.service': string;
  'admin.acp.activeKeys': string;
  'admin.acp.asyncTasks': string;
  'admin.acp.dingtalk': string;
  'admin.acp.connected': string;
  'admin.acp.disconnected': string;
  'admin.acp.disabled': string;
  'admin.acp.apiKeys': string;
  'admin.acp.apiKeysDesc': string;
  'admin.acp.createKey': string;
  'admin.acp.newKey': string;
  'admin.acp.keyName': string;
  'admin.acp.keyNamePlaceholder': string;
  'admin.acp.nameRequired': string;
  'admin.acp.generate': string;
  'admin.acp.keyCreated': string;
  'admin.acp.keyCreatedHint': string;
  'admin.acp.copy': string;
  'admin.acp.copied': string;
  'admin.acp.noKeys': string;
  'admin.acp.noKeysHint': string;
  'admin.acp.thName': string;
  'admin.acp.thKeyPrefix': string;
  'admin.acp.thStatus': string;
  'admin.acp.thCalls': string;
  'admin.acp.thLastUsed': string;
  'admin.acp.thCreatedAt': string;
  'admin.acp.thActions': string;
  'admin.acp.statusActive': string;
  'admin.acp.statusRevoked': string;
  'admin.acp.revoke': string;
  'admin.acp.revokeConfirm': string;
  'admin.acp.revokeMsg': string;
  'admin.acp.envKeyNoRevoke': string;
  'admin.acp.apiDocs': string;
  'admin.acp.docSyncChat': string;
  'admin.acp.docAsyncChat': string;
  'admin.acp.docTaskStatus': string;
  'admin.acp.docKnowledge': string;
  'admin.acp.usageExample': string;
  // Admin - Status
  'admin.status.running': string;
  'admin.status.healthy': string;
  'admin.status.degraded': string;
  'admin.status.loadFailed': string;
  'admin.status.noData': string;
  'admin.status.loading': string;
  // Admin - Overview
  'admin.overview.totalLabel': string;
  'admin.overview.pending': string;
  'admin.overview.inProgress': string;
  'admin.overview.resolved': string;
  'admin.overview.closed': string;
  'admin.overview.totalKol': string;
  'admin.overview.cooperating': string;
  'admin.overview.totalCooperation': string;
  'admin.overview.trendNew': string;
  'admin.overview.trendResolved': string;
  'admin.overview.cpuLoad': string;
  'admin.overview.cores': string;
  'admin.overview.serviceStatus': string;
  'admin.overview.uptime': string;
  'admin.overview.dbUsers': string;
  'admin.overview.dbChats': string;
  'admin.overview.dbMessages': string;
  'admin.overview.dbSize': string;
  'admin.overview.heapUsed': string;
  'admin.overview.rss': string;
  'admin.overview.activeTasks': string;
  'admin.overview.noActiveTasks': string;
  'admin.overview.elapsedSec': string;
  'admin.overview.ticketStats': string;
  'admin.overview.kolStats': string;
  'admin.overview.ticketTrend': string;
  // Admin - System
  'admin.system.memory': string;
  'admin.system.used': string;
  'admin.system.total': string;
  'admin.system.usageRate': string;
  'admin.system.free': string;
  'admin.system.disk': string;
  'admin.system.diskUsed': string;
  'admin.system.diskAvailable': string;
  'admin.system.platform': string;
  'admin.system.nodeVersion': string;
  'admin.system.pid': string;
  'admin.system.processMemory': string;
  'admin.system.browserStatus': string;
  'admin.system.circuitBreaker': string;
  'admin.system.failCount': string;
  'admin.system.lastFail': string;
  'admin.system.recoverBrowser': string;
  'admin.system.resetBreaker': string;
  'admin.system.breakerClosed': string;
  'admin.system.breakerOpen': string;
  'admin.system.breakerHalfOpen': string;
  'admin.system.opSuccess': string;
  'admin.system.opFailed': string;
  'admin.system.ports': string;
  'admin.system.halfOpenAttempts': string;
  'admin.system.sysInfo': string;
  // Admin - Users
  'admin.users.search': string;
  'admin.users.roleAdmin': string;
  'admin.users.roleMember': string;
  'admin.users.confirmRoleChange': string;
  'admin.users.demoteToMember': string;
  'admin.users.promoteToAdmin': string;
  'admin.users.thName': string;
  'admin.users.thRole': string;
  'admin.users.thMessages': string;
  'admin.users.thChats': string;
  'admin.users.thLastActive': string;
  'admin.users.thActions': string;
  // Admin - Config
  'admin.config.catGeneral': string;
  'admin.config.catAI': string;
  'admin.config.catGateway': string;
  'admin.config.catStorage': string;
  'admin.config.catAuth': string;
  'admin.config.noConfig': string;
  // Admin - Roles
  'admin.roles.addRole': string;
  'admin.roles.create': string;
  'admin.roles.save': string;
  'admin.roles.noRoles': string;
  'admin.roles.editRole': string;
  'admin.roles.deleteConfirm': string;
  // Admin - Audit
  'admin.audit.totalRecords': string;
  'admin.audit.noLogs': string;
  'admin.audit.noLogsHint': string;
  'admin.audit.thTime': string;
  'admin.audit.thOperator': string;
  'admin.audit.thAction': string;
  'admin.audit.thTarget': string;
  'admin.audit.thDetail': string;
  'admin.audit.prevPage': string;
  'admin.audit.nextPage': string;
  'admin.audit.configUpdate': string;
  'admin.audit.roleCreate': string;
  'admin.audit.roleUpdate': string;
  'admin.audit.roleDelete': string;
  // Admin - Assign Rules
  'admin.assign.title': string;
  'admin.assign.addRule': string;
  'admin.assign.editRule': string;
  'admin.assign.newRule': string;
  'admin.assign.category': string;
  'admin.assign.priority': string;
  'admin.assign.assignee': string;
  'admin.assign.update': string;
  'admin.assign.createBtn': string;
  'admin.assign.cancel': string;
  'admin.assign.noRules': string;
  'admin.assign.noRulesHint': string;
  'admin.assign.thCategory': string;
  'admin.assign.thPriority': string;
  'admin.assign.thAssignee': string;
  'admin.assign.thCreatedAt': string;
  'admin.assign.thActions': string;
  'admin.assign.ruleExplanation': string;
  'admin.assign.ruleHint1': string;
  'admin.assign.ruleHint2': string;
  'admin.assign.ruleHint3': string;
  'admin.assign.ruleHint4': string;
  'admin.assign.ruleHint5': string;
  // Admin - Categories & Priorities
  'admin.cat.payment': string;
  'admin.cat.account': string;
  'admin.cat.technical': string;
  'admin.cat.shipping': string;
  'admin.cat.refund': string;
  'admin.cat.general': string;
  'admin.cat.default': string;
  'admin.priority.all': string;
  'admin.priority.critical': string;
  'admin.priority.high': string;
  'admin.priority.medium': string;
  'admin.priority.low': string;
  'admin.priority.urgent': string;
  // Admin - formatUptime
  'admin.time.days': string;
  'admin.time.hours': string;
  'admin.time.minutes': string;
  // KOL Manager
  'kol.title': string;
  'kol.total': string;
  'kol.platformCoverage': string;
  'kol.cooperating': string;
  'kol.totalCooperation': string;
  'kol.search': string;
  'kol.allPlatforms': string;
  'kol.addKol': string;
  'kol.addFirst': string;
  'kol.noData': string;
  'kol.noDataHint': string;
  'kol.editKol': string;
  'kol.refreshData': string;
  'kol.refreshing': string;
  'kol.refreshed': string;
  'kol.refreshFailed': string;
  'kol.addSuccess': string;
  'kol.addFailed': string;
  'kol.updateSuccess': string;
  'kol.updateFailed': string;
  'kol.deleteConfirm': string;
  'kol.deleteSuccess': string;
  'kol.deleteFailed': string;
  'kol.followers': string;
  'kol.engagementRate': string;
  'kol.region': string;
  'kol.status.active': string;
  'kol.status.inactive': string;
  'kol.status.blacklisted': string;
  'kol.status.pending': string;
  'kol.coop.none': string;
  'kol.coop.contacted': string;
  'kol.coop.negotiating': string;
  'kol.coop.contracted': string;
  'kol.coop.completed': string;
  'kol.form.name': string;
  'kol.form.platform': string;
  'kol.form.handle': string;
  'kol.form.followers': string;
  'kol.form.category': string;
  'kol.form.country': string;
  'kol.form.language': string;
  'kol.form.email': string;
  'kol.form.coopStatus': string;
  'kol.form.notes': string;
  'kol.form.save': string;
  'kol.form.add': string;
  'kol.form.cancel': string;
  'kol.cat.gaming': string;
  'kol.cat.beauty': string;
  'kol.cat.tech': string;
  'kol.cat.lifestyle': string;
  'kol.cat.food': string;
  'kol.cat.fashion': string;
  'kol.cat.fitness': string;
  'kol.cat.education': string;
  // KOL Detail
  'kolDetail.back': string;
  'kolDetail.basicInfo': string;
  'kolDetail.coopHistory': string;
  'kolDetail.addCoop': string;
  'kolDetail.noCoop': string;
  'kolDetail.noCoopHint': string;
  'kolDetail.platform': string;
  'kolDetail.handle': string;
  'kolDetail.followers': string;
  'kolDetail.engagementRate': string;
  'kolDetail.category': string;
  'kolDetail.country': string;
  'kolDetail.language': string;
  'kolDetail.email': string;
  'kolDetail.phone': string;
  'kolDetail.status': string;
  'kolDetail.coopStatus': string;
  'kolDetail.lastContacted': string;
  'kolDetail.createdAt': string;
  'kolDetail.notes': string;
  'kolDetail.coopType': string;
  'kolDetail.coopAmount': string;
  'kolDetail.coopStartDate': string;
  'kolDetail.coopEndDate': string;
  'kolDetail.coopNotes': string;
  'kolDetail.coopStatusLabel': string;
  'kolDetail.coopSave': string;
  'kolDetail.coopCancel': string;
  'kolDetail.coopDeleteConfirm': string;
  'kolDetail.notFound': string;

  'kolDetail.backToList': string;
  'kolDetail.coopCount': string;
  'kolDetail.totalInvestment': string;
  'kolDetail.addedAt': string;
  'kolDetail.roiAnalysis': string;
  'kolDetail.totalBudget': string;
  'kolDetail.actualSpend': string;
  'kolDetail.budgetUtilization': string;
  'kolDetail.avgCoopCost': string;
  'kolDetail.completionRate': string;
  'kolDetail.estReach': string;
  'kolDetail.coopHistoryTitle': string;
  'kolDetail.addCoopRecord': string;
  'kolDetail.addFirstCoop': string;
  'kolDetail.coopBudget': string;
  'kolDetail.coopActual': string;
  'kolDetail.coopStatus.planning': string;
  'kolDetail.coopStatus.active': string;
  'kolDetail.coopStatus.completed': string;
  'kolDetail.coopStatus.cancelled': string;
  'kolDetail.campaignType.promotion': string;
  'kolDetail.campaignType.review': string;
  'kolDetail.campaignType.livestream': string;
  'kolDetail.campaignType.sponsored': string;
  'kolDetail.campaignType.affiliate': string;
  'kolDetail.campaignType.other': string;
  'kolDetail.form.campaignName': string;
  'kolDetail.form.campaignType': string;
  'kolDetail.form.campaignStatus': string;
  'kolDetail.form.startDate': string;
  'kolDetail.form.endDate': string;
  'kolDetail.form.budget': string;
  'kolDetail.form.actualCost': string;
  'kolDetail.form.deliverables': string;
  'kolDetail.form.delivPlaceholder': string;

  'kb.title': string;
  'kb.docCount': string;
  'kb.addKnowledge': string;
  'kb.searchDebug': string;
  'kb.uploadFile': string;
  'kb.upload': string;
  'kb.search': string;
  'kb.searchPlaceholder': string;
  'kb.categories': string;
  'kb.all': string;
  'kb.cat.uncategorized': string;
  'kb.cat.techDoc': string;
  'kb.cat.productReq': string;
  'kb.cat.meetingNotes': string;
  'kb.cat.knowledgeBase': string;
  'kb.cat.training': string;
  'kb.cat.standards': string;
  'kb.cat.apiDoc': string;
  'kb.textEntry': string;
  'kb.emptyTitle': string;
  'kb.emptyDesc': string;
  'kb.emptyUploadFile': string;
  'kb.emptyUploadHint': string;
  'kb.emptyAddText': string;
  'kb.emptyAddTextHint': string;
  'kb.emptyBrowse': string;
  'kb.emptyBrowseHint': string;
  'kb.notVectorized': string;
  'kb.vectorized': string;
  'kb.retry': string;
  'kb.regenerate': string;
  'kb.vectorBlocks': string;
  'kb.contentLength': string;
  'kb.chars': string;
  'kb.notVectorizedHint': string;
  'kb.showing': string;
  'kb.total': string;
  'kb.docs': string;
  'kb.prevPage': string;
  'kb.nextPage': string;
  'kb.category': string;
  'kb.description': string;
  'kb.fileName': string;
  'kb.size': string;
  'kb.createdAt': string;
  'kb.embeddingStatus': string;
  'kb.contentPreview': string;
  'kb.contentTruncated': string;
  'kb.deleteDoc': string;
  'kb.uploadFileTitle': string;
  'kb.selectFile': string;
  'kb.supportedFormats': string;
  'kb.titleLabel': string;
  'kb.descLabel': string;
  'kb.categoryLabel': string;
  'kb.tagsLabel': string;
  'kb.tagsCommaSep': string;
  'kb.cancel': string;
  'kb.uploading': string;
  'kb.addKnowledgeEntry': string;
  'kb.titleRequired': string;
  'kb.titlePlaceholder': string;
  'kb.contentLabel': string;
  'kb.contentPlaceholder': string;
  'kb.saving': string;
  'kb.save': string;
  'kb.uploadSuccess': string;
  'kb.uploadFailed': string;
  'kb.addTextSuccess': string;
  'kb.addTextFailed': string;
  'kb.deleteConfirm': string;
  'kb.deleteSuccess': string;
  'kb.deleteFailed': string;
  'kb.formatTextEntry': string;
  'kb.customCategory': string;
  'kb.customCategoryPlaceholder': string;
  'kb.tagInputPlaceholder': string;
  'kb.tagInputHint': string;
  'wf.title': string;
  'wf.search': string;
  'wf.create': string;
  'wf.noWorkflows': string;
  'wf.noWorkflowsHint': string;
  'wf.createFirst': string;
  'wf.steps': string;
  'wf.lastUpdated': string;
  'wf.run': string;
  'wf.edit': string;
  'wf.delete': string;
  'wf.deleteConfirm': string;
  'wf.deleteSuccess': string;
  'wf.deleteFailed': string;
  'wf.createWorkflow': string;
  'wf.editWorkflow': string;
  'wf.name': string;
  'wf.namePlaceholder': string;
  'wf.description': string;
  'wf.descPlaceholder': string;
  'wf.addStep': string;
  'wf.stepType': string;
  'wf.stepPrompt': string;
  'wf.stepAction': string;
  'wf.stepCondition': string;
  'wf.removeStep': string;
  'wf.cancel': string;
  'wf.save': string;
  'wf.saving': string;
  'wf.saveSuccess': string;
  'wf.saveFailed': string;
  'wf.cron.notSet': string;
  'wf.cron.custom': string;
  'wf.cron.hourly': string;
  'wf.cron.hourlyDesc': string;
  'wf.cron.daily9': string;
  'wf.cron.daily9Desc': string;
  'wf.cron.daily18': string;
  'wf.cron.daily18Desc': string;
  'wf.cron.weekday9': string;
  'wf.cron.weekday9Desc': string;
  'wf.cron.monday9': string;
  'wf.cron.monday9Desc': string;
  'wf.cron.monthly1': string;
  'wf.cron.monthly1Desc': string;
  'wf.cat.uncategorized': string;
  'wf.cat.dailyTask': string;
  'wf.cat.dataAnalysis': string;
  'wf.cat.contentCreation': string;
  'wf.cat.codeDev': string;
  'wf.cat.devops': string;
  'wf.cat.research': string;
  'wf.step': string;
  'wf.confirmDelete': string;
  'wf.copy': string;
  'wf.neverRun': string;
  'wf.justNow': string;
  'wf.minutesAgo': string;
  'wf.hoursAgo': string;
  'wf.daysAgo': string;
  'wf.tpl.searchWeb': string;
  'wf.tpl.searchInfo': string;
  'wf.tpl.searchPrompt': string;
  'wf.tpl.analyzeDoc': string;
  'wf.tpl.analyzeFile': string;
  'wf.tpl.analyzePrompt': string;
  'wf.tpl.dataAnalysis': string;
  'wf.tpl.analyzeData': string;
  'wf.tpl.dataPrompt': string;
  'wf.tpl.codeGen': string;
  'wf.tpl.genCode': string;
  'wf.tpl.codePrompt': string;
  'wf.tpl.sendNotify': string;
  'wf.tpl.sendNotifyDesc': string;
  'wf.tpl.notifyPrompt': string;
  'wf.tpl.webScrape': string;
  'wf.tpl.scrapeWeb': string;
  'wf.tpl.scrapePrompt': string;
  'wf.tpl.dataQuery': string;
  'wf.tpl.queryData': string;
  'wf.tpl.queryPrompt': string;
  'wf.tpl.genReport': string;
  'wf.tpl.genReportDesc': string;
  'wf.tpl.reportPrompt': string;
  'wf.stepName': string;
  'wf.unnamedStep': string;
  'wf.promptPlaceholder': string;
  'wf.waitForCompletion': string;
  'wf.chars': string;
  'wf.selectTemplate': string;
  'wf.blankStep': string;
  'wf.workflowName': string;
  'wf.workflowNamePlaceholder': string;
  'wf.descLabel': string;
  'wf.descPlaceholderShort': string;
  'wf.categoryLabel': string;
  'wf.cronTrigger': string;
  'wf.cronNotEnabled': string;
  'wf.quickSelect': string;
  'wf.collapseCron': string;
  'wf.expandCron': string;
  'wf.cronPlaceholder': string;
  'wf.cronHint': string;
  'wf.execSteps': string;
  'wf.addStepBtn': string;
  'wf.continueAdd': string;
  'wf.emptyTitle': string;
  'wf.emptyDesc': string;
  'wf.emptyStep1': string;
  'wf.emptyStep1Desc': string;
  'wf.emptyStep2': string;
  'wf.emptyStep2Desc': string;
  'wf.emptyStep3': string;
  'wf.emptyStep3Desc': string;
  'wf.createFirstBtn': string;
  'wf.nSteps': string;
  'wf.runNTimes': string;
  'wf.nStepsShort': string;
  'wf.runBtn': string;
  'wf.editBtn': string;
  'wf.copyBtn': string;
  'wf.deleteBtn': string;
  'wf.editWorkflowTitle': string;
  'wf.createWorkflowTitle': string;
  'wf.cancelBtn': string;
  'wf.saveBtn': string;
  'wf.savingBtn': string;
  'wf.descriptionLabel': string;
  'wf.categoryLabelShort': string;
  'wf.runLabel': string;
  'wf.recentLabel': string;
  'wf.stepsLabel': string;
  'wf.count': string;
  'wf.workflowTitle': string;
  'wf.runSuccess': string;
  'wf.runFailed': string;
  'wf.type.prompt': string;
  'wf.type.action': string;
  'wf.type.condition': string;
  'wf.type.loop': string;
  'team.title': string;
  'team.search': string;
  'team.invite': string;
  'team.members': string;
  'team.role.admin': string;
  'team.role.member': string;
  'team.role.viewer': string;
  'team.status.active': string;
  'team.status.invited': string;
  'team.status.disabled': string;
  'team.noMembers': string;
  'team.noMembersHint': string;
  'team.inviteFirst': string;
  'team.lastActive': string;
  'team.changeRole': string;
  'team.remove': string;
  'team.removeConfirm': string;
  'team.removeSuccess': string;
  'team.removeFailed': string;
  'team.inviteMember': string;
  'team.email': string;
  'team.emailPlaceholder': string;
  'team.selectRole': string;
  'team.cancel': string;
  'team.sendInvite': string;
  'team.sending': string;
  'team.inviteSuccess': string;
  'team.inviteFailed': string;
  'team.role.manager': string;
  'team.role.cs': string;
  'team.orgLevel.ceo': string;
  'team.orgLevel.vp': string;
  'team.orgLevel.lead': string;
  'team.orgLevel.staff': string;
  'team.createUser': string;
  'team.createUserTitle': string;
  'team.editUser': string;
  'team.editUserTitle': string;
  'team.resetPw': string;
  'team.resetPwTitle': string;
  'team.username': string;
  'team.usernamePlaceholder': string;
  'team.displayName': string;
  'team.displayNamePlaceholder': string;
  'team.password': string;
  'team.passwordPlaceholder': string;
  'team.passwordMinLen': string;
  'team.newPassword': string;
  'team.role': string;
  'team.orgLevel': string;
  'team.department': string;
  'team.manager': string;
  'team.emailLabel': string;
  'team.phone': string;
  'team.phonePlaceholder': string;
  'team.unassigned': string;
  'team.none': string;
  'team.save': string;
  'team.saving': string;
  'team.createBtn': string;
  'team.saveChanges': string;
  'team.createDept': string;
  'team.createDeptTitle': string;
  'team.editDept': string;
  'team.editDeptTitle': string;
  'team.deptName': string;
  'team.deptNamePlaceholder': string;
  'team.description': string;
  'team.descPlaceholder': string;
  'team.parentDept': string;
  'team.parentDeptNone': string;
  'team.deptManager': string;
  'team.deptManagerNone': string;
  'team.sortOrder': string;
  'team.saveDept': string;
  'team.deactivateUser': string;
  'team.deactivateConfirm': string;
  'team.deactivated': string;
  'team.deleteDept': string;
  'team.deleteDeptConfirm': string;
  'team.deletedDept': string;
  'team.opFailed': string;
  'team.deleteFailed': string;
  'team.networkError': string;
  'team.usernameRequired': string;
  'team.createFailed': string;
  'team.updateFailed': string;
  'team.deptNameRequired': string;
  'team.pwResetSuccess': string;
  'team.pwResetNotify': string;
  'team.close': string;
  'team.confirmReset': string;
  'team.activeMembers': string;
  'team.departments': string;
  'team.userMgmt': string;
  'team.deptMgmt': string;
  'team.searchPlaceholder': string;
  'team.all': string;
  'team.user': string;
  'team.roleLabel': string;
  'team.deptLabel': string;
  'team.managerLabel': string;
  'team.levelLabel': string;
  'team.lastLogin': string;
  'team.actions': string;
  'team.editTooltip': string;
  'team.resetPwTooltip': string;
  'team.deactivateTooltip': string;
  'team.noMatchUsers': string;
  'team.noMatchUsersDesc': string;
  'team.noUsers': string;
  'team.noUsersDesc': string;
  'team.noDepts': string;
  'team.noDeptsHint': string;
  'team.noDesc': string;
  'team.managerColon': string;
  'team.memberCount': string;
  'team.editDeptTooltip': string;
  'team.deleteDeptTooltip': string;
  'team.userCreated': string;
  'team.userUpdated': string;
  'team.deptUpdated': string;
  'team.deptCreated': string;
  'team.confirmAction': string;
  'team.confirmDelete': string;
  'fp.title': string;
  'fp.search': string;
  'fp.noFiles': string;
  'fp.noFilesHint': string;
  'fp.download': string;
  'fp.delete': string;
  'fp.deleteConfirm': string;
  'fp.preview': string;
  'fp.fileInfo': string;
  'fp.fileName': string;
  'fp.fileSize': string;
  'fp.fileType': string;
  'fp.createdAt': string;
  'fp.close': string;
  'fp.copyContent': string;
  'fp.downloadFile': string;
  'fp.binaryNoPreview': string;
  'fp.loadingFiles': string;
  'fp.selectFile': string;
  'fp.selectFileHint': string;
  'fp.workspaceFiles': string;
  'fp.changes': string;
  'fp.refreshFiles': string;
  'fp.closePanel': string;
  'fp.loadFailed': string;
  'sd.title': string;
  'sd.back': string;
  'sd.searchPlaceholder': string;
  'sd.search': string;
  'sd.results': string;
  'sd.noResults': string;
  'sd.noResultsHint': string;
  'sd.score': string;
  'sd.source': string;
  'sd.chunk': string;
  'sd.similarity': string;
  'sd.topK': string;
  'sd.threshold': string;
  'sd.searchTime': string;
  'sd.totalResults': string;
  'sd.minChars': string;
  'sd.categoryFilter': string;
  'sd.nResults': string;
  'sd.nFused': string;
  'sd.totalTime': string;
  'sd.queryLabel': string;
  'sd.noChannelResults': string;
  'sd.panelTitle': string;
  'sd.panelDesc': string;
  'cap.search': string;
  'cap.all': string;
  'cap.enabled': string;
  'cap.disabled': string;
  'cap.noResults': string;
  'cap.noResultsHint': string;
  'cap.toggleOn': string;
  'cap.toggleOff': string;
  'cap.category': string;
  'cap.title': string;
  'cap.description': string;
  'cap.webSearch': string;
  'cap.webSearchDesc': string;
  'cap.codeExec': string;
  'cap.codeExecDesc': string;
  'cap.fileUpload': string;
  'cap.fileUploadDesc': string;
  'cap.imageGen': string;
  'cap.imageGenDesc': string;
  'cap.voiceTrans': string;
  'cap.voiceTransDesc': string;
  'cap.knowledgeBase': string;
  'cap.knowledgeBaseDesc': string;
  'cap.workflow': string;
  'cap.workflowDesc': string;
  'cap.close': string;
  'cap.toolCat.codeExec': string;
  'cap.toolCat.fileOps': string;
  'cap.toolCat.browser': string;
  'cap.toolCat.searchEngine': string;
  'cap.toolCat.imageProc': string;
  'cap.toolCat.voiceSynth': string;
  'cap.toolCat.multiAgent': string;
  'cap.toolCat.messaging': string;
  'cap.toolCat.elevated': string;
  'cap.tool.exec': string;
  'cap.tool.process': string;
  'cap.tool.read': string;
  'cap.tool.write': string;
  'cap.tool.edit': string;
  'cap.tool.applyPatch': string;
  'cap.tool.image': string;
  'cap.tool.canvas': string;
  'cap.tool.browser': string;
  'cap.tool.webSearch': string;
  'cap.tool.webFetch': string;
  'cap.tool.tts': string;
  'cap.tool.subagents': string;
  'cap.tool.agentsList': string;
  'cap.tool.message': string;
  'cap.tool.nodes': string;
  'cap.tool.elevated': string;
  'cap.tool.sessionsList': string;
  'cap.tool.sessionsHistory': string;
  'cap.tool.sessionsSend': string;
  'cap.tool.sessionsSpawn': string;
  'cap.tool.sessionStatus': string;
  'cap.skillCat.ops': string;
  'cap.skillCat.dev': string;
  'cap.skillCat.security': string;
  'cap.skillCat.creative': string;
  'cap.skillCat.data': string;
  'cap.skillCat.monitor': string;
  'cap.skillCat.evolution': string;
  'cap.skillCat.integration': string;
  'cap.skillCat.other': string;
  'cap.aiCenter': string;
  'cap.sysCaps': string;
  'cap.searchSkills': string;
  'cap.searchTools': string;
  'cap.noSkillMatch': string;
  'cap.invoking': string;
  'cap.use': string;
  'cap.useSkillMsg': string;
  'cap.useSkill': string;
  'cap.skillReady': string;
  'cap.skillNotReady': string;
  'cap.skillDescription': string;
  'cap.skillInfo': string;
  'cap.skillId': string;
  'cap.skillVersion': string;
  'cap.skillAuthor': string;
  'cap.skillTriggers': string;
  'invite.title': string;
  'invite.noAccess': string;
  'invite.adminOnly': string;
  'invite.back': string;
  'invite.createTitle': string;
  'invite.maxUses': string;
  'invite.expireDays': string;
  'invite.createBtn': string;
  'invite.creating': string;
  'invite.empty': string;
  'invite.emptyDesc': string;
  'invite.created': string;
  'invite.expired': string;
  'invite.statusActive': string;
  'invite.statusExpired': string;
  'invite.statusUsed': string;
  'invite.statusInactive': string;
  'invite.uses': string;
  'notif.title': string;
  'notif.markAllRead': string;
  'notif.all': string;
  'notif.unread': string;
  'notif.loading': string;
  'notif.emptyUnread': string;
  'notif.emptyUnreadDesc': string;
  'notif.empty': string;
  'notif.emptyDesc': string;
  'notif.typeTicket': string;
  'notif.typeKol': string;
  'notif.typeSystem': string;
  'notif.typeAlert': string;
  'notif.fetchError': string;
  'notif.markReadError': string;
  'notif.deleteError': string;
  'notif.markRead': string;
  'notif.delete': string;
  'prompt.title': string;
  'prompt.search': string;
  'prompt.allCats': string;
  'prompt.empty': string;
  'prompt.emptyDesc': string;
  'prompt.useBtn': string;
  'prompt.usedCount': string;
  'prompt.catOps': string;
  'prompt.catDev': string;
  'prompt.catDevOps': string;
  'prompt.catCreative': string;
  'prompt.catAnalysis': string;
  'prompt.catGeneral': string;
  'task.title': string;
  'task.autoRefresh': string;
  'task.paused': string;
  'task.total': string;
  'task.completed': string;
  'task.failed': string;
  'task.avgDuration': string;
  'task.statusRunning': string;
  'task.statusCompleted': string;
  'task.statusFailed': string;
  'task.statusQueued': string;
  'task.empty': string;
  'task.emptyRunning': string;
  'task.emptyCompleted': string;
  'task.emptyFailed': string;
  'task.emptyQueued': string;
  'task.backToChat': string;
  'task.running': string;

  // Ticket Manager
  'ticket.title': string;
  'ticket.total': string;
  'ticket.search': string;
  'ticket.allStatus': string;
  'ticket.allPriority': string;
  'ticket.allCategory': string;
  'ticket.createTicket': string;
  'ticket.noTickets': string;
  'ticket.noTicketsHint': string;
  'ticket.status.open': string;
  'ticket.status.inProgress': string;
  'ticket.status.resolved': string;
  'ticket.status.closed': string;
  'ticket.priority.critical': string;
  'ticket.priority.high': string;
  'ticket.priority.medium': string;
  'ticket.priority.low': string;
  'ticket.form.title': string;
  'ticket.form.description': string;
  'ticket.form.category': string;
  'ticket.form.priority': string;
  'ticket.form.submit': string;
  'ticket.form.cancel': string;
  'ticket.assignee': string;
  'ticket.createdAt': string;
  'ticket.updatedAt': string;
  'ticket.addComment': string;
  'ticket.commentPlaceholder': string;
  'ticket.submitComment': string;
  'ticket.noComments': string;
  'ticket.aiAnalysis': string;
  'ticket.changeStatus': string;
  'ticket.changePriority': string;
  'ticket.created': string;
  'ticket.createFailed': string;
  'ticket.statusUpdated': string;
  'ticket.statusUpdateFailed': string;
  'ticket.autoAssigned': string;
  'ticket.noAssignRule': string;
  'ticket.aiRecommend': string;
  'ticket.aiAnalyzing': string;
  'ticket.aiApply': string;
  'ticket.aiApplied': string;
  'ticket.aiCategory': string;
  'ticket.aiPriority': string;
  'ticket.cat.general': string;
  'ticket.cat.product': string;
  'ticket.cat.shipping': string;
  'ticket.cat.payment': string;
  'ticket.cat.refund': string;
  'ticket.cat.account': string;
  'ticket.form.descPlaceholder': string;
  'ticket.form.titlePlaceholder': string;
  'ticket.form.customerName': string;
  'ticket.form.customerPlatform': string;
  'ticket.form.selectPlatform': string;
  'ticket.detail.customer': string;
  'ticket.detail.email': string;
  'ticket.detail.platform': string;
  'ticket.detail.assignee': string;
  'ticket.detail.autoAssign': string;
  // store error messages
  'store.err.systemBusy': string;
  'store.err.waitingSeconds': string;
  'store.err.taskTimeout': string;
  'store.err.taskFailed': string;
  'store.err.sendFailed': string;
  'store.err.retrying409': string;
  'store.err.chatBusy': string;
  'store.err.tooFrequent': string;
  'store.err.loginExpired': string;
  'store.err.chatNotFound': string;
  'store.err.serverError': string;
  'store.err.requestTimeout': string;
  'store.err.networkFailed': string;
  'store.err.regenerateFailed': string;
  'store.err.serverErrorShort': string;
  // Home page
  'home.title': string;
  'home.subtitle': string;
  'home.startChat': string;
  // export utils
  'export.mdTitle': string;
  'export.model': string;
  'export.taskType': string;
  'export.thinking': string;
  'export.toolCalls': string;
  'export.toolName': string;
  'export.args': string;
  'export.result': string;
  'export.status': string;
  'export.steps': string;
  'export.stepName': string;
  'export.detail': string;
  // ErrorBoundary
  'error.unexpectedError': string;
  'error.reloadPage': string;
  'error.backToHome': string;
  'error.showDetails': string;
  'error.hideDetails': string;
  'error.autoRetryAttempted': string;
  'error.componentStack': string;
  'network.offline': string;
  'network.backOnline': string;
  // ModelSelector
  'model.smartRouterName': string;
  'model.smartRouterDesc': string;
  'model.claudeDesc': string;
  'model.deepseekV4Desc': string;
  'model.gpt55Desc': string;
  'model.gpt54MiniDesc': string;
  'model.geminiFlashDesc': string;
  'model.gpt5MiniDesc': string;
  'model.gpt4Desc': string;
  'model.gpt4oDesc': string;
  'model.gpt4oMiniDesc': string;
  'model.tierAuto': string;
  'model.tierPremium': string;
  'model.tierFast': string;
  'model.tierReasoning': string;
  'model.currentModel': string;
  'model.selectModel': string;
  // TagManager
  'tag.title': string;
  'tag.noTags': string;
  'tag.inputPlaceholder': string;
  'tag.add': string;
  'tag.existingTags': string;
  // FileUploadButton
  'upload.fileTooLarge': string;
  'upload.uploadImage': string;
  'upload.uploadFile': string;
  // AttachmentPreview
  'attachment.failed': string;
  // MessageAttachments
  'attachment.openInNewTab': string;
  // AIFileOutput
  'aiFile.generatedFiles': string;
  'aiFile.openInNewTab': string;
  'aiFile.copyCode': string;
  'aiFile.downloadFile': string;
  'aiFile.collapse': string;
  'aiFile.expandAll': string;
  'aiFile.lines': string;
  // ShareDialog
  'share.title': string;
  'share.loadFailed': string;
  'share.sharedTo': string;
  'share.shareFailed': string;
  'share.cancelShareConfirm': string;
  'share.cancelShareFailed': string;
  'share.conversation': string;
  'share.loading': string;
  'share.noShareableUsers': string;
  'share.selectUser': string;
  'share.readOnly': string;
  'share.readWrite': string;
  'share.shared': string;
  'share.notSharedYet': string;
  'share.readWriteLabel': string;
  'share.readOnlyLabel': string;
  'share.cancelShare': string;
  'share.readOnlyHint': string;
  'share.copyLink': string;
  'share.linkCopied': string;
  // RoleSelector
  'role.selectRole': string;
  'role.role': string;
  'role.aiRoles': string;
  'role.aiRolesHint': string;
  // KnowledgeReferences
  'kref.title': string;
  // SearchResultCards
  'searchCards.results': string;
  // NotificationCenter - relative time
  'notif.justNow': string;
  'notif.minutesAgo': string;
  'notif.hoursAgo': string;
  'notif.daysAgo': string;

  // Unified time formatting
  'time.justNow': string;
  'time.minutesAgo': string;
  'time.hoursAgo': string;
  'time.daysAgo': string;
  'time.neverRun': string;

  // Sidebar tag colors (these are data keys, keep as-is)
  // CapabilitiesPanel skill categories (data keys)
  // StatsPage
  'stats.codeBlock': string;
  // Team extra
  'team.noDepts2': string;
  'team.noDeptsHint2': string;
  'team.noDesc2': string;
  'team.managerColon2': string;

  // CEO Dashboard & Analytics
  'sidebar.ceoDashboard': string;
  'sidebar.dataAnalytics': string;
  'sidebar.dailyReports': string;
  'sidebar.opsEfficiency': string;
  // Browser Preview
  'browserPreview.noScreenshots': string;
  'browserPreview.hint': string;
  'browserPreview.connecting': string;
  'browserPreview.takeOver': string;
  'browserPreview.returnControl': string;
  'browserPreview.browserOffline': string;
  // Input & Toast
  'input.stopping': string;
  'toast.waitForAI': string;
  // Chat roles
  'chat.ai': string;
  'chat.system': string;
  'chat.user': string;
};

// ─── Language packs ─────────────────────────────────────────

const zhCN: TranslationKeys = {
  // Sidebar
  'sidebar.newChat': '新建',
  'sidebar.searchPlaceholder': '搜索对话标题和内容...',
  'sidebar.sharedChats': '共享给我的对话',
  'sidebar.batchManage': '批量管理',
  'sidebar.promptTemplates': '提示词模板',
  'sidebar.aiCapabilities': 'AI 能力中心',
  'sidebar.stats': '系统统计',
  'sidebar.inviteCodes': '管理邀请码',
  'sidebar.logout': '退出登录',
  'sidebar.admin': '管理员',
  'sidebar.member': '成员',
  'sidebar.collapseSidebar': '收起侧边栏',
  'sidebar.expandSidebar': '展开侧边栏',
  'sidebar.aiReady': 'AI 就绪',
  'sidebar.aiOffline': 'AI 离线',
  'sidebar.connected': '已连接',
  'sidebar.disconnected': '未连接',
  'sidebar.deleteConfirm': '确定删除这个对话吗？',
  'sidebar.rename': '重命名',
  'sidebar.delete': '删除',

  // Chat
  'chat.inputPlaceholder': '输入消息，Enter 发送',
  'chat.send': '发送消息',
  'chat.uploadFile': '上传文件',
  'chat.currentModel': '当前模型',
  'chat.manageTags': '管理标签',
  'chat.exportChat': '导出对话',
  'chat.openFilePanel': '打开文件面板',
  'chat.copyMessage': '复制消息',
  'chat.regenerate': '重新生成',
  'chat.thinking': '思考中',
  'chat.toolCalls': '个工具调用',
  'chat.allSuccess': '全部成功',
  'chat.steps': '个步骤',

  // Capabilities Panel
  'capabilities.title': 'AI 能力中心',
  'capabilities.skills': '技能',
  'capabilities.tools': '工具',
  'capabilities.caps': '能力',
  'capabilities.searchSkills': '搜索技能...',
  'capabilities.searchTools': '搜索工具...',
  'capabilities.noResults': '没有匹配的结果',

  // Prompt Templates
  'prompts.title': '提示词模板',
  'prompts.searchPlaceholder': '搜索提示词...',
  'prompts.usePrompt': '使用',
  'prompts.noPrompts': '暂无提示词模板',
  'prompts.category': '分类',
  'prompts.allCategories': '全部分类',

  // Stats
  'stats.title': '系统统计',
  'stats.refresh': '刷新',
  'stats.totalChats': '总对话',
  'stats.totalMessages': '总消息',
  'stats.totalUsers': '总用户',
  'stats.database': '数据库',
  'stats.messageTrend': '消息趋势（近7天）',
  'stats.roleDistribution': '消息角色分布',
  'stats.modelUsage': '模型使用',
  'stats.routingComplexity': '路由复杂度分布',
  'stats.hotTags': '热门标签',
  'stats.userActivity': '用户活跃度',
  'stats.recentRouting': '最近路由记录',
  'stats.user': '用户',
  'stats.role': '角色',
  'stats.chatCount': '对话数',
  'stats.messageCount': '消息数',
  'stats.lastLogin': '最后登录',
  'stats.userMessages': '用户消息',
  'stats.aiReplies': 'AI回复',
  'stats.fetchError': '加载统计数据失败',
  'workflow.loadError': '加载工作流失败',
  'workflow.saveError': '保存工作流失败',
  'workflow.deleteError': '删除工作流失败',
  'workflow.duplicateError': '复制工作流失败',
  'taskQueue.loadError': '加载任务列表失败',
  'prompt.loadError': '加载提示词模板失败',
  'chatPage.exportError': '导出对话失败',

  // Common
  'common.loading': '加载中...',
  'common.error': '出错了',
  'common.retry': '重试',
  'common.cancel': '取消',
  'common.confirm': '确认',
  'common.save': '保存',
  'common.back': '返回',
  'common.noData': '暂无数据',
  'common.copied': '已复制',
  'common.featureComingSoon': '功能即将上线',
  'common.language': '语言',

  // Sidebar Navigation
  'sidebar.conversations': '对话',
  'sidebar.capabilities': '能力',
  'sidebar.knowledge': '知识库',
  'sidebar.workflows': '工作流',
  'sidebar.tasks': '任务',
  'sidebar.tickets': '工单',
  'sidebar.kol': 'KOL',
  'sidebar.notifications': '通知',
  'sidebar.console': '控制台',
  'sidebar.navGroupTools': 'AI 工具',
  'sidebar.navGroupAdmin': '管理',
  'sidebar.team': '团队',
  'sidebar.globalSearch': '全局搜索... (Ctrl+K)',
  'sidebar.tagFilter': '标签筛选',
  'sidebar.noSharedChats': '暂无共享对话',
  'sidebar.from': '来自',
  'sidebar.selected': '已选',
  'sidebar.selectAll': '全选',
  'sidebar.deselectAll': '取消全选',
  'sidebar.noMatchingChats': '没有找到匹配的对话',
  'sidebar.noTagChats': '没有此标签的对话',
  'sidebar.noChatsYet': '还没有对话',
  'sidebar.chatList': '对话列表',
  'sidebar.clickNewToStart': '点击上方"新建"开始',
  'sidebar.noKnowledgeOrWorkflow': '未找到知识库或工作流结果',
  'sidebar.foundChats': '个对话',
  'sidebar.searching': '搜索中...',
  'sidebar.aiStarting': '启动中',
  'sidebar.reconnecting': '重连中',
  'sidebar.disconnectedShort': '断开',
  'sidebar.newConversation': '新对话',
  'sidebar.exitBatchMode': '退出多选',

  // Toast messages
  'toast.createChatFailed': '创建对话失败',
  'toast.renameFailed': '重命名失败',
  'toast.renameSuccess': '重命名成功',
  'toast.deleteFailed': '删除失败',
  'toast.deleteSuccess': '对话已删除',
  'toast.batchDeleteFailed': '批量删除失败',
  'toast.batchDeleteSuccess': '已删除',
  'toast.exportFailed': '导出失败，请重试',
  'toast.copySuccess': '已复制到剪贴板',
  'toast.copyFailed': '复制失败',

  // ChatPage
  'chatPage.exportConversation': '导出对话',
  'chatPage.exportMarkdown': '导出 Markdown',
  'chatPage.exportJson': '导出 JSON',
  'chatPage.collapseSidebar': '收起侧边栏',
  'chatPage.expandSidebar': '展开侧边栏',
  'chatPage.aiConnected': 'AI 引擎已连接',
  'chatPage.wsConnectedAiConnecting': 'WebSocket 已连接，AI 连接中...',
  'chatPage.disconnectedReconnecting': '连接断开，重连中...',
  'chatPage.connected': '已连接',
  'chatPage.aiConnecting': 'AI 连接中',
  'chatPage.reconnecting': '重连中',
  'chatPage.manageTags': '管理标签',
  'chatPage.openFilePanel': '打开文件面板',
  'chatPage.closeFilePanel': '关闭文件面板',
  'chatPage.viewFiles': '查看文件',
  'chatPage.workspaceFiles': '工作区文件',
  'chatPage.changes': '变更',
  'chatPage.backToList': '返回列表',
  'chatPage.binaryFile': '二进制文件，无法预览',
  'chatPage.noWorkspaceFiles': '暂无工作区文件',
  'chatPage.filesAppearHere': '当 AI 创建或修改文件时，文件将自动显示在这里',

  // LoginPage
  'login.subtitle': '游侠出海 AI 中台',
  'login.loginTab': '登录',
  'login.registerTab': '注册',
  'login.username': '用户名',
  'login.usernamePlaceholder': '请输入用户名',
  'login.password': '密码',
  'login.passwordPlaceholder': '请输入密码',
  'login.passwordMinLength': '至少6位',
  'login.confirmPassword': '确认密码',
  'login.confirmPasswordPlaceholder': '再次输入密码',
  'login.inviteCode': '邀请码',
  'login.inviteCodeHint': '请向管理员获取邀请码',
  'login.loggingIn': '登录中...',
  'login.registering': '注册中...',
  'login.loginButton': '登录',
  'login.registerButton': '注册',
  'login.noAccountHint': '没有账号？点击上方“注册”标签，使用邀请码注册',
  'login.hasAccountHint': '已有账号？点击上方“登录”标签',
  'login.errorEmptyFields': '请输入用户名和密码',
  'login.errorPasswordMismatch': '两次输入的密码不一致',
  'login.errorPasswordTooShort': '密码至少6位',
  'login.errorNoInviteCode': '请输入邀请码',
  'login.errorLoginFailed': '登录失败',
  'login.errorRegisterFailed': '注册失败',
  'validation.usernameTooShort': '用户名至少 2 个字符',
  'validation.usernameTooLong': '用户名不超过 30 个字符',
  'validation.fieldRequired': '此字段不能为空',
  'validation.nameTooLong': '名称过长',

  // MessageInput
  'input.imageAttachment': '图片',
  'input.fileAttachment': '文件',
  'input.dropFilesHere': '拖放文件到这里',
  'input.supportsImagesAndDocs': '支持图片和文档',
  'input.connecting': '连接中...',
  'input.aiReplying': 'AI 正在回复...',
  'input.placeholder': '输入消息，Enter 发送，Shift+Enter 换行',
  'input.placeholderMobile': '输入消息...',
  'input.ariaLabel': '输入消息',
  'input.processing': '正在处理',
  'input.uploading': '文件上传中...',
  'input.send': '发送',
  'input.sendMessage': '发送消息',
  'input.footer': 'RangerAI · 游侠出海 AI 中台',

  'model.smartRouter': '智能路由',

  // MessageList — Task types
  'msg.taskType.code': '代码',
  'msg.taskType.reasoning': '推理',
  'msg.taskType.creative': '创作',
  'msg.taskType.research': '研究',
  'msg.taskType.imageGeneration': '图片生成',
  'msg.taskType.chat': '对话',
  'msg.thinking.low': '轻量',
  'msg.thinking.medium': '标准',
  'msg.thinking.high': '深度',
  'msg.thinking.xhigh': '极深',
  'msg.thinkingSuffix': '思考',

  // Skill categories
  'msg.skillCat.ops': '运维',
  'msg.skillCat.security': '安全',
  'msg.skillCat.network': '网络',
  'msg.skillCat.monitoring': '监控',
  'msg.skillCat.deploy': '部署',
  'msg.skillCat.backup': '备份',
  'msg.skillCat.log': '日志',
  'msg.skillCat.cost': '成本',
  'msg.skillCat.env': '环境',
  'msg.skillCat.cron': '定时',
  'msg.skillCat.evolve': '进化',
  'msg.skillCat.creation': '创作',
  'msg.skillCat.query': '查询',
  'msg.skillCat.dev': '开发',
  'msg.skillCat.mgmt': '管理',

  // Tool labels
  'msg.tool.webSearch': '网络搜索',
  'msg.tool.webFetch': '网页获取',
  'msg.tool.browser': '浏览器',
  'msg.tool.terminal': '终端',
  'msg.tool.readFile': '读取文件',
  'msg.tool.writeFile': '写入文件',
  'msg.tool.editFile': '编辑文件',
  'msg.tool.genImage': '生成图片',
  'msg.tool.canvas': '画布',
  'msg.tool.tts': '语音合成',
  'msg.tool.codeExec': '代码执行',
  'msg.tool.memorySearch': '搜索记忆',
  'msg.tool.memoryGet': '获取记忆',

  // Tool display titles
  'msg.toolTitle.search': '搜索',
  'msg.toolTitle.fetch': '获取',
  'msg.toolTitle.browserAction': '浏览器',
  'msg.toolTitle.execCmd': '执行命令',
  'msg.toolTitle.read': '读取',
  'msg.toolTitle.write': '写入',
  'msg.toolTitle.edit': '编辑',
  'msg.toolTitle.genImage': '生成图片',
  'msg.toolTitle.canvasOp': '画布操作',
  'msg.toolTitle.tts': '语音合成',
  'msg.toolTitle.memSearch': '搜索记忆',
  'msg.toolTitle.memGet': '获取记忆',
  'msg.toolTitle.file': '文件',

  // Execution timeline
  'msg.exec.running': '正在执行',
  'msg.exec.done': '执行完成',
  'msg.exec.steps': '步骤',

  // Tool card labels
  'msg.card.params': '参数',
  'msg.card.result': '结果',
  'msg.card.browserScreenshot': '浏览器截图',
  'msg.card.generatedImage': '生成图片',
  'msg.card.imageGenerating': '图片生成中...',

  // Image preview
  'msg.preview.imagePreview': '图片预览',
  'msg.preview.closePreview': '关闭图片预览',
  'msg.preview.viewLarger': '查看大图',
  'msg.preview.browserScreenshot': '浏览器截图',
  'msg.preview.closeSsPreview': '关闭截图预览',

  // Persisted tool summary
  'msg.summary.toolCalls': '个工具调用',
  'msg.summary.success': '成功',
  'msg.summary.fail': '失败',
  'msg.summary.allSuccess': '全部成功',
  'msg.summary.stepsCount': '个步骤',
  'msg.summary.expandAll': '... 展开全部',
  'msg.summary.collapse': '收起',
  'msg.summary.viewTerminal': '查看终端输出',

  // Message actions
  'msg.action.copied': '已复制',
  'msg.action.copyMsg': '复制消息',
  'msg.action.copy': '复制',
  'msg.action.regenerate': '重新生成',

  // Streaming / thinking
  'msg.stream.deepThinking': '深度思考中',
  'msg.stream.thinking': '正在思考...',
  'msg.stream.analyzing': '正在分析...',
  'msg.stream.close': '关闭',
  'msg.phase.executing': '正在执行',
  'msg.phase.outputting': '正在输出',
  'msg.scrollToBottom': '滚动到底部',

  // Welcome page
  'msg.welcome.subtitle': '游侠出海 AI 中台 — 拥有 94 项专业技能的智能助手',
  'msg.welcome.modelRoute': '支持 23+ AI 模型智能路由 · 自动选择最优技能组合',
  'msg.welcome.describeNeeds': '描述你的需求，RangerAI 会自动选择最合适的技能组合',
  'msg.welcome.cap.webSearch': '网络搜索与分析',
  'msg.welcome.cap.webSearchDesc': '实时搜索、网页抓取、数据提取与竞品分析',
  'msg.welcome.cap.codeDev': '代码开发与调试',
  'msg.welcome.cap.codeDevDesc': '全栈开发、代码审查、Bug 修复与自动化脚本',
  'msg.welcome.cap.dataViz': '数据处理与可视化',
  'msg.welcome.cap.dataVizDesc': '数据清洗、统计分析、图表生成与报告撰写',
  'msg.welcome.cap.securityOps': '安全审计与运维',
  'msg.welcome.cap.securityOpsDesc': '服务器巡检、漏洞扫描、性能监控与部署管理',
  'msg.welcome.cap.contentDesign': '内容创作与设计',
  'msg.welcome.cap.contentDesignDesc': '文案撰写、图片生成、多语言翻译与 SEO 优化',
  'msg.welcome.cap.fileMgmt': '文件处理与管理',
  'msg.welcome.cap.fileMgmtDesc': '文档转换、PDF 解析、批量处理与云端同步',
  'msg.welcome.cap.aiModel': 'AI 模型与推理',
  'msg.welcome.cap.aiModelDesc': '智能路由 23+ 模型、多轮对话、深度思考与专家级回答',
  'msg.welcome.cap.sysIntegration': '系统集成与 API',
  'msg.welcome.cap.sysIntegrationDesc': 'REST API 调用、数据库操作、第三方服务对接',
  'msg.welcome.cap.docReport': '文档与报告生成',
  'msg.welcome.cap.docReportDesc': '技术文档、商业报告、研究分析与知识库整理',
  'msg.welcome.cap.multiLang': '多语言与本地化',
  'msg.welcome.cap.multiLangDesc': '中英日韩等多语种翻译、出海内容本地化与文化适配',
  'msg.welcome.cap.browserAuto': '浏览器自动化',
  'msg.welcome.cap.browserAutoDesc': '网页操作、表单填写、截图审查与自动化测试',
  'msg.welcome.cap.taskOrch': '任务编排与自动化',
  'msg.welcome.cap.taskOrchDesc': '多步骤任务编排、定时执行、工作流自动化',
  'msg.welcome.cap.smartChat': '智能对话与咨询',
  'msg.welcome.cap.smartChatDesc': '专业问答、商业咨询、技术支持与决策建议',
  'msg.welcome.cap.research': '研究与情报分析',
  'msg.welcome.cap.researchDesc': '行业研究、市场情报、技术趋势与竞争分析',
  'msg.welcome.cap.projectMgmt': '项目管理与协作',
  'msg.welcome.cap.projectMgmtDesc': '任务跟踪、团队协作、进度管理与资源分配',
  // Admin Dashboard
  'admin.title': '管理控制台',
  'admin.running': '运行',
  'admin.version': 'v',
  'admin.tab.overview': '总览',
  'admin.tab.system': '系统监控',
  'admin.tab.users': '用户管理',
  'admin.tab.config': '系统配置',
  'admin.tab.roles': 'AI角色',
  'admin.tab.audit': '操作日志',
  'admin.tab.assignRules': '分配规则',
  'admin.tab.openPlatform': '开放平台',
  'admin.tab.services': '服务管理',
  'admin.nav.monitor': '监控',
  'admin.nav.manage': '管理',
  'admin.nav.ops': '运维',
  'admin.nav.ai': 'AI 智能',
  'admin.tab.toolMemory': '工具记忆',
  'admin.toolMemory.title': '自适应工具记忆',
  'admin.toolMemory.totalRecords': '总记录数',
  'admin.toolMemory.subTypeStats': '工具子类型统计',
  'admin.toolMemory.topTools': '最常用工具',
  'admin.toolMemory.recentPatterns': '最近任务模式',
  'admin.toolMemory.hitCount': '命中次数',
  'admin.toolMemory.successRate': '成功率',
  'admin.toolMemory.avgDuration': '平均耗时',
  'admin.toolMemory.noData': '暂无工具记忆数据',
  'admin.refresh': '刷新数据',
  'admin.collapse': '收起侧栏',
  'admin.acp.service': 'ACP 网关',
  'admin.acp.activeKeys': '活跃密钥',
  'admin.acp.asyncTasks': '异步任务',
  'admin.acp.dingtalk': '钉钉适配器',
  'admin.acp.connected': '已连接',
  'admin.acp.disconnected': '已断开',
  'admin.acp.disabled': '未启用',
  'admin.acp.apiKeys': 'API 密钥管理',
  'admin.acp.apiKeysDesc': '管理外部系统通过 ACP 网关调用 RangerAI 的 API 密钥',
  'admin.acp.createKey': '创建密钥',
  'admin.acp.newKey': '创建新的 API 密钥',
  'admin.acp.keyName': '密钥名称',
  'admin.acp.keyNamePlaceholder': '例如：钉钉机器人、CRM 系统',
  'admin.acp.nameRequired': '请输入密钥名称',
  'admin.acp.generate': '生成',
  'admin.acp.keyCreated': 'API 密钥已创建',
  'admin.acp.keyCreatedHint': '请立即复制保存，此密钥仅显示一次，关闭后无法再次查看。',
  'admin.acp.copy': '复制',
  'admin.acp.copied': '已复制',
  'admin.acp.noKeys': '暂无 API 密钥',
  'admin.acp.noKeysHint': '创建一个 API 密钥以允许外部系统调用 RangerAI',
  'admin.acp.thName': '名称',
  'admin.acp.thKeyPrefix': '密钥前缀',
  'admin.acp.thStatus': '状态',
  'admin.acp.thCalls': '调用次数',
  'admin.acp.thLastUsed': '最后使用',
  'admin.acp.thCreatedAt': '创建时间',
  'admin.acp.thActions': '操作',
  'admin.acp.statusActive': '活跃',
  'admin.acp.statusRevoked': '已吊销',
  'admin.acp.revoke': '吊销',
  'admin.acp.revokeConfirm': '确认吊销密钥',
  'admin.acp.revokeMsg': '确定要吊销此 API 密钥吗？吊销后将无法恢复：',
  'admin.acp.envKeyNoRevoke': '环境变量配置的密钥无法通过界面吊销',
  'admin.acp.apiDocs': 'API 接口文档',
  'admin.acp.docSyncChat': '同步对话（等待回复）',
  'admin.acp.docAsyncChat': '异步对话（立即返回任务 ID）',
  'admin.acp.docTaskStatus': '查询异步任务状态',
  'admin.acp.docKnowledge': '知识库检索',
  'admin.acp.usageExample': '使用示例：',
  'admin.status.running': '运行中',
  'admin.status.healthy': '健康',
  'admin.status.degraded': '降级',
  'admin.status.loadFailed': '加载失败',
  'admin.status.noData': '无系统数据',
  'admin.status.loading': '加载中...',
  'admin.overview.totalLabel': '共',
  'admin.overview.pending': '待处理',
  'admin.overview.inProgress': '处理中',
  'admin.overview.resolved': '已解决',
  'admin.overview.closed': '已关闭',
  'admin.overview.totalKol': '总 KOL',
  'admin.overview.cooperating': '合作中',
  'admin.overview.totalCooperation': '总合作',
  'admin.overview.trendNew': '新建',
  'admin.overview.trendResolved': '解决',
  'admin.overview.cpuLoad': 'CPU负载',
  'admin.overview.cores': '核',
  'admin.overview.serviceStatus': '服务状态',
  'admin.overview.uptime': '运行时间',
  'admin.overview.dbUsers': '用户数',
  'admin.overview.dbChats': '会话数',
  'admin.overview.dbMessages': '消息数',
  'admin.overview.dbSize': '数据库大小',
  'admin.overview.heapUsed': '堆内存',
  'admin.overview.rss': 'RSS内存',
  'admin.overview.activeTasks': '活跃任务',
  'admin.overview.noActiveTasks': '无活跃任务',
  'admin.overview.elapsedSec': '秒',
  'admin.overview.ticketStats': '工单统计',
  'admin.overview.kolStats': 'KOL 统计',
  'admin.overview.ticketTrend': '工单趋势',
  'admin.system.memory': '系统内存',
  'admin.system.used': '已用',
  'admin.system.total': '总共',
  'admin.system.usageRate': '使用率',
  'admin.system.free': '空闲',
  'admin.system.disk': '磁盘',
  'admin.system.diskUsed': '已用',
  'admin.system.diskAvailable': '可用',
  'admin.system.platform': '平台',
  'admin.system.nodeVersion': 'Node版本',
  'admin.system.pid': '进程PID',
  'admin.system.processMemory': '进程内存',
  'admin.system.browserStatus': '浏览器状态',
  'admin.system.circuitBreaker': '熔断器',
  'admin.system.failCount': '失败次数',
  'admin.system.lastFail': '最近失败',
  'admin.system.recoverBrowser': '恢复浏览器',
  'admin.system.resetBreaker': '重置熔断器',
  'admin.system.breakerClosed': '正常',
  'admin.system.breakerOpen': '已熔断',
  'admin.system.breakerHalfOpen': '半开',
  'admin.system.opSuccess': '操作成功',
  'admin.system.opFailed': '操作失败',
  'admin.system.ports': '端口状态',
  'admin.system.halfOpenAttempts': '半开尝试',
  'admin.system.sysInfo': '系统信息',
  'admin.users.search': '搜索用户...',
  'admin.users.roleAdmin': '管理员',
  'admin.users.roleMember': '成员',
  'admin.users.confirmRoleChange': '确定将此用户角色更改为',
  'admin.users.demoteToMember': '降为成员',
  'admin.users.promoteToAdmin': '升为管理员',
  'admin.users.thName': '用户名',
  'admin.users.thRole': '角色',
  'admin.users.thMessages': '消息数',
  'admin.users.thChats': '会话数',
  'admin.users.thLastActive': '最近活跃',
  'admin.users.thActions': '操作',
  'admin.config.catGeneral': '通用',
  'admin.config.catAI': 'AI引擎',
  'admin.config.catGateway': 'Gateway',
  'admin.config.catStorage': '存储',
  'admin.config.catAuth': '认证',
  'admin.config.noConfig': '无配置项',
  'admin.roles.addRole': '新增角色',
  'admin.roles.create': '创建',
  'admin.roles.save': '保存',
  'admin.roles.noRoles': '无AI角色',
  'admin.roles.editRole': '编辑角色',
  'admin.roles.deleteConfirm': '确定删除此角色？',
  'admin.audit.totalRecords': '条记录',
  'admin.audit.noLogs': '暂无操作日志',
  'admin.audit.noLogsHint': '系统配置变更和角色管理操作将记录在此',
  'admin.audit.thTime': '时间',
  'admin.audit.thOperator': '操作者',
  'admin.audit.thAction': '操作',
  'admin.audit.thTarget': '目标',
  'admin.audit.thDetail': '详情',
  'admin.audit.prevPage': '上一页',
  'admin.audit.nextPage': '下一页',
  'admin.audit.configUpdate': '配置更新',
  'admin.audit.roleCreate': '创建角色',
  'admin.audit.roleUpdate': '更新角色',
  'admin.audit.roleDelete': '删除角色',
  'admin.assign.title': '工单分配规则',
  'admin.assign.addRule': '新增规则',
  'admin.assign.editRule': '编辑规则',
  'admin.assign.newRule': '新增规则',
  'admin.assign.category': '工单分类',
  'admin.assign.priority': '优先级范围',
  'admin.assign.assignee': '处理人',
  'admin.assign.update': '更新',
  'admin.assign.createBtn': '创建',
  'admin.assign.cancel': '取消',
  'admin.assign.noRules': '暂无分配规则',
  'admin.assign.noRulesHint': '点击“新增规则”开始配置工单自动分配',
  'admin.assign.thCategory': '分类',
  'admin.assign.thPriority': '优先级',
  'admin.assign.thAssignee': '处理人',
  'admin.assign.thCreatedAt': '创建时间',
  'admin.assign.thActions': '操作',
  'admin.assign.ruleExplanation': '分配规则说明',
  'admin.assign.ruleHint1': '新工单创建时，AI 会自动分析内容并推荐分类和优先级',
  'admin.assign.ruleHint2': '系统根据分类和优先级匹配对应的分配规则，自动分配处理人',
  'admin.assign.ruleHint3': '优先级为“所有优先级”的规则会匹配该分类下的所有工单',
  'admin.assign.ruleHint4': '如果没有匹配到精确规则，会尝试匹配“默认（兆底）”分类的规则',
  'admin.assign.ruleHint5': '匹配优先级：精确分类+精确优先级 > 精确分类+所有优先级 > 默认分类',
  'admin.cat.payment': '支付问题',
  'admin.cat.account': '账户问题',
  'admin.cat.technical': '技术问题',
  'admin.cat.shipping': '物流问题',
  'admin.cat.refund': '退款问题',
  'admin.cat.general': '一般咨询',
  'admin.cat.default': '默认（兆底）',
  'admin.priority.all': '所有优先级',
  'admin.priority.critical': '紧急',
  'admin.priority.high': '高',
  'admin.priority.medium': '中',
  'admin.priority.low': '低',
  'admin.priority.urgent': '紧急',
  'admin.time.days': '天',
  'admin.time.hours': '小时',
  'admin.time.minutes': '分钟',

  // KOL Manager
  'kol.title': 'KOL 管理',
  'kol.total': '总 KOL',
  'kol.platformCoverage': '平台覆盖',
  'kol.cooperating': '合作中',
  'kol.totalCooperation': '总合作',
  'kol.search': '搜索 KOL 名称、平台账号...',
  'kol.allPlatforms': '全部平台',
  'kol.addKol': '添加 KOL',
  'kol.addFirst': '添加第一个 KOL',
  'kol.noData': '暂无 KOL 数据',
  'kol.noDataHint': '添加 KOL 以开始管理达人资源',
  'kol.editKol': '编辑 KOL',
  'kol.refreshData': '刷新数据',
  'kol.refreshing': '刷新中...',
  'kol.refreshed': '已刷新 KOL 数据',
  'kol.refreshFailed': '刷新失败',
  'kol.addSuccess': 'KOL 添加成功',
  'kol.addFailed': 'KOL 添加失败',
  'kol.updateSuccess': 'KOL 信息已更新',
  'kol.updateFailed': 'KOL 更新失败',
  'kol.deleteConfirm': '确定删除此 KOL？',
  'kol.deleteSuccess': 'KOL 已删除',
  'kol.deleteFailed': 'KOL 删除失败',
  'kol.followers': '粉丝',
  'kol.engagementRate': '互动率',
  'kol.region': '地区',
  'kol.status.active': '活跃',
  'kol.status.inactive': '不活跃',
  'kol.status.blacklisted': '黑名单',
  'kol.status.pending': '待审核',
  'kol.coop.none': '未联系',
  'kol.coop.contacted': '已联系',
  'kol.coop.negotiating': '洽谈中',
  'kol.coop.contracted': '已签约',
  'kol.coop.completed': '已完成',
  'kol.form.name': '名称',
  'kol.form.platform': '平台',
  'kol.form.handle': '账号',
  'kol.form.followers': '粉丝数',
  'kol.form.category': '分类',
  'kol.form.country': '国家/地区',
  'kol.form.language': '语言',
  'kol.form.email': '联系邮箱',
  'kol.form.coopStatus': '合作状态',
  'kol.form.notes': '备注',
  'kol.form.save': '保存',
  'kol.form.add': '添加',
  'kol.form.cancel': '取消',
  'kol.cat.gaming': '游戏',
  'kol.cat.beauty': '美妆',
  'kol.cat.tech': '科技',
  'kol.cat.lifestyle': '生活',
  'kol.cat.food': '美食',
  'kol.cat.fashion': '时尚',
  'kol.cat.fitness': '健身',
  'kol.cat.education': '教育',
  // KOL Detail
  'kolDetail.back': '返回',
  'kolDetail.basicInfo': '基本信息',
  'kolDetail.coopHistory': '合作记录',
  'kolDetail.addCoop': '添加合作',
  'kolDetail.noCoop': '暂无合作记录',
  'kolDetail.noCoopHint': '添加合作记录以跟踪合作历史',
  'kolDetail.platform': '平台',
  'kolDetail.handle': '账号',
  'kolDetail.followers': '粉丝数',
  'kolDetail.engagementRate': '互动率',
  'kolDetail.category': '分类',
  'kolDetail.country': '国家/地区',
  'kolDetail.language': '语言',
  'kolDetail.email': '联系邮箱',
  'kolDetail.phone': '联系电话',
  'kolDetail.status': '状态',
  'kolDetail.coopStatus': '合作状态',
  'kolDetail.lastContacted': '最近联系',
  'kolDetail.createdAt': '创建时间',
  'kolDetail.notes': '备注',
  'kolDetail.coopType': '合作类型',
  'kolDetail.coopAmount': '合作金额',
  'kolDetail.coopStartDate': '开始日期',
  'kolDetail.coopEndDate': '结束日期',
  'kolDetail.coopNotes': '合作备注',
  'kolDetail.coopStatusLabel': '合作状态',
  'kolDetail.coopSave': '保存',
  'kolDetail.coopCancel': '取消',
  'kolDetail.coopDeleteConfirm': '确定删除此合作记录？',
  'kolDetail.notFound': '未找到该 KOL',

  'kolDetail.backToList': '返回 KOL 列表',
  'kolDetail.coopCount': '合作次数',
  'kolDetail.totalInvestment': '总投入',
  'kolDetail.addedAt': '添加时间',
  'kolDetail.roiAnalysis': 'ROI 分析',
  'kolDetail.totalBudget': '总预算',
  'kolDetail.actualSpend': '实际花费',
  'kolDetail.budgetUtilization': '预算利用率',
  'kolDetail.avgCoopCost': '平均单次合作成本',
  'kolDetail.completionRate': '完成率',
  'kolDetail.estReach': '预估单次触达',
  'kolDetail.coopHistoryTitle': '合作历史',
  'kolDetail.addCoopRecord': '新增合作',
  'kolDetail.addFirstCoop': '添加第一条合作记录',
  'kolDetail.coopBudget': '预算',
  'kolDetail.coopActual': '实际',
  'kolDetail.coopStatus.planning': '规划中',
  'kolDetail.coopStatus.active': '进行中',
  'kolDetail.coopStatus.completed': '已完成',
  'kolDetail.coopStatus.cancelled': '已取消',
  'kolDetail.campaignType.promotion': '推广',
  'kolDetail.campaignType.review': '测评',
  'kolDetail.campaignType.livestream': '直播',
  'kolDetail.campaignType.sponsored': '赞助',
  'kolDetail.campaignType.affiliate': '联盟',
  'kolDetail.campaignType.other': '其他',
  'kolDetail.form.campaignName': '活动名称',
  'kolDetail.form.campaignType': '活动类型',
  'kolDetail.form.campaignStatus': '状态',
  'kolDetail.form.startDate': '开始日期',
  'kolDetail.form.endDate': '结束日期',
  'kolDetail.form.budget': '预算 ($)',
  'kolDetail.form.actualCost': '实际花费 ($)',
  'kolDetail.form.deliverables': '交付物',
  'kolDetail.form.delivPlaceholder': '例：3条短视频 + 1条直播',
  'kb.title': '知识库',
  'kb.docCount': '篇文档',
  'kb.addKnowledge': '添加知识',
  'kb.searchDebug': '搜索调试',
  'kb.uploadFile': '上传文件',
  'kb.upload': '上传',
  'kb.search': '搜索',
  'kb.searchPlaceholder': '搜索文档标题、内容、标签...',
  'kb.categories': '分类',
  'kb.all': '全部',
  'kb.cat.uncategorized': '未分类',
  'kb.cat.techDoc': '技术文档',
  'kb.cat.productReq': '产品需求',
  'kb.cat.meetingNotes': '会议纪要',
  'kb.cat.knowledgeBase': '知识沉淀',
  'kb.cat.training': '培训资料',
  'kb.cat.standards': '规范标准',
  'kb.cat.apiDoc': 'API文档',
  'kb.textEntry': '文本条目',
  'kb.emptyTitle': '开始构建你的知识库',
  'kb.emptyDesc': '知识库帮你集中管理文档、技术资料和团队知识，让 AI 能更智能地回答你的问题。',
  'kb.emptyUploadFile': '上传文件',
  'kb.emptyUploadHint': 'PDF、Word、图片等',
  'kb.emptyAddText': '添加文本',
  'kb.emptyAddTextHint': '笔记、知识点等',
  'kb.emptyBrowse': '先看看',
  'kb.emptyBrowseHint': '返回对话页',
  'kb.notVectorized': '未向量化',
  'kb.vectorized': '已向量化',
  'kb.retry': '重试',
  'kb.regenerate': '重新生成',
  'kb.vectorBlocks': '个向量块',
  'kb.contentLength': '内容长度',
  'kb.chars': '字符',
  'kb.notVectorizedHint': '该文档无法被语义搜索命中',
  'kb.showing': '显示',
  'kb.total': '共',
  'kb.docs': '篇',
  'kb.prevPage': '上一页',
  'kb.nextPage': '下一页',
  'kb.category': '分类',
  'kb.description': '描述',
  'kb.fileName': '文件名',
  'kb.size': '大小',
  'kb.createdAt': '创建时间',
  'kb.embeddingStatus': 'Embedding 状态',
  'kb.contentPreview': '内容预览',
  'kb.contentTruncated': '... (内容过长，已截断)',
  'kb.deleteDoc': '删除文档',
  'kb.uploadFileTitle': '上传文件',
  'kb.selectFile': '选择文件',
  'kb.supportedFormats': '支持 TXT、Markdown、JSON、CSV、PDF、Word (.docx)',
  'kb.titleLabel': '标题',
  'kb.descLabel': '描述',
  'kb.categoryLabel': '分类',
  'kb.tagsLabel': '标签',
  'kb.tagsCommaSep': '标签（逗号分隔）',
  'kb.cancel': '取消',
  'kb.uploading': '上传中...',
  'kb.addKnowledgeEntry': '添加知识条目',
  'kb.titleRequired': '标题 *',
  'kb.titlePlaceholder': '知识条目标题',
  'kb.contentLabel': '内容',
  'kb.contentPlaceholder': '输入知识内容（支持 Markdown 格式）',
  'kb.saving': '保存中...',
  'kb.save': '保存',
  'kb.uploadSuccess': '文档上传成功',
  'kb.uploadFailed': '文档上传失败',
  'kb.addTextSuccess': '文本内容添加成功',
  'kb.addTextFailed': '文本添加失败',
  'kb.deleteConfirm': '确定删除此文档？',
  'kb.deleteSuccess': '文档已删除',
  'kb.deleteFailed': '文档删除失败',
  'kb.formatTextEntry': '文本条目',
  'kb.customCategory': '自定义分类...',
  'kb.customCategoryPlaceholder': '输入自定义分类名称',
  'kb.tagInputPlaceholder': '输入标签后按回车添加',
  'kb.tagInputHint': '按回车或逗号添加标签，Backspace 删除',
  'wf.title': '工作流',
  'wf.search': '搜索工作流...',
  'wf.create': '创建工作流',
  'wf.noWorkflows': '暂无工作流',
  'wf.noWorkflowsHint': '创建工作流来自动化你的任务',
  'wf.createFirst': '创建第一个工作流',
  'wf.steps': '步骤',
  'wf.lastUpdated': '最后更新',
  'wf.run': '运行',
  'wf.edit': '编辑',
  'wf.delete': '删除',
  'wf.deleteConfirm': '确定删除此工作流？',
  'wf.deleteSuccess': '工作流已删除',
  'wf.deleteFailed': '工作流删除失败',
  'wf.createWorkflow': '创建工作流',
  'wf.editWorkflow': '编辑工作流',
  'wf.name': '名称',
  'wf.namePlaceholder': '工作流名称',
  'wf.description': '描述',
  'wf.descPlaceholder': '工作流描述',
  'wf.addStep': '添加步骤',
  'wf.stepType': '步骤类型',
  'wf.stepPrompt': '提示词',
  'wf.stepAction': '动作',
  'wf.stepCondition': '条件',
  'wf.removeStep': '删除步骤',
  'wf.cancel': '取消',
  'wf.save': '保存',
  'wf.saving': '保存中...',
  'wf.saveSuccess': '工作流保存成功',
  'wf.saveFailed': '工作流保存失败',
  'wf.cron.notSet': '未设置',
  'wf.cron.custom': '自定义',
  'wf.cron.hourly': '每小时',
  'wf.cron.hourlyDesc': '每小时整点执行',
  'wf.cron.daily9': '每天 9:00',
  'wf.cron.daily9Desc': '每天早上 9 点执行',
  'wf.cron.daily18': '每天 18:00',
  'wf.cron.daily18Desc': '每天下午 6 点执行',
  'wf.cron.weekday9': '工作日 9:00',
  'wf.cron.weekday9Desc': '周一至周五早上 9 点',
  'wf.cron.monday9': '每周一 9:00',
  'wf.cron.monday9Desc': '每周一早上 9 点执行',
  'wf.cron.monthly1': '每月 1 号',
  'wf.cron.monthly1Desc': '每月 1 号早上 9 点执行',
  'wf.cat.uncategorized': '未分类',
  'wf.cat.dailyTask': '日常任务',
  'wf.cat.dataAnalysis': '数据分析',
  'wf.cat.contentCreation': '内容创作',
  'wf.cat.codeDev': '代码开发',
  'wf.cat.devops': '运维部署',
  'wf.cat.research': '调研报告',
  'wf.step': '步骤',
  'wf.confirmDelete': '确定删除此工作流？',
  'wf.copy': '副本',
  'wf.neverRun': '从未运行',
  'wf.justNow': '刚刚',
  'wf.minutesAgo': '分钟前',
  'wf.hoursAgo': '小时前',
  'wf.daysAgo': '天前',
  'wf.tpl.searchWeb': '搜索网页',
  'wf.tpl.searchInfo': '搜索信息',
  'wf.tpl.searchPrompt': '请搜索以下关键词的最新信息：[关键词]，并整理出要点。',
  'wf.tpl.analyzeDoc': '分析文档',
  'wf.tpl.analyzeFile': '分析文件',
  'wf.tpl.analyzePrompt': '请分析以下内容，提取关键信息并生成摘要：',
  'wf.tpl.dataAnalysis': '数据分析',
  'wf.tpl.analyzeData': '分析数据',
  'wf.tpl.dataPrompt': '请对以下数据进行分析，找出趋势和关键指标：',
  'wf.tpl.codeGen': '代码生成',
  'wf.tpl.genCode': '生成代码',
  'wf.tpl.codePrompt': '请根据以下需求生成代码：',
  'wf.tpl.sendNotify': '发送通知',
  'wf.tpl.sendNotifyDesc': '发送通知',
  'wf.tpl.notifyPrompt': '请将以上分析结果整理成简报，格式清晰，重点突出。',
  'wf.tpl.webScrape': '网页抓取',
  'wf.tpl.scrapeWeb': '抓取网页',
  'wf.tpl.scrapePrompt': '请访问以下网址并提取页面中的关键内容：[URL]',
  'wf.tpl.dataQuery': '数据查询',
  'wf.tpl.queryData': '查询数据',
  'wf.tpl.queryPrompt': '请查询以下数据并返回结果：',
  'wf.tpl.genReport': '生成报告',
  'wf.tpl.genReportDesc': '生成报告',
  'wf.tpl.reportPrompt': '请根据以上所有步骤的结果，生成一份完整的分析报告，包含：1. 概述 2. 关键发现 3. 建议',
  'wf.stepName': '步骤名称',
  'wf.unnamedStep': '未命名步骤',
  'wf.promptPlaceholder': '输入发送给 AI 的提示词...\n\n例如：请搜索最新的行业报告并整理出关键数据',
  'wf.waitForCompletion': '等待完成后再执行下一步',
  'wf.chars': '字',
  'wf.selectTemplate': '选择步骤模板',
  'wf.blankStep': '+ 空白步骤',
  'wf.workflowName': '工作流名称 *',
  'wf.workflowNamePlaceholder': '例如：每日数据分析报告',
  'wf.descLabel': '描述',
  'wf.descPlaceholderShort': '简要描述工作流用途',
  'wf.categoryLabel': '分类',
  'wf.cronTrigger': '定时触发',
  'wf.cronNotEnabled': '未启用',
  'wf.quickSelect': '快速选择',
  'wf.collapseCron': '↑ 收起自定义',
  'wf.expandCron': '↓ 自定义 Cron 表达式',
  'wf.cronPlaceholder': '例如: 0 9 * * 1-5',
  'wf.cronHint': '格式: 分 时 日 月 周 — 例如 "30 8 * * 1-5" = 工作日 8:30',
  'wf.execSteps': '执行步骤',
  'wf.addStepBtn': '添加步骤',
  'wf.continueAdd': '继续添加',
  'wf.emptyTitle': '用工作流自动化你的任务',
  'wf.emptyDesc': '将多步骤任务编排成工作流，一键执行，让 AI 按顺序自动完成。',
  'wf.emptyStep1': '数据采集',
  'wf.emptyStep1Desc': '搜索网页、读取文件、查询数据库',
  'wf.emptyStep2': 'AI 分析',
  'wf.emptyStep2Desc': '数据清洗、分析总结、生成报告',
  'wf.emptyStep3': '结果输出',
  'wf.emptyStep3Desc': '发送通知、保存文件、更新系统',
  'wf.createFirstBtn': '创建第一个工作流',
  'wf.nSteps': '个步骤',
  'wf.runNTimes': '运行 {n} 次',
  'wf.nStepsShort': '步骤',
  'wf.runBtn': '运行',
  'wf.editBtn': '编辑',
  'wf.copyBtn': '复制',
  'wf.deleteBtn': '删除',
  'wf.editWorkflowTitle': '编辑工作流',
  'wf.createWorkflowTitle': '创建工作流',
  'wf.cancelBtn': '取消',
  'wf.saveBtn': '保存',
  'wf.savingBtn': '保存中...',
  'wf.descriptionLabel': '描述',
  'wf.categoryLabelShort': '分类',
  'wf.runLabel': '运行',
  'wf.recentLabel': '最近',
  'wf.stepsLabel': '步骤',
  'wf.count': '个',
  'wf.workflowTitle': '工作流',
  'wf.runSuccess': '工作流运行成功',
  'wf.runFailed': '工作流运行失败',
  'wf.type.prompt': '提示词',
  'wf.type.action': '动作',
  'wf.type.condition': '条件',
  'wf.type.loop': '循环',
  'team.title': '团队管理',
  'team.search': '搜索成员...',
  'team.invite': '邀请成员',
  'team.members': '成员',
  'team.role.admin': '管理员',
  'team.role.member': '成员',
  'team.role.viewer': '查看者',
  'team.status.active': '活跃',
  'team.status.invited': '已邀请',
  'team.status.disabled': '已禁用',
  'team.noMembers': '暂无成员',
  'team.noMembersHint': '邀请团队成员开始协作',
  'team.inviteFirst': '邀请第一位成员',
  'team.lastActive': '最后活跃',
  'team.changeRole': '更改角色',
  'team.remove': '移除',
  'team.removeConfirm': '确定移除此成员？',
  'team.removeSuccess': '成员已移除',
  'team.removeFailed': '成员移除失败',
  'team.inviteMember': '邀请成员',
  'team.email': '邮箱',
  'team.emailPlaceholder': '输入邮箱地址',
  'team.selectRole': '选择角色',
  'team.cancel': '取消',
  'team.sendInvite': '发送邀请',
  'team.sending': '发送中...',
  'team.inviteSuccess': '邀请已发送',
  'team.inviteFailed': '邀请发送失败',
  'team.role.manager': '经理',
  'team.role.cs': '客服',
  'team.orgLevel.ceo': 'CEO',
  'team.orgLevel.vp': 'VP',
  'team.orgLevel.lead': '组长',
  'team.orgLevel.staff': '员工',
  'team.createUser': '创建用户',
  'team.createUserTitle': '创建新用户',
  'team.editUser': '编辑用户',
  'team.editUserTitle': '编辑用户: {name}',
  'team.resetPw': '重置密码',
  'team.resetPwTitle': '重置密码: {name}',
  'team.username': '用户名',
  'team.usernamePlaceholder': '登录用户名',
  'team.displayName': '显示名称',
  'team.displayNamePlaceholder': '显示名称',
  'team.password': '密码',
  'team.passwordPlaceholder': '至少 6 个字符',
  'team.passwordMinLen': '密码至少 6 个字符',
  'team.newPassword': '新密码',
  'team.role': '角色',
  'team.orgLevel': '组织层级',
  'team.department': '所属部门',
  'team.manager': '直属上级',
  'team.emailLabel': '邮箱',
  'team.phone': '手机号',
  'team.phonePlaceholder': '手机号',
  'team.unassigned': '未分配',
  'team.none': '无',
  'team.save': '保存',
  'team.saving': '保存中...',
  'team.createBtn': '创建用户',
  'team.saveChanges': '保存修改',
  'team.createDept': '创建部门',
  'team.createDeptTitle': '创建新部门',
  'team.editDept': '编辑部门',
  'team.editDeptTitle': '编辑部门: {name}',
  'team.deptName': '部门名称',
  'team.deptNamePlaceholder': '例如：技术部',
  'team.description': '描述',
  'team.descPlaceholder': '部门描述',
  'team.parentDept': '上级部门',
  'team.parentDeptNone': '无（顶级部门）',
  'team.deptManager': '部门负责人',
  'team.deptManagerNone': '未指定',
  'team.sortOrder': '排序',
  'team.saveDept': '创建部门',
  'team.deactivateUser': '停用用户',
  'team.deactivateConfirm': '确定要停用用户「{name}」吗？停用后该用户将无法登录系统。',
  'team.deactivated': '已停用 {name}',
  'team.deleteDept': '删除部门',
  'team.deleteDeptConfirm': '确定要删除部门「{name}」吗？该操作不可撤销。',
  'team.deletedDept': '已删除部门 {name}',
  'team.opFailed': '操作失败',
  'team.deleteFailed': '删除失败',
  'team.networkError': '网络错误',
  'team.usernameRequired': '用户名和密码不能为空',
  'team.createFailed': '创建失败',
  'team.updateFailed': '更新失败',
  'team.deptNameRequired': '部门名称不能为空',
  'team.pwResetSuccess': '密码已重置成功',
  'team.pwResetNotify': '请通知用户使用新密码登录',
  'team.close': '关闭',
  'team.confirmReset': '确认重置',
  'team.activeMembers': '{n} 名活跃成员',
  'team.departments': '{n} 个部门',
  'team.userMgmt': '用户管理',
  'team.deptMgmt': '部门管理',
  'team.searchPlaceholder': '搜索用户名、显示名或邮箱...',
  'team.all': '全部',
  'team.user': '用户',
  'team.roleLabel': '角色',
  'team.deptLabel': '部门',
  'team.managerLabel': '上级',
  'team.levelLabel': '层级',
  'team.lastLogin': '最后登录',
  'team.actions': '操作',
  'team.editTooltip': '编辑',
  'team.resetPwTooltip': '重置密码',
  'team.deactivateTooltip': '停用',
  'team.noMatchUsers': '没有匹配的用户',
  'team.noMatchUsersDesc': '请尝试修改搜索条件或筛选条件',
  'team.noUsers': '暂无用户',
  'team.noUsersDesc': '用户注册后将显示在这里',
  'team.noDepts': '暂无部门',
  'team.noDeptsHint': '点击上方"创建部门"按钮开始',
  'team.noDesc': '无描述',
  'team.managerColon': '负责人: {name}',
  'team.memberCount': '{n} 人',
  'team.editDeptTooltip': '编辑',
  'team.deleteDeptTooltip': '删除',
  'team.userCreated': '用户创建成功',
  'team.userUpdated': '用户信息已更新',
  'team.deptUpdated': '部门已更新',
  'team.deptCreated': '部门创建成功',
  'team.confirmAction': '确认操作',
  'team.confirmDelete': '确认删除',
  'fp.title': '文件管理',
  'fp.search': '搜索文件...',
  'fp.noFiles': '暂无文件',
  'fp.noFilesHint': '上传文件或在对话中发送文件',
  'fp.download': '下载',
  'fp.delete': '删除',
  'fp.deleteConfirm': '确定删除此文件？',
  'fp.preview': '预览',
  'fp.fileInfo': '文件信息',
  'fp.fileName': '文件名',
  'fp.fileSize': '大小',
  'fp.fileType': '类型',
  'fp.createdAt': '创建时间',
  'fp.close': '关闭',
  'fp.copyContent': '复制内容',
  'fp.downloadFile': '下载文件',
  'fp.binaryNoPreview': '二进制文件，无法预览',
  'fp.loadingFiles': '加载文件列表...',
  'fp.selectFile': '选择文件查看内容',
  'fp.selectFileHint': '点击左侧文件树中的文件进行预览',
  'fp.workspaceFiles': '工作区文件',
  'fp.changes': '变更',
  'fp.refreshFiles': '刷新文件列表',
  'fp.closePanel': '关闭文件面板',
  'fp.loadFailed': '文件加载失败',
  'sd.title': '搜索调试',
  'sd.back': '返回',
  'sd.searchPlaceholder': '输入搜索查询...',
  'sd.search': '搜索',
  'sd.results': '搜索结果',
  'sd.noResults': '无结果',
  'sd.noResultsHint': '尝试不同的搜索词',
  'sd.score': '得分',
  'sd.source': '来源',
  'sd.chunk': '块',
  'sd.similarity': '相似度',
  'sd.topK': 'Top K',
  'sd.threshold': '阈值',
  'sd.searchTime': '搜索耗时',
  'sd.totalResults': '总结果数',
  'sd.minChars': '查询至少需要 2 个字符',
  'sd.categoryFilter': '分类筛选',
  'sd.nResults': '{n} 条结果',
  'sd.nFused': '{n} 条融合',
  'sd.totalTime': '总耗时',
  'sd.queryLabel': '查询',
  'sd.noChannelResults': '该通道无结果',
  'sd.panelTitle': 'RAG 搜索调试面板',
  'sd.panelDesc': '输入查询后，可以对比 FTS（全文搜索）、Vector（语义搜索）和 Hybrid（RRF 融合）三种搜索通道的结果和评分。',
  'cap.search': '搜索能力...',
  'cap.all': '全部',
  'cap.enabled': '已启用',
  'cap.disabled': '已禁用',
  'cap.noResults': '没有匹配的能力',
  'cap.noResultsHint': '尝试调整搜索条件',
  'cap.toggleOn': '已启用',
  'cap.toggleOff': '已禁用',
  'cap.category': '分类',
  'cap.title': '能力面板',
  'cap.description': '管理 AI 助手的能力',
  'cap.webSearch': '网络搜索',
  'cap.webSearchDesc': '搜索互联网获取实时信息',
  'cap.codeExec': '代码执行',
  'cap.codeExecDesc': '运行代码并返回结果',
  'cap.fileUpload': '文件上传',
  'cap.fileUploadDesc': '上传和处理文件',
  'cap.imageGen': '图片生成',
  'cap.imageGenDesc': '根据描述生成图片',
  'cap.voiceTrans': '语音转写',
  'cap.voiceTransDesc': '将语音转换为文字',
  'cap.knowledgeBase': '知识库',
  'cap.knowledgeBaseDesc': '从知识库中检索信息',
  'cap.workflow': '工作流',
  'cap.workflowDesc': '执行预定义的工作流',
  'cap.close': '关闭',
  'cap.toolCat.codeExec': '代码执行',
  'cap.toolCat.fileOps': '文件操作',
  'cap.toolCat.browser': '浏览器',
  'cap.toolCat.searchEngine': '搜索引擎',
  'cap.toolCat.imageProc': '图像处理',
  'cap.toolCat.voiceSynth': '语音合成',
  'cap.toolCat.multiAgent': '多智能体',
  'cap.toolCat.messaging': '消息通信',
  'cap.toolCat.elevated': '高级权限',
  'cap.tool.exec': '命令执行',
  'cap.tool.process': '进程管理',
  'cap.tool.read': '文件读取',
  'cap.tool.write': '文件写入',
  'cap.tool.edit': '文件编辑',
  'cap.tool.applyPatch': '补丁应用',
  'cap.tool.image': '图像生成',
  'cap.tool.canvas': '画布绘制',
  'cap.tool.browser': '浏览器自动化',
  'cap.tool.webSearch': '网络搜索',
  'cap.tool.webFetch': '网页抓取',
  'cap.tool.tts': '文字转语音',
  'cap.tool.subagents': '子智能体',
  'cap.tool.agentsList': '智能体列表',
  'cap.tool.message': '消息发送',
  'cap.tool.nodes': '节点通信',
  'cap.tool.elevated': '提权操作',
  'cap.tool.sessionsList': '会话列表',
  'cap.tool.sessionsHistory': '会话历史',
  'cap.tool.sessionsSend': '会话发送',
  'cap.tool.sessionsSpawn': '会话创建',
  'cap.tool.sessionStatus': '会话状态',
  'cap.skillCat.ops': '运维管理',
  'cap.skillCat.dev': '开发工具',
  'cap.skillCat.security': '安全防护',
  'cap.skillCat.creative': '内容创作',
  'cap.skillCat.data': '数据分析',
  'cap.skillCat.monitor': '监控告警',
  'cap.skillCat.evolution': '自我进化',
  'cap.skillCat.integration': '第三方集成',
  'cap.skillCat.other': '其他能力',
  'cap.aiCenter': 'AI 能力中心',
  'cap.sysCaps': '系统能力',
  'cap.searchSkills': '搜索 Skills...',
  'cap.searchTools': '搜索 Tools...',
  'cap.noSkillMatch': '没有找到匹配的 Skill',
  'cap.invoking': '启动中',
  'cap.use': '使用',
  'cap.useSkillMsg': '请使用「{name}」技能来帮我完成任务。',
  'cap.useSkill': '使用此技能',
  'cap.skillReady': '就绪',
  'cap.skillNotReady': '未就绪',
  'cap.skillDescription': '描述',
  'cap.skillInfo': '技能信息',
  'cap.skillId': '技能 ID',
  'cap.skillVersion': '版本',
  'cap.skillAuthor': '作者',
  'cap.skillTriggers': '触发关键词',
  'invite.title': '邀请码管理',
  'invite.noAccess': '无权访问',
  'invite.adminOnly': '仅管理员可以管理邀请码',
  'invite.back': '返回首页',
  'invite.createTitle': '创建新邀请码',
  'invite.maxUses': '最大使用次数',
  'invite.expireDays': '有效天数',
  'invite.createBtn': '生成邀请码',
  'invite.creating': '生成中...',
  'invite.empty': '还没有邀请码',
  'invite.emptyDesc': '点击上方按钮创建新的邀请码',
  'invite.created': '创建',
  'invite.expired': '过期',
  'invite.statusActive': '有效',
  'invite.statusExpired': '已过期',
  'invite.statusUsed': '已用完',
  'invite.statusInactive': '已停用',
  'invite.uses': '次',
  'notif.title': '通知中心',
  'notif.markAllRead': '全部已读',
  'notif.all': '全部',
  'notif.unread': '未读',
  'notif.loading': '加载中...',
  'notif.emptyUnread': '没有未读通知',
  'notif.emptyUnreadDesc': '所有通知已读，太棒了！',
  'notif.empty': '暂无通知',
  'notif.emptyDesc': '系统通知将在此处显示',
  'notif.typeTicket': '工单',
  'notif.typeKol': 'KOL',
  'notif.typeSystem': '系统',
  'notif.typeAlert': '告警',
  'notif.fetchError': '获取通知失败',
  'notif.markReadError': '标记已读失败',
  'notif.deleteError': '删除通知失败',
  'notif.markRead': '标记已读',
  'notif.delete': '删除',
  'prompt.title': '提示词模板库',
  'prompt.search': '搜索模板...',
  'prompt.allCats': '全部',
  'prompt.empty': '暂无模板',
  'prompt.emptyDesc': '开始创建你的第一个提示词模板吧',
  'prompt.useBtn': '使用',
  'prompt.usedCount': '次使用',
  'prompt.catOps': '运营',
  'prompt.catDev': '研发',
  'prompt.catDevOps': '运维',
  'prompt.catCreative': '创作',
  'prompt.catAnalysis': '分析',
  'prompt.catGeneral': '通用',
  'task.title': '任务队列',
  'task.autoRefresh': '自动刷新',
  'task.paused': '已暂停',
  'task.total': '总任务',
  'task.completed': '已完成',
  'task.failed': '失败',
  'task.avgDuration': '平均耗时',
  'task.statusRunning': '执行中',
  'task.statusCompleted': '已完成',
  'task.statusFailed': '失败',
  'task.statusQueued': '排队中',
  'task.empty': '任务队列暂无记录',
  'task.emptyRunning': '运行中',
  'task.emptyCompleted': '已完成',
  'task.emptyFailed': '失败',
  'task.emptyQueued': '排队中',
  'task.backToChat': '返回对话',
  'task.running': '运行中',
  // Ticket Manager
  'ticket.title': '工单管理',
  'ticket.total': '共',
  'ticket.search': '搜索工单...',
  'ticket.allStatus': '全部状态',
  'ticket.allPriority': '全部优先级',
  'ticket.allCategory': '全部分类',
  'ticket.createTicket': '创建工单',
  'ticket.noTickets': '暂无工单',
  'ticket.noTicketsHint': '创建工单以开始跟踪问题',
  'ticket.status.open': '待处理',
  'ticket.status.inProgress': '处理中',
  'ticket.status.resolved': '已解决',
  'ticket.status.closed': '已关闭',
  'ticket.priority.critical': '紧急',
  'ticket.priority.high': '高',
  'ticket.priority.medium': '中',
  'ticket.priority.low': '低',
  'ticket.form.title': '标题',
  'ticket.form.description': '描述',
  'ticket.form.category': '分类',
  'ticket.form.priority': '优先级',
  'ticket.form.submit': '提交',
  'ticket.form.cancel': '取消',
  'ticket.assignee': '处理人',
  'ticket.createdAt': '创建时间',
  'ticket.updatedAt': '更新时间',
  'ticket.addComment': '添加评论',
  'ticket.commentPlaceholder': '输入评论内容...',
  'ticket.submitComment': '提交评论',
  'ticket.noComments': '暂无评论',
  'ticket.aiAnalysis': 'AI 分析',
  'ticket.changeStatus': '更改状态',
  'ticket.changePriority': '更改优先级',

  'ticket.created': '工单已创建',
  'ticket.createFailed': '工单创建失败',
  'ticket.statusUpdated': '工单状态已更新',
  'ticket.statusUpdateFailed': '工单更新失败',
  'ticket.autoAssigned': '已自动分配给',
  'ticket.noAssignRule': '未匹配到分配规则',
  'ticket.aiRecommend': 'AI 推荐',
  'ticket.aiAnalyzing': '分析中...',
  'ticket.aiApply': '采纳 AI 推荐',
  'ticket.aiApplied': '已采纳',
  'ticket.aiCategory': '分类',
  'ticket.aiPriority': '优先级',
  'ticket.cat.general': '通用',
  'ticket.cat.product': '产品问题',
  'ticket.cat.shipping': '物流',
  'ticket.cat.payment': '支付',
  'ticket.cat.refund': '退款',
  'ticket.cat.account': '账号',
  'ticket.form.descPlaceholder': '详细描述问题...',
  'ticket.form.titlePlaceholder': '简要描述问题',
  'ticket.form.customerName': '客户姓名',
  'ticket.form.customerPlatform': '客户平台',
  'ticket.form.selectPlatform': '选择平台',
  'ticket.detail.customer': '客户',
  'ticket.detail.email': '邮箱',
  'ticket.detail.platform': '平台',
  'ticket.detail.assignee': '负责人',
  'ticket.detail.autoAssign': '自动分配',
  'store.err.systemBusy': '系统暂时繁忙，正在恢复中...',
  'store.err.waitingSeconds': '📝 正在深度分析中，已用时 {seconds} 秒，请耐心等待...',
  'store.err.taskTimeout': '任务超时，请重新发送消息重试',
  'store.err.taskFailed': '任务处理失败，请重试',
  'store.err.sendFailed': '发送消息失败，请重试',
  'store.err.retrying409': '当前对话正在处理中，3秒后自动重试...',
  'store.err.chatBusy': '当前对话正在处理中，请等待完成后再发送',
  'store.err.tooFrequent': '请求过于频繁，请稍后再试',
  'store.err.loginExpired': '登录已过期，请重新登录',
  'store.err.chatNotFound': '对话不存在，请刷新页面',
  'store.err.serverError': '服务器错误，请稍后重试',
  'store.err.requestTimeout': '请求超时，请检查网络后重试',
  'store.err.networkFailed': '网络连接失败，请检查网络后重试',
  'store.err.regenerateFailed': '重新生成失败，请重试',
  'store.err.serverErrorShort': '服务器错误',
  'home.title': 'RangerAI',
  'home.subtitle': '智能对话助手',
  'home.startChat': '开始对话',
  'export.mdTitle': '对话记录',
  'export.model': '模型',
  'export.taskType': '任务类型',
  'export.thinking': '思考过程',
  'export.toolCalls': '工具调用',
  'export.toolName': '工具',
  'export.args': '参数',
  'export.result': '结果',
  'export.status': '状态',
  'export.steps': '执行步骤',
  'export.stepName': '步骤',
  'export.detail': '详情',
  // ErrorBoundary
  'error.unexpectedError': '应用发生了意外错误',
  'error.reloadPage': '重新加载页面',
  'error.backToHome': '返回首页',
  'error.showDetails': '显示错误详情',
  'error.hideDetails': '隐藏错误详情',
  'error.autoRetryAttempted': '已自动重试 {count} 次',
  'error.componentStack': '组件堆栈',
  'network.offline': '网络连接已断开，请检查网络设置',
  'network.backOnline': '网络已恢复连接',
  // ModelSelector
  'model.smartRouterName': '智能路由',
  'model.smartRouterDesc': '根据任务类型自动选择最优模型',
  'model.claudeDesc': '代码与创意写作',
  'model.deepseekV4Desc': 'Agent 能力最强，代码与推理',
  'model.gpt55Desc': '综合能力最强，中文优秀',
  'model.gpt54MiniDesc': '轻量快速，成本优化',
  'model.geminiFlashDesc': '快速响应，图片生成',
  'model.gpt5MiniDesc': '轻量快速',
  'model.gpt4Desc': '综合推理能力',
  'model.gpt4oDesc': '快速响应',
  'model.gpt4oMiniDesc': '轻量快速',
  'model.tierAuto': '智能',
  'model.tierPremium': '旗舰模型',
  'model.tierFast': '快速响应',
  'model.tierReasoning': '深度推理',
  'model.currentModel': '当前模型',
  'model.selectModel': '选择模型',
  // TagManager
  'tag.title': '标签管理',
  'tag.noTags': '暂无标签',
  'tag.inputPlaceholder': '输入标签名称，按 Enter 添加',
  'tag.add': '添加',
  'tag.existingTags': '已有标签：',
  // FileUploadButton
  'upload.fileTooLarge': '文件超过 20MB 限制',
  'upload.uploadImage': '上传图片',
  'upload.uploadFile': '上传文件',
  // AttachmentPreview
  'attachment.failed': '失败',
  // MessageAttachments
  'attachment.openInNewTab': '在新标签页打开',
  // AIFileOutput
  'aiFile.generatedFiles': '生成的文件',
  'aiFile.openInNewTab': '在新标签页打开',
  'aiFile.copyCode': '复制代码',
  'aiFile.downloadFile': '下载文件',
  'aiFile.collapse': '收起',
  'aiFile.expandAll': '展开全部',
  'aiFile.lines': '行',
  // ShareDialog
  'share.title': '共享对话',
  'share.loadFailed': '加载数据失败',
  'share.sharedTo': '已共享给',
  'share.shareFailed': '共享失败，请重试',
  'share.cancelShareConfirm': '确定取消共享？',
  'share.cancelShareFailed': '取消共享失败',
  'share.conversation': '对话',
  'share.loading': '加载中...',
  'share.noShareableUsers': '没有可共享的用户',
  'share.selectUser': '选择用户',
  'share.readOnly': '只读',
  'share.readWrite': '读写',
  'share.shared': '已共享',
  'share.notSharedYet': '尚未共享给任何人',
  'share.readWriteLabel': '读写',
  'share.readOnlyLabel': '只读',
  'share.cancelShare': '取消共享',
  'share.readOnlyHint': '只读用户可以查看对话内容，读写用户可以在对话中发送消息',
  'share.copyLink': '复制链接',
  'share.linkCopied': '已复制',
  // RoleSelector
  'role.selectRole': '选择 AI 角色',
  'role.role': '角色',
  'role.aiRoles': 'AI 角色',
  'role.aiRolesHint': '选择专业角色获得更精准的回答',
  // KnowledgeReferences
  'kref.title': '知识库引用',
  // SearchResultCards
  'searchCards.results': '搜索结果',
  // NotificationCenter - relative time
  'notif.justNow': '刚刚',
  'notif.minutesAgo': '分钟前',
  'notif.hoursAgo': '小时前',
  'notif.daysAgo': '天前',
  'time.justNow': '刚刚',
  'time.minutesAgo': '分钟前',
  'time.hoursAgo': '小时前',
  'time.daysAgo': '天前',
  'time.neverRun': '从未运行',
  // StatsPage
  'stats.codeBlock': '[代码]',
  // Team extra
  'team.noDepts2': '暂无部门',
  'team.noDeptsHint2': '点击上方"创建部门"按钮开始',
  'team.noDesc2': '无描述',
  'team.managerColon2': '负责人',
  'sidebar.ceoDashboard': 'CEO看板',
  'sidebar.dataAnalytics': '数据分析',
  'sidebar.dailyReports': '日报分析',
  'sidebar.opsEfficiency': '运营效率',
  // Browser Preview
  'browserPreview.noScreenshots': '暂无截图',
  'browserPreview.hint': '当 AI 使用浏览器时，截图将在此显示',
  'browserPreview.connecting': '连接中...',
  'browserPreview.takeOver': '接管浏览器',
  'browserPreview.returnControl': '归还控制权',
  'browserPreview.browserOffline': '浏览器离线',
  // Input & Toast
  'input.stopping': '停止中...',
  "input.stopGeneration": "停止生成",
  'toast.waitForAI': '请等待 AI 回复完成后再发送',
  // Chat roles
  'chat.ai': 'AI',
  'chat.system': '系统',
  'chat.user': '用户',

};

const zhTW: TranslationKeys = {
  'sidebar.newChat': '新建',
  'sidebar.searchPlaceholder': '搜尋對話標題和內容...',
  'sidebar.sharedChats': '共享給我的對話',
  'sidebar.batchManage': '批次管理',
  'sidebar.promptTemplates': '提示詞範本',
  'sidebar.aiCapabilities': 'AI 能力中心',
  'sidebar.stats': '系統統計',
  'sidebar.inviteCodes': '管理邀請碼',
  'sidebar.logout': '登出',
  'sidebar.admin': '管理員',
  'sidebar.member': '成員',
  'sidebar.collapseSidebar': '收合側邊欄',
  'sidebar.expandSidebar': '展開側邊欄',
  'sidebar.aiReady': 'AI 就緒',
  'sidebar.aiOffline': 'AI 離線',
  'sidebar.connected': '已連線',
  'sidebar.disconnected': '未連線',
  'sidebar.deleteConfirm': '確定刪除這個對話嗎？',
  'sidebar.rename': '重新命名',
  'sidebar.delete': '刪除',

  'chat.inputPlaceholder': '輸入訊息，Enter 發送',
  'chat.send': '發送訊息',
  'chat.uploadFile': '上傳檔案',
  'chat.currentModel': '目前模型',
  'chat.manageTags': '管理標籤',
  'chat.exportChat': '匯出對話',
  'chat.openFilePanel': '開啟檔案面板',
  'chat.copyMessage': '複製訊息',
  'chat.regenerate': '重新生成',
  'chat.thinking': '思考中',
  'chat.toolCalls': '個工具呼叫',
  'chat.allSuccess': '全部成功',
  'chat.steps': '個步驟',

  'capabilities.title': 'AI 能力中心',
  'capabilities.skills': '技能',
  'capabilities.tools': '工具',
  'capabilities.caps': '能力',
  'capabilities.searchSkills': '搜尋技能...',
  'capabilities.searchTools': '搜尋工具...',
  'capabilities.noResults': '沒有匹配的結果',

  'prompts.title': '提示詞範本',
  'prompts.searchPlaceholder': '搜尋提示詞...',
  'prompts.usePrompt': '使用',
  'prompts.noPrompts': '暫無提示詞範本',
  'prompts.category': '分類',
  'prompts.allCategories': '全部分類',

  'stats.title': '系統統計',
  'stats.refresh': '重新整理',
  'stats.totalChats': '總對話',
  'stats.totalMessages': '總訊息',
  'stats.totalUsers': '總使用者',
  'stats.database': '資料庫',
  'stats.messageTrend': '訊息趨勢（近7天）',
  'stats.roleDistribution': '訊息角色分佈',
  'stats.modelUsage': '模型使用',
  'stats.routingComplexity': '路由複雜度分佈',
  'stats.hotTags': '熱門標籤',
  'stats.userActivity': '使用者活躍度',
  'stats.recentRouting': '最近路由記錄',
  'stats.user': '使用者',
  'stats.role': '角色',
  'stats.chatCount': '對話數',
  'stats.messageCount': '訊息數',
  'stats.lastLogin': '最後登入',
  'stats.userMessages': '使用者訊息',
  'stats.aiReplies': 'AI回覆',
  'stats.fetchError': '載入統計資料失敗',
  'workflow.loadError': '載入工作流失敗',
  'workflow.saveError': '儲存工作流失敗',
  'workflow.deleteError': '刪除工作流失敗',
  'workflow.duplicateError': '複製工作流失敗',
  'taskQueue.loadError': '載入任務列表失敗',
  'prompt.loadError': '載入提示詞模板失敗',
  'chatPage.exportError': '匯出對話失敗',

  'common.loading': '載入中...',
  'common.error': '出錯了',
  'common.retry': '重試',
  'common.cancel': '取消',
  'common.confirm': '確認',
  'common.save': '儲存',
  'common.back': '返回',
  'common.noData': '暫無資料',
  'common.copied': '已複製',
  'common.featureComingSoon': '功能即將上線',
  'common.language': '語言',

  // Sidebar Navigation
  'sidebar.conversations': '對話',
  'sidebar.capabilities': '能力',
  'sidebar.knowledge': '知識庫',
  'sidebar.workflows': '工作流',
  'sidebar.tasks': '任務',
  'sidebar.tickets': '工單',
  'sidebar.kol': 'KOL',
  'sidebar.notifications': '通知',
  'sidebar.console': '控制台',
  'sidebar.navGroupTools': 'AI 工具',
  'sidebar.navGroupAdmin': '管理',
  'sidebar.team': '團隊',
  'sidebar.globalSearch': '全局搜尋... (Ctrl+K)',
  'sidebar.tagFilter': '標籤篩選',
  'sidebar.noSharedChats': '暫無共享對話',
  'sidebar.from': '來自',
  'sidebar.selected': '已選',
  'sidebar.selectAll': '全選',
  'sidebar.deselectAll': '取消全選',
  'sidebar.noMatchingChats': '沒有找到匹配的對話',
  'sidebar.noTagChats': '沒有此標籤的對話',
  'sidebar.noChatsYet': '還沒有對話',
  'sidebar.chatList': '對話列表',
  'sidebar.clickNewToStart': '點擊上方"新建"開始',
  'sidebar.noKnowledgeOrWorkflow': '未找到知識庫或工作流結果',
  'sidebar.foundChats': '個對話',
  'sidebar.searching': '搜尋中...',
  'sidebar.aiStarting': '啟動中',
  'sidebar.reconnecting': '重連中',
  'sidebar.disconnectedShort': '斷開',
  'sidebar.newConversation': '新對話',
  'sidebar.exitBatchMode': '退出多選',

  // Toast messages
  'toast.createChatFailed': '建立對話失敗',
  'toast.renameFailed': '重新命名失敗',
  'toast.renameSuccess': '重新命名成功',
  'toast.deleteFailed': '刪除失敗',
  'toast.deleteSuccess': '對話已刪除',
  'toast.batchDeleteFailed': '批次刪除失敗',
  'toast.batchDeleteSuccess': '已刪除',
  'toast.exportFailed': '匯出失敗，請重試',
  'toast.copySuccess': '已複製到剪貼板',
  'toast.copyFailed': '複製失敗',

  // ChatPage
  'chatPage.exportConversation': '匯出對話',
  'chatPage.exportMarkdown': '匯出 Markdown',
  'chatPage.exportJson': '匯出 JSON',
  'chatPage.collapseSidebar': '收起側邊欄',
  'chatPage.expandSidebar': '展開側邊欄',
  'chatPage.aiConnected': 'AI 引擎已連接',
  'chatPage.wsConnectedAiConnecting': 'WebSocket 已連接，AI 連接中...',
  'chatPage.disconnectedReconnecting': '連接斷開，重連中...',
  'chatPage.connected': '已連接',
  'chatPage.aiConnecting': 'AI 連接中',
  'chatPage.reconnecting': '重連中',
  'chatPage.manageTags': '管理標籤',
  'chatPage.openFilePanel': '開啟檔案面板',
  'chatPage.closeFilePanel': '關閉檔案面板',
  'chatPage.viewFiles': '查看檔案',
  'chatPage.workspaceFiles': '工作區檔案',
  'chatPage.changes': '變更',
  'chatPage.backToList': '返回列表',
  'chatPage.binaryFile': '二進位檔案，無法預覽',
  'chatPage.noWorkspaceFiles': '暫無工作區檔案',
  'chatPage.filesAppearHere': '當 AI 建立或修改檔案時，檔案將自動顯示在這裡',

  // LoginPage
  'login.subtitle': '遊俠出海 AI 中台',
  'login.loginTab': '登入',
  'login.registerTab': '註冊',
  'login.username': '使用者名稱',
  'login.usernamePlaceholder': '請輸入使用者名稱',
  'login.password': '密碼',
  'login.passwordPlaceholder': '請輸入密碼',
  'login.passwordMinLength': '至少6位',
  'login.confirmPassword': '確認密碼',
  'login.confirmPasswordPlaceholder': '再次輸入密碼',
  'login.inviteCode': '邀請碼',
  'login.inviteCodeHint': '請向管理員獲取邀請碼',
  'login.loggingIn': '登入中...',
  'login.registering': '註冊中...',
  'login.loginButton': '登入',
  'login.registerButton': '註冊',
  'login.noAccountHint': '沒有帳號？點擊上方「註冊」標籤，使用邀請碼註冊',
  'login.hasAccountHint': '已有帳號？點擊上方「登入」標籤',
  'login.errorEmptyFields': '請輸入使用者名稱和密碼',
  'login.errorPasswordMismatch': '兩次輸入的密碼不一致',
  'login.errorPasswordTooShort': '密碼至少6位',
  'login.errorNoInviteCode': '請輸入邀請碼',
  'login.errorLoginFailed': '登入失敗',
  'login.errorRegisterFailed': '註冊失敗',
  'validation.usernameTooShort': '使用者名稱至少 2 個字元',
  'validation.usernameTooLong': '使用者名稱不超過 30 個字元',
  'validation.fieldRequired': '此欄位不能為空',
  'validation.nameTooLong': '名稱過長',

  // MessageInput
  'input.imageAttachment': '圖片',
  'input.fileAttachment': '檔案',
  'input.dropFilesHere': '拖放檔案到這裡',
  'input.supportsImagesAndDocs': '支援圖片和文件',
  'input.connecting': '連接中...',
  'input.aiReplying': 'AI 正在回覆...',
  'input.placeholder': '輸入訊息，Enter 傳送，Shift+Enter 換行',
  'input.placeholderMobile': '輸入訊息...',
  'input.ariaLabel': '輸入訊息',
  'input.processing': '正在處理',
  'input.uploading': '檔案上傳中...',
  'input.send': '傳送',
  'input.sendMessage': '傳送訊息',
  'input.footer': 'RangerAI · 遊俠出海 AI 中台',

  'model.smartRouter': '智慧路由',

  // MessageList
  'msg.taskType.code': '程式碼',
  'msg.taskType.reasoning': '推理',
  'msg.taskType.creative': '創作',
  'msg.taskType.research': '研究',
  'msg.taskType.imageGeneration': '圖片生成',
  'msg.taskType.chat': '對話',
  'msg.thinking.low': '輕量',
  'msg.thinking.medium': '標準',
  'msg.thinking.high': '深度',
  'msg.thinking.xhigh': '極深',
  'msg.thinkingSuffix': '思考',
  'msg.skillCat.ops': '運維',
  'msg.skillCat.security': '安全',
  'msg.skillCat.network': '網路',
  'msg.skillCat.monitoring': '監控',
  'msg.skillCat.deploy': '部署',
  'msg.skillCat.backup': '備份',
  'msg.skillCat.log': '日誌',
  'msg.skillCat.cost': '成本',
  'msg.skillCat.env': '環境',
  'msg.skillCat.cron': '定時',
  'msg.skillCat.evolve': '進化',
  'msg.skillCat.creation': '創作',
  'msg.skillCat.query': '查詢',
  'msg.skillCat.dev': '開發',
  'msg.skillCat.mgmt': '管理',
  'msg.tool.webSearch': '網路搜尋',
  'msg.tool.webFetch': '網頁取得',
  'msg.tool.browser': '瀏覽器',
  'msg.tool.terminal': '終端機',
  'msg.tool.readFile': '讀取檔案',
  'msg.tool.writeFile': '寫入檔案',
  'msg.tool.editFile': '編輯檔案',
  'msg.tool.genImage': '生成圖片',
  'msg.tool.canvas': '畫布',
  'msg.tool.tts': '語音合成',
  'msg.tool.codeExec': '程式碼執行',
  'msg.tool.memorySearch': '搜尋記憶',
  'msg.tool.memoryGet': '取得記憶',
  'msg.toolTitle.search': '搜尋',
  'msg.toolTitle.fetch': '取得',
  'msg.toolTitle.browserAction': '瀏覽器',
  'msg.toolTitle.execCmd': '執行命令',
  'msg.toolTitle.read': '讀取',
  'msg.toolTitle.write': '寫入',
  'msg.toolTitle.edit': '編輯',
  'msg.toolTitle.genImage': '生成圖片',
  'msg.toolTitle.canvasOp': '畫布操作',
  'msg.toolTitle.tts': '語音合成',
  'msg.toolTitle.memSearch': '搜尋記憶',
  'msg.toolTitle.memGet': '取得記憶',
  'msg.toolTitle.file': '檔案',
  'msg.exec.running': '正在執行',
  'msg.exec.done': '執行完成',
  'msg.exec.steps': '步驟',
  'msg.card.params': '參數',
  'msg.card.result': '結果',
  'msg.card.browserScreenshot': '瀏覽器截圖',
  'msg.card.generatedImage': '生成圖片',
  'msg.card.imageGenerating': '圖片生成中...',
  'msg.preview.imagePreview': '圖片預覽',
  'msg.preview.closePreview': '關閉圖片預覽',
  'msg.preview.viewLarger': '查看大圖',
  'msg.preview.browserScreenshot': '瀏覽器截圖',
  'msg.preview.closeSsPreview': '關閉截圖預覽',
  'msg.summary.toolCalls': '個工具呼叫',
  'msg.summary.success': '成功',
  'msg.summary.fail': '失敗',
  'msg.summary.allSuccess': '全部成功',
  'msg.summary.stepsCount': '個步驟',
  'msg.summary.expandAll': '... 展開全部',
  'msg.summary.collapse': '收起',
  'msg.summary.viewTerminal': '查看終端輸出',
  'msg.action.copied': '已複製',
  'msg.action.copyMsg': '複製訊息',
  'msg.action.copy': '複製',
  'msg.action.regenerate': '重新生成',
  'msg.stream.deepThinking': '深度思考中',
  'msg.stream.thinking': '正在思考...',
  'msg.stream.analyzing': '正在分析...',
  'msg.stream.close': '關閉',
  'msg.phase.executing': '正在執行',
  'msg.phase.outputting': '正在輸出',
  'msg.scrollToBottom': '捲動到底部',
  'msg.welcome.subtitle': '遊俠出海 AI 中台 — 擁有 94 項專業技能的智慧助手',
  'msg.welcome.modelRoute': '支援 23+ AI 模型智慧路由 · 自動選擇最佳技能組合',
  'msg.welcome.describeNeeds': '描述您的需求，RangerAI 會自動選擇最合適的技能組合',
  'msg.welcome.cap.webSearch': '網路搜尋與分析',
  'msg.welcome.cap.webSearchDesc': '即時搜尋、網頁抓取、資料提取與競品分析',
  'msg.welcome.cap.codeDev': '程式碼開發與除錯',
  'msg.welcome.cap.codeDevDesc': '全端開發、程式碼審查、Bug 修復與自動化腳本',
  'msg.welcome.cap.dataViz': '資料處理與視覺化',
  'msg.welcome.cap.dataVizDesc': '資料清洗、統計分析、圖表生成與報告撰寫',
  'msg.welcome.cap.securityOps': '安全審計與運維',
  'msg.welcome.cap.securityOpsDesc': '伺服器巡檢、漏洞掃描、效能監控與部署管理',
  'msg.welcome.cap.contentDesign': '內容創作與設計',
  'msg.welcome.cap.contentDesignDesc': '文案撰寫、圖片生成、多語言翻譯與 SEO 優化',
  'msg.welcome.cap.fileMgmt': '檔案處理與管理',
  'msg.welcome.cap.fileMgmtDesc': '文件轉換、PDF 解析、批次處理與雲端同步',
  'msg.welcome.cap.aiModel': 'AI 模型與推理',
  'msg.welcome.cap.aiModelDesc': '智慧路由 23+ 模型、多輪對話、深度思考與專家級回答',
  'msg.welcome.cap.sysIntegration': '系統整合與 API',
  'msg.welcome.cap.sysIntegrationDesc': 'REST API 呼叫、資料庫操作、第三方服務對接',
  'msg.welcome.cap.docReport': '文件與報告生成',
  'msg.welcome.cap.docReportDesc': '技術文件、商業報告、研究分析與知識庫整理',
  'msg.welcome.cap.multiLang': '多語言與本地化',
  'msg.welcome.cap.multiLangDesc': '中英日韓等多語種翻譯、出海內容本地化與文化適配',
  'msg.welcome.cap.browserAuto': '瀏覽器自動化',
  'msg.welcome.cap.browserAutoDesc': '網頁操作、表單填寫、截圖審查與自動化測試',
  'msg.welcome.cap.taskOrch': '任務編排與自動化',
  'msg.welcome.cap.taskOrchDesc': '多步驟任務編排、定時執行、工作流自動化',
  'msg.welcome.cap.smartChat': '智慧對話與諮詢',
  'msg.welcome.cap.smartChatDesc': '專業問答、商業諮詢、技術支援與決策建議',
  'msg.welcome.cap.research': '研究與情報分析',
  'msg.welcome.cap.researchDesc': '行業研究、市場情報、技術趨勢與競爭分析',
  'msg.welcome.cap.projectMgmt': '專案管理與協作',
  'msg.welcome.cap.projectMgmtDesc': '任務追蹤、團隊協作、進度管理與資源分配',
  // Admin Dashboard
  'admin.title': '管理控制台',
  'admin.running': '運行',
  'admin.version': 'v',
  'admin.tab.overview': '總覽',
  'admin.tab.system': '系統監控',
  'admin.tab.users': '用戶管理',
  'admin.tab.config': '系統配置',
  'admin.tab.roles': 'AI角色',
  'admin.tab.audit': '操作日誌',
  'admin.tab.assignRules': '分配規則',
  'admin.tab.openPlatform': '開放平台',
  'admin.tab.services': '服務管理',
  'admin.nav.monitor': '監控',
  'admin.nav.manage': '管理',
  'admin.nav.ops': '運維',
  'admin.nav.ai': 'AI 智能',
  'admin.tab.toolMemory': '工具記憶',
  'admin.toolMemory.title': '自適應工具記憶',
  'admin.toolMemory.totalRecords': '總記錄數',
  'admin.toolMemory.subTypeStats': '工具子類型統計',
  'admin.toolMemory.topTools': '最常用工具',
  'admin.toolMemory.recentPatterns': '最近任務模式',
  'admin.toolMemory.hitCount': '命中次數',
  'admin.toolMemory.successRate': '成功率',
  'admin.toolMemory.avgDuration': '平均耗時',
  'admin.toolMemory.noData': '暫無工具記憶數據',
  'admin.refresh': '刷新數據',
  'admin.collapse': '收起側欄',
  'admin.acp.service': 'ACP 網關',
  'admin.acp.activeKeys': '活躍密鑰',
  'admin.acp.asyncTasks': '非同步任務',
  'admin.acp.dingtalk': '釘釘適配器',
  'admin.acp.connected': '已連接',
  'admin.acp.disconnected': '已斷開',
  'admin.acp.disabled': '未啟用',
  'admin.acp.apiKeys': 'API 密鑰管理',
  'admin.acp.apiKeysDesc': '管理外部系統透過 ACP 網關調用 RangerAI 的 API 密鑰',
  'admin.acp.createKey': '建立密鑰',
  'admin.acp.newKey': '建立新的 API 密鑰',
  'admin.acp.keyName': '密鑰名稱',
  'admin.acp.keyNamePlaceholder': '例如：釘釘機器人、CRM 系統',
  'admin.acp.nameRequired': '請輸入密鑰名稱',
  'admin.acp.generate': '生成',
  'admin.acp.keyCreated': 'API 密鑰已建立',
  'admin.acp.keyCreatedHint': '請立即複製儲存，此密鑰僅顯示一次，關閉後無法再次查看。',
  'admin.acp.copy': '複製',
  'admin.acp.copied': '已複製',
  'admin.acp.noKeys': '暫無 API 密鑰',
  'admin.acp.noKeysHint': '建立一個 API 密鑰以允許外部系統調用 RangerAI',
  'admin.acp.thName': '名稱',
  'admin.acp.thKeyPrefix': '密鑰前綴',
  'admin.acp.thStatus': '狀態',
  'admin.acp.thCalls': '調用次數',
  'admin.acp.thLastUsed': '最後使用',
  'admin.acp.thCreatedAt': '建立時間',
  'admin.acp.thActions': '操作',
  'admin.acp.statusActive': '活躍',
  'admin.acp.statusRevoked': '已吃銷',
  'admin.acp.revoke': '吃銷',
  'admin.acp.revokeConfirm': '確認吃銷密鑰',
  'admin.acp.revokeMsg': '確定要吃銷此 API 密鑰嗎？吃銷後將無法恢復：',
  'admin.acp.envKeyNoRevoke': '環境變數配置的密鑰無法透過界面吃銷',
  'admin.acp.apiDocs': 'API 介面文件',
  'admin.acp.docSyncChat': '同步對話（等待回覆）',
  'admin.acp.docAsyncChat': '非同步對話（立即返回任務 ID）',
  'admin.acp.docTaskStatus': '查詢非同步任務狀態',
  'admin.acp.docKnowledge': '知識庫檢索',
  'admin.acp.usageExample': '使用範例：',
  'admin.status.running': '運行中',
  'admin.status.healthy': '健康',
  'admin.status.degraded': '降級',
  'admin.status.loadFailed': '載入失敗',
  'admin.status.noData': '無系統數據',
  'admin.status.loading': '載入中...',
  'admin.overview.totalLabel': '共',
  'admin.overview.pending': '待處理',
  'admin.overview.inProgress': '處理中',
  'admin.overview.resolved': '已解決',
  'admin.overview.closed': '已關閉',
  'admin.overview.totalKol': '總 KOL',
  'admin.overview.cooperating': '合作中',
  'admin.overview.totalCooperation': '總合作',
  'admin.overview.trendNew': '新建',
  'admin.overview.trendResolved': '解決',
  'admin.overview.cpuLoad': 'CPU負載',
  'admin.overview.cores': '核',
  'admin.overview.serviceStatus': '服務狀態',
  'admin.overview.uptime': '運行時間',
  'admin.overview.dbUsers': '用戶數',
  'admin.overview.dbChats': '會話數',
  'admin.overview.dbMessages': '訊息數',
  'admin.overview.dbSize': '資料庫大小',
  'admin.overview.heapUsed': '堆記憶體',
  'admin.overview.rss': 'RSS記憶體',
  'admin.overview.activeTasks': '活躍任務',
  'admin.overview.noActiveTasks': '無活躍任務',
  'admin.overview.elapsedSec': '秒',
  'admin.overview.ticketStats': '工單統計',
  'admin.overview.kolStats': 'KOL 統計',
  'admin.overview.ticketTrend': '工單趨勢',
  'admin.system.memory': '系統記憶體',
  'admin.system.used': '已用',
  'admin.system.total': '總共',
  'admin.system.usageRate': '使用率',
  'admin.system.free': '空閒',
  'admin.system.disk': '磁碟',
  'admin.system.diskUsed': '已用',
  'admin.system.diskAvailable': '可用',
  'admin.system.platform': '平台',
  'admin.system.nodeVersion': 'Node版本',
  'admin.system.pid': '程序PID',
  'admin.system.processMemory': '程序記憶體',
  'admin.system.browserStatus': '瀏覽器狀態',
  'admin.system.circuitBreaker': '熔斷器',
  'admin.system.failCount': '失敗次數',
  'admin.system.lastFail': '最近失敗',
  'admin.system.recoverBrowser': '恢復瀏覽器',
  'admin.system.resetBreaker': '重置熔斷器',
  'admin.system.breakerClosed': '正常',
  'admin.system.breakerOpen': '已熔斷',
  'admin.system.breakerHalfOpen': '半開',
  'admin.system.opSuccess': '操作成功',
  'admin.system.opFailed': '操作失敗',
  'admin.system.ports': '端口狀態',
  'admin.system.halfOpenAttempts': '半開嘗試',
  'admin.system.sysInfo': '系統資訊',
  'admin.users.search': '搜尋用戶...',
  'admin.users.roleAdmin': '管理員',
  'admin.users.roleMember': '成員',
  'admin.users.confirmRoleChange': '確定將此用戶角色變更為',
  'admin.users.demoteToMember': '降為成員',
  'admin.users.promoteToAdmin': '升為管理員',
  'admin.users.thName': '用戶名',
  'admin.users.thRole': '角色',
  'admin.users.thMessages': '訊息數',
  'admin.users.thChats': '會話數',
  'admin.users.thLastActive': '最近活躍',
  'admin.users.thActions': '操作',
  'admin.config.catGeneral': '通用',
  'admin.config.catAI': 'AI引擎',
  'admin.config.catGateway': 'Gateway',
  'admin.config.catStorage': '儲存',
  'admin.config.catAuth': '認證',
  'admin.config.noConfig': '無配置項',
  'admin.roles.addRole': '新增角色',
  'admin.roles.create': '建立',
  'admin.roles.save': '儲存',
  'admin.roles.noRoles': '無AI角色',
  'admin.roles.editRole': '編輯角色',
  'admin.roles.deleteConfirm': '確定刪除此角色？',
  'admin.audit.totalRecords': '條記錄',
  'admin.audit.noLogs': '暫無操作日誌',
  'admin.audit.noLogsHint': '系統配置變更和角色管理操作將記錄在此',
  'admin.audit.thTime': '時間',
  'admin.audit.thOperator': '操作者',
  'admin.audit.thAction': '操作',
  'admin.audit.thTarget': '目標',
  'admin.audit.thDetail': '詳情',
  'admin.audit.prevPage': '上一頁',
  'admin.audit.nextPage': '下一頁',
  'admin.audit.configUpdate': '配置更新',
  'admin.audit.roleCreate': '建立角色',
  'admin.audit.roleUpdate': '更新角色',
  'admin.audit.roleDelete': '刪除角色',
  'admin.assign.title': '工單分配規則',
  'admin.assign.addRule': '新增規則',
  'admin.assign.editRule': '編輯規則',
  'admin.assign.newRule': '新增規則',
  'admin.assign.category': '工單分類',
  'admin.assign.priority': '優先級範圍',
  'admin.assign.assignee': '處理人',
  'admin.assign.update': '更新',
  'admin.assign.createBtn': '建立',
  'admin.assign.cancel': '取消',
  'admin.assign.noRules': '暫無分配規則',
  'admin.assign.noRulesHint': '點擊「新增規則」開始配置工單自動分配',
  'admin.assign.thCategory': '分類',
  'admin.assign.thPriority': '優先級',
  'admin.assign.thAssignee': '處理人',
  'admin.assign.thCreatedAt': '建立時間',
  'admin.assign.thActions': '操作',
  'admin.assign.ruleExplanation': '分配規則說明',
  'admin.assign.ruleHint1': '新工單建立時，AI 會自動分析內容並推薦分類和優先級',
  'admin.assign.ruleHint2': '系統根據分類和優先級匹配對應的分配規則，自動分配處理人',
  'admin.assign.ruleHint3': '優先級為「所有優先級」的規則會匹配該分類下的所有工單',
  'admin.assign.ruleHint4': '如果沒有匹配到精確規則，會嘗試匹配「預設（兆底）」分類的規則',
  'admin.assign.ruleHint5': '匹配優先級：精確分類+精確優先級 > 精確分類+所有優先級 > 預設分類',
  'admin.cat.payment': '付款問題',
  'admin.cat.account': '帳戶問題',
  'admin.cat.technical': '技術問題',
  'admin.cat.shipping': '物流問題',
  'admin.cat.refund': '退款問題',
  'admin.cat.general': '一般諮詢',
  'admin.cat.default': '預設（兆底）',
  'admin.priority.all': '所有優先級',
  'admin.priority.critical': '緊急',
  'admin.priority.high': '高',
  'admin.priority.medium': '中',
  'admin.priority.low': '低',
  'admin.priority.urgent': '緊急',
  'admin.time.days': '天',
  'admin.time.hours': '小時',
  'admin.time.minutes': '分鐘',

  // KOL Manager
  'kol.title': 'KOL 管理',
  'kol.total': '總 KOL',
  'kol.platformCoverage': '平台覆蓋',
  'kol.cooperating': '合作中',
  'kol.totalCooperation': '總合作',
  'kol.search': '搜尋 KOL 名稱、平台帳號...',
  'kol.allPlatforms': '全部平台',
  'kol.addKol': '新增 KOL',
  'kol.addFirst': '新增第一個 KOL',
  'kol.noData': '暫無 KOL 資料',
  'kol.noDataHint': '新增 KOL 以開始管理達人資源',
  'kol.editKol': '編輯 KOL',
  'kol.refreshData': '重新整理',
  'kol.refreshing': '重新整理中...',
  'kol.refreshed': '已重新整理 KOL 資料',
  'kol.refreshFailed': '重新整理失敗',
  'kol.addSuccess': 'KOL 新增成功',
  'kol.addFailed': 'KOL 新增失敗',
  'kol.updateSuccess': 'KOL 資訊已更新',
  'kol.updateFailed': 'KOL 更新失敗',
  'kol.deleteConfirm': '確定刪除此 KOL？',
  'kol.deleteSuccess': 'KOL 已刪除',
  'kol.deleteFailed': 'KOL 刪除失敗',
  'kol.followers': '粉絲',
  'kol.engagementRate': '互動率',
  'kol.region': '地區',
  'kol.status.active': '活躍',
  'kol.status.inactive': '不活躍',
  'kol.status.blacklisted': '黑名單',
  'kol.status.pending': '待審核',
  'kol.coop.none': '未聯繫',
  'kol.coop.contacted': '已聯繫',
  'kol.coop.negotiating': '洽談中',
  'kol.coop.contracted': '已簽約',
  'kol.coop.completed': '已完成',
  'kol.form.name': '名稱',
  'kol.form.platform': '平台',
  'kol.form.handle': '帳號',
  'kol.form.followers': '粉絲數',
  'kol.form.category': '分類',
  'kol.form.country': '國家/地區',
  'kol.form.language': '語言',
  'kol.form.email': '聯繫信箱',
  'kol.form.coopStatus': '合作狀態',
  'kol.form.notes': '備註',
  'kol.form.save': '儲存',
  'kol.form.add': '新增',
  'kol.form.cancel': '取消',
  'kol.cat.gaming': '遊戲',
  'kol.cat.beauty': '美妝',
  'kol.cat.tech': '科技',
  'kol.cat.lifestyle': '生活',
  'kol.cat.food': '美食',
  'kol.cat.fashion': '時尚',
  'kol.cat.fitness': '健身',
  'kol.cat.education': '教育',
  // KOL Detail
  'kolDetail.back': '返回',
  'kolDetail.basicInfo': '基本資訊',
  'kolDetail.coopHistory': '合作記錄',
  'kolDetail.addCoop': '新增合作',
  'kolDetail.noCoop': '暫無合作記錄',
  'kolDetail.noCoopHint': '新增合作記錄以追蹤合作歷史',
  'kolDetail.platform': '平台',
  'kolDetail.handle': '帳號',
  'kolDetail.followers': '粉絲數',
  'kolDetail.engagementRate': '互動率',
  'kolDetail.category': '分類',
  'kolDetail.country': '國家/地區',
  'kolDetail.language': '語言',
  'kolDetail.email': '聯繫信箱',
  'kolDetail.phone': '聯繫電話',
  'kolDetail.status': '狀態',
  'kolDetail.coopStatus': '合作狀態',
  'kolDetail.lastContacted': '最近聯繫',
  'kolDetail.createdAt': '建立時間',
  'kolDetail.notes': '備註',
  'kolDetail.coopType': '合作類型',
  'kolDetail.coopAmount': '合作金額',
  'kolDetail.coopStartDate': '開始日期',
  'kolDetail.coopEndDate': '結束日期',
  'kolDetail.coopNotes': '合作備註',
  'kolDetail.coopStatusLabel': '合作狀態',
  'kolDetail.coopSave': '儲存',
  'kolDetail.coopCancel': '取消',
  'kolDetail.coopDeleteConfirm': '確定刪除此合作記錄？',
  'kolDetail.notFound': '未找到該 KOL',

  'kolDetail.backToList': '返回 KOL 列表',
  'kolDetail.coopCount': '合作次數',
  'kolDetail.totalInvestment': '總投入',
  'kolDetail.addedAt': '新增時間',
  'kolDetail.roiAnalysis': 'ROI 分析',
  'kolDetail.totalBudget': '總預算',
  'kolDetail.actualSpend': '實際花費',
  'kolDetail.budgetUtilization': '預算利用率',
  'kolDetail.avgCoopCost': '平均單次合作成本',
  'kolDetail.completionRate': '完成率',
  'kolDetail.estReach': '預估單次觸達',
  'kolDetail.coopHistoryTitle': '合作歷史',
  'kolDetail.addCoopRecord': '新增合作',
  'kolDetail.addFirstCoop': '新增第一條合作記錄',
  'kolDetail.coopBudget': '預算',
  'kolDetail.coopActual': '實際',
  'kolDetail.coopStatus.planning': '規劃中',
  'kolDetail.coopStatus.active': '進行中',
  'kolDetail.coopStatus.completed': '已完成',
  'kolDetail.coopStatus.cancelled': '已取消',
  'kolDetail.campaignType.promotion': '推廣',
  'kolDetail.campaignType.review': '測評',
  'kolDetail.campaignType.livestream': '直播',
  'kolDetail.campaignType.sponsored': '贊助',
  'kolDetail.campaignType.affiliate': '聯盟',
  'kolDetail.campaignType.other': '其他',
  'kolDetail.form.campaignName': '活動名稱',
  'kolDetail.form.campaignType': '活動類型',
  'kolDetail.form.campaignStatus': '狀態',
  'kolDetail.form.startDate': '開始日期',
  'kolDetail.form.endDate': '結束日期',
  'kolDetail.form.budget': '預算 ($)',
  'kolDetail.form.actualCost': '實際花費 ($)',
  'kolDetail.form.deliverables': '交付物',
  'kolDetail.form.delivPlaceholder': '例：3條短影片 + 1條直播',
  'kb.title': '知識庫',
  'kb.docCount': '篇文件',
  'kb.addKnowledge': '新增知識',
  'kb.searchDebug': '搜尋除錯',
  'kb.uploadFile': '上傳檔案',
  'kb.upload': '上傳',
  'kb.search': '搜尋',
  'kb.searchPlaceholder': '搜尋文件標題、內容、標籤...',
  'kb.categories': '分類',
  'kb.all': '全部',
  'kb.cat.uncategorized': '未分類',
  'kb.cat.techDoc': '技術文件',
  'kb.cat.productReq': '產品需求',
  'kb.cat.meetingNotes': '會議紀要',
  'kb.cat.knowledgeBase': '知識沉澱',
  'kb.cat.training': '培訓資料',
  'kb.cat.standards': '規範標準',
  'kb.cat.apiDoc': 'API文件',
  'kb.textEntry': '文字條目',
  'kb.emptyTitle': '開始建立你的知識庫',
  'kb.emptyDesc': '知識庫幫你集中管理文件、技術資料和團隊知識，讓 AI 能更智慧地回答你的問題。',
  'kb.emptyUploadFile': '上傳檔案',
  'kb.emptyUploadHint': 'PDF、Word、圖片等',
  'kb.emptyAddText': '新增文字',
  'kb.emptyAddTextHint': '筆記、知識點等',
  'kb.emptyBrowse': '先看看',
  'kb.emptyBrowseHint': '返回對話頁',
  'kb.notVectorized': '未向量化',
  'kb.vectorized': '已向量化',
  'kb.retry': '重試',
  'kb.regenerate': '重新產生',
  'kb.vectorBlocks': '個向量塊',
  'kb.contentLength': '內容長度',
  'kb.chars': '字元',
  'kb.notVectorizedHint': '該文件無法被語意搜尋命中',
  'kb.showing': '顯示',
  'kb.total': '共',
  'kb.docs': '篇',
  'kb.prevPage': '上一頁',
  'kb.nextPage': '下一頁',
  'kb.category': '分類',
  'kb.description': '描述',
  'kb.fileName': '檔案名稱',
  'kb.size': '大小',
  'kb.createdAt': '建立時間',
  'kb.embeddingStatus': 'Embedding 狀態',
  'kb.contentPreview': '內容預覽',
  'kb.contentTruncated': '... (內容過長，已截斷)',
  'kb.deleteDoc': '刪除文件',
  'kb.uploadFileTitle': '上傳檔案',
  'kb.selectFile': '選擇檔案',
  'kb.supportedFormats': '支援 TXT、Markdown、JSON、CSV、PDF、Word (.docx)',
  'kb.titleLabel': '標題',
  'kb.descLabel': '描述',
  'kb.categoryLabel': '分類',
  'kb.tagsLabel': '標籤',
  'kb.tagsCommaSep': '標籤（逗號分隔）',
  'kb.cancel': '取消',
  'kb.uploading': '上傳中...',
  'kb.addKnowledgeEntry': '新增知識條目',
  'kb.titleRequired': '標題 *',
  'kb.titlePlaceholder': '知識條目標題',
  'kb.contentLabel': '內容',
  'kb.contentPlaceholder': '輸入知識內容（支援 Markdown 格式）',
  'kb.saving': '儲存中...',
  'kb.save': '儲存',
  'kb.uploadSuccess': '文件上傳成功',
  'kb.uploadFailed': '文件上傳失敗',
  'kb.addTextSuccess': '文字內容新增成功',
  'kb.addTextFailed': '文字新增失敗',
  'kb.deleteConfirm': '確定刪除此文件？',
  'kb.deleteSuccess': '文件已刪除',
  'kb.deleteFailed': '文件刪除失敗',
  'kb.formatTextEntry': '文字條目',
  'kb.customCategory': '自訂分類...',
  'kb.customCategoryPlaceholder': '輸入自訂分類名稱',
  'kb.tagInputPlaceholder': '輸入標籤後按 Enter 新增',
  'kb.tagInputHint': '按 Enter 或逗號新增標籤，Backspace 刪除',
  'wf.title': '工作流',
  'wf.search': '搜尋工作流...',
  'wf.create': '建立工作流',
  'wf.noWorkflows': '暫無工作流',
  'wf.noWorkflowsHint': '建立工作流來自動化你的任務',
  'wf.createFirst': '建立第一個工作流',
  'wf.steps': '步驟',
  'wf.lastUpdated': '最後更新',
  'wf.run': '執行',
  'wf.edit': '編輯',
  'wf.delete': '刪除',
  'wf.deleteConfirm': '確定刪除此工作流？',
  'wf.deleteSuccess': '工作流已刪除',
  'wf.deleteFailed': '工作流刪除失敗',
  'wf.createWorkflow': '建立工作流',
  'wf.editWorkflow': '編輯工作流',
  'wf.name': '名稱',
  'wf.namePlaceholder': '工作流名稱',
  'wf.description': '描述',
  'wf.descPlaceholder': '工作流描述',
  'wf.addStep': '新增步驟',
  'wf.stepType': '步驟類型',
  'wf.stepPrompt': '提示詞',
  'wf.stepAction': '動作',
  'wf.stepCondition': '條件',
  'wf.removeStep': '刪除步驟',
  'wf.cancel': '取消',
  'wf.save': '儲存',
  'wf.saving': '儲存中...',
  'wf.saveSuccess': '工作流儲存成功',
  'wf.saveFailed': '工作流儲存失敗',
  'wf.cron.notSet': '未設置',
  'wf.cron.custom': '自訂',
  'wf.cron.hourly': '每小時',
  'wf.cron.hourlyDesc': '每小時整點執行',
  'wf.cron.daily9': '每天 9:00',
  'wf.cron.daily9Desc': '每天早上 9 點執行',
  'wf.cron.daily18': '每天 18:00',
  'wf.cron.daily18Desc': '每天下午 6 點執行',
  'wf.cron.weekday9': '工作日 9:00',
  'wf.cron.weekday9Desc': '週一至週五早上 9 點',
  'wf.cron.monday9': '每週一 9:00',
  'wf.cron.monday9Desc': '每週一早上 9 點執行',
  'wf.cron.monthly1': '每月 1 號',
  'wf.cron.monthly1Desc': '每月 1 號早上 9 點執行',
  'wf.cat.uncategorized': '未分類',
  'wf.cat.dailyTask': '日常任務',
  'wf.cat.dataAnalysis': '數據分析',
  'wf.cat.contentCreation': '內容創作',
  'wf.cat.codeDev': '程式開發',
  'wf.cat.devops': '維運部署',
  'wf.cat.research': '調研報告',
  'wf.step': '步驟',
  'wf.confirmDelete': '確定刪除此工作流？',
  'wf.copy': '副本',
  'wf.neverRun': '從未運行',
  'wf.justNow': '剛剛',
  'wf.minutesAgo': '分鐘前',
  'wf.hoursAgo': '小時前',
  'wf.daysAgo': '天前',
  'wf.tpl.searchWeb': '搜尋網頁',
  'wf.tpl.searchInfo': '搜尋資訊',
  'wf.tpl.searchPrompt': '請搜尋以下關鍵詞的最新資訊：[關鍵詞]，並整理出要點。',
  'wf.tpl.analyzeDoc': '分析文件',
  'wf.tpl.analyzeFile': '分析檔案',
  'wf.tpl.analyzePrompt': '請分析以下內容，提取關鍵資訊並生成摘要：',
  'wf.tpl.dataAnalysis': '數據分析',
  'wf.tpl.analyzeData': '分析數據',
  'wf.tpl.dataPrompt': '請對以下數據進行分析，找出趨勢和關鍵指標：',
  'wf.tpl.codeGen': '程式碼生成',
  'wf.tpl.genCode': '生成程式碼',
  'wf.tpl.codePrompt': '請根據以下需求生成程式碼：',
  'wf.tpl.sendNotify': '發送通知',
  'wf.tpl.sendNotifyDesc': '發送通知',
  'wf.tpl.notifyPrompt': '請將以上分析結果整理成簡報，格式清晰，重點突出。',
  'wf.tpl.webScrape': '網頁抓取',
  'wf.tpl.scrapeWeb': '抓取網頁',
  'wf.tpl.scrapePrompt': '請訪問以下網址並提取頁面中的關鍵內容：[URL]',
  'wf.tpl.dataQuery': '數據查詢',
  'wf.tpl.queryData': '查詢數據',
  'wf.tpl.queryPrompt': '請查詢以下數據並返回結果：',
  'wf.tpl.genReport': '生成報告',
  'wf.tpl.genReportDesc': '生成報告',
  'wf.tpl.reportPrompt': '請根據以上所有步驟的結果，生成一份完整的分析報告，包含：1. 概述 2. 關鍵發現 3. 建議',
  'wf.stepName': '步驟名稱',
  'wf.unnamedStep': '未命名步驟',
  'wf.promptPlaceholder': '輸入發送給 AI 的提示詞...',
  'wf.waitForCompletion': '等待完成後再執行下一步',
  'wf.chars': '字',
  'wf.selectTemplate': '選擇步驟模板',
  'wf.blankStep': '+ 空白步驟',
  'wf.workflowName': '工作流名稱 *',
  'wf.workflowNamePlaceholder': '例如：每日數據分析報告',
  'wf.descLabel': '描述',
  'wf.descPlaceholderShort': '簡要描述工作流用途',
  'wf.categoryLabel': '分類',
  'wf.cronTrigger': '定時觸發',
  'wf.cronNotEnabled': '未啟用',
  'wf.quickSelect': '快速選擇',
  'wf.collapseCron': '↑ 收起自訂',
  'wf.expandCron': '↓ 自訂 Cron 表達式',
  'wf.cronPlaceholder': '例如: 0 9 * * 1-5',
  'wf.cronHint': '格式: 分 時 日 月 週 — 例如 "30 8 * * 1-5" = 工作日 8:30',
  'wf.execSteps': '執行步驟',
  'wf.addStepBtn': '新增步驟',
  'wf.continueAdd': '繼續新增',
  'wf.emptyTitle': '用工作流自動化你的任務',
  'wf.emptyDesc': '將多步驟任務編排成工作流，一鍵執行，讓 AI 按順序自動完成。',
  'wf.emptyStep1': '數據採集',
  'wf.emptyStep1Desc': '搜尋網頁、讀取檔案、查詢資料庫',
  'wf.emptyStep2': 'AI 分析',
  'wf.emptyStep2Desc': '數據清洗、分析總結、生成報告',
  'wf.emptyStep3': '結果輸出',
  'wf.emptyStep3Desc': '發送通知、儲存檔案、更新系統',
  'wf.createFirstBtn': '建立第一個工作流',
  'wf.nSteps': '個步驟',
  'wf.runNTimes': '運行 {n} 次',
  'wf.nStepsShort': '步驟',
  'wf.runBtn': '運行',
  'wf.editBtn': '編輯',
  'wf.copyBtn': '複製',
  'wf.deleteBtn': '刪除',
  'wf.editWorkflowTitle': '編輯工作流',
  'wf.createWorkflowTitle': '建立工作流',
  'wf.cancelBtn': '取消',
  'wf.saveBtn': '儲存',
  'wf.savingBtn': '儲存中...',
  'wf.descriptionLabel': '描述',
  'wf.categoryLabelShort': '分類',
  'wf.runLabel': '運行',
  'wf.recentLabel': '最近',
  'wf.stepsLabel': '步驟',
  'wf.count': '個',
  'wf.workflowTitle': '工作流',
  'wf.runSuccess': '工作流執行成功',
  'wf.runFailed': '工作流執行失敗',
  'wf.type.prompt': '提示詞',
  'wf.type.action': '動作',
  'wf.type.condition': '條件',
  'wf.type.loop': '迴圈',
  'team.title': '團隊管理',
  'team.search': '搜尋成員...',
  'team.invite': '邀請成員',
  'team.members': '成員',
  'team.role.admin': '管理員',
  'team.role.member': '成員',
  'team.role.viewer': '檢視者',
  'team.status.active': '活躍',
  'team.status.invited': '已邀請',
  'team.status.disabled': '已停用',
  'team.noMembers': '暫無成員',
  'team.noMembersHint': '邀請團隊成員開始協作',
  'team.inviteFirst': '邀請第一位成員',
  'team.lastActive': '最後活躍',
  'team.changeRole': '更改角色',
  'team.remove': '移除',
  'team.removeConfirm': '確定移除此成員？',
  'team.removeSuccess': '成員已移除',
  'team.removeFailed': '成員移除失敗',
  'team.inviteMember': '邀請成員',
  'team.email': '電子郵件',
  'team.emailPlaceholder': '輸入電子郵件地址',
  'team.selectRole': '選擇角色',
  'team.cancel': '取消',
  'team.sendInvite': '傳送邀請',
  'team.sending': '傳送中...',
  'team.inviteSuccess': '邀請已傳送',
  'team.inviteFailed': '邀請傳送失敗',
  'team.role.manager': '經理',
  'team.role.cs': '客服',
  'team.orgLevel.ceo': 'CEO',
  'team.orgLevel.vp': 'VP',
  'team.orgLevel.lead': '組長',
  'team.orgLevel.staff': '員工',
  'team.createUser': '建立使用者',
  'team.createUserTitle': '建立新使用者',
  'team.editUser': '編輯使用者',
  'team.editUserTitle': '編輯使用者: {name}',
  'team.resetPw': '重設密碼',
  'team.resetPwTitle': '重設密碼: {name}',
  'team.username': '使用者名稱',
  'team.usernamePlaceholder': '登入使用者名稱',
  'team.displayName': '顯示名稱',
  'team.displayNamePlaceholder': '顯示名稱',
  'team.password': '密碼',
  'team.passwordPlaceholder': '至少 6 個字元',
  'team.passwordMinLen': '密碼至少 6 個字元',
  'team.newPassword': '新密碼',
  'team.role': '角色',
  'team.orgLevel': '組織層級',
  'team.department': '所屬部門',
  'team.manager': '直屬上級',
  'team.emailLabel': '電子郵件',
  'team.phone': '手機號碼',
  'team.phonePlaceholder': '手機號碼',
  'team.unassigned': '未分配',
  'team.none': '無',
  'team.save': '儲存',
  'team.saving': '儲存中...',
  'team.createBtn': '建立使用者',
  'team.saveChanges': '儲存修改',
  'team.createDept': '建立部門',
  'team.createDeptTitle': '建立新部門',
  'team.editDept': '編輯部門',
  'team.editDeptTitle': '編輯部門: {name}',
  'team.deptName': '部門名稱',
  'team.deptNamePlaceholder': '例如：技術部',
  'team.description': '描述',
  'team.descPlaceholder': '部門描述',
  'team.parentDept': '上級部門',
  'team.parentDeptNone': '無（頂級部門）',
  'team.deptManager': '部門負責人',
  'team.deptManagerNone': '未指定',
  'team.sortOrder': '排序',
  'team.saveDept': '建立部門',
  'team.deactivateUser': '停用使用者',
  'team.deactivateConfirm': '確定要停用使用者「{name}」嗎？停用後該使用者將無法登入系統。',
  'team.deactivated': '已停用 {name}',
  'team.deleteDept': '刪除部門',
  'team.deleteDeptConfirm': '確定要刪除部門「{name}」嗎？此操作不可撤銷。',
  'team.deletedDept': '已刪除部門 {name}',
  'team.opFailed': '操作失敗',
  'team.deleteFailed': '刪除失敗',
  'team.networkError': '網路錯誤',
  'team.usernameRequired': '使用者名稱和密碼不能為空',
  'team.createFailed': '建立失敗',
  'team.updateFailed': '更新失敗',
  'team.deptNameRequired': '部門名稱不能為空',
  'team.pwResetSuccess': '密碼已重設成功',
  'team.pwResetNotify': '請通知使用者使用新密碼登入',
  'team.close': '關閉',
  'team.confirmReset': '確認重設',
  'team.activeMembers': '{n} 名活躍成員',
  'team.departments': '{n} 個部門',
  'team.userMgmt': '使用者管理',
  'team.deptMgmt': '部門管理',
  'team.searchPlaceholder': '搜尋使用者名稱、顯示名稱或電子郵件...',
  'team.all': '全部',
  'team.user': '使用者',
  'team.roleLabel': '角色',
  'team.deptLabel': '部門',
  'team.managerLabel': '上級',
  'team.levelLabel': '層級',
  'team.lastLogin': '最後登入',
  'team.actions': '操作',
  'team.editTooltip': '編輯',
  'team.resetPwTooltip': '重設密碼',
  'team.deactivateTooltip': '停用',
  'team.noMatchUsers': '沒有匹配的使用者',
  'team.noMatchUsersDesc': '請嘗試修改搜尋條件或篩選條件',
  'team.noUsers': '暫無使用者',
  'team.noUsersDesc': '使用者註冊後將顯示在這裡',
  'team.noDepts': '暫無部門',
  'team.noDeptsHint': '點擊上方「建立部門」按鈕開始',
  'team.noDesc': '無描述',
  'team.managerColon': '負責人: {name}',
  'team.memberCount': '{n} 人',
  'team.editDeptTooltip': '編輯',
  'team.deleteDeptTooltip': '刪除',
  'team.userCreated': '使用者建立成功',
  'team.userUpdated': '使用者資訊已更新',
  'team.deptUpdated': '部門已更新',
  'team.deptCreated': '部門建立成功',
  'team.confirmAction': '確認操作',
  'team.confirmDelete': '確認刪除',
  'fp.title': '檔案管理',
  'fp.search': '搜尋檔案...',
  'fp.noFiles': '暫無檔案',
  'fp.noFilesHint': '上傳檔案或在對話中傳送檔案',
  'fp.download': '下載',
  'fp.delete': '刪除',
  'fp.deleteConfirm': '確定刪除此檔案？',
  'fp.preview': '預覽',
  'fp.fileInfo': '檔案資訊',
  'fp.fileName': '檔案名稱',
  'fp.fileSize': '大小',
  'fp.fileType': '類型',
  'fp.createdAt': '建立時間',
  'fp.close': '關閉',
  'fp.copyContent': '複製內容',
  'fp.downloadFile': '下載檔案',
  'fp.binaryNoPreview': '二進位檔案，無法預覽',
  'fp.loadingFiles': '載入檔案列表...',
  'fp.selectFile': '選擇檔案查看內容',
  'fp.selectFileHint': '點擊左側檔案樹中的檔案進行預覽',
  'fp.workspaceFiles': '工作區檔案',
  'fp.changes': '變更',
  'fp.refreshFiles': '重新整理檔案列表',
  'fp.closePanel': '關閉檔案面板',
  'fp.loadFailed': '檔案載入失敗',
  'sd.title': '搜尋除錯',
  'sd.back': '返回',
  'sd.searchPlaceholder': '輸入搜尋查詢...',
  'sd.search': '搜尋',
  'sd.results': '搜尋結果',
  'sd.noResults': '無結果',
  'sd.noResultsHint': '嘗試不同的搜尋詞',
  'sd.score': '得分',
  'sd.source': '來源',
  'sd.chunk': '塊',
  'sd.similarity': '相似度',
  'sd.topK': 'Top K',
  'sd.threshold': '閾值',
  'sd.searchTime': '搜尋耗時',
  'sd.totalResults': '總結果數',
  'sd.minChars': '查詢至少需要 2 個字元',
  'sd.categoryFilter': '分類篩選',
  'sd.nResults': '{n} 筆結果',
  'sd.nFused': '{n} 筆融合',
  'sd.totalTime': '總耗時',
  'sd.queryLabel': '查詢',
  'sd.noChannelResults': '該通道無結果',
  'sd.panelTitle': 'RAG 搜尋除錯面板',
  'sd.panelDesc': '輸入查詢後，可以對比 FTS（全文搜尋）、Vector（語義搜尋）和 Hybrid（RRF 融合）三種搜尋通道的結果和評分。',
  'cap.search': '搜尋能力...',
  'cap.all': '全部',
  'cap.enabled': '已啟用',
  'cap.disabled': '已停用',
  'cap.noResults': '沒有匹配的能力',
  'cap.noResultsHint': '嘗試調整搜尋條件',
  'cap.toggleOn': '已啟用',
  'cap.toggleOff': '已停用',
  'cap.category': '分類',
  'cap.title': '能力面板',
  'cap.description': '管理 AI 助手的能力',
  'cap.webSearch': '網路搜尋',
  'cap.webSearchDesc': '搜尋網際網路獲取即時資訊',
  'cap.codeExec': '程式碼執行',
  'cap.codeExecDesc': '執行程式碼並返回結果',
  'cap.fileUpload': '檔案上傳',
  'cap.fileUploadDesc': '上傳和處理檔案',
  'cap.imageGen': '圖片產生',
  'cap.imageGenDesc': '根據描述產生圖片',
  'cap.voiceTrans': '語音轉寫',
  'cap.voiceTransDesc': '將語音轉換為文字',
  'cap.knowledgeBase': '知識庫',
  'cap.knowledgeBaseDesc': '從知識庫中檢索資訊',
  'cap.workflow': '工作流',
  'cap.workflowDesc': '執行預定義的工作流',
  'cap.close': '關閉',
  'cap.toolCat.codeExec': '程式碼執行',
  'cap.toolCat.fileOps': '檔案操作',
  'cap.toolCat.browser': '瀏覽器',
  'cap.toolCat.searchEngine': '搜尋引擎',
  'cap.toolCat.imageProc': '影像處理',
  'cap.toolCat.voiceSynth': '語音合成',
  'cap.toolCat.multiAgent': '多智能體',
  'cap.toolCat.messaging': '訊息通訊',
  'cap.toolCat.elevated': '進階權限',
  'cap.tool.exec': '命令執行',
  'cap.tool.process': '程序管理',
  'cap.tool.read': '檔案讀取',
  'cap.tool.write': '檔案寫入',
  'cap.tool.edit': '檔案編輯',
  'cap.tool.applyPatch': '補丁套用',
  'cap.tool.image': '影像生成',
  'cap.tool.canvas': '畫布繪製',
  'cap.tool.browser': '瀏覽器自動化',
  'cap.tool.webSearch': '網路搜尋',
  'cap.tool.webFetch': '網頁擷取',
  'cap.tool.tts': '文字轉語音',
  'cap.tool.subagents': '子智能體',
  'cap.tool.agentsList': '智能體列表',
  'cap.tool.message': '訊息發送',
  'cap.tool.nodes': '節點通訊',
  'cap.tool.elevated': '提權操作',
  'cap.tool.sessionsList': '工作階段列表',
  'cap.tool.sessionsHistory': '工作階段歷史',
  'cap.tool.sessionsSend': '工作階段發送',
  'cap.tool.sessionsSpawn': '工作階段建立',
  'cap.tool.sessionStatus': '工作階段狀態',
  'cap.skillCat.ops': '維運管理',
  'cap.skillCat.dev': '開發工具',
  'cap.skillCat.security': '安全防護',
  'cap.skillCat.creative': '內容創作',
  'cap.skillCat.data': '資料分析',
  'cap.skillCat.monitor': '監控告警',
  'cap.skillCat.evolution': '自我進化',
  'cap.skillCat.integration': '第三方整合',
  'cap.skillCat.other': '其他能力',
  'cap.aiCenter': 'AI 能力中心',
  'cap.sysCaps': '系統能力',
  'cap.searchSkills': '搜尋 Skills...',
  'cap.searchTools': '搜尋 Tools...',
  'cap.noSkillMatch': '沒有找到匹配的 Skill',
  'cap.invoking': '啟動中',
  'cap.use': '使用',
  'cap.useSkillMsg': '請使用「{name}」技能來幫我完成任務。',
  'cap.useSkill': '使用此技能',
  'cap.skillReady': '就緒',
  'cap.skillNotReady': '未就緒',
  'cap.skillDescription': '描述',
  'cap.skillInfo': '技能資訊',
  'cap.skillId': '技能 ID',
  'cap.skillVersion': '版本',
  'cap.skillAuthor': '作者',
  'cap.skillTriggers': '觸發關鍵詞',
  'invite.title': '邀請碼管理',
  'invite.noAccess': '無權存取',
  'invite.adminOnly': '僅管理員可以管理邀請碼',
  'invite.back': '返回首頁',
  'invite.createTitle': '建立新邀請碼',
  'invite.maxUses': '最大使用次數',
  'invite.expireDays': '有效天數',
  'invite.createBtn': '產生邀請碼',
  'invite.creating': '產生中...',
  'invite.empty': '還沒有邀請碼',
  'invite.emptyDesc': '點擊上方按鈕建立新的邀請碼',
  'invite.created': '建立',
  'invite.expired': '過期',
  'invite.statusActive': '有效',
  'invite.statusExpired': '已過期',
  'invite.statusUsed': '已用完',
  'invite.statusInactive': '已停用',
  'invite.uses': '次',
  'notif.title': '通知中心',
  'notif.markAllRead': '全部已讀',
  'notif.all': '全部',
  'notif.unread': '未讀',
  'notif.loading': '載入中...',
  'notif.emptyUnread': '沒有未讀通知',
  'notif.emptyUnreadDesc': '所有通知已讀，太棒了！',
  'notif.empty': '暫無通知',
  'notif.emptyDesc': '系統通知將在此處顯示',
  'notif.typeTicket': '工單',
  'notif.typeKol': 'KOL',
  'notif.typeSystem': '系統',
  'notif.typeAlert': '告警',
  'notif.fetchError': '獲取通知失敗',
  'notif.markReadError': '標記已讀失敗',
  'notif.deleteError': '刪除通知失敗',
  'notif.markRead': '標記已讀',
  'notif.delete': '刪除',
  'prompt.title': '提示詞模板庫',
  'prompt.search': '搜尋模板...',
  'prompt.allCats': '全部',
  'prompt.empty': '暫無模板',
  'prompt.emptyDesc': '開始建立你的第一個提示詞模板吧',
  'prompt.useBtn': '使用',
  'prompt.usedCount': '次使用',
  'prompt.catOps': '營運',
  'prompt.catDev': '研發',
  'prompt.catDevOps': '維運',
  'prompt.catCreative': '創作',
  'prompt.catAnalysis': '分析',
  'prompt.catGeneral': '通用',
  'task.title': '任務佇列',
  'task.autoRefresh': '自動重新整理',
  'task.paused': '已暫停',
  'task.total': '總任務',
  'task.completed': '已完成',
  'task.failed': '失敗',
  'task.avgDuration': '平均耗時',
  'task.statusRunning': '執行中',
  'task.statusCompleted': '已完成',
  'task.statusFailed': '失敗',
  'task.statusQueued': '排隊中',
  'task.empty': '任務佇列暫無記錄',
  'task.emptyRunning': '執行中',
  'task.emptyCompleted': '已完成',
  'task.emptyFailed': '失敗',
  'task.emptyQueued': '排隊中',
  'task.backToChat': '返回對話',
  'task.running': '執行中',
  // Ticket Manager
  'ticket.title': '工單管理',
  'ticket.total': '共',
  'ticket.search': '搜尋工單...',
  'ticket.allStatus': '全部狀態',
  'ticket.allPriority': '全部優先級',
  'ticket.allCategory': '全部分類',
  'ticket.createTicket': '建立工單',
  'ticket.noTickets': '暫無工單',
  'ticket.noTicketsHint': '建立工單以開始追蹤問題',
  'ticket.status.open': '待處理',
  'ticket.status.inProgress': '處理中',
  'ticket.status.resolved': '已解決',
  'ticket.status.closed': '已關閉',
  'ticket.priority.critical': '緊急',
  'ticket.priority.high': '高',
  'ticket.priority.medium': '中',
  'ticket.priority.low': '低',
  'ticket.form.title': '標題',
  'ticket.form.description': '描述',
  'ticket.form.category': '分類',
  'ticket.form.priority': '優先級',
  'ticket.form.submit': '提交',
  'ticket.form.cancel': '取消',
  'ticket.assignee': '處理人',
  'ticket.createdAt': '建立時間',
  'ticket.updatedAt': '更新時間',
  'ticket.addComment': '新增評論',
  'ticket.commentPlaceholder': '輸入評論內容...',
  'ticket.submitComment': '提交評論',
  'ticket.noComments': '暫無評論',
  'ticket.aiAnalysis': 'AI 分析',
  'ticket.changeStatus': '變更狀態',
  'ticket.changePriority': '變更優先級',

  'ticket.created': '工單已建立',
  'ticket.createFailed': '工單建立失敗',
  'ticket.statusUpdated': '工單狀態已更新',
  'ticket.statusUpdateFailed': '工單更新失敗',
  'ticket.autoAssigned': '已自動分配給',
  'ticket.noAssignRule': '未匹配到分配規則',
  'ticket.aiRecommend': 'AI 推薦',
  'ticket.aiAnalyzing': '分析中...',
  'ticket.aiApply': '採納 AI 推薦',
  'ticket.aiApplied': '已採納',
  'ticket.aiCategory': '分類',
  'ticket.aiPriority': '優先級',
  'ticket.cat.general': '通用',
  'ticket.cat.product': '產品問題',
  'ticket.cat.shipping': '物流',
  'ticket.cat.payment': '支付',
  'ticket.cat.refund': '退款',
  'ticket.cat.account': '帳號',
  'ticket.form.descPlaceholder': '詳細描述問題...',
  'ticket.form.titlePlaceholder': '簡要描述問題',
  'ticket.form.customerName': '客戶姓名',
  'ticket.form.customerPlatform': '客戶平台',
  'ticket.form.selectPlatform': '選擇平台',
  'ticket.detail.customer': '客戶',
  'ticket.detail.email': '信箱',
  'ticket.detail.platform': '平台',
  'ticket.detail.assignee': '負責人',
  'ticket.detail.autoAssign': '自動分配',
  'store.err.systemBusy': '系統暫時繁忙，正在恢復中...',
  'store.err.waitingSeconds': '📝 正在深度分析中，已用時 {seconds} 秒，請耐心等待...',
  'store.err.taskTimeout': '任務超時，請重新發送訊息重試',
  'store.err.taskFailed': '任務處理失敗，請重試',
  'store.err.sendFailed': '發送訊息失敗，請重試',
  'store.err.retrying409': '當前對話正在處理中，3秒後自動重試...',
  'store.err.chatBusy': '當前對話正在處理中，請等待完成後再發送',
  'store.err.tooFrequent': '請求過於頻繁，請稍後再試',
  'store.err.loginExpired': '登入已過期，請重新登入',
  'store.err.chatNotFound': '對話不存在，請重新整理頁面',
  'store.err.serverError': '伺服器錯誤，請稍後重試',
  'store.err.requestTimeout': '請求超時，請檢查網路後重試',
  'store.err.networkFailed': '網路連線失敗，請檢查網路後重試',
  'store.err.regenerateFailed': '重新生成失敗，請重試',
  'store.err.serverErrorShort': '伺服器錯誤',
  'home.title': 'RangerAI',
  'home.subtitle': '智慧對話助手',
  'home.startChat': '開始對話',
  'export.mdTitle': '對話記錄',
  'export.model': '模型',
  'export.taskType': '任務類型',
  'export.thinking': '思考過程',
  'export.toolCalls': '工具呼叫',
  'export.toolName': '工具',
  'export.args': '參數',
  'export.result': '結果',
  'export.status': '狀態',
  'export.steps': '執行步驟',
  'export.stepName': '步驟',
  'export.detail': '詳情',
  'error.unexpectedError': '應用程式發生了意外錯誤',
  'error.reloadPage': '重新載入頁面',
  'error.backToHome': '返回首頁',
  'error.showDetails': '顯示錯誤詳情',
  'error.hideDetails': '隱藏錯誤詳情',
  'error.autoRetryAttempted': '已自動重試 {count} 次',
  'error.componentStack': '元件堆疊',
  'network.offline': '網路連線已中斷，請檢查網路設定',
  'network.backOnline': '網路已恢復連線',
  'model.smartRouterName': '智慧路由',
  'model.smartRouterDesc': '根據任務類型自動選擇最佳模型',
  'model.claudeDesc': '程式碼與創意寫作',
  'model.deepseekV4Desc': 'Agent 能力最強，程式碼與推理',
  'model.gpt55Desc': '綜合能力最強，中文優秀',
  'model.gpt54MiniDesc': '輕量快速，成本優化',
  'model.geminiFlashDesc': '快速回應，圖片生成',
  'model.gpt5MiniDesc': '輕量快速',
  'model.gpt4Desc': '綜合推理能力',
  'model.gpt4oDesc': '快速回應',
  'model.gpt4oMiniDesc': '輕量快速',
  'model.tierAuto': '智慧',
  'model.tierPremium': '旗艦模型',
  'model.tierFast': '快速回應',
  'model.tierReasoning': '深度推理',
  'model.currentModel': '目前模型',
  'model.selectModel': '選擇模型',
  'tag.title': '標籤管理',
  'tag.noTags': '尚無標籤',
  'tag.inputPlaceholder': '輸入標籤名稱，按 Enter 新增',
  'tag.add': '新增',
  'tag.existingTags': '已有標籤：',
  'upload.fileTooLarge': '檔案超過 20MB 限制',
  'upload.uploadImage': '上傳圖片',
  'upload.uploadFile': '上傳檔案',
  'attachment.failed': '失敗',
  'attachment.openInNewTab': '在新分頁開啟',
  'aiFile.generatedFiles': '產生的檔案',
  'aiFile.openInNewTab': '在新分頁開啟',
  'aiFile.copyCode': '複製程式碼',
  'aiFile.downloadFile': '下載檔案',
  'aiFile.collapse': '收起',
  'aiFile.expandAll': '展開全部',
  'aiFile.lines': '行',
  'share.title': '共享對話',
  'share.loadFailed': '載入資料失敗',
  'share.sharedTo': '已共享給',
  'share.shareFailed': '共享失敗，請重試',
  'share.cancelShareConfirm': '確定取消共享？',
  'share.cancelShareFailed': '取消共享失敗',
  'share.conversation': '對話',
  'share.loading': '載入中...',
  'share.noShareableUsers': '沒有可共享的使用者',
  'share.selectUser': '選擇使用者',
  'share.readOnly': '唯讀',
  'share.readWrite': '讀寫',
  'share.shared': '已共享',
  'share.notSharedYet': '尚未共享給任何人',
  'share.readWriteLabel': '讀寫',
  'share.readOnlyLabel': '唯讀',
  'share.cancelShare': '取消共享',
  'share.readOnlyHint': '唯讀使用者可以查看對話內容，讀寫使用者可以在對話中發送訊息',
  'share.copyLink': '複製連結',
  'share.linkCopied': '已複製',
  'role.selectRole': '選擇 AI 角色',
  'role.role': '角色',
  'role.aiRoles': 'AI 角色',
  'role.aiRolesHint': '選擇專業角色獲得更精準的回答',
  'kref.title': '知識庫引用',
  'searchCards.results': '搜尋結果',
  'notif.justNow': '剛剛',
  'notif.minutesAgo': '分鐘前',
  'notif.hoursAgo': '小時前',
  'notif.daysAgo': '天前',
  'time.justNow': '剛剛',
  'time.minutesAgo': '分鐘前',
  'time.hoursAgo': '小時前',
  'time.daysAgo': '天前',
  'time.neverRun': '從未運行',
  'stats.codeBlock': '[程式碼]',
  'team.noDepts2': '尚無部門',
  'team.noDeptsHint2': '點擊上方"建立部門"按鈕開始',
  'team.noDesc2': '無描述',
  'team.managerColon2': '負責人',
  'sidebar.ceoDashboard': 'CEO看板',
  'sidebar.dataAnalytics': '數據分析',
  'sidebar.dailyReports': '日報分析',
  'sidebar.opsEfficiency': '運營效率',
  // Browser Preview
  'browserPreview.noScreenshots': '暫無截圖',
  'browserPreview.hint': '當 AI 使用瀏覽器時，截圖將在此顯示',
  'browserPreview.connecting': '連接中...',
  'browserPreview.takeOver': '接管瀏覽器',
  'browserPreview.returnControl': '歸還控制權',
  'browserPreview.browserOffline': '瀏覽器離線',
  // Input & Toast
  'input.stopping': '停止中...',
  "input.stopGeneration": "停止生成",
  'toast.waitForAI': '請等待 AI 回覆完成後再發送',
  // Chat roles
  'chat.ai': 'AI',
  'chat.system': '系統',
  'chat.user': '使用者',

};

const en: TranslationKeys = {
  'sidebar.newChat': 'New',
  'sidebar.searchPlaceholder': 'Search chats...',
  'sidebar.sharedChats': 'Shared with me',
  'sidebar.batchManage': 'Batch manage',
  'sidebar.promptTemplates': 'Prompt Templates',
  'sidebar.aiCapabilities': 'AI Capabilities',
  'sidebar.stats': 'System Stats',
  'sidebar.inviteCodes': 'Invite Codes',
  'sidebar.logout': 'Sign out',
  'sidebar.admin': 'Admin',
  'sidebar.member': 'Member',
  'sidebar.collapseSidebar': 'Collapse sidebar',
  'sidebar.expandSidebar': 'Expand sidebar',
  'sidebar.aiReady': 'AI Ready',
  'sidebar.aiOffline': 'AI Offline',
  'sidebar.connected': 'Connected',
  'sidebar.disconnected': 'Disconnected',
  'sidebar.deleteConfirm': 'Delete this conversation?',
  'sidebar.rename': 'Rename',
  'sidebar.delete': 'Delete',

  'chat.inputPlaceholder': 'Type a message, press Enter to send',
  'chat.send': 'Send',
  'chat.uploadFile': 'Upload file',
  'chat.currentModel': 'Current model',
  'chat.manageTags': 'Manage tags',
  'chat.exportChat': 'Export chat',
  'chat.openFilePanel': 'Open file panel',
  'chat.copyMessage': 'Copy message',
  'chat.regenerate': 'Regenerate',
  'chat.thinking': 'Thinking',
  'chat.toolCalls': 'tool calls',
  'chat.allSuccess': 'all succeeded',
  'chat.steps': 'steps',

  'capabilities.title': 'AI Capabilities',
  'capabilities.skills': 'Skills',
  'capabilities.tools': 'Tools',
  'capabilities.caps': 'Caps',
  'capabilities.searchSkills': 'Search Skills...',
  'capabilities.searchTools': 'Search Tools...',
  'capabilities.noResults': 'No matching results',

  'prompts.title': 'Prompt Templates',
  'prompts.searchPlaceholder': 'Search prompts...',
  'prompts.usePrompt': 'Use',
  'prompts.noPrompts': 'No prompt templates yet',
  'prompts.category': 'Category',
  'prompts.allCategories': 'All categories',

  'stats.title': 'System Statistics',
  'stats.refresh': 'Refresh',
  'stats.totalChats': 'Total Chats',
  'stats.totalMessages': 'Total Messages',
  'stats.totalUsers': 'Total Users',
  'stats.database': 'Database',
  'stats.messageTrend': 'Message Trend (7 days)',
  'stats.roleDistribution': 'Role Distribution',
  'stats.modelUsage': 'Model Usage',
  'stats.routingComplexity': 'Routing Complexity',
  'stats.hotTags': 'Hot Tags',
  'stats.userActivity': 'User Activity',
  'stats.recentRouting': 'Recent Routing',
  'stats.user': 'User',
  'stats.role': 'Role',
  'stats.chatCount': 'Chats',
  'stats.messageCount': 'Messages',
  'stats.lastLogin': 'Last Login',
  'stats.userMessages': 'User Messages',
  'stats.aiReplies': 'AI Replies',
  'stats.fetchError': 'Failed to load statistics',
  'workflow.loadError': 'Failed to load workflows',
  'workflow.saveError': 'Failed to save workflow',
  'workflow.deleteError': 'Failed to delete workflow',
  'workflow.duplicateError': 'Failed to duplicate workflow',
  'taskQueue.loadError': 'Failed to load tasks',
  'prompt.loadError': 'Failed to load prompt templates',
  'chatPage.exportError': 'Failed to export conversation',

  'common.loading': 'Loading...',
  'common.error': 'Something went wrong',
  'common.retry': 'Retry',
  'common.cancel': 'Cancel',
  'common.confirm': 'Confirm',
  'common.save': 'Save',
  'common.back': 'Back',
  'common.noData': 'No data available',
  'common.copied': 'Copied',
  'common.featureComingSoon': 'Coming soon',
  'common.language': 'Language',

  // Sidebar Navigation
  'sidebar.conversations': 'Chats',
  'sidebar.capabilities': 'Capabilities',
  'sidebar.knowledge': 'Knowledge',
  'sidebar.workflows': 'Workflows',
  'sidebar.tasks': 'Tasks',
  'sidebar.tickets': 'Tickets',
  'sidebar.kol': 'KOL',
  'sidebar.notifications': 'Notifications',
  'sidebar.console': 'Console',
  'sidebar.navGroupTools': 'AI Tools',
  'sidebar.navGroupAdmin': 'Admin',
  'sidebar.team': 'Team',
  'sidebar.globalSearch': 'Search all... (Ctrl+K)',
  'sidebar.tagFilter': 'Filter by tag',
  'sidebar.noSharedChats': 'No shared chats',
  'sidebar.from': 'From',
  'sidebar.selected': 'selected',
  'sidebar.selectAll': 'Select all',
  'sidebar.deselectAll': 'Deselect all',
  'sidebar.noMatchingChats': 'No matching chats found',
  'sidebar.noTagChats': 'No chats with this tag',
  'sidebar.noChatsYet': 'No chats yet',
  'sidebar.chatList': 'Chat list',
  'sidebar.clickNewToStart': 'Click "New" above to start',
  'sidebar.noKnowledgeOrWorkflow': 'No knowledge or workflow results found',
  'sidebar.foundChats': 'chats',
  'sidebar.searching': 'Searching...',
  'sidebar.aiStarting': 'Starting',
  'sidebar.reconnecting': 'Reconnecting',
  'sidebar.disconnectedShort': 'Offline',
  'sidebar.newConversation': 'New chat',
  'sidebar.exitBatchMode': 'Exit batch mode',

  // Toast messages
  'toast.createChatFailed': 'Failed to create chat',
  'toast.renameFailed': 'Rename failed',
  'toast.renameSuccess': 'Renamed successfully',
  'toast.deleteFailed': 'Delete failed',
  'toast.deleteSuccess': 'Chat deleted',
  'toast.batchDeleteFailed': 'Batch delete failed',
  'toast.batchDeleteSuccess': 'Deleted',
  'toast.exportFailed': 'Export failed, please retry',
  'toast.copySuccess': 'Copied to clipboard',
  'toast.copyFailed': 'Copy failed',

  // ChatPage
  'chatPage.exportConversation': 'Export conversation',
  'chatPage.exportMarkdown': 'Export Markdown',
  'chatPage.exportJson': 'Export JSON',
  'chatPage.collapseSidebar': 'Collapse sidebar',
  'chatPage.expandSidebar': 'Expand sidebar',
  'chatPage.aiConnected': 'AI engine connected',
  'chatPage.wsConnectedAiConnecting': 'WebSocket connected, AI connecting...',
  'chatPage.disconnectedReconnecting': 'Disconnected, reconnecting...',
  'chatPage.connected': 'Connected',
  'chatPage.aiConnecting': 'AI connecting',
  'chatPage.reconnecting': 'Reconnecting',
  'chatPage.manageTags': 'Manage tags',
  'chatPage.openFilePanel': 'Open file panel',
  'chatPage.closeFilePanel': 'Close file panel',
  'chatPage.viewFiles': 'View files',
  'chatPage.workspaceFiles': 'Workspace files',
  'chatPage.changes': 'changes',
  'chatPage.backToList': 'Back to list',
  'chatPage.binaryFile': 'Binary file, cannot preview',
  'chatPage.noWorkspaceFiles': 'No workspace files',
  'chatPage.filesAppearHere': 'Files will appear here when AI creates or modifies them',

  // LoginPage
  'login.subtitle': 'AI Platform for Going Global',
  'login.loginTab': 'Login',
  'login.registerTab': 'Register',
  'login.username': 'Username',
  'login.usernamePlaceholder': 'Enter username',
  'login.password': 'Password',
  'login.passwordPlaceholder': 'Enter password',
  'login.passwordMinLength': 'At least 6 characters',
  'login.confirmPassword': 'Confirm Password',
  'login.confirmPasswordPlaceholder': 'Re-enter password',
  'login.inviteCode': 'Invite Code',
  'login.inviteCodeHint': 'Contact admin for an invite code',
  'login.loggingIn': 'Logging in...',
  'login.registering': 'Registering...',
  'login.loginButton': 'Login',
  'login.registerButton': 'Register',
  'login.noAccountHint': 'No account? Click the "Register" tab above and use an invite code',
  'login.hasAccountHint': 'Already have an account? Click the "Login" tab above',
  'login.errorEmptyFields': 'Please enter username and password',
  'login.errorPasswordMismatch': 'Passwords do not match',
  'login.errorPasswordTooShort': 'Password must be at least 6 characters',
  'login.errorNoInviteCode': 'Please enter an invite code',
  'login.errorLoginFailed': 'Login failed',
  'login.errorRegisterFailed': 'Registration failed',
  'validation.usernameTooShort': 'Username must be at least 2 characters',
  'validation.usernameTooLong': 'Username must be 30 characters or less',
  'validation.fieldRequired': 'This field is required',
  'validation.nameTooLong': 'Name is too long',

  // MessageInput
  'input.imageAttachment': 'Image',
  'input.fileAttachment': 'File',
  'input.dropFilesHere': 'Drop files here',
  'input.supportsImagesAndDocs': 'Supports images and documents',
  'input.connecting': 'Connecting...',
  'input.aiReplying': 'AI is replying...',
  'input.placeholder': 'Type a message, Enter to send, Shift+Enter for new line',
  'input.placeholderMobile': 'Type a message...',
  'input.ariaLabel': 'Type a message',
  'input.processing': 'Processing',
  'input.uploading': 'Uploading files...',
  'input.send': 'Send',
  'input.sendMessage': 'Send message',
  'input.footer': 'RangerAI · AI Platform for Going Global',

  'model.smartRouter': 'Smart Router',

  // MessageList
  'msg.taskType.code': 'Code',
  'msg.taskType.reasoning': 'Reasoning',
  'msg.taskType.creative': 'Creative',
  'msg.taskType.research': 'Research',
  'msg.taskType.imageGeneration': 'Image Gen',
  'msg.taskType.chat': 'Chat',
  'msg.thinking.low': 'Light',
  'msg.thinking.medium': 'Standard',
  'msg.thinking.high': 'Deep',
  'msg.thinking.xhigh': 'Ultra',
  'msg.thinkingSuffix': ' thinking',
  'msg.skillCat.ops': 'Ops',
  'msg.skillCat.security': 'Security',
  'msg.skillCat.network': 'Network',
  'msg.skillCat.monitoring': 'Monitoring',
  'msg.skillCat.deploy': 'Deploy',
  'msg.skillCat.backup': 'Backup',
  'msg.skillCat.log': 'Logs',
  'msg.skillCat.cost': 'Cost',
  'msg.skillCat.env': 'Env',
  'msg.skillCat.cron': 'Cron',
  'msg.skillCat.evolve': 'Evolve',
  'msg.skillCat.creation': 'Creation',
  'msg.skillCat.query': 'Query',
  'msg.skillCat.dev': 'Dev',
  'msg.skillCat.mgmt': 'Mgmt',
  'msg.tool.webSearch': 'Web Search',
  'msg.tool.webFetch': 'Web Fetch',
  'msg.tool.browser': 'Browser',
  'msg.tool.terminal': 'Terminal',
  'msg.tool.readFile': 'Read File',
  'msg.tool.writeFile': 'Write File',
  'msg.tool.editFile': 'Edit File',
  'msg.tool.genImage': 'Generate Image',
  'msg.tool.canvas': 'Canvas',
  'msg.tool.tts': 'Text-to-Speech',
  'msg.tool.codeExec': 'Code Exec',
  'msg.tool.memorySearch': 'Memory Search',
  'msg.tool.memoryGet': 'Memory Get',
  'msg.toolTitle.search': 'Search',
  'msg.toolTitle.fetch': 'Fetch',
  'msg.toolTitle.browserAction': 'Browser',
  'msg.toolTitle.execCmd': 'Execute command',
  'msg.toolTitle.read': 'Read',
  'msg.toolTitle.write': 'Write',
  'msg.toolTitle.edit': 'Edit',
  'msg.toolTitle.genImage': 'Generate image',
  'msg.toolTitle.canvasOp': 'Canvas operation',
  'msg.toolTitle.tts': 'Text-to-speech',
  'msg.toolTitle.memSearch': 'Memory search',
  'msg.toolTitle.memGet': 'Memory get',
  'msg.toolTitle.file': 'file',
  'msg.exec.running': 'Running',
  'msg.exec.done': 'Completed',
  'msg.exec.steps': 'steps',
  'msg.card.params': 'Parameters',
  'msg.card.result': 'Result',
  'msg.card.browserScreenshot': 'Browser Screenshot',
  'msg.card.generatedImage': 'Generated Image',
  'msg.card.imageGenerating': 'Generating image...',
  'msg.preview.imagePreview': 'Image preview',
  'msg.preview.closePreview': 'Close image preview',
  'msg.preview.viewLarger': 'View larger',
  'msg.preview.browserScreenshot': 'Browser screenshot',
  'msg.preview.closeSsPreview': 'Close screenshot preview',
  'msg.summary.toolCalls': ' tool calls',
  'msg.summary.success': ' succeeded',
  'msg.summary.fail': ' failed',
  'msg.summary.allSuccess': 'all succeeded',
  'msg.summary.stepsCount': ' steps',
  'msg.summary.expandAll': '... expand all',
  'msg.summary.collapse': 'collapse',
  'msg.summary.viewTerminal': 'View terminal output',
  'msg.action.copied': 'Copied',
  'msg.action.copyMsg': 'Copy message',
  'msg.action.copy': 'Copy',
  'msg.action.regenerate': 'Regenerate',
  'msg.stream.deepThinking': 'Deep thinking',
  'msg.stream.thinking': 'Thinking...',
  'msg.stream.analyzing': 'Analyzing...',
  'msg.stream.close': 'Close',
  'msg.phase.executing': 'Executing',
  'msg.phase.outputting': 'Outputting',
  'msg.scrollToBottom': 'Scroll to bottom',
  'msg.welcome.subtitle': 'AI Platform for Going Global — 94 professional skills at your service',
  'msg.welcome.modelRoute': '23+ AI models with smart routing · Auto-selects optimal skill combinations',
  'msg.welcome.describeNeeds': 'Describe your needs and RangerAI will automatically select the best skill combination',
  'msg.welcome.cap.webSearch': 'Web Search & Analysis',
  'msg.welcome.cap.webSearchDesc': 'Real-time search, web scraping, data extraction & competitor analysis',
  'msg.welcome.cap.codeDev': 'Code Development & Debugging',
  'msg.welcome.cap.codeDevDesc': 'Full-stack dev, code review, bug fixes & automation scripts',
  'msg.welcome.cap.dataViz': 'Data Processing & Visualization',
  'msg.welcome.cap.dataVizDesc': 'Data cleaning, statistical analysis, chart generation & report writing',
  'msg.welcome.cap.securityOps': 'Security Audit & Operations',
  'msg.welcome.cap.securityOpsDesc': 'Server inspection, vulnerability scanning, performance monitoring & deployment',
  'msg.welcome.cap.contentDesign': 'Content Creation & Design',
  'msg.welcome.cap.contentDesignDesc': 'Copywriting, image generation, multilingual translation & SEO optimization',
  'msg.welcome.cap.fileMgmt': 'File Processing & Management',
  'msg.welcome.cap.fileMgmtDesc': 'Document conversion, PDF parsing, batch processing & cloud sync',
  'msg.welcome.cap.aiModel': 'AI Models & Reasoning',
  'msg.welcome.cap.aiModelDesc': 'Smart routing 23+ models, multi-turn dialogue, deep thinking & expert answers',
  'msg.welcome.cap.sysIntegration': 'System Integration & API',
  'msg.welcome.cap.sysIntegrationDesc': 'REST API calls, database operations, third-party service integration',
  'msg.welcome.cap.docReport': 'Document & Report Generation',
  'msg.welcome.cap.docReportDesc': 'Technical docs, business reports, research analysis & knowledge base',
  'msg.welcome.cap.multiLang': 'Multilingual & Localization',
  'msg.welcome.cap.multiLangDesc': 'Multi-language translation, content localization & cultural adaptation',
  'msg.welcome.cap.browserAuto': 'Browser Automation',
  'msg.welcome.cap.browserAutoDesc': 'Web operations, form filling, screenshot review & automated testing',
  'msg.welcome.cap.taskOrch': 'Task Orchestration & Automation',
  'msg.welcome.cap.taskOrchDesc': 'Multi-step task orchestration, scheduled execution, workflow automation',
  'msg.welcome.cap.smartChat': 'Smart Chat & Consulting',
  'msg.welcome.cap.smartChatDesc': 'Professional Q&A, business consulting, tech support & decision advice',
  'msg.welcome.cap.research': 'Research & Intelligence',
  'msg.welcome.cap.researchDesc': 'Industry research, market intelligence, tech trends & competitive analysis',
  'msg.welcome.cap.projectMgmt': 'Project Management & Collaboration',
  'msg.welcome.cap.projectMgmtDesc': 'Task tracking, team collaboration, progress management & resource allocation',
  // Admin Dashboard
  'admin.title': 'Admin Console',
  'admin.running': 'Running',
  'admin.version': 'v',
  'admin.tab.overview': 'Overview',
  'admin.tab.system': 'System',
  'admin.tab.users': 'Users',
  'admin.tab.config': 'Config',
  'admin.tab.roles': 'AI Roles',
  'admin.tab.audit': 'Audit Log',
  'admin.tab.assignRules': 'Assign Rules',
  'admin.tab.openPlatform': 'Open Platform',
  'admin.tab.services': 'Services',
  'admin.nav.monitor': 'Monitor',
  'admin.nav.manage': 'Manage',
  'admin.nav.ops': 'Operations',
  'admin.nav.ai': 'AI Intelligence',
  'admin.tab.toolMemory': 'Tool Memory',
  'admin.toolMemory.title': 'Adaptive Tool Memory',
  'admin.toolMemory.totalRecords': 'Total Records',
  'admin.toolMemory.subTypeStats': 'Tool SubType Stats',
  'admin.toolMemory.topTools': 'Most Used Tools',
  'admin.toolMemory.recentPatterns': 'Recent Task Patterns',
  'admin.toolMemory.hitCount': 'Hit Count',
  'admin.toolMemory.successRate': 'Success Rate',
  'admin.toolMemory.avgDuration': 'Avg Duration',
  'admin.toolMemory.noData': 'No tool memory data yet',
  'admin.refresh': 'Refresh',
  'admin.collapse': 'Collapse',
  'admin.acp.service': 'ACP Gateway',
  'admin.acp.activeKeys': 'Active Keys',
  'admin.acp.asyncTasks': 'Async Tasks',
  'admin.acp.dingtalk': 'DingTalk Adapter',
  'admin.acp.connected': 'Connected',
  'admin.acp.disconnected': 'Disconnected',
  'admin.acp.disabled': 'Disabled',
  'admin.acp.apiKeys': 'API Key Management',
  'admin.acp.apiKeysDesc': 'Manage API keys for external systems to access RangerAI via ACP Gateway',
  'admin.acp.createKey': 'Create Key',
  'admin.acp.newKey': 'Create New API Key',
  'admin.acp.keyName': 'Key Name',
  'admin.acp.keyNamePlaceholder': 'e.g. DingTalk Bot, CRM System',
  'admin.acp.nameRequired': 'Please enter a key name',
  'admin.acp.generate': 'Generate',
  'admin.acp.keyCreated': 'API Key Created',
  'admin.acp.keyCreatedHint': 'Copy and save immediately. This key is shown only once and cannot be viewed again.',
  'admin.acp.copy': 'Copy',
  'admin.acp.copied': 'Copied',
  'admin.acp.noKeys': 'No API Keys',
  'admin.acp.noKeysHint': 'Create an API key to allow external systems to call RangerAI',
  'admin.acp.thName': 'Name',
  'admin.acp.thKeyPrefix': 'Key Prefix',
  'admin.acp.thStatus': 'Status',
  'admin.acp.thCalls': 'Calls',
  'admin.acp.thLastUsed': 'Last Used',
  'admin.acp.thCreatedAt': 'Created',
  'admin.acp.thActions': 'Actions',
  'admin.acp.statusActive': 'Active',
  'admin.acp.statusRevoked': 'Revoked',
  'admin.acp.revoke': 'Revoke',
  'admin.acp.revokeConfirm': 'Confirm Revoke Key',
  'admin.acp.revokeMsg': 'Are you sure you want to revoke this API key? This cannot be undone:',
  'admin.acp.envKeyNoRevoke': 'Environment variable keys cannot be revoked via the UI',
  'admin.acp.apiDocs': 'API Documentation',
  'admin.acp.docSyncChat': 'Synchronous chat (wait for reply)',
  'admin.acp.docAsyncChat': 'Asynchronous chat (returns task ID immediately)',
  'admin.acp.docTaskStatus': 'Query async task status',
  'admin.acp.docKnowledge': 'Knowledge base search',
  'admin.acp.usageExample': 'Usage example:',
  'admin.status.running': 'Running',
  'admin.status.healthy': 'Healthy',
  'admin.status.degraded': 'Degraded',
  'admin.status.loadFailed': 'Load failed',
  'admin.status.noData': 'No system data',
  'admin.status.loading': 'Loading...',
  'admin.overview.totalLabel': 'Total',
  'admin.overview.pending': 'Pending',
  'admin.overview.inProgress': 'In Progress',
  'admin.overview.resolved': 'Resolved',
  'admin.overview.closed': 'Closed',
  'admin.overview.totalKol': 'Total KOLs',
  'admin.overview.cooperating': 'Active',
  'admin.overview.totalCooperation': 'Total Deals',
  'admin.overview.trendNew': 'Created',
  'admin.overview.trendResolved': 'Resolved',
  'admin.overview.cpuLoad': 'CPU Load',
  'admin.overview.cores': 'cores',
  'admin.overview.serviceStatus': 'Service Status',
  'admin.overview.uptime': 'Uptime',
  'admin.overview.dbUsers': 'Users',
  'admin.overview.dbChats': 'Chats',
  'admin.overview.dbMessages': 'Messages',
  'admin.overview.dbSize': 'DB Size',
  'admin.overview.heapUsed': 'Heap Used',
  'admin.overview.rss': 'RSS Memory',
  'admin.overview.activeTasks': 'Active Tasks',
  'admin.overview.noActiveTasks': 'No active tasks',
  'admin.overview.elapsedSec': 's',
  'admin.overview.ticketStats': 'Ticket Stats',
  'admin.overview.kolStats': 'KOL Stats',
  'admin.overview.ticketTrend': 'Ticket Trend',
  'admin.system.memory': 'System Memory',
  'admin.system.used': 'Used',
  'admin.system.total': 'Total',
  'admin.system.usageRate': 'Usage',
  'admin.system.free': 'Free',
  'admin.system.disk': 'Disk',
  'admin.system.diskUsed': 'Used',
  'admin.system.diskAvailable': 'Available',
  'admin.system.platform': 'Platform',
  'admin.system.nodeVersion': 'Node Version',
  'admin.system.pid': 'Process PID',
  'admin.system.processMemory': 'Process Memory',
  'admin.system.browserStatus': 'Browser Status',
  'admin.system.circuitBreaker': 'Circuit Breaker',
  'admin.system.failCount': 'Fail Count',
  'admin.system.lastFail': 'Last Failure',
  'admin.system.recoverBrowser': 'Recover Browser',
  'admin.system.resetBreaker': 'Reset Breaker',
  'admin.system.breakerClosed': 'Closed',
  'admin.system.breakerOpen': 'Open',
  'admin.system.breakerHalfOpen': 'Half-Open',
  'admin.system.opSuccess': 'Operation succeeded',
  'admin.system.opFailed': 'Operation failed',
  'admin.system.ports': 'Port Status',
  'admin.system.halfOpenAttempts': 'Half-Open Attempts',
  'admin.system.sysInfo': 'System Info',
  'admin.users.search': 'Search users...',
  'admin.users.roleAdmin': 'Admin',
  'admin.users.roleMember': 'Member',
  'admin.users.confirmRoleChange': 'Change this user\'s role to',
  'admin.users.demoteToMember': 'Demote to Member',
  'admin.users.promoteToAdmin': 'Promote to Admin',
  'admin.users.thName': 'Username',
  'admin.users.thRole': 'Role',
  'admin.users.thMessages': 'Messages',
  'admin.users.thChats': 'Chats',
  'admin.users.thLastActive': 'Last Active',
  'admin.users.thActions': 'Actions',
  'admin.config.catGeneral': 'General',
  'admin.config.catAI': 'AI Engine',
  'admin.config.catGateway': 'Gateway',
  'admin.config.catStorage': 'Storage',
  'admin.config.catAuth': 'Auth',
  'admin.config.noConfig': 'No config items',
  'admin.roles.addRole': 'Add Role',
  'admin.roles.create': 'Create',
  'admin.roles.save': 'Save',
  'admin.roles.noRoles': 'No AI roles',
  'admin.roles.editRole': 'Edit Role',
  'admin.roles.deleteConfirm': 'Delete this role?',
  'admin.audit.totalRecords': 'records',
  'admin.audit.noLogs': 'No audit logs',
  'admin.audit.noLogsHint': 'Config changes and role management will be logged here',
  'admin.audit.thTime': 'Time',
  'admin.audit.thOperator': 'Operator',
  'admin.audit.thAction': 'Action',
  'admin.audit.thTarget': 'Target',
  'admin.audit.thDetail': 'Detail',
  'admin.audit.prevPage': 'Prev',
  'admin.audit.nextPage': 'Next',
  'admin.audit.configUpdate': 'Config Update',
  'admin.audit.roleCreate': 'Create Role',
  'admin.audit.roleUpdate': 'Update Role',
  'admin.audit.roleDelete': 'Delete Role',
  'admin.assign.title': 'Ticket Assign Rules',
  'admin.assign.addRule': 'Add Rule',
  'admin.assign.editRule': 'Edit Rule',
  'admin.assign.newRule': 'New Rule',
  'admin.assign.category': 'Category',
  'admin.assign.priority': 'Priority Range',
  'admin.assign.assignee': 'Assignee',
  'admin.assign.update': 'Update',
  'admin.assign.createBtn': 'Create',
  'admin.assign.cancel': 'Cancel',
  'admin.assign.noRules': 'No assign rules',
  'admin.assign.noRulesHint': 'Click "Add Rule" to configure auto-assignment',
  'admin.assign.thCategory': 'Category',
  'admin.assign.thPriority': 'Priority',
  'admin.assign.thAssignee': 'Assignee',
  'admin.assign.thCreatedAt': 'Created',
  'admin.assign.thActions': 'Actions',
  'admin.assign.ruleExplanation': 'Rule Explanation',
  'admin.assign.ruleHint1': 'When a new ticket is created, AI auto-analyzes content and recommends category & priority',
  'admin.assign.ruleHint2': 'System matches assign rules by category and priority, auto-assigning the handler',
  'admin.assign.ruleHint3': 'Rules with "All Priorities" match all tickets in that category',
  'admin.assign.ruleHint4': 'If no exact match, the system falls back to "Default" category rules',
  'admin.assign.ruleHint5': 'Match priority: Exact category+priority > Exact category+all > Default category',
  'admin.cat.payment': 'Payment',
  'admin.cat.account': 'Account',
  'admin.cat.technical': 'Technical',
  'admin.cat.shipping': 'Shipping',
  'admin.cat.refund': 'Refund',
  'admin.cat.general': 'General',
  'admin.cat.default': 'Default (Fallback)',
  'admin.priority.all': 'All Priorities',
  'admin.priority.critical': 'Critical',
  'admin.priority.high': 'High',
  'admin.priority.medium': 'Medium',
  'admin.priority.low': 'Low',
  'admin.priority.urgent': 'Urgent',
  'admin.time.days': 'd',
  'admin.time.hours': 'h',
  'admin.time.minutes': 'min',

  // KOL Manager
  'kol.title': 'KOL Management',
  'kol.total': 'Total KOLs',
  'kol.platformCoverage': 'Platforms',
  'kol.cooperating': 'Active Coops',
  'kol.totalCooperation': 'Total Coops',
  'kol.search': 'Search KOL name, handle...',
  'kol.allPlatforms': 'All Platforms',
  'kol.addKol': 'Add KOL',
  'kol.addFirst': 'Add First KOL',
  'kol.noData': 'No KOL Data',
  'kol.noDataHint': 'Add KOLs to start managing influencer resources',
  'kol.editKol': 'Edit KOL',
  'kol.refreshData': 'Refresh',
  'kol.refreshing': 'Refreshing...',
  'kol.refreshed': 'KOL data refreshed',
  'kol.refreshFailed': 'Refresh failed',
  'kol.addSuccess': 'KOL added successfully',
  'kol.addFailed': 'Failed to add KOL',
  'kol.updateSuccess': 'KOL info updated',
  'kol.updateFailed': 'Failed to update KOL',
  'kol.deleteConfirm': 'Delete this KOL?',
  'kol.deleteSuccess': 'KOL deleted',
  'kol.deleteFailed': 'Failed to delete KOL',
  'kol.followers': 'Followers',
  'kol.engagementRate': 'Engagement',
  'kol.region': 'Region',
  'kol.status.active': 'Active',
  'kol.status.inactive': 'Inactive',
  'kol.status.blacklisted': 'Blacklisted',
  'kol.status.pending': 'Pending',
  'kol.coop.none': 'Not Contacted',
  'kol.coop.contacted': 'Contacted',
  'kol.coop.negotiating': 'Negotiating',
  'kol.coop.contracted': 'Contracted',
  'kol.coop.completed': 'Completed',
  'kol.form.name': 'Name',
  'kol.form.platform': 'Platform',
  'kol.form.handle': 'Handle',
  'kol.form.followers': 'Followers',
  'kol.form.category': 'Category',
  'kol.form.country': 'Country/Region',
  'kol.form.language': 'Language',
  'kol.form.email': 'Contact Email',
  'kol.form.coopStatus': 'Cooperation Status',
  'kol.form.notes': 'Notes',
  'kol.form.save': 'Save',
  'kol.form.add': 'Add',
  'kol.form.cancel': 'Cancel',
  'kol.cat.gaming': 'Gaming',
  'kol.cat.beauty': 'Beauty',
  'kol.cat.tech': 'Tech',
  'kol.cat.lifestyle': 'Lifestyle',
  'kol.cat.food': 'Food',
  'kol.cat.fashion': 'Fashion',
  'kol.cat.fitness': 'Fitness',
  'kol.cat.education': 'Education',
  // KOL Detail
  'kolDetail.back': 'Back',
  'kolDetail.basicInfo': 'Basic Info',
  'kolDetail.coopHistory': 'Cooperation History',
  'kolDetail.addCoop': 'Add Cooperation',
  'kolDetail.noCoop': 'No cooperation records',
  'kolDetail.noCoopHint': 'Add cooperation records to track history',
  'kolDetail.platform': 'Platform',
  'kolDetail.handle': 'Handle',
  'kolDetail.followers': 'Followers',
  'kolDetail.engagementRate': 'Engagement Rate',
  'kolDetail.category': 'Category',
  'kolDetail.country': 'Country/Region',
  'kolDetail.language': 'Language',
  'kolDetail.email': 'Contact Email',
  'kolDetail.phone': 'Contact Phone',
  'kolDetail.status': 'Status',
  'kolDetail.coopStatus': 'Cooperation Status',
  'kolDetail.lastContacted': 'Last Contacted',
  'kolDetail.createdAt': 'Created At',
  'kolDetail.notes': 'Notes',
  'kolDetail.coopType': 'Cooperation Type',
  'kolDetail.coopAmount': 'Amount',
  'kolDetail.coopStartDate': 'Start Date',
  'kolDetail.coopEndDate': 'End Date',
  'kolDetail.coopNotes': 'Cooperation Notes',
  'kolDetail.coopStatusLabel': 'Status',
  'kolDetail.coopSave': 'Save',
  'kolDetail.coopCancel': 'Cancel',
  'kolDetail.coopDeleteConfirm': 'Delete this cooperation record?',
  'kolDetail.notFound': 'KOL not found',

  'kolDetail.backToList': 'Back to KOL List',
  'kolDetail.coopCount': 'Cooperations',
  'kolDetail.totalInvestment': 'Total Investment',
  'kolDetail.addedAt': 'Added At',
  'kolDetail.roiAnalysis': 'ROI Analysis',
  'kolDetail.totalBudget': 'Total Budget',
  'kolDetail.actualSpend': 'Actual Spend',
  'kolDetail.budgetUtilization': 'Budget Utilization',
  'kolDetail.avgCoopCost': 'Avg Cost per Coop',
  'kolDetail.completionRate': 'Completion Rate',
  'kolDetail.estReach': 'Est. Reach per Post',
  'kolDetail.coopHistoryTitle': 'Cooperation History',
  'kolDetail.addCoopRecord': 'Add Cooperation',
  'kolDetail.addFirstCoop': 'Add first cooperation record',
  'kolDetail.coopBudget': 'Budget',
  'kolDetail.coopActual': 'Actual',
  'kolDetail.coopStatus.planning': 'Planning',
  'kolDetail.coopStatus.active': 'Active',
  'kolDetail.coopStatus.completed': 'Completed',
  'kolDetail.coopStatus.cancelled': 'Cancelled',
  'kolDetail.campaignType.promotion': 'Promotion',
  'kolDetail.campaignType.review': 'Review',
  'kolDetail.campaignType.livestream': 'Livestream',
  'kolDetail.campaignType.sponsored': 'Sponsored',
  'kolDetail.campaignType.affiliate': 'Affiliate',
  'kolDetail.campaignType.other': 'Other',
  'kolDetail.form.campaignName': 'Campaign Name',
  'kolDetail.form.campaignType': 'Campaign Type',
  'kolDetail.form.campaignStatus': 'Status',
  'kolDetail.form.startDate': 'Start Date',
  'kolDetail.form.endDate': 'End Date',
  'kolDetail.form.budget': 'Budget ($)',
  'kolDetail.form.actualCost': 'Actual Cost ($)',
  'kolDetail.form.deliverables': 'Deliverables',
  'kolDetail.form.delivPlaceholder': 'e.g., 3 short videos + 1 livestream',
  'kb.title': 'Knowledge Base',
  'kb.docCount': 'documents',
  'kb.addKnowledge': 'Add Knowledge',
  'kb.searchDebug': 'Search Debug',
  'kb.uploadFile': 'Upload File',
  'kb.upload': 'Upload',
  'kb.search': 'Search',
  'kb.searchPlaceholder': 'Search document titles, content, tags...',
  'kb.categories': 'Categories',
  'kb.all': 'All',
  'kb.cat.uncategorized': 'Uncategorized',
  'kb.cat.techDoc': 'Tech Docs',
  'kb.cat.productReq': 'Product Reqs',
  'kb.cat.meetingNotes': 'Meeting Notes',
  'kb.cat.knowledgeBase': 'Knowledge',
  'kb.cat.training': 'Training',
  'kb.cat.standards': 'Standards',
  'kb.cat.apiDoc': 'API Docs',
  'kb.textEntry': 'Text Entry',
  'kb.emptyTitle': 'Start building your knowledge base',
  'kb.emptyDesc': 'Knowledge base helps you manage documents, technical materials and team knowledge, enabling AI to answer your questions more intelligently.',
  'kb.emptyUploadFile': 'Upload File',
  'kb.emptyUploadHint': 'PDF, Word, images, etc.',
  'kb.emptyAddText': 'Add Text',
  'kb.emptyAddTextHint': 'Notes, knowledge points, etc.',
  'kb.emptyBrowse': 'Browse',
  'kb.emptyBrowseHint': 'Back to chat',
  'kb.notVectorized': 'Not vectorized',
  'kb.vectorized': 'Vectorized',
  'kb.retry': 'Retry',
  'kb.regenerate': 'Regenerate',
  'kb.vectorBlocks': 'vector blocks',
  'kb.contentLength': 'Content length',
  'kb.chars': 'chars',
  'kb.notVectorizedHint': 'This document cannot be found by semantic search',
  'kb.showing': 'Showing',
  'kb.total': 'Total',
  'kb.docs': 'docs',
  'kb.prevPage': 'Previous',
  'kb.nextPage': 'Next',
  'kb.category': 'Category',
  'kb.description': 'Description',
  'kb.fileName': 'File Name',
  'kb.size': 'Size',
  'kb.createdAt': 'Created',
  'kb.embeddingStatus': 'Embedding Status',
  'kb.contentPreview': 'Content Preview',
  'kb.contentTruncated': '... (Content too long, truncated)',
  'kb.deleteDoc': 'Delete Document',
  'kb.uploadFileTitle': 'Upload File',
  'kb.selectFile': 'Select File',
  'kb.supportedFormats': 'Supports TXT, Markdown, JSON, CSV, PDF, Word (.docx)',
  'kb.titleLabel': 'Title',
  'kb.descLabel': 'Description',
  'kb.categoryLabel': 'Category',
  'kb.tagsLabel': 'Tags',
  'kb.tagsCommaSep': 'Tags (comma separated)',
  'kb.cancel': 'Cancel',
  'kb.uploading': 'Uploading...',
  'kb.addKnowledgeEntry': 'Add Knowledge Entry',
  'kb.titleRequired': 'Title *',
  'kb.titlePlaceholder': 'Knowledge entry title',
  'kb.contentLabel': 'Content',
  'kb.contentPlaceholder': 'Enter knowledge content (Markdown supported)',
  'kb.saving': 'Saving...',
  'kb.save': 'Save',
  'kb.uploadSuccess': 'Document uploaded successfully',
  'kb.uploadFailed': 'Document upload failed',
  'kb.addTextSuccess': 'Text content added successfully',
  'kb.addTextFailed': 'Text addition failed',
  'kb.deleteConfirm': 'Are you sure you want to delete this document?',
  'kb.deleteSuccess': 'Document deleted',
  'kb.deleteFailed': 'Document deletion failed',
  'kb.formatTextEntry': 'Text Entry',
  'kb.customCategory': 'Custom category...',
  'kb.customCategoryPlaceholder': 'Enter custom category name',
  'kb.tagInputPlaceholder': 'Type a tag and press Enter',
  'kb.tagInputHint': 'Press Enter or comma to add, Backspace to remove',
  'wf.title': 'Workflows',
  'wf.search': 'Search workflows...',
  'wf.create': 'Create Workflow',
  'wf.noWorkflows': 'No workflows yet',
  'wf.noWorkflowsHint': 'Create workflows to automate your tasks',
  'wf.createFirst': 'Create your first workflow',
  'wf.steps': 'steps',
  'wf.lastUpdated': 'Last updated',
  'wf.run': 'Run',
  'wf.edit': 'Edit',
  'wf.delete': 'Delete',
  'wf.deleteConfirm': 'Are you sure you want to delete this workflow?',
  'wf.deleteSuccess': 'Workflow deleted',
  'wf.deleteFailed': 'Workflow deletion failed',
  'wf.createWorkflow': 'Create Workflow',
  'wf.editWorkflow': 'Edit Workflow',
  'wf.name': 'Name',
  'wf.namePlaceholder': 'Workflow name',
  'wf.description': 'Description',
  'wf.descPlaceholder': 'Workflow description',
  'wf.addStep': 'Add Step',
  'wf.stepType': 'Step Type',
  'wf.stepPrompt': 'Prompt',
  'wf.stepAction': 'Action',
  'wf.stepCondition': 'Condition',
  'wf.removeStep': 'Remove Step',
  'wf.cancel': 'Cancel',
  'wf.save': 'Save',
  'wf.saving': 'Saving...',
  'wf.saveSuccess': 'Workflow saved successfully',
  'wf.saveFailed': 'Workflow save failed',
  'wf.cron.notSet': 'Not set',
  'wf.cron.custom': 'Custom',
  'wf.cron.hourly': 'Hourly',
  'wf.cron.hourlyDesc': 'Run every hour on the hour',
  'wf.cron.daily9': 'Daily 9:00',
  'wf.cron.daily9Desc': 'Run daily at 9 AM',
  'wf.cron.daily18': 'Daily 18:00',
  'wf.cron.daily18Desc': 'Run daily at 6 PM',
  'wf.cron.weekday9': 'Weekdays 9:00',
  'wf.cron.weekday9Desc': 'Mon-Fri at 9 AM',
  'wf.cron.monday9': 'Monday 9:00',
  'wf.cron.monday9Desc': 'Every Monday at 9 AM',
  'wf.cron.monthly1': 'Monthly 1st',
  'wf.cron.monthly1Desc': '1st of each month at 9 AM',
  'wf.cat.uncategorized': 'Uncategorized',
  'wf.cat.dailyTask': 'Daily Tasks',
  'wf.cat.dataAnalysis': 'Data Analysis',
  'wf.cat.contentCreation': 'Content Creation',
  'wf.cat.codeDev': 'Code Development',
  'wf.cat.devops': 'DevOps',
  'wf.cat.research': 'Research',
  'wf.step': 'Step',
  'wf.confirmDelete': 'Delete this workflow?',
  'wf.copy': 'Copy',
  'wf.neverRun': 'Never run',
  'wf.justNow': 'Just now',
  'wf.minutesAgo': 'min ago',
  'wf.hoursAgo': 'hr ago',
  'wf.daysAgo': 'days ago',
  'wf.tpl.searchWeb': 'Web Search',
  'wf.tpl.searchInfo': 'Search info',
  'wf.tpl.searchPrompt': 'Search for the latest information on [keyword] and summarize key points.',
  'wf.tpl.analyzeDoc': 'Analyze Doc',
  'wf.tpl.analyzeFile': 'Analyze file',
  'wf.tpl.analyzePrompt': 'Analyze the following content, extract key information and generate a summary:',
  'wf.tpl.dataAnalysis': 'Data Analysis',
  'wf.tpl.analyzeData': 'Analyze data',
  'wf.tpl.dataPrompt': 'Analyze the following data, identify trends and key metrics:',
  'wf.tpl.codeGen': 'Code Gen',
  'wf.tpl.genCode': 'Generate code',
  'wf.tpl.codePrompt': 'Generate code based on the following requirements:',
  'wf.tpl.sendNotify': 'Send Notification',
  'wf.tpl.sendNotifyDesc': 'Send notification',
  'wf.tpl.notifyPrompt': 'Compile the analysis results into a clear, well-structured briefing.',
  'wf.tpl.webScrape': 'Web Scrape',
  'wf.tpl.scrapeWeb': 'Scrape web',
  'wf.tpl.scrapePrompt': 'Visit the following URL and extract key content: [URL]',
  'wf.tpl.dataQuery': 'Data Query',
  'wf.tpl.queryData': 'Query data',
  'wf.tpl.queryPrompt': 'Query the following data and return results:',
  'wf.tpl.genReport': 'Generate Report',
  'wf.tpl.genReportDesc': 'Generate report',
  'wf.tpl.reportPrompt': 'Based on all previous steps, generate a complete analysis report including: 1. Overview 2. Key Findings 3. Recommendations',
  'wf.stepName': 'Step name',
  'wf.unnamedStep': 'Unnamed step',
  'wf.promptPlaceholder': 'Enter prompt for AI...',
  'wf.waitForCompletion': 'Wait for completion before next step',
  'wf.chars': 'chars',
  'wf.selectTemplate': 'Select Step Template',
  'wf.blankStep': '+ Blank Step',
  'wf.workflowName': 'Workflow Name *',
  'wf.workflowNamePlaceholder': 'e.g., Daily Data Analysis Report',
  'wf.descLabel': 'Description',
  'wf.descPlaceholderShort': 'Brief description of workflow purpose',
  'wf.categoryLabel': 'Category',
  'wf.cronTrigger': 'Scheduled Trigger',
  'wf.cronNotEnabled': 'Not enabled',
  'wf.quickSelect': 'Quick Select',
  'wf.collapseCron': '↑ Collapse custom',
  'wf.expandCron': '↓ Custom Cron Expression',
  'wf.cronPlaceholder': 'e.g.: 0 9 * * 1-5',
  'wf.cronHint': 'Format: min hour day month weekday — e.g. "30 8 * * 1-5" = Weekdays 8:30',
  'wf.execSteps': 'Execution Steps',
  'wf.addStepBtn': 'Add Step',
  'wf.continueAdd': 'Continue adding',
  'wf.emptyTitle': 'Automate your tasks with workflows',
  'wf.emptyDesc': 'Orchestrate multi-step tasks into workflows, execute with one click, let AI complete them in order.',
  'wf.emptyStep1': 'Data Collection',
  'wf.emptyStep1Desc': 'Search web, read files, query databases',
  'wf.emptyStep2': 'AI Analysis',
  'wf.emptyStep2Desc': 'Data cleaning, analysis, report generation',
  'wf.emptyStep3': 'Output Results',
  'wf.emptyStep3Desc': 'Send notifications, save files, update systems',
  'wf.createFirstBtn': 'Create your first workflow',
  'wf.nSteps': 'steps',
  'wf.runNTimes': 'Run {n} times',
  'wf.nStepsShort': 'steps',
  'wf.runBtn': 'Run',
  'wf.editBtn': 'Edit',
  'wf.copyBtn': 'Copy',
  'wf.deleteBtn': 'Delete',
  'wf.editWorkflowTitle': 'Edit Workflow',
  'wf.createWorkflowTitle': 'Create Workflow',
  'wf.cancelBtn': 'Cancel',
  'wf.saveBtn': 'Save',
  'wf.savingBtn': 'Saving...',
  'wf.descriptionLabel': 'Description',
  'wf.categoryLabelShort': 'Category',
  'wf.runLabel': 'Runs',
  'wf.recentLabel': 'Recent',
  'wf.stepsLabel': 'Steps',
  'wf.count': '',
  'wf.workflowTitle': 'Workflows',
  'wf.runSuccess': 'Workflow executed successfully',
  'wf.runFailed': 'Workflow execution failed',
  'wf.type.prompt': 'Prompt',
  'wf.type.action': 'Action',
  'wf.type.condition': 'Condition',
  'wf.type.loop': 'Loop',
  'team.title': 'Team Management',
  'team.search': 'Search members...',
  'team.invite': 'Invite Member',
  'team.members': 'members',
  'team.role.admin': 'Admin',
  'team.role.member': 'Member',
  'team.role.viewer': 'Viewer',
  'team.status.active': 'Active',
  'team.status.invited': 'Invited',
  'team.status.disabled': 'Disabled',
  'team.noMembers': 'No members yet',
  'team.noMembersHint': 'Invite team members to start collaborating',
  'team.inviteFirst': 'Invite first member',
  'team.lastActive': 'Last active',
  'team.changeRole': 'Change Role',
  'team.remove': 'Remove',
  'team.removeConfirm': 'Are you sure you want to remove this member?',
  'team.removeSuccess': 'Member removed',
  'team.removeFailed': 'Member removal failed',
  'team.inviteMember': 'Invite Member',
  'team.email': 'Email',
  'team.emailPlaceholder': 'Enter email address',
  'team.selectRole': 'Select Role',
  'team.cancel': 'Cancel',
  'team.sendInvite': 'Send Invite',
  'team.sending': 'Sending...',
  'team.inviteSuccess': 'Invite sent',
  'team.inviteFailed': 'Invite failed',
  'team.role.manager': 'Manager',
  'team.role.cs': 'Support',
  'team.orgLevel.ceo': 'CEO',
  'team.orgLevel.vp': 'VP',
  'team.orgLevel.lead': 'Lead',
  'team.orgLevel.staff': 'Staff',
  'team.createUser': 'Create User',
  'team.createUserTitle': 'Create New User',
  'team.editUser': 'Edit User',
  'team.editUserTitle': 'Edit User: {name}',
  'team.resetPw': 'Reset Password',
  'team.resetPwTitle': 'Reset Password: {name}',
  'team.username': 'Username',
  'team.usernamePlaceholder': 'Login username',
  'team.displayName': 'Display Name',
  'team.displayNamePlaceholder': 'Display name',
  'team.password': 'Password',
  'team.passwordPlaceholder': 'At least 6 characters',
  'team.passwordMinLen': 'Password must be at least 6 characters',
  'team.newPassword': 'New Password',
  'team.role': 'Role',
  'team.orgLevel': 'Org Level',
  'team.department': 'Department',
  'team.manager': 'Manager',
  'team.emailLabel': 'Email',
  'team.phone': 'Phone',
  'team.phonePlaceholder': 'Phone number',
  'team.unassigned': 'Unassigned',
  'team.none': 'None',
  'team.save': 'Save',
  'team.saving': 'Saving...',
  'team.createBtn': 'Create User',
  'team.saveChanges': 'Save Changes',
  'team.createDept': 'Create Department',
  'team.createDeptTitle': 'Create New Department',
  'team.editDept': 'Edit Department',
  'team.editDeptTitle': 'Edit Department: {name}',
  'team.deptName': 'Department Name',
  'team.deptNamePlaceholder': 'e.g. Engineering',
  'team.description': 'Description',
  'team.descPlaceholder': 'Department description',
  'team.parentDept': 'Parent Department',
  'team.parentDeptNone': 'None (Top-level)',
  'team.deptManager': 'Department Head',
  'team.deptManagerNone': 'Not assigned',
  'team.sortOrder': 'Sort Order',
  'team.saveDept': 'Create Department',
  'team.deactivateUser': 'Deactivate User',
  'team.deactivateConfirm': 'Are you sure you want to deactivate user "{name}"? They will no longer be able to log in.',
  'team.deactivated': 'Deactivated {name}',
  'team.deleteDept': 'Delete Department',
  'team.deleteDeptConfirm': 'Are you sure you want to delete department "{name}"? This action cannot be undone.',
  'team.deletedDept': 'Deleted department {name}',
  'team.opFailed': 'Operation failed',
  'team.deleteFailed': 'Delete failed',
  'team.networkError': 'Network error',
  'team.usernameRequired': 'Username and password are required',
  'team.createFailed': 'Creation failed',
  'team.updateFailed': 'Update failed',
  'team.deptNameRequired': 'Department name is required',
  'team.pwResetSuccess': 'Password has been reset',
  'team.pwResetNotify': 'Please notify the user to log in with the new password',
  'team.close': 'Close',
  'team.confirmReset': 'Confirm Reset',
  'team.activeMembers': '{n} active members',
  'team.departments': '{n} departments',
  'team.userMgmt': 'User Management',
  'team.deptMgmt': 'Department Management',
  'team.searchPlaceholder': 'Search username, display name or email...',
  'team.all': 'All',
  'team.user': 'User',
  'team.roleLabel': 'Role',
  'team.deptLabel': 'Department',
  'team.managerLabel': 'Manager',
  'team.levelLabel': 'Level',
  'team.lastLogin': 'Last Login',
  'team.actions': 'Actions',
  'team.editTooltip': 'Edit',
  'team.resetPwTooltip': 'Reset Password',
  'team.deactivateTooltip': 'Deactivate',
  'team.noMatchUsers': 'No matching users',
  'team.noMatchUsersDesc': 'Try adjusting your search or filter criteria.',
  'team.noUsers': 'No users yet',
  'team.noUsersDesc': 'Users will appear here after registration.',
  'team.noDepts': 'No departments yet',
  'team.noDeptsHint': 'Click Create Department above to get started',
  'team.noDesc': 'No description',
  'team.managerColon': 'Head: {name}',
  'team.memberCount': '{n} members',
  'team.editDeptTooltip': 'Edit',
  'team.deleteDeptTooltip': 'Delete',
  'team.userCreated': 'User created successfully',
  'team.userUpdated': 'User info updated',
  'team.deptUpdated': 'Department updated',
  'team.deptCreated': 'Department created successfully',
  'team.confirmAction': 'Confirm',
  'team.confirmDelete': 'Confirm Delete',
  'fp.title': 'File Manager',
  'fp.search': 'Search files...',
  'fp.noFiles': 'No files yet',
  'fp.noFilesHint': 'Upload files or send files in conversations',
  'fp.download': 'Download',
  'fp.delete': 'Delete',
  'fp.deleteConfirm': 'Are you sure you want to delete this file?',
  'fp.preview': 'Preview',
  'fp.fileInfo': 'File Info',
  'fp.fileName': 'File Name',
  'fp.fileSize': 'Size',
  'fp.fileType': 'Type',
  'fp.createdAt': 'Created',
  'fp.close': 'Close',
  'fp.copyContent': 'Copy Content',
  'fp.downloadFile': 'Download File',
  'fp.binaryNoPreview': 'Binary file, cannot preview',
  'fp.loadingFiles': 'Loading files...',
  'fp.selectFile': 'Select a file to view',
  'fp.selectFileHint': 'Click a file in the tree to preview',
  'fp.workspaceFiles': 'Workspace Files',
  'fp.changes': 'changes',
  'fp.refreshFiles': 'Refresh file list',
  'fp.closePanel': 'Close file panel',
  'fp.loadFailed': 'Failed to load file',
  'sd.title': 'Search Debug',
  'sd.back': 'Back',
  'sd.searchPlaceholder': 'Enter search query...',
  'sd.search': 'Search',
  'sd.results': 'Search Results',
  'sd.noResults': 'No results',
  'sd.noResultsHint': 'Try different search terms',
  'sd.score': 'Score',
  'sd.source': 'Source',
  'sd.chunk': 'Chunk',
  'sd.similarity': 'Similarity',
  'sd.topK': 'Top K',
  'sd.threshold': 'Threshold',
  'sd.searchTime': 'Search time',
  'sd.totalResults': 'Total results',
  'sd.minChars': 'Query must be at least 2 characters',
  'sd.categoryFilter': 'Category filter',
  'sd.nResults': '{n} results',
  'sd.nFused': '{n} fused',
  'sd.totalTime': 'Total Time',
  'sd.queryLabel': 'Query',
  'sd.noChannelResults': 'No results in this channel',
  'sd.panelTitle': 'RAG Search Debug Panel',
  'sd.panelDesc': 'Enter a query to compare results and scores across FTS (full-text search), Vector (semantic search), and Hybrid (RRF fusion) channels.',
  'cap.search': 'Search capabilities...',
  'cap.all': 'All',
  'cap.enabled': 'Enabled',
  'cap.disabled': 'Disabled',
  'cap.noResults': 'No matching capabilities',
  'cap.noResultsHint': 'Try adjusting your search',
  'cap.toggleOn': 'Enabled',
  'cap.toggleOff': 'Disabled',
  'cap.category': 'Category',
  'cap.title': 'Capabilities',
  'cap.description': 'Manage AI assistant capabilities',
  'cap.webSearch': 'Web Search',
  'cap.webSearchDesc': 'Search the internet for real-time information',
  'cap.codeExec': 'Code Execution',
  'cap.codeExecDesc': 'Run code and return results',
  'cap.fileUpload': 'File Upload',
  'cap.fileUploadDesc': 'Upload and process files',
  'cap.imageGen': 'Image Generation',
  'cap.imageGenDesc': 'Generate images from descriptions',
  'cap.voiceTrans': 'Voice Transcription',
  'cap.voiceTransDesc': 'Convert speech to text',
  'cap.knowledgeBase': 'Knowledge Base',
  'cap.knowledgeBaseDesc': 'Retrieve information from knowledge base',
  'cap.workflow': 'Workflows',
  'cap.workflowDesc': 'Execute predefined workflows',
  'cap.close': 'Close',
  'cap.toolCat.codeExec': 'Code Execution',
  'cap.toolCat.fileOps': 'File Operations',
  'cap.toolCat.browser': 'Browser',
  'cap.toolCat.searchEngine': 'Search Engine',
  'cap.toolCat.imageProc': 'Image Processing',
  'cap.toolCat.voiceSynth': 'Voice Synthesis',
  'cap.toolCat.multiAgent': 'Multi-Agent',
  'cap.toolCat.messaging': 'Messaging',
  'cap.toolCat.elevated': 'Elevated Privileges',
  'cap.tool.exec': 'Command Execution',
  'cap.tool.process': 'Process Management',
  'cap.tool.read': 'File Read',
  'cap.tool.write': 'File Write',
  'cap.tool.edit': 'File Edit',
  'cap.tool.applyPatch': 'Apply Patch',
  'cap.tool.image': 'Image Generation',
  'cap.tool.canvas': 'Canvas Drawing',
  'cap.tool.browser': 'Browser Automation',
  'cap.tool.webSearch': 'Web Search',
  'cap.tool.webFetch': 'Web Fetch',
  'cap.tool.tts': 'Text to Speech',
  'cap.tool.subagents': 'Sub-Agents',
  'cap.tool.agentsList': 'Agent List',
  'cap.tool.message': 'Send Message',
  'cap.tool.nodes': 'Node Communication',
  'cap.tool.elevated': 'Elevated Operation',
  'cap.tool.sessionsList': 'Session List',
  'cap.tool.sessionsHistory': 'Session History',
  'cap.tool.sessionsSend': 'Session Send',
  'cap.tool.sessionsSpawn': 'Session Create',
  'cap.tool.sessionStatus': 'Session Status',
  'cap.skillCat.ops': 'Operations',
  'cap.skillCat.dev': 'Development',
  'cap.skillCat.security': 'Security',
  'cap.skillCat.creative': 'Creative',
  'cap.skillCat.data': 'Data Analysis',
  'cap.skillCat.monitor': 'Monitoring',
  'cap.skillCat.evolution': 'Self-Evolution',
  'cap.skillCat.integration': 'Integrations',
  'cap.skillCat.other': 'Other',
  'cap.aiCenter': 'AI Capabilities',
  'cap.sysCaps': 'System Capabilities',
  'cap.searchSkills': 'Search Skills...',
  'cap.searchTools': 'Search Tools...',
  'cap.noSkillMatch': 'No matching skills found',
  'cap.invoking': 'Starting',
  'cap.use': 'Use',
  'cap.useSkillMsg': 'Please use the "{name}" skill to help me complete the task.',
  'cap.useSkill': 'Use This Skill',
  'cap.skillReady': 'Ready',
  'cap.skillNotReady': 'Not Ready',
  'cap.skillDescription': 'Description',
  'cap.skillInfo': 'Skill Info',
  'cap.skillId': 'Skill ID',
  'cap.skillVersion': 'Version',
  'cap.skillAuthor': 'Author',
  'cap.skillTriggers': 'Trigger Keywords',
  'invite.title': 'Invite Codes',
  'invite.noAccess': 'Access Denied',
  'invite.adminOnly': 'Only admins can manage invite codes',
  'invite.back': 'Back to Home',
  'invite.createTitle': 'Create New Invite Code',
  'invite.maxUses': 'Max Uses',
  'invite.expireDays': 'Valid Days',
  'invite.createBtn': 'Generate Code',
  'invite.creating': 'Generating...',
  'invite.empty': 'No invite codes yet',
  'invite.emptyDesc': 'Click the button above to create a new invite code.',
  'invite.created': 'Created',
  'invite.expired': 'Expires',
  'invite.statusActive': 'Active',
  'invite.statusExpired': 'Expired',
  'invite.statusUsed': 'Used Up',
  'invite.statusInactive': 'Deactivated',
  'invite.uses': 'uses',
  'notif.title': 'Notifications',
  'notif.markAllRead': 'Mark All Read',
  'notif.all': 'All',
  'notif.unread': 'Unread',
  'notif.loading': 'Loading...',
  'notif.emptyUnread': 'No unread notifications',
  'notif.emptyUnreadDesc': 'All caught up!',
  'notif.empty': 'No notifications',
  'notif.emptyDesc': 'System notifications will appear here',
  'notif.typeTicket': 'Ticket',
  'notif.typeKol': 'KOL',
  'notif.typeSystem': 'System',
  'notif.typeAlert': 'Alert',
  'notif.fetchError': 'Failed to load notifications',
  'notif.markReadError': 'Failed to mark as read',
  'notif.deleteError': 'Failed to delete notification',
  'notif.markRead': 'Mark as read',
  'notif.delete': 'Delete',
  'prompt.title': 'Prompt Templates',
  'prompt.search': 'Search templates...',
  'prompt.allCats': 'All',
  'prompt.empty': 'No templates',
  'prompt.emptyDesc': 'Create your first prompt template to get started.',
  'prompt.useBtn': 'Use',
  'prompt.usedCount': 'uses',
  'prompt.catOps': 'Operations',
  'prompt.catDev': 'Development',
  'prompt.catDevOps': 'DevOps',
  'prompt.catCreative': 'Creative',
  'prompt.catAnalysis': 'Analysis',
  'prompt.catGeneral': 'General',
  'task.title': 'Task Queue',
  'task.autoRefresh': 'Auto Refresh',
  'task.paused': 'Paused',
  'task.total': 'Total',
  'task.completed': 'Completed',
  'task.failed': 'Failed',
  'task.avgDuration': 'Avg Duration',
  'task.statusRunning': 'Running',
  'task.statusCompleted': 'Completed',
  'task.statusFailed': 'Failed',
  'task.statusQueued': 'Queued',
  'task.empty': 'No tasks in queue',
  'task.emptyRunning': 'Running',
  'task.emptyCompleted': 'Completed',
  'task.emptyFailed': 'Failed',
  'task.emptyQueued': 'Queued',
  'task.backToChat': 'Back to Chat',
  'task.running': 'Running',
  // Ticket Manager
  'ticket.title': 'Ticket Management',
  'ticket.total': 'Total',
  'ticket.search': 'Search tickets...',
  'ticket.allStatus': 'All Status',
  'ticket.allPriority': 'All Priority',
  'ticket.allCategory': 'All Categories',
  'ticket.createTicket': 'Create Ticket',
  'ticket.noTickets': 'No Tickets',
  'ticket.noTicketsHint': 'Create a ticket to start tracking issues',
  'ticket.status.open': 'Open',
  'ticket.status.inProgress': 'In Progress',
  'ticket.status.resolved': 'Resolved',
  'ticket.status.closed': 'Closed',
  'ticket.priority.critical': 'Critical',
  'ticket.priority.high': 'High',
  'ticket.priority.medium': 'Medium',
  'ticket.priority.low': 'Low',
  'ticket.form.title': 'Title',
  'ticket.form.description': 'Description',
  'ticket.form.category': 'Category',
  'ticket.form.priority': 'Priority',
  'ticket.form.submit': 'Submit',
  'ticket.form.cancel': 'Cancel',
  'ticket.assignee': 'Assignee',
  'ticket.createdAt': 'Created At',
  'ticket.updatedAt': 'Updated At',
  'ticket.addComment': 'Add Comment',
  'ticket.commentPlaceholder': 'Enter comment...',
  'ticket.submitComment': 'Submit Comment',
  'ticket.noComments': 'No comments yet',
  'ticket.aiAnalysis': 'AI Analysis',
  'ticket.changeStatus': 'Change Status',
  'ticket.changePriority': 'Change Priority',

  'ticket.created': 'Ticket created',
  'ticket.createFailed': 'Failed to create ticket',
  'ticket.statusUpdated': 'Ticket status updated',
  'ticket.statusUpdateFailed': 'Failed to update ticket',
  'ticket.autoAssigned': 'Auto-assigned to',
  'ticket.noAssignRule': 'No matching assignment rule',
  'ticket.aiRecommend': 'AI Recommendation',
  'ticket.aiAnalyzing': 'Analyzing...',
  'ticket.aiApply': 'Apply AI Recommendation',
  'ticket.aiApplied': 'Applied',
  'ticket.aiCategory': 'Category',
  'ticket.aiPriority': 'Priority',
  'ticket.cat.general': 'General',
  'ticket.cat.product': 'Product',
  'ticket.cat.shipping': 'Shipping',
  'ticket.cat.payment': 'Payment',
  'ticket.cat.refund': 'Refund',
  'ticket.cat.account': 'Account',
  'ticket.form.descPlaceholder': 'Describe the issue in detail...',
  'ticket.form.titlePlaceholder': 'Brief description of the issue',
  'ticket.form.customerName': 'Customer Name',
  'ticket.form.customerPlatform': 'Customer Platform',
  'ticket.form.selectPlatform': 'Select Platform',
  'ticket.detail.customer': 'Customer',
  'ticket.detail.email': 'Email',
  'ticket.detail.platform': 'Platform',
  'ticket.detail.assignee': 'Assignee',
  'ticket.detail.autoAssign': 'Auto-assigned',
  'store.err.systemBusy': 'System is temporarily busy, recovering...',
  'store.err.waitingSeconds': '⚠️ Waited {seconds} seconds, still processing...',
  'store.err.taskTimeout': 'Task timed out, please resend your message',
  'store.err.taskFailed': 'Task processing failed, please retry',
  'store.err.sendFailed': 'Failed to send message, please retry',
  'store.err.retrying409': 'Chat is busy, auto-retrying in 3 seconds...',
  'store.err.chatBusy': 'Chat is busy, please wait until it finishes',
  'store.err.tooFrequent': 'Too many requests, please try again later',
  'store.err.loginExpired': 'Session expired, please log in again',
  'store.err.chatNotFound': 'Chat not found, please refresh the page',
  'store.err.serverError': 'Server error, please try again later',
  'store.err.requestTimeout': 'Request timed out, please check your network',
  'store.err.networkFailed': 'Network connection failed, please check your network',
  'store.err.regenerateFailed': 'Regeneration failed, please retry',
  'store.err.serverErrorShort': 'Server error',
  'home.title': 'RangerAI',
  'home.subtitle': 'Intelligent Chat Assistant',
  'home.startChat': 'Start Chat',
  'export.mdTitle': 'Chat History',
  'export.model': 'Model',
  'export.taskType': 'Task Type',
  'export.thinking': 'Thinking',
  'export.toolCalls': 'Tool Calls',
  'export.toolName': 'Tool',
  'export.args': 'Arguments',
  'export.result': 'Result',
  'export.status': 'Status',
  'export.steps': 'Execution Steps',
  'export.stepName': 'Step',
  'export.detail': 'Detail',
  'error.unexpectedError': 'An unexpected error occurred',
  'error.reloadPage': 'Reload Page',
  'error.backToHome': 'Back to Home',
  'error.showDetails': 'Show error details',
  'error.hideDetails': 'Hide error details',
  'error.autoRetryAttempted': 'Auto-retry attempted {count} times',
  'error.componentStack': 'Component Stack',
  'network.offline': 'Network connection lost. Please check your settings.',
  'network.backOnline': 'Back online',
  'model.smartRouterName': 'Smart Router',
  'model.smartRouterDesc': 'Auto-select optimal model based on task type',
  'model.claudeDesc': 'Code & creative writing',
  'model.deepseekV4Desc': 'Best agentic, code & reasoning',
  'model.gpt55Desc': 'Strongest overall, excellent Chinese',
  'model.gpt54MiniDesc': 'Lightweight & cost-efficient',
  'model.geminiFlashDesc': 'Fast response, image generation',
  'model.gpt5MiniDesc': 'Lightweight & fast',
  'model.gpt4Desc': 'Comprehensive reasoning',
  'model.gpt4oDesc': 'Fast response',
  'model.gpt4oMiniDesc': 'Lightweight & fast',
  'model.tierAuto': 'Auto',
  'model.tierPremium': 'Premium',
  'model.tierFast': 'Fast',
  'model.tierReasoning': 'Reasoning',
  'model.currentModel': 'Current model',
  'model.selectModel': 'Select Model',
  'tag.title': 'Tag Manager',
  'tag.noTags': 'No tags yet',
  'tag.inputPlaceholder': 'Enter tag name, press Enter to add',
  'tag.add': 'Add',
  'tag.existingTags': 'Existing tags:',
  'upload.fileTooLarge': 'File exceeds 20MB limit',
  'upload.uploadImage': 'Upload Image',
  'upload.uploadFile': 'Upload File',
  'attachment.failed': 'Failed',
  'attachment.openInNewTab': 'Open in new tab',
  'aiFile.generatedFiles': 'Generated Files',
  'aiFile.openInNewTab': 'Open in new tab',
  'aiFile.copyCode': 'Copy code',
  'aiFile.downloadFile': 'Download file',
  'aiFile.collapse': 'Collapse',
  'aiFile.expandAll': 'Expand all',
  'aiFile.lines': 'lines',
  'share.title': 'Share Conversation',
  'share.loadFailed': 'Failed to load data',
  'share.sharedTo': 'Shared with',
  'share.shareFailed': 'Share failed, please retry',
  'share.cancelShareConfirm': 'Cancel sharing?',
  'share.cancelShareFailed': 'Failed to cancel sharing',
  'share.conversation': 'Conversation',
  'share.loading': 'Loading...',
  'share.noShareableUsers': 'No shareable users',
  'share.selectUser': 'Select user',
  'share.readOnly': 'Read only',
  'share.readWrite': 'Read & Write',
  'share.shared': 'Shared',
  'share.notSharedYet': 'Not shared with anyone yet',
  'share.readWriteLabel': 'Read & Write',
  'share.readOnlyLabel': 'Read only',
  'share.cancelShare': 'Cancel share',
  'share.readOnlyHint': 'Read-only users can view conversations; read-write users can send messages',
  'share.copyLink': 'Copy Link',
  'share.linkCopied': 'Copied',
  'role.selectRole': 'Select AI Role',
  'role.role': 'Role',
  'role.aiRoles': 'AI Roles',
  'role.aiRolesHint': 'Choose a specialized role for more precise answers',
  'kref.title': 'Knowledge References',
  'searchCards.results': 'Search Results',
  'notif.justNow': 'just now',
  'notif.minutesAgo': 'min ago',
  'notif.hoursAgo': 'hr ago',
  'notif.daysAgo': 'days ago',
  'time.justNow': 'just now',
  'time.minutesAgo': 'min ago',
  'time.hoursAgo': 'hr ago',
  'time.daysAgo': 'days ago',
  'time.neverRun': 'Never run',
  'stats.codeBlock': '[code]',
  'team.noDepts2': 'No departments',
  'team.noDeptsHint2': 'Click "Create Department" above to start',
  'team.noDesc2': 'No description',
  'team.managerColon2': 'Manager',
  'sidebar.ceoDashboard': 'CEO Dashboard',
  'sidebar.opsEfficiency': 'Ops Efficiency',
  // Browser Preview
  'browserPreview.noScreenshots': 'No screenshots yet',
  'browserPreview.hint': 'Screenshots will appear here when AI uses the browser',
  'browserPreview.connecting': 'Connecting...',
  'browserPreview.takeOver': 'Take Over Browser',
  'browserPreview.returnControl': 'Return Control',
  'browserPreview.browserOffline': 'Browser Offline',
  // Input & Toast
  'input.stopping': 'Stopping...',
  'toast.waitForAI': 'Please wait for AI to finish before sending',
  "input.stopGeneration": "Stop Generation",
  // Chat roles
  'chat.ai': 'AI',
  'chat.system': 'System',
  'chat.user': 'User',

  'sidebar.dataAnalytics': 'Data Analytics',
  'sidebar.dailyReports': 'Daily Reports',
};

const translations: Record<Locale, TranslationKeys> = {
  'zh-CN': zhCN,
  'zh-TW': zhTW,
  'en': en,
};

// ─── Context & Provider ─────────────────────────────────────

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: keyof TranslationKeys) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

const STORAGE_KEY = 'rangerai-locale';

function detectLocale(): Locale {
  // 1. Check localStorage
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored && stored in translations) return stored as Locale;

  // 2. Check browser language
  const browserLang = navigator.language;
  if (browserLang.startsWith('zh')) {
    if (browserLang.includes('TW') || browserLang.includes('HK')) return 'zh-TW';
    return 'zh-CN';
  }
  if (browserLang.startsWith('en')) return 'en';

  // 3. Default
  return 'zh-CN';
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(detectLocale);

  const setLocale = useCallback((newLocale: Locale) => {
    setLocaleState(newLocale);
    localStorage.setItem(STORAGE_KEY, newLocale);
    document.documentElement.lang = newLocale === 'zh-CN' ? 'zh-Hans' : newLocale === 'zh-TW' ? 'zh-Hant' : 'en';
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale === 'zh-CN' ? 'zh-Hans' : locale === 'zh-TW' ? 'zh-Hant' : 'en';
  }, [locale]);

  const t = useCallback((key: keyof TranslationKeys): string => {
    return translations[locale]?.[key] ?? translations['zh-CN'][key] ?? key;
  }, [locale]);

  return (
    <I18nContext.Provider value={{ locale, setLocale, t }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used within I18nProvider');
  return ctx;
}
