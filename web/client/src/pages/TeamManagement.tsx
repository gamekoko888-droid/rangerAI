import { PageAgent } from "page-agent";
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Users, Building2, ChevronRight, ChevronDown, User, Shield,
  Search, Crown, LayoutGrid, UserCircle, Hash, Briefcase,
  ChevronUp, Network, ArrowLeft, Clock
} from 'lucide-react';
import { toast as sonnerToast } from 'sonner';
import { useI18n } from '../lib/i18n';
import { logger } from "../lib/logger";
import { EmptyState } from '../components/EmptyState';
import { validateFields, required } from '../lib/formValidation';

/* ─── Types ───────────────────────────────────────────────── */
interface Member {
  id: string;
  username: string;
  displayName: string;
  team: string;
  role: string;
  department_id: string;
}

interface RawDept {
  id: string;
  name: string;
  description?: string;
  parent_id: string | null;
  manager_id: string | null;
  managerName?: string | null;
  sort_order: number;
  memberCount?: number;
}

interface DeptNode extends RawDept {
  children: DeptNode[];
  members: Member[];
  totalMembers: number;
}

/* ─── Color palette for departments ──────────────────────── */
const DEPT_COLORS: Record<string, { accent: string; bg: string; border: string; badge: string }> = {
  '综合管理中心': { accent: 'text-emerald-400', bg: 'bg-emerald-500/8', border: 'border-emerald-500/20', badge: 'bg-emerald-500/15 text-emerald-300' },
  '豹量中心': { accent: 'text-blue-400', bg: 'bg-blue-500/8', border: 'border-blue-500/20', badge: 'bg-blue-500/15 text-blue-300' },
  'TT项目组': { accent: 'text-rose-400', bg: 'bg-rose-500/8', border: 'border-rose-500/20', badge: 'bg-rose-500/15 text-rose-300' },
  '窜天猴中心': { accent: 'text-amber-400', bg: 'bg-amber-500/8', border: 'border-amber-500/20', badge: 'bg-amber-500/15 text-amber-300' },
};
const DEFAULT_COLOR = { accent: 'text-violet-400', bg: 'bg-violet-500/8', border: 'border-violet-500/20', badge: 'bg-violet-500/15 text-violet-300' };

function getDeptColor(name: string) {
  return DEPT_COLORS[name] || DEFAULT_COLOR;
}

function getRootDeptName(dept: DeptNode, deptMap: Record<string, DeptNode>): string {
  let current = dept;
  while (current.parent_id && deptMap[current.parent_id]) {
    current = deptMap[current.parent_id];
  }
  return current.name;
}

/* ─── Role badge helper ──────────────────────────────────── */
function getRoleBadge(team: string) {
  const t = team?.toLowerCase() || '';
  if (t.includes('负责人') || t.includes('总经理') || t.includes('总监'))
    return { label: '负责人', cls: 'bg-amber-500/15 text-amber-300 ring-amber-500/30' };
  if (t.includes('组长') || t.includes('小组长'))
    return { label: '组长', cls: 'bg-blue-500/15 text-blue-300 ring-blue-500/30' };
  if (t.includes('商务'))
    return { label: '商务', cls: 'bg-purple-500/15 text-purple-300 ring-purple-500/30' };
  if (t.includes('运营'))
    return { label: '运营', cls: 'bg-teal-500/15 text-teal-300 ring-teal-500/30' };
  if (t.includes('剪辑'))
    return { label: '剪辑', cls: 'bg-pink-500/15 text-pink-300 ring-pink-500/30' };
  if (t.includes('java') || t.includes('前端') || t.includes('后端'))
    return { label: '技术', cls: 'bg-cyan-500/15 text-cyan-300 ring-cyan-500/30' };
  if (t.includes('行政') || t.includes('财务') || t.includes('人事') || t.includes('法务'))
    return { label: '职能', cls: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30' };
  return { label: '成员', cls: 'bg-zinc-500/15 text-zinc-400 ring-zinc-500/30' };
}

/* ─── Extract sub-role from team string ──────────────────── */
function getSubRole(team: string): string {
  if (!team) return '';
  // "金币组-游戏客服" → "游戏客服"
  const parts = team.split('-');
  return parts.length > 1 ? parts.slice(1).join('-') : team;
}

/* ─── Avatar initials ────────────────────────────────────── */
function AvatarInitial({ name, size = 'md' }: { name: string; size?: 'sm' | 'md' | 'lg' }) {
  const initial = name?.charAt(0) || '?';
  const sizeClasses = {
    sm: 'w-7 h-7 text-xs',
    md: 'w-9 h-9 text-sm',
    lg: 'w-14 h-14 text-xl',
  };
  // Generate consistent color from name
  const colors = [
    'from-blue-500 to-blue-600',
    'from-emerald-500 to-emerald-600',
    'from-violet-500 to-violet-600',
    'from-rose-500 to-rose-600',
    'from-amber-500 to-amber-600',
    'from-cyan-500 to-cyan-600',
    'from-pink-500 to-pink-600',
    'from-indigo-500 to-indigo-600',
  ];
  const colorIdx = name ? name.charCodeAt(0) % colors.length : 0;
  return (
    <div className={`${sizeClasses[size]} rounded-lg bg-gradient-to-br ${colors[colorIdx]} flex items-center justify-center font-semibold text-white shadow-sm shrink-0`}>
      {initial}
    </div>
  );
}

/* ─── Stats Card ─────────────────────────────────────────── */
function StatCard({ icon: Icon, label, value, color }: { icon: any; label: string; value: number | string; color: string }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-white/[0.03] border border-white/[0.06]">
      <div className={`w-9 h-9 rounded-lg ${color} flex items-center justify-center`}>
        <Icon className="w-4 h-4" />
      </div>
      <div>
        <div className="text-[11px] text-zinc-500 font-medium uppercase tracking-wider">{label}</div>
        <div className="text-lg font-semibold text-zinc-100 -mt-0.5">{value}</div>
      </div>
    </div>
  );
}

/* ─── Department Tree Node ───────────────────────────────── */
function TreeNode({
  dept,
  level,
  expanded,
  onToggle,
  onSelectDept,
  onSelectMember,
  selectedId,
  searchQuery,
  deptMap,
}: {
  dept: DeptNode;
  level: number;
  expanded: Set<string>;
  onToggle: (id: string) => void;
  onSelectDept: (d: DeptNode) => void;
  onSelectMember: (m: Member) => void;
  selectedId: string | null;
  searchQuery: string;
  deptMap: Record<string, DeptNode>;
}) {
  const isExpanded = expanded.has(dept.id);
  const hasChildren = dept.children.length > 0 || dept.members.length > 0;
  const rootName = getRootDeptName(dept, deptMap);
  const color = getDeptColor(rootName);
  const isSelected = selectedId === dept.id;

  // Filter members by search
  const filteredMembers = searchQuery
    ? dept.members.filter(m =>
        m.displayName.toLowerCase().includes(searchQuery.toLowerCase()) ||
        m.team?.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : dept.members;

  // Filter children by search (show if any descendant matches)
  const filteredChildren = searchQuery
    ? dept.children.filter(c => hasMatchingDescendant(c, searchQuery))
    : dept.children;

  if (searchQuery && filteredMembers.length === 0 && filteredChildren.length === 0) {
    return null;
  }

  return (
    <div>
      {/* Department header */}
      <div
        className={`group flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer transition-all duration-150
          ${isSelected ? `${color.bg} ${color.border} border` : 'hover:bg-white/[0.04] border border-transparent'}
        `}
        style={{ paddingLeft: `${level * 16 + 12}px` }}
        onClick={() => { onSelectDept(dept); if (hasChildren && !isExpanded) onToggle(dept.id); }}
      >
        {/* Expand/collapse */}
        <button
          className="w-5 h-5 flex items-center justify-center rounded hover:bg-white/10 transition-colors shrink-0"
          onClick={(e) => { e.stopPropagation(); if (hasChildren) onToggle(dept.id); }}
        >
          {hasChildren ? (
            isExpanded
              ? <ChevronDown className="w-3.5 h-3.5 text-zinc-400" />
              : <ChevronRight className="w-3.5 h-3.5 text-zinc-500" />
          ) : (
            <span className="w-1.5 h-1.5 rounded-full bg-zinc-700" />
          )}
        </button>

        {/* Dept icon */}
        <div className={`w-7 h-7 rounded-md ${color.bg} ${color.border} border flex items-center justify-center shrink-0`}>
          {level === 0 ? <Building2 className={`w-3.5 h-3.5 ${color.accent}`} /> : <Network className={`w-3.5 h-3.5 ${color.accent}`} />}
        </div>

        {/* Name & count */}
        <span className={`text-sm font-medium truncate ${isSelected ? 'text-zinc-100' : 'text-zinc-300 group-hover:text-zinc-100'} transition-colors`}>
          {dept.name}
        </span>
        <span className="text-[11px] text-zinc-600 font-mono ml-auto shrink-0">
          {dept.totalMembers}人
        </span>
      </div>

      {/* Children & Members */}
      {isExpanded && (
        <div className="animate-in slide-in-from-top-1 duration-150">
          {filteredChildren
            .sort((a, b) => a.sort_order - b.sort_order)
            .map(child => (
              <TreeNode
                key={child.id}
                dept={child}
                level={level + 1}
                expanded={expanded}
                onToggle={onToggle}
                onSelectDept={onSelectDept}
                onSelectMember={onSelectMember}
                selectedId={selectedId}
                searchQuery={searchQuery}
                deptMap={deptMap}
              />
            ))}
          {filteredMembers.map(member => (
            <div
              key={member.id}
              className={`group flex items-center gap-2.5 px-3 py-1.5 rounded-lg cursor-pointer transition-all duration-150
                ${selectedId === member.id ? 'bg-white/[0.06] border border-white/10' : 'hover:bg-white/[0.03] border border-transparent'}
              `}
              style={{ paddingLeft: `${(level + 1) * 16 + 12}px` }}
              onClick={() => onSelectMember(member)}
            >
              <AvatarInitial name={member.displayName} size="sm" />
              <span className={`text-sm truncate ${selectedId === member.id ? 'text-zinc-100' : 'text-zinc-400 group-hover:text-zinc-200'} transition-colors`}>
                {member.displayName}
              </span>
              <span className="text-[10px] text-zinc-600 truncate ml-auto">
                {getSubRole(member.team)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function hasMatchingDescendant(dept: DeptNode, query: string): boolean {
  const q = query.toLowerCase();
  if (dept.name.toLowerCase().includes(q)) return true;
  if (dept.members.some(m => m.displayName.toLowerCase().includes(q) || m.team?.toLowerCase().includes(q))) return true;
  return dept.children.some(c => hasMatchingDescendant(c, q));
}

/* ─── Member Detail Panel ────────────────────────────────── */
function MemberDetail({ member, deptMap }: { member: Member; deptMap: Record<string, DeptNode> }) {
  const dept = deptMap[member.department_id];
  const rootName = dept ? getRootDeptName(dept, deptMap) : '';
  const color = getDeptColor(rootName);
  const badge = getRoleBadge(member.team);

  // ─── 日报时间戳 ───────────────────────────────────────
  const [lastReport, setLastReport] = useState<string | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  React.useEffect(() => {
    let alive = true;
    setLastReport(null);
    setReportLoading(true);
    fetch('/api/reports/dingtalk/member-last-report?name=' + encodeURIComponent(member.displayName))
      .then(r => r.json())
      .then(d => { if (alive) setLastReport(d.create_time || null); })
      .catch(() => {})
      .finally(() => { if (alive) setReportLoading(false); });
    return () => { alive = false; };
  }, [member.displayName]);

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-right-2 duration-200">
      {/* Header */}
      <div className="flex items-start gap-4">
        <AvatarInitial name={member.displayName} size="lg" />
        <div className="flex-1 min-w-0">
          <h2 className="text-xl font-bold text-zinc-100">{member.displayName}</h2>
          <p className="text-sm text-zinc-500 mt-0.5">{getSubRole(member.team)}</p>
          <div className="flex items-center gap-2 mt-2">
            <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-medium ring-1 ring-inset ${badge.cls}`}>
              {badge.label}
            </span>
            {dept && (
              <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-medium ${color.badge}`}>
                {dept.name}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Info grid */}
      <div className="grid grid-cols-2 gap-3">
        <InfoCard icon={Hash} label="员工 ID" value={member.id} />
        <InfoCard icon={UserCircle} label="用户名" value={member.username} />
        <InfoCard icon={Building2} label="所属部门" value={dept?.name || '未分配'} />
        <InfoCard icon={Briefcase} label="岗位分工" value={getSubRole(member.team) || '未分配'} />
        <InfoCard icon={Shield} label="系统角色" value={member.role === 'admin' ? '管理员' : '成员'} />
        <InfoCard icon={Network} label="所属中心" value={rootName || '未分配'} />
      </div>

      {/* 日报时间戳卡片 */}
      <div className="p-3 rounded-xl bg-white/[0.02] border border-white/[0.05]">
        <div className="flex items-center gap-1.5 mb-1">
          <Clock className="w-3 h-3 text-zinc-600" />
          <span className="text-[10px] text-zinc-600 font-medium uppercase tracking-wider">最后日报时间</span>
        </div>
        <div className="text-sm font-medium text-zinc-300">
          {reportLoading ? '查询中…' : (lastReport ? new Date(lastReport).toLocaleString('zh-CN') : '日报匹配引擎已挂载 - 实时数据同步中')}
        </div>
      </div>

      {/* Same dept colleagues */}
      {dept && dept.members.length > 1 && (
        <div>
          <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-3">同组同事</h3>
          <div className="space-y-1">
            {dept.members
              .filter(m => m.id !== member.id)
              .slice(0, 8)
              .map(m => (
                <div key={m.id} className="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-white/[0.02] border border-white/[0.04]">
                  <AvatarInitial name={m.displayName} size="sm" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-zinc-300 truncate">{m.displayName}</div>
                    <div className="text-[11px] text-zinc-600 truncate">{getSubRole(m.team)}</div>
                  </div>
                </div>
              ))}
            {dept.members.length > 9 && (
              <div className="text-[11px] text-zinc-600 text-center py-1">
                还有 {dept.members.length - 9} 人...
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Department Detail Panel ────────────────────────────── */
function DeptDetail({ dept, deptMap }: { dept: DeptNode; deptMap: Record<string, DeptNode> }) {
  const rootName = getRootDeptName(dept, deptMap);
  const color = getDeptColor(rootName);
  const manager = dept.manager_id ? dept.members.find(m => m.id === dept.manager_id) : null;

  // Group members by sub-role
  const roleGroups = useMemo(() => {
    const groups: Record<string, Member[]> = {};
    dept.members.forEach(m => {
      const role = getSubRole(m.team) || '其他';
      if (!groups[role]) groups[role] = [];
      groups[role].push(m);
    });
    return Object.entries(groups).sort((a, b) => b[1].length - a[1].length);
  }, [dept.members]);

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-right-2 duration-200">
      {/* Header */}
      <div className="flex items-start gap-4">
        <div className={`w-14 h-14 rounded-xl ${color.bg} ${color.border} border flex items-center justify-center shrink-0`}>
          <Building2 className={`w-6 h-6 ${color.accent}`} />
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-xl font-bold text-zinc-100">{dept.name}</h2>
          {dept.description && <p className="text-sm text-zinc-500 mt-0.5">{dept.description}</p>}
          <div className="flex items-center gap-2 mt-2">
            <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-medium ${color.badge}`}>
              {dept.totalMembers} 人
            </span>
            {dept.children.length > 0 && (
              <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-medium bg-zinc-500/15 text-zinc-400">
                {dept.children.length} 个子组
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Manager */}
      {(manager || dept.managerName) && (
        <div className="p-3 rounded-xl bg-white/[0.03] border border-white/[0.06]">
          <div className="text-[11px] text-zinc-500 font-medium uppercase tracking-wider mb-2">负责人</div>
          <div className="flex items-center gap-3">
            <AvatarInitial name={manager?.displayName || dept.managerName || '?'} size="md" />
            <div>
              <div className="text-sm font-medium text-zinc-200">{manager?.displayName || dept.managerName}</div>
              {manager && <div className="text-[11px] text-zinc-500">{getSubRole(manager.team)}</div>}
            </div>
            <Crown className="w-4 h-4 text-amber-400 ml-auto" />
          </div>
        </div>
      )}

      {/* Sub-departments */}
      {dept.children.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-3">下属组别</h3>
          <div className="grid grid-cols-2 gap-2">
            {dept.children.map(child => {
              const childColor = getDeptColor(rootName);
              return (
                <div key={child.id} className={`p-3 rounded-xl ${childColor.bg} border ${childColor.border} transition-colors`}>
                  <div className="flex items-center gap-2">
                    <Network className={`w-3.5 h-3.5 ${childColor.accent}`} />
                    <span className="text-sm font-medium text-zinc-200 truncate">{child.name}</span>
                  </div>
                  <div className="text-[11px] text-zinc-500 mt-1">{child.totalMembers} 人</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Members by role */}
      {roleGroups.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-3">
            直属成员 ({dept.members.length})
          </h3>
          <div className="space-y-4">
            {roleGroups.map(([role, members]) => (
              <div key={role}>
                <div className="text-[11px] text-zinc-600 font-medium mb-1.5 px-1">{role} · {members.length}人</div>
                <div className="space-y-1">
                  {members.map(m => (
                    <div key={m.id} className="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-white/[0.02] border border-white/[0.04] hover:bg-white/[0.04] transition-colors">
                      <AvatarInitial name={m.displayName} size="sm" />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-zinc-300 truncate">{m.displayName}</div>
                      </div>
                      <span className="text-[10px] text-zinc-600">{m.id}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Info Card ──────────────────────────────────────────── */
function InfoCard({ icon: Icon, label, value }: { icon: any; label: string; value: string }) {
  return (
    <div className="p-3 rounded-xl bg-white/[0.02] border border-white/[0.05]">
      <div className="flex items-center gap-1.5 mb-1">
        <Icon className="w-3 h-3 text-zinc-600" />
        <span className="text-[10px] text-zinc-600 font-medium uppercase tracking-wider">{label}</span>
      </div>
      <div className="text-sm font-medium text-zinc-300 truncate">{value}</div>
    </div>
  );
}

/* ─── Main Component ─────────────────────────────────────── */
export default function TeamManagement() {
  const { t } = useI18n();
  const [loading, setLoading] = useState(true);
  const [departments, setDepartments] = useState<DeptNode[]>([]);
  const [allUsers, setAllUsers] = useState<Member[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedType, setSelectedType] = useState<'dept' | 'member'>('dept');
  const [viewMode, setViewMode] = useState<'tree' | 'grid'>('tree');



  const handleMemberClick = async (member: Member) => {
    // setSelectedMember(member);
    // setReportData(null);
    try {
      const res = await fetch(`/api/team/member-report?name=${encodeURIComponent(member.displayName)}`);
      const data = await res.json();
      // setReportData(data);
    } catch (e) { logger.error(e); }
  };

  // Build flat dept map for lookups
  const deptMap = useMemo(() => {
    const map: Record<string, DeptNode> = {};
    const flatten = (nodes: DeptNode[]) => {
      nodes.forEach(n => { map[n.id] = n; flatten(n.children); });
    };
    flatten(departments);
    return map;
  }, [departments]);

  // Selected item
  const selectedItem = useMemo(() => {
    if (!selectedId) return null;
    if (selectedType === 'dept') return deptMap[selectedId] || null;
    return allUsers.find(u => String(u.id) === String(selectedId)) || null;
  }, [selectedId, selectedType, deptMap, allUsers]);

  useEffect(() => {
    fetchData();
  }, []);

  // Auto-expand when searching
  useEffect(() => {
    if (searchQuery) {
      const allIds = new Set<string>();
      const collect = (nodes: DeptNode[]) => {
        nodes.forEach(n => { allIds.add(n.id); collect(n.children); });
      };
      collect(departments);
      setExpanded(allIds);
    }
  }, [searchQuery, departments]);

  const fetchData = async () => {
    try {
      setLoading(true);
      const token = localStorage.getItem('rangerai_token');
      const headers: Record<string, string> = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const [dRes, uRes] = await Promise.all([
        fetch('/api/admin/departments', { headers }).then(r => r.json()),
        fetch('/api/admin/users', { headers }).then(r => r.json()),
      ]);

      const rawDepts: RawDept[] = dRes?.departments || dRes || [];
      const rawUsers: Member[] = (uRes?.users || uRes || [])
        .filter((u: any) => u.isActive === true || u.isActive === 1)
        .map((u: any) => ({
          id: u.id,
          username: u.username || '',
          displayName: u.displayName || u.display_name || u.username || '未知',
          team: u.team || u.departmentName || '',
          role: u.role || 'member',
          department_id: u.department_id || '',
        }));

      setAllUsers(rawUsers);

      // Build tree
      const map: Record<string, DeptNode> = {};
      rawDepts.forEach(d => {
        map[d.id] = { ...d, children: [], members: [], totalMembers: 0 };
      });

      rawUsers.forEach(u => {
        if (map[u.department_id]) {
          map[u.department_id].members.push(u);
        }
      });

      const roots: DeptNode[] = [];
      rawDepts.forEach(d => {
        if (d.parent_id && map[d.parent_id]) {
          map[d.parent_id].children.push(map[d.id]);
        } else if (!d.parent_id) {
          roots.push(map[d.id]);
        }
      });

      // Calculate total members recursively
      const calcTotal = (node: DeptNode): number => {
        node.totalMembers = node.members.length + node.children.reduce((sum, c) => sum + calcTotal(c), 0);
        return node.totalMembers;
      };
      roots.forEach(calcTotal);

      // Sort
      roots.sort((a, b) => a.sort_order - b.sort_order);

      setDepartments(roots);

      // Auto-expand top-level
      const initialExpanded = new Set<string>();
      roots.forEach(r => initialExpanded.add(r.id));
      setExpanded(initialExpanded);

      // Select first dept
      if (roots.length > 0 && !selectedId) {
        setSelectedId(roots[0].id);
        setSelectedType('dept');
      }
    } catch (err) {
      logger.error('Failed to load team data:', err);
      sonnerToast.error(t('team.networkError'));
    } finally {
      setLoading(false);
    }
  };

  const handleToggle = useCallback((id: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleSelectDept = useCallback((dept: DeptNode) => {
    setSelectedId(dept.id);
    setSelectedType('dept');
  }, []);

  const handleSelectMember = useCallback((member: Member) => {
    setSelectedId(member.id);
    setSelectedType('member');
  }, []);

  const handleValidate = useCallback((fields: Record<string, string>) => {
    return validateFields(Object.entries(fields).map(([key, value]) => ({
      value,
      rules: [required('validation.required')],
    })));
  }, []);

  // Stats
  const stats = useMemo(() => {
    const topDepts = departments.length;
    const totalGroups = Object.keys(deptMap).length;
    return { total: allUsers.length, topDepts, totalGroups };
  }, [allUsers, departments, deptMap]);

  if (loading) {
    return (
      <div className="h-screen bg-[#09090b] flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-zinc-700 border-t-zinc-400 rounded-full animate-spin" />
          <span className="text-sm text-zinc-500">加载组织架构...</span>
        </div>
      </div>
    );
  }

  if (!loading && departments.length === 0) {
    return (
      <EmptyState icon={Users} title="暂无组织架构" description="请先创建部门" />
    );
  }

  return (
    <div className="h-screen bg-[#09090b] text-zinc-100 flex flex-col overflow-hidden">
      {/* Top bar */}
      <div className="shrink-0 px-6 py-4 border-b border-white/[0.06] bg-[#09090b]/80 backdrop-blur-sm">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={() => window.history.back()}
              className="w-8 h-8 rounded-lg hover:bg-white/[0.06] flex items-center justify-center transition-colors"
            >
              <ArrowLeft className="w-4 h-4 text-zinc-400" />
            </button>
            <div>
              <h1 className="text-lg font-bold text-zinc-100">组织架构</h1>
              <p className="text-[11px] text-zinc-500 mt-0.5">团队成员与部门管理</p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            {/* Stats */}
            <div className="hidden lg:flex items-center gap-3">
              <StatCard icon={Users} label="总人数" value={stats.total} color="bg-blue-500/10 text-blue-400" />
              <StatCard icon={Building2} label="中心" value={stats.topDepts} color="bg-emerald-500/10 text-emerald-400" />
              <StatCard icon={Network} label="组别" value={stats.totalGroups} color="bg-violet-500/10 text-violet-400" />
            </div>
          </div>
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 flex min-h-0">
        {/* Left: Tree panel */}
        <div className="w-[320px] shrink-0 border-r border-white/[0.06] flex flex-col bg-[#0a0a0c]">
          {/* Search */}
          <div className="p-3 border-b border-white/[0.04]">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-600" />
              <input
                type="text"
                placeholder="搜索成员或部门..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="w-full pl-9 pr-3 py-2 text-sm bg-white/[0.04] border border-white/[0.06] rounded-lg text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-white/[0.12] focus:bg-white/[0.06] transition-all"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-600 hover:text-zinc-400 text-xs"
                >
                  ✕
                </button>
              )}
            </div>
          </div>

          {/* Tree */}
          <div className="flex-1 overflow-y-auto py-2 px-1.5 scrollbar-thin scrollbar-thumb-zinc-800 scrollbar-track-transparent">
            {departments.map(dept => (
              <TreeNode
                key={dept.id}
                dept={dept}
                level={0}
                expanded={expanded}
                onToggle={handleToggle}
                onSelectDept={handleSelectDept}
                onSelectMember={handleSelectMember}
                selectedId={selectedId}
                searchQuery={searchQuery}
                deptMap={deptMap}
              />
            ))}
          </div>

          {/* Bottom stats (mobile) */}
          <div className="lg:hidden p-3 border-t border-white/[0.04] flex items-center justify-around text-[11px] text-zinc-500">
            <span>{stats.total} 人</span>
            <span>{stats.topDepts} 中心</span>
            <span>{stats.totalGroups} 组</span>
          </div>
        </div>

        {/* Right: Detail panel */}
        <div className="flex-1 overflow-y-auto p-6 bg-[#09090b]">
          {selectedItem ? (
            <div className="max-w-2xl mx-auto">
              {selectedType === 'dept' ? (
                <DeptDetail dept={selectedItem as DeptNode} deptMap={deptMap} />
              ) : (
                <MemberDetail member={selectedItem as Member} deptMap={deptMap} />
              )}
            </div>
          ) : (
            <div className="flex-1 h-full flex flex-col items-center justify-center opacity-30">
              <Users className="w-16 h-16 mb-4" />
              <p className="text-sm font-medium">选择部门或成员查看详情</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
