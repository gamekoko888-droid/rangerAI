/**
 * Rating Admin API client
 */

const BASE = '/api/rating';

function getToken(): string | null {
  return localStorage.getItem('rating_admin_token');
}

function authHeaders(): HeadersInit {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

async function req<T = any>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(opts.headers || {}) },
    ...opts,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { const j = await res.json(); msg = j.error || msg; } catch {}
    throw new Error(msg);
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('json')) return res.json() as Promise<T>;
  return res as unknown as T;
}

// Auth
export const adminLogin = (username: string, password: string) =>
  req<{ ok: boolean; token: string; admin: AdminUser }>('/admin/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });

export const adminMe = () => req<AdminUser>('/admin/me');

// Overview
export const adminOverview = () => req<OverviewData>('/admin/overview');

// Org
export const orgSync = () => req('/admin/org/sync', { method: 'POST' });
export const orgDepartments = () => req<{ departments: Department[] }>('/admin/org/departments');
export const orgEmployees = (params?: { groupId?: number; search?: string }) => {
  const sp = new URLSearchParams();
  if (params?.groupId) sp.set('groupId', String(params.groupId));
  if (params?.search) sp.set('search', params.search);
  return req<{ employees: Employee[] }>(`/admin/org/employees?${sp}`);
};

// Groups
export const getGroups = () => req<{ groups: Group[] }>('/admin/groups');
export const createGroup = (data: { name: string; departmentId?: number; leaderEmployeeId?: number; remark?: string }) =>
  req('/admin/groups', { method: 'POST', body: JSON.stringify(data) });
export const updateGroup = (id: number, data: Partial<{ name: string; departmentId: number | null; leaderEmployeeId: number | null; remark: string; isActive: boolean }>) =>
  req(`/admin/groups/${id}`, { method: 'PUT', body: JSON.stringify(data) });
export const deleteGroup = (id: number) => req(`/admin/groups/${id}`, { method: 'DELETE' });
export const getGroupMembers = (id: number) => req<{ members: Employee[] }>(`/admin/groups/${id}/members`);
export const setGroupMembers = (id: number, employeeIds: number[]) =>
  req(`/admin/groups/${id}/members`, { method: 'POST', body: JSON.stringify({ employeeIds }) });

// Campaigns
export const getCampaigns = () => req<{ campaigns: Campaign[] }>('/admin/campaigns');
export const createCampaign = (data: { name: string; monthKey: string; startAt: string; endAt: string; targetGroupId?: number | null }) =>
  req('/admin/campaigns', { method: 'POST', body: JSON.stringify(data) });
export const deleteCampaign = (id: number) => req(`/admin/campaigns/${id}`, { method: 'DELETE' });
export const activateCampaign = (id: number) =>
  req<{ ok: boolean; voters: VoterWithToken[]; entryCode?: string }>(`/admin/campaigns/${id}/activate`, { method: 'PUT' });
export const closeCampaign = (id: number) =>
  req(`/admin/campaigns/${id}/close`, { method: 'PUT' });

// Voters
export const getCampaignVoters = (id: number, groupId?: number) => {
  const sp = groupId ? `?groupId=${groupId}` : '';
  return req<{ voters: Voter[] }>(`/admin/campaigns/${id}/voters${sp}`);
};
export const resetVoter = (id: number) => req<{ ok: boolean; entryToken: string }>(`/admin/voters/${id}/reset`, { method: 'PUT' });
export const voidVoter = (id: number) => req(`/admin/voters/${id}/void`, { method: 'PUT' });

// Results
export const getCampaignResults = (id: number, groupId?: number) => {
  const sp = groupId ? `?groupId=${groupId}` : '';
  return req<{ results: ResultRow[] }>(`/admin/campaigns/${id}/results${sp}`);
};
export const exportResultsUrl = (id: number) => `${BASE}/admin/campaigns/${id}/results/export`;

// Admins
export const getAdmins = () => req<{ admins: AdminUser[] }>('/admin/admins');
export const createAdmin = (data: { username: string; password: string; realName?: string; adminRole?: string; managedGroupId?: number }) =>
  req('/admin/admins', { method: 'POST', body: JSON.stringify(data) });
export const updateAdmin = (id: number, data: Partial<{ realName: string; adminRole: string; managedGroupId: number | null; isActive: boolean; password: string }>) =>
  req(`/admin/admins/${id}`, { method: 'PUT', body: JSON.stringify(data) });
export const deleteAdmin = (id: number) =>
  req(`/admin/admins/${id}`, { method: 'DELETE' });

// Audit
export const getAuditLogs = (page = 1, limit = 50) =>
  req<{ logs: AuditLog[]; total: number; page: number; limit: number }>(`/admin/audit?page=${page}&limit=${limit}`);

// ── Types ──────────────────────────────────────────────────────────────────
export interface AdminUser {
  id: number;
  username: string;
  realName?: string;
  real_name?: string;
  role?: string;
  admin_role?: string;
  managedGroupId?: number | null;
  managed_group_id?: number | null;
  is_active?: number;
  last_login_at?: string;
  created_at?: string;
}

export interface Department {
  id: number;
  dingtalk_dept_id: string;
  name: string;
  is_active: number;
}

export interface Employee {
  id: number;
  name: string;
  job_no?: string;
  email?: string;
  department_id?: number;
  dept_name?: string;
  group_id?: number | null;
  group_name?: string | null;
  employment_status: number;
}

export interface Group {
  id: number;
  name: string;
  department_id?: number;
  dept_name?: string;
  leader_employee_id?: number;
  leader_name?: string;
  member_count?: number;
  is_active: number;
  remark?: string;
}

export interface Campaign {
  id: number;
  month_key: string;
  name: string;
  status: 'draft' | 'active' | 'closed';
  start_at: string;
  end_at: string;
  voted_count?: number;
  total_voters?: number;
  created_at: string;
  target_group_id?: number | null;
  target_group_name?: string | null;
  public_entry_code?: string | null;
}

export interface Voter {
  id: number;
  campaignId: number;
  employeeId: number;
  employeeName: string;
  groupId: number;
  groupName: string;
  status: 'unused' | 'claimed' | 'used' | 'voided';
  claimedAt?: string;
  usedAt?: string;
  createdAt: string;
}

export interface VoterWithToken extends Voter {
  entryToken: string;
}

export interface ResultRow {
  member_id: number;
  name: string;
  group_id: number;
  group_name: string;
  avg_impression_score?: number;
  avg_hygiene_score?: number;
  submission_count?: number;
}

export interface AuditLog {
  id: number;
  operator_admin_id?: number;
  admin_username?: string;
  action: string;
  target_type?: string;
  target_id?: string;
  detail?: string;
  ip?: string;
  created_at: string;
}

export interface OverviewData {
  campaigns: Campaign[];
  groupCount: number;
  employeeCount: number;
}
