import { useState, useEffect, useCallback } from 'react';
import RatingAdminLogin from './RatingAdminLogin';
import {
  adminOverview, orgSync, orgDepartments, orgEmployees,
  getGroups, createGroup, updateGroup, deleteGroup, getGroupMembers, setGroupMembers as apiSetGroupMembers,
  getCampaigns, createCampaign, deleteCampaign, activateCampaign, closeCampaign,
  getCampaignVoters, resetVoter, voidVoter,
  getCampaignResults, exportResultsUrl,
  getAdmins, createAdmin, updateAdmin, deleteAdmin,
  getAuditLogs,
  type AdminUser, type Campaign, type Group, type Employee,
  type Voter, type VoterWithToken, type ResultRow, type AuditLog,
} from '../lib/ratingApi';

// ── Helpers ──────────────────────────────────────────────────────────────────
function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`bg-zinc-900 border border-zinc-800 rounded-xl p-5 ${className}`}>{children}</div>;
}

function Badge({ label, color }: { label: string; color: string }) {
  const colors: Record<string, string> = {
    draft: 'bg-zinc-700 text-zinc-300',
    active: 'bg-green-800 text-green-300',
    closed: 'bg-zinc-600 text-zinc-400',
    unused: 'bg-zinc-700 text-zinc-300',
    claimed: 'bg-yellow-800 text-yellow-300',
    used: 'bg-green-800 text-green-300',
    voided: 'bg-red-900 text-red-400',
    super_admin: 'bg-purple-800 text-purple-300',
    admin: 'bg-blue-800 text-blue-300',
    viewer: 'bg-zinc-700 text-zinc-300',
  };
  return <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${colors[color] || 'bg-zinc-700 text-zinc-300'}`}>{label}</span>;
}

function Btn({ children, onClick, variant = 'default', size = 'md', disabled, className = '' }: any) {
  const base = 'inline-flex items-center justify-center font-medium rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed';
  const sizes: any = { sm: 'px-3 py-1.5 text-xs', md: 'px-4 py-2 text-sm', lg: 'px-5 py-2.5 text-sm' };
  const variants: any = {
    default: 'bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700',
    primary: 'bg-blue-600 hover:bg-blue-500 text-white',
    danger: 'bg-red-900 hover:bg-red-800 text-red-300 border border-red-800',
    success: 'bg-green-800 hover:bg-green-700 text-green-300 border border-green-700',
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`${base} ${sizes[size] || sizes.md} ${variants[variant] || variants.default} ${className}`}
    >
      {children}
    </button>
  );
}

function Modal({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: React.ReactNode }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl p-6 w-full max-w-md shadow-2xl">
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-base font-semibold text-white">{title}</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300 text-lg transition">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function InputField({ label, value, onChange, type = 'text', placeholder = '' }: any) {
  return (
    <div>
      <label className="block text-xs text-zinc-400 mb-1">{label}</label>
      <input
        type={type}
        className="w-full rounded-lg bg-zinc-800 border border-zinc-700 text-white px-3 py-2 text-sm outline-none focus:border-blue-500 transition"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </div>
  );
}

// ── Overview Tab ──────────────────────────────────────────────────────────────
function OverviewTab() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    adminOverview().then(setData).catch(() => {}).finally(() => setLoading(false));
  }, []);
  if (loading) return <div className="text-zinc-500 text-sm p-8 text-center">加载中...</div>;
  if (!data) return <div className="text-zinc-500 text-sm p-8 text-center">加载失败</div>;

  const activeCampaign = data.campaigns?.find((c: Campaign) => c.status === 'active');
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
        <Card>
          <div className="text-3xl font-bold text-blue-400">{data.groupCount}</div>
          <div className="text-xs text-zinc-500 mt-1">活跃小组</div>
        </Card>
        <Card>
          <div className="text-3xl font-bold text-green-400">{data.employeeCount}</div>
          <div className="text-xs text-zinc-500 mt-1">在职员工</div>
        </Card>
        {activeCampaign && (
          <Card>
            <div className="text-sm font-medium text-white">{activeCampaign.name}</div>
            <div className="text-xs text-zinc-500 mt-1">进行中的活动</div>
            <div className="mt-2 text-xs text-green-400">
              {activeCampaign.voted_count || 0} / {activeCampaign.total_voters || 0} 已投票
            </div>
          </Card>
        )}
      </div>

      <Card>
        <div className="text-sm font-semibold text-zinc-300 mb-4">近期活动</div>
        {data.campaigns?.length === 0 ? (
          <div className="text-zinc-600 text-sm text-center py-4">暂无活动</div>
        ) : (
          <div className="space-y-2">
            {data.campaigns?.map((c: Campaign) => (
              <div key={c.id} className="flex items-center justify-between py-2 border-b border-zinc-800 last:border-0">
                <div>
                  <span className="text-sm text-white">{c.name}</span>
                  <span className="text-xs text-zinc-500 ml-2">{c.month_key}</span>
                </div>
                <div className="flex items-center gap-3">
                  {c.status === 'active' && (
                    <span className="text-xs text-zinc-500">{c.voted_count}/{c.total_voters} 投票</span>
                  )}
                  <Badge label={{ draft: '草稿', active: '进行中', closed: '已结束' }[c.status] || c.status} color={c.status} />
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

// ── Org Tab ───────────────────────────────────────────────────────────────────
function OrgTab() {
  const [departments, setDepartments] = useState<any[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [search, setSearch] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [msg, setMsg] = useState('');

  const loadData = useCallback(() => {
    orgDepartments().then(r => setDepartments(r.departments));
    orgEmployees({ search: search || undefined }).then(r => setEmployees(r.employees));
  }, [search]);

  useEffect(() => { loadData(); }, [loadData]);

  const handleSync = async () => {
    setSyncing(true);
    setMsg('');
    try {
      const r = await orgSync();
      setMsg(`同步成功：${r.depts} 个部门，${r.employees} 名员工`);
      loadData();
    } catch (e: any) {
      setMsg(`同步失败：${e.message}`);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Btn onClick={handleSync} disabled={syncing} variant="primary">
          {syncing ? '同步中...' : '🔄 同步钉钉组织架构'}
        </Btn>
        {msg && <span className="text-xs text-zinc-400">{msg}</span>}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <div className="text-sm font-semibold text-zinc-300 mb-3">部门列表 ({departments.length})</div>
          <div className="space-y-1.5 max-h-64 overflow-y-auto">
            {departments.length === 0 ? (
              <div className="text-zinc-600 text-xs py-4 text-center">暂无部门，请先同步钉钉</div>
            ) : (
              departments.map(d => (
                <div key={d.id} className="text-sm text-zinc-300 py-1 border-b border-zinc-800 last:border-0">
                  {d.name}
                </div>
              ))
            )}
          </div>
        </Card>

        <Card>
          <div className="flex items-center gap-2 mb-3">
            <span className="text-sm font-semibold text-zinc-300">员工列表 ({employees.length})</span>
            <input
              className="ml-auto rounded bg-zinc-800 border border-zinc-700 text-white px-2 py-1 text-xs outline-none focus:border-blue-500"
              placeholder="搜索姓名..."
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
          <div className="space-y-1 max-h-64 overflow-y-auto">
            {employees.length === 0 ? (
              <div className="text-zinc-600 text-xs py-4 text-center">暂无员工</div>
            ) : (
              employees.map(e => (
                <div key={e.id} className="flex items-center justify-between py-1 border-b border-zinc-800 last:border-0">
                  <span className="text-sm text-zinc-300">{e.name}</span>
                  <span className="text-xs text-zinc-600">{e.dept_name || '-'}</span>
                </div>
              ))
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}

// ── Groups Tab ────────────────────────────────────────────────────────────────
function GroupsTab() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [editGroup, setEditGroup] = useState<Group | null>(null);
  const [viewGroupId, setViewGroupId] = useState<number | null>(null);
  const [groupMembers, setGroupMembers] = useState<Employee[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [form, setForm] = useState({ name: '', remark: '' });
  const [msg, setMsg] = useState('');

  const load = useCallback(() => {
    getGroups().then(r => setGroups(r.groups));
    orgEmployees().then(r => setEmployees(r.employees));
  }, []);

  useEffect(() => { load(); }, [load]);

  const loadGroupMembers = async (gid: number) => {
    setViewGroupId(gid);
    const r = await getGroupMembers(gid);
    setGroupMembers(r.members);
    setSelectedIds(new Set(r.members.map(m => m.id)));
  };

  const handleCreate = async () => {
    try {
      await createGroup({ name: form.name, remark: form.remark });
      setShowCreate(false);
      setForm({ name: '', remark: '' });
      load();
      setMsg('小组创建成功');
    } catch (e: any) { setMsg(e.message); }
  };

  const handleSetMembers = async (gid: number) => {
    try {
      await apiSetGroupMembers(gid, Array.from(selectedIds));
      setMsg('成员设置成功');
      loadGroupMembers(gid);
      load();
    } catch (e: any) { setMsg(e.message); }
  };

  const handleDeleteGroup = async (gid: number, name: string) => {
    if (!confirm(`确认删除小组"${name}"？成员将被移出该组，此操作不可撤销。`)) return;
    try {
      await deleteGroup(gid);
      load();
      setMsg('小组已删除');
    } catch (e: any) { setMsg(e.message); }
  };

  const currentGroup = viewGroupId ? groups.find(g => g.id === viewGroupId) : null;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Btn onClick={() => setShowCreate(true)} variant="primary">+ 创建小组</Btn>
        {msg && <span className="text-xs text-zinc-400">{msg}</span>}
      </div>

      <Card>
        <div className="text-sm font-semibold text-zinc-300 mb-3">小组列表</div>
        {groups.length === 0 ? (
          <div className="text-zinc-600 text-sm text-center py-6">暂无小组</div>
        ) : (
          <div className="space-y-2">
            {groups.map(g => (
              <div key={g.id} className="flex items-center justify-between py-2.5 px-3 rounded-lg border border-zinc-800 hover:border-zinc-700 transition">
                <div>
                  <span className="text-sm font-medium text-white">{g.name}</span>
                  <span className="text-xs text-zinc-500 ml-2">{g.member_count || 0} 人</span>
                  {g.dept_name && <span className="text-xs text-zinc-600 ml-2">{g.dept_name}</span>}
                </div>
                <div className="flex gap-1.5">
                  <Btn size="sm" onClick={() => loadGroupMembers(g.id)}>管理成员</Btn>
                  <Btn size="sm" variant="danger" onClick={() => handleDeleteGroup(g.id, g.name)}>删除</Btn>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Create Group Modal */}
      <Modal open={showCreate} title="创建小组" onClose={() => setShowCreate(false)}>
        <div className="space-y-4">
          <InputField label="小组名称" value={form.name} onChange={(v: string) => setForm({ ...form, name: v })} placeholder="如：研发一组" />
          <InputField label="备注" value={form.remark} onChange={(v: string) => setForm({ ...form, remark: v })} placeholder="可选" />
          <div className="flex gap-2 justify-end">
            <Btn onClick={() => setShowCreate(false)}>取消</Btn>
            <Btn onClick={handleCreate} variant="primary">创建</Btn>
          </div>
        </div>
      </Modal>

      {/* Manage Members Modal */}
      <Modal open={viewGroupId !== null} title={`管理成员 — ${currentGroup?.name || ''}`} onClose={() => setViewGroupId(null)}>
        <div className="space-y-4">
          <div className="text-xs text-zinc-400 mb-2">点击员工名字可切换选中/取消</div>
          <div className="max-h-64 overflow-y-auto space-y-1 border border-zinc-800 rounded-lg p-2">
            {employees.length === 0 ? (
              <div className="text-zinc-600 text-xs py-2 text-center">暂无员工（请先同步钉钉）</div>
            ) : (
              employees.map(e => {
                const checked = selectedIds.has(e.id);
                return (
                  <div
                    key={e.id}
                    onClick={() => {
                      const next = new Set(selectedIds);
                      checked ? next.delete(e.id) : next.add(e.id);
                      setSelectedIds(next);
                    }}
                    className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer transition ${checked ? 'bg-blue-900/30 text-blue-300' : 'text-zinc-400 hover:bg-zinc-800'}`}
                  >
                    <span className={`w-4 h-4 border rounded flex-shrink-0 flex items-center justify-center text-xs ${checked ? 'bg-blue-600 border-blue-600 text-white' : 'border-zinc-600'}`}>
                      {checked ? '✓' : ''}
                    </span>
                    <span className="text-sm">{e.name}</span>
                    <span className="text-xs text-zinc-600 ml-auto">{e.dept_name || ''}</span>
                  </div>
                );
              })
            )}
          </div>
          <div className="text-xs text-zinc-500">已选 {selectedIds.size} 人</div>
          <div className="flex gap-2 justify-end">
            <Btn onClick={() => setViewGroupId(null)}>取消</Btn>
            <Btn onClick={() => viewGroupId && handleSetMembers(viewGroupId)} variant="primary">保存成员</Btn>
          </div>
        </div>
      </Modal>
    </div>
  );
}

// ── Campaigns Tab ─────────────────────────────────────────────────────────────
function CampaignsTab({ currentAdmin }: { currentAdmin: AdminUser }) {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ name: '', monthKey: '', startAt: '', endAt: '', targetGroupId: '' });
  const [msg, setMsg] = useState('');
  const [activatedVoters, setActivatedVoters] = useState<VoterWithToken[] | null>(null);
  const [activeCampaignEntryCode, setActiveCampaignEntryCode] = useState<string | null>(null);
  const [auditAttrib, setAuditAttrib] = useState<any[] | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    getCampaigns().then(r => setCampaigns(r.campaigns));
    getGroups().then(r => setGroups(r.groups));
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleCreate = async () => {
    if (!form.name || !form.monthKey || !form.startAt || !form.endAt) {
      setMsg('请填写所有字段'); return;
    }
    try {
      await createCampaign({
        ...form,
        targetGroupId: form.targetGroupId ? parseInt(form.targetGroupId) : null,
      });
      setShowCreate(false);
      setForm({ name: '', monthKey: '', startAt: '', endAt: '', targetGroupId: '' });
      load();
      setMsg('活动创建成功');
    } catch (e: any) { setMsg(e.message); }
  };

  const handleDeleteCampaign = async (id: number, name: string) => {
    if (!confirm(`确认删除活动"${name}"？此操作不可撤销。`)) return;
    try {
      await deleteCampaign(id);
      load();
      setMsg('活动已删除');
    } catch (e: any) { setMsg(e.message); }
  };

  const handleActivate = async (id: number) => {
    if (!confirm('确认激活活动？激活后将冻结成员快照并生成投票令牌。')) return;
    setLoading(true);
    try {
      const r = await activateCampaign(id);
      setActivatedVoters(r.voters);
      if (r.entryCode) setActiveCampaignEntryCode(r.entryCode);
      load();
      setMsg(`活动已激活，生成 ${r.voters.length} 个令牌`);
    } catch (e: any) { setMsg(e.message); }
    setLoading(false);
  };

  const handleClose = async (id: number) => {
    if (!confirm('确认关闭活动？')) return;
    try {
      await closeCampaign(id);
      load();
      setMsg('活动已关闭');
    } catch (e: any) { setMsg(e.message); }
  };

  const handleShowVoters = async (id: number) => {
    setLoading(true);
    try {
      const r = await getCampaignVoters(id);
      setActivatedVoters(r.voters as any);
      // Grab entry code from campaign list
      const c = campaigns.find(x => x.id === id);
      if ((c as any)?.public_entry_code) setActiveCampaignEntryCode((c as any).public_entry_code);
      setMsg(`已加载 ${r.voters.length} 个令牌`);
    } catch (e: any) { setMsg(e.message); }
    setLoading(false);
  };

  const handleShowAttrib = async (id: number) => {
    setLoading(true);
    try {
      const token = localStorage.getItem('ratingAdminToken') || '';
      const res = await fetch(`/api/rating/admin/audit/score-attribution?campaign_id=${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) { const d = await res.json(); setMsg(d.error || '无权限'); setLoading(false); return; }
      const data = await res.json();
      setAuditAttrib(data.claims || []);
    } catch (e: any) { setMsg(e.message); }
    setLoading(false);
  };

  const copyEntryLink = (code: string) => {
    const url = `${window.location.origin}/rating?code=${code}`;
    navigator.clipboard.writeText(url).then(() => setMsg(`链接已复制：${url}`));
  };

  const downloadVoters = () => {
    if (!activatedVoters) return;
    const lines = ['姓名,小组,投票令牌,状态', ...activatedVoters.map(v => {
      const name = v.employeeName || (v as any).employee_name || '';
      const group = v.groupName || (v as any).group_name || '';
      const token = v.entryToken || '';
      const status = (v as any).status || '';
      return `${name},${group},${token},${status}`;
    })];
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `voters-${Date.now()}.csv`;
    a.click();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Btn onClick={() => setShowCreate(true)} variant="primary">+ 创建活动</Btn>
        {msg && <span className="text-xs text-zinc-400">{msg}</span>}
      </div>

      <Card>
        {campaigns.length === 0 ? (
          <div className="text-zinc-600 text-sm text-center py-6">暂无活动</div>
        ) : (
          <div className="space-y-3">
            {campaigns.map(c => (
              <div key={c.id} className="py-3 border-b border-zinc-800 last:border-0 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-white">{c.name}</span>
                      <Badge label={{ draft: '草稿', active: '进行中', closed: '已结束' }[c.status] || c.status} color={c.status} />
                      {c.target_group_name && (
                        <span className="text-xs bg-zinc-700 text-zinc-300 px-1.5 py-0.5 rounded">👥 {c.target_group_name}</span>
                      )}
                    </div>
                    <div className="text-xs text-zinc-500 mt-0.5">
                      {c.month_key} · {c.voted_count || 0}/{c.total_voters || 0} 投票
                    </div>
                  </div>
                  <div className="flex gap-1.5 flex-wrap">
                    {c.status === 'draft' && (
                      <>
                        <Btn size="sm" variant="success" onClick={() => handleActivate(c.id)} disabled={loading}>激活</Btn>
                        {currentAdmin.admin_role === 'super_admin' && (
                          <Btn size="sm" variant="danger" onClick={() => handleDeleteCampaign(c.id, c.name)}>删除</Btn>
                        )}
                      </>
                    )}
                    {c.status === 'active' && (
                      <>
                        <Btn size="sm" variant="secondary" onClick={() => handleShowVoters(c.id)} disabled={loading}>查看令牌</Btn>
                        {currentAdmin.admin_role === 'super_admin' && (
                          <Btn size="sm" variant="secondary" onClick={() => handleShowAttrib(c.id)} disabled={loading}>🔍 溯源</Btn>
                        )}
                        <Btn size="sm" variant="danger" onClick={() => handleClose(c.id)}>关闭</Btn>
                      </>
                    )}
                    {c.status === 'closed' && (
                      <>
                        {currentAdmin.admin_role === 'super_admin' && (
                          <>
                            <Btn size="sm" variant="secondary" onClick={() => handleShowAttrib(c.id)} disabled={loading}>🔍 溯源</Btn>
                            <Btn size="sm" variant="danger" onClick={() => handleDeleteCampaign(c.id, c.name)}>删除</Btn>
                          </>
                        )}
                      </>
                    )}
                  </div>
                </div>
                {/* Entry link — always visible when entry code exists */}
                {c.public_entry_code && (
                  <div className="flex items-center gap-2 bg-zinc-800/60 rounded-lg px-3 py-2">
                    <span className="text-xs text-zinc-400 shrink-0">员工入口：</span>
                    <span className="font-mono text-xs text-blue-300 truncate flex-1">
                      {window.location.origin}/rating?code={c.public_entry_code}
                    </span>
                    <Btn size="sm" variant="primary" onClick={() => copyEntryLink(c.public_entry_code!)}>📋 复制</Btn>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Create Campaign Modal */}
      <Modal open={showCreate} title="创建评分活动" onClose={() => setShowCreate(false)}>
        <div className="space-y-4">
          <InputField label="活动名称" value={form.name} onChange={(v: string) => setForm({ ...form, name: v })} placeholder="如：2026年4月互评" />
          <InputField label="月份 (YYYY-MM)" value={form.monthKey} onChange={(v: string) => setForm({ ...form, monthKey: v })} placeholder="2026-04" />
          <InputField label="开始时间" type="datetime-local" value={form.startAt} onChange={(v: string) => setForm({ ...form, startAt: v })} />
          <InputField label="结束时间" type="datetime-local" value={form.endAt} onChange={(v: string) => setForm({ ...form, endAt: v })} />
          <div>
            <label className="block text-xs text-zinc-400 mb-1">参与小组（可选，不选则全部小组参与）</label>
            <select
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
              value={form.targetGroupId}
              onChange={e => setForm({ ...form, targetGroupId: e.target.value })}
            >
              <option value="">全部小组</option>
              {groups.filter(g => g.is_active).map(g => (
                <option key={g.id} value={String(g.id)}>{g.name}</option>
              ))}
            </select>
          </div>
          <div className="flex gap-2 justify-end">
            <Btn onClick={() => setShowCreate(false)}>取消</Btn>
            <Btn onClick={handleCreate} variant="primary">创建</Btn>
          </div>
        </div>
      </Modal>

      {/* Activated Voters Modal */}
      <Modal open={!!activatedVoters} title={`令牌已生成 (${activatedVoters?.length || 0} 个)`} onClose={() => { setActivatedVoters(null); setActiveCampaignEntryCode(null); }}>
        <div className="space-y-4">
          {/* Entry code & link block */}
          {activeCampaignEntryCode && (
            <div className="bg-blue-900/20 border border-blue-700/40 rounded-xl p-4 space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs text-blue-400 font-medium">员工入口链接（发到群里即可）</span>
                <span className="font-mono text-white font-bold tracking-widest text-lg">{activeCampaignEntryCode}</span>
              </div>
              <div className="font-mono text-xs text-zinc-400 break-all">
                {window.location.origin}/rating?code={activeCampaignEntryCode}
              </div>
              <button
                onClick={() => copyEntryLink(activeCampaignEntryCode)}
                className="w-full bg-blue-600 hover:bg-blue-500 text-white rounded-lg py-2 text-sm font-medium transition"
              >
                📋 复制入口链接
              </button>
              <p className="text-xs text-zinc-500">员工点链接 → 选自己名字 → 直接开始评分。无需 HR 逐个发令牌。</p>
            </div>
          )}
          <p className="text-sm text-zinc-400">以下是每个员工的原始令牌（用于备查/手动发放）：</p>
          <div className="max-h-48 overflow-y-auto border border-zinc-800 rounded-lg p-2 space-y-1">
            {activatedVoters?.map((v, i) => (
              <div key={i} className="text-xs text-zinc-400">
                <span className="text-white">{v.employeeName || (v as any).employee_name}</span>
                <span className="text-zinc-600 mx-1">·</span>
                <span className="text-zinc-500">{v.groupName || (v as any).group_name}</span>
                <span className="text-zinc-600 mx-1">·</span>
                <span className="font-mono text-blue-400 break-all">
                  {v.entryToken || <span className="text-zinc-600 italic">已使用/已重置</span>}
                </span>
              </div>
            ))}
          </div>
          <Btn onClick={downloadVoters} variant="secondary" className="w-full">⬇ 下载令牌 CSV（备用）</Btn>
        </div>
      </Modal>

      {/* Attribution Audit Modal */}
      <Modal open={!!auditAttrib} title="评分溯源（仅超管可见）" onClose={() => setAuditAttrib(null)}>
        <div className="space-y-3">
          <p className="text-xs text-zinc-500">以下为领取令牌的员工身份记录，可用于排查异常评分。</p>
          <div className="max-h-64 overflow-y-auto border border-zinc-800 rounded-lg divide-y divide-zinc-800">
            {(auditAttrib || []).length === 0 && (
              <p className="text-zinc-600 text-sm text-center py-4">暂无领取记录</p>
            )}
            {(auditAttrib || []).map((row: any, i: number) => (
              <div key={i} className="px-3 py-2 text-xs space-y-0.5">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-white">{row.real_name}</span>
                  {row.dept_name && <span className="text-zinc-500">{row.dept_name}</span>}
                  {row.group_name && <span className="text-blue-400">{row.group_name}</span>}
                </div>
                <div className="text-zinc-600">
                  领取于 {row.claimed_at || '—'} · 状态: <span className={row.voter_status === 'used' ? 'text-green-400' : 'text-zinc-400'}>{row.voter_status}</span>
                  {row.ip_address && ` · IP: ${row.ip_address}`}
                </div>
              </div>
            ))}
          </div>
        </div>
      </Modal>
    </div>
  );
}

// ── Results Tab ────────────────────────────────────────────────────────────────
function ResultsTab({ currentAdmin }: { currentAdmin: AdminUser }) {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [selectedCampaign, setSelectedCampaign] = useState<number | ''>('');
  const [results, setResults] = useState<ResultRow[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    getCampaigns().then(r => {
      setCampaigns(r.campaigns);
      const active = r.campaigns.find(c => c.status !== 'draft');
      if (active) setSelectedCampaign(active.id);
    });
  }, []);

  useEffect(() => {
    if (!selectedCampaign) { setResults([]); return; }
    setLoading(true);
    getCampaignResults(selectedCampaign as number)
      .then(r => setResults(r.results))
      .catch(() => setResults([]))
      .finally(() => setLoading(false));
  }, [selectedCampaign]);

  const byGroup: Record<string, ResultRow[]> = {};
  for (const r of results) {
    if (!byGroup[r.group_name]) byGroup[r.group_name] = [];
    byGroup[r.group_name].push(r);
  }

  const role = (currentAdmin.role || currentAdmin.admin_role || '');
  const exportUrl = selectedCampaign ? `${exportResultsUrl(selectedCampaign as number)}?token=${localStorage.getItem('rating_admin_token')}` : '';

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <select
          className="rounded-lg bg-zinc-800 border border-zinc-700 text-white px-3 py-2 text-sm outline-none"
          value={selectedCampaign}
          onChange={e => setSelectedCampaign(e.target.value ? parseInt(e.target.value) : '')}
        >
          <option value="">选择活动...</option>
          {campaigns.map(c => <option key={c.id} value={c.id}>{c.name} ({c.month_key})</option>)}
        </select>
        {role === 'super_admin' && selectedCampaign && (
          <a
            href={`/api/rating/admin/campaigns/${selectedCampaign}/results/export`}
            className="inline-flex items-center px-4 py-2 text-sm bg-green-800 hover:bg-green-700 text-green-300 border border-green-700 rounded-lg transition"
            download
          >
            ⬇ 导出 Excel
          </a>
        )}
      </div>

      {loading && <div className="text-zinc-500 text-sm text-center py-8">加载中...</div>}

      {!loading && Object.keys(byGroup).length === 0 && selectedCampaign && (
        <div className="text-zinc-600 text-sm text-center py-8">暂无评分数据</div>
      )}

      {Object.entries(byGroup).map(([groupName, rows]) => (
        <Card key={groupName}>
          <div className="text-sm font-semibold text-zinc-300 mb-3">{groupName}</div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-zinc-500 border-b border-zinc-800">
                  <th className="text-left py-2 font-medium">姓名</th>
                  <th className="text-right py-2 font-medium">印象分均值</th>
                  <th className="text-right py-2 font-medium">卫生分均值</th>
                  <th className="text-right py-2 font-medium">提交人数</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.member_id} className="border-b border-zinc-800/50 last:border-0 hover:bg-zinc-800/20">
                    <td className="py-2.5 text-white">{r.name}</td>
                    <td className="py-2.5 text-right text-blue-400">{r.avg_impression_score?.toFixed(1) ?? '—'}</td>
                    <td className="py-2.5 text-right text-green-400">{r.avg_hygiene_score?.toFixed(1) ?? '—'}</td>
                    <td className="py-2.5 text-right text-zinc-400">{r.submission_count ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ))}
    </div>
  );
}

// ── Admins Tab ────────────────────────────────────────────────────────────────
function AdminsTab() {
  const [admins, setAdmins] = useState<AdminUser[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ username: '', password: '', realName: '', adminRole: 'admin', managedGroupId: '' });
  const [msg, setMsg] = useState('');

  useEffect(() => {
    getAdmins().then(r => setAdmins(r.admins));
    getGroups().then(r => setGroups(r.groups));
  }, []);

  const handleCreate = async () => {
    if (!form.username || !form.password) { setMsg('用户名和密码必填'); return; }
    try {
      await createAdmin({
        username: form.username,
        password: form.password,
        realName: form.realName || undefined,
        adminRole: form.adminRole,
        managedGroupId: form.managedGroupId ? parseInt(form.managedGroupId) : undefined,
      });
      setShowCreate(false);
      setForm({ username: '', password: '', realName: '', adminRole: 'admin', managedGroupId: '' });
      getAdmins().then(r => setAdmins(r.admins));
      setMsg('管理员已创建');
    } catch (e: any) { setMsg(e.message); }
  };

  const handleToggle = async (admin: AdminUser) => {
    try {
      await updateAdmin(admin.id, { isActive: !admin.is_active });
      getAdmins().then(r => setAdmins(r.admins));
    } catch (e: any) { setMsg(e.message); }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('确认删除此管理员？')) return;
    try {
      await deleteAdmin(id);
      setAdmins(a => a.filter(x => x.id !== id));
      setMsg('已删除');
    } catch (e: any) { setMsg(e.message); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Btn onClick={() => setShowCreate(true)} variant="primary">+ 创建管理员</Btn>
        {msg && <span className="text-xs text-zinc-400">{msg}</span>}
      </div>

      <Card>
        <div className="space-y-2">
          {admins.map(a => (
            <div key={a.id} className="flex items-center justify-between py-2.5 border-b border-zinc-800 last:border-0">
              <div>
                <span className="text-sm text-white">{a.username}</span>
                {a.real_name && <span className="text-xs text-zinc-500 ml-2">({a.real_name})</span>}
                <div className="flex items-center gap-2 mt-1">
                  <Badge label={a.admin_role || ''} color={a.admin_role || 'viewer'} />
                  {!a.is_active && <Badge label="已禁用" color="voided" />}
                </div>
              </div>
              <div className="flex gap-1.5">
                <Btn size="sm" onClick={() => handleToggle(a)}>
                  {a.is_active ? '禁用' : '启用'}
                </Btn>
                <Btn size="sm" variant="danger" onClick={() => handleDelete(a.id)}>删除</Btn>
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Modal open={showCreate} title="创建管理员" onClose={() => setShowCreate(false)}>
        <div className="space-y-4">
          <InputField label="用户名" value={form.username} onChange={(v: string) => setForm({ ...form, username: v })} />
          <InputField label="密码" type="password" value={form.password} onChange={(v: string) => setForm({ ...form, password: v })} />
          <InputField label="真实姓名" value={form.realName} onChange={(v: string) => setForm({ ...form, realName: v })} />
          <div>
            <label className="block text-xs text-zinc-400 mb-1">角色</label>
            <select
              className="w-full rounded-lg bg-zinc-800 border border-zinc-700 text-white px-3 py-2 text-sm outline-none"
              value={form.adminRole}
              onChange={e => setForm({ ...form, adminRole: e.target.value })}
            >
              <option value="super_admin">超级管理员</option>
              <option value="admin">管理员</option>
              <option value="viewer">观察者</option>
            </select>
          </div>
          {form.adminRole === 'admin' && (
            <div>
              <label className="block text-xs text-zinc-400 mb-1">负责小组（子管理员）</label>
              <select
                className="w-full rounded-lg bg-zinc-800 border border-zinc-700 text-white px-3 py-2 text-sm outline-none"
                value={form.managedGroupId}
                onChange={e => setForm({ ...form, managedGroupId: e.target.value })}
              >
                <option value="">不限小组</option>
                {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </div>
          )}
          <div className="flex gap-2 justify-end">
            <Btn onClick={() => setShowCreate(false)}>取消</Btn>
            <Btn onClick={handleCreate} variant="primary">创建</Btn>
          </div>
        </div>
      </Modal>
    </div>
  );
}

// ── Audit Tab ─────────────────────────────────────────────────────────────────
function AuditTab() {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    getAuditLogs(page).then(r => {
      setLogs(r.logs);
      setTotal(r.total);
    }).finally(() => setLoading(false));
  }, [page]);

  return (
    <div className="space-y-4">
      <Card>
        <div className="text-xs text-zinc-500 mb-3">共 {total} 条记录</div>
        {loading && <div className="text-zinc-500 text-sm text-center py-4">加载中...</div>}
        <div className="space-y-1.5">
          {logs.map(l => (
            <div key={l.id} className="py-2 border-b border-zinc-800/50 last:border-0">
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono bg-zinc-800 px-1.5 py-0.5 rounded text-zinc-300">{l.action}</span>
                {l.admin_username && <span className="text-xs text-zinc-400">{l.admin_username}</span>}
                {l.target_type && <span className="text-xs text-zinc-600">{l.target_type}:{l.target_id}</span>}
                <span className="text-xs text-zinc-600 ml-auto">{new Date(l.created_at).toLocaleString('zh-CN')}</span>
              </div>
            </div>
          ))}
        </div>
        {total > 50 && (
          <div className="flex items-center justify-between mt-4 pt-3 border-t border-zinc-800">
            <Btn size="sm" disabled={page === 1} onClick={() => setPage(p => p - 1)}>← 上一页</Btn>
            <span className="text-xs text-zinc-500">第 {page} 页</span>
            <Btn size="sm" disabled={page * 50 >= total} onClick={() => setPage(p => p + 1)}>下一页 →</Btn>
          </div>
        )}
      </Card>
    </div>
  );
}

// ── Main App ───────────────────────────────────────────────────────────────────
type Tab = 'overview' | 'org' | 'groups' | 'campaigns' | 'results' | 'admins' | 'audit';

export default function RatingAdmin() {
  const [currentAdmin, setCurrentAdmin] = useState<AdminUser | null>(() => {
    try { return JSON.parse(localStorage.getItem('rating_admin_user') || 'null'); } catch { return null; }
  });
  const [activeTab, setActiveTab] = useState<Tab>('overview');

  const handleLogin = (admin: AdminUser) => setCurrentAdmin(admin);
  const handleLogout = () => {
    localStorage.removeItem('rating_admin_token');
    localStorage.removeItem('rating_admin_user');
    setCurrentAdmin(null);
  };

  if (!currentAdmin) {
    return <RatingAdminLogin onLogin={handleLogin} />;
  }

  const role = currentAdmin.role || currentAdmin.admin_role || '';
  const isSuperAdmin = role === 'super_admin';

  const tabs: { id: Tab; label: string; hidden?: boolean }[] = [
    { id: 'overview', label: '概览' },
    { id: 'org', label: '组织架构' },
    { id: 'groups', label: '小组管理' },
    { id: 'campaigns', label: '活动管理' },
    { id: 'results', label: '评分结果' },
    { id: 'admins', label: '管理员', hidden: !isSuperAdmin },
    { id: 'audit', label: '审计日志' },
  ].filter((t): t is { id: Tab; label: string; hidden?: boolean } => !t.hidden);

  return (
    <div className="min-h-dvh bg-zinc-950 text-white">
      {/* Header */}
      <div className="sticky top-0 z-30 bg-zinc-950/90 backdrop-blur border-b border-zinc-800">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-lg">🏆</span>
            <span className="text-sm font-semibold text-white">评分管理后台</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-zinc-500">{currentAdmin.real_name || currentAdmin.username}</span>
            <Badge label={role} color={role} />
            <button onClick={handleLogout} className="text-xs text-zinc-500 hover:text-zinc-300 transition">退出</button>
          </div>
        </div>

        {/* Tabs */}
        <div className="max-w-6xl mx-auto px-4 flex gap-1 overflow-x-auto pb-0">
          {tabs.map(t => (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              className={`flex-shrink-0 text-sm px-4 py-2.5 border-b-2 transition ${activeTab === t.id ? 'border-blue-500 text-blue-400' : 'border-transparent text-zinc-500 hover:text-zinc-300'}`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="max-w-6xl mx-auto px-4 py-6">
        {activeTab === 'overview' && <OverviewTab />}
        {activeTab === 'org' && <OrgTab />}
        {activeTab === 'groups' && <GroupsTab />}
        {activeTab === 'campaigns' && <CampaignsTab currentAdmin={currentAdmin} />}
        {activeTab === 'results' && <ResultsTab currentAdmin={currentAdmin} />}
        {activeTab === 'admins' && isSuperAdmin && <AdminsTab />}
        {activeTab === 'audit' && <AuditTab />}
      </div>
    </div>
  );
}
