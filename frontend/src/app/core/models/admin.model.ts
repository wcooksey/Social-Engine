/** Cross-tenant operator views. Only the super-admin account can load these. */

export interface AdminOverview {
  organizations: number;
  users: number;
  leads: number;
  activeJobs: number;
  runningNow: number;
  runsThisWeek: number;
  spendThisWeekUsd: number;
}

export interface AdminOrganization {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  engineModel: string | null;
  paused: boolean;
  dailySendCap: number;
  socialAutonomy: boolean;
  userCount: number;
  leadCount: number;
  campaignCount: number;
  lastRunAt: string | null;
  spendThisWeekUsd: number;
}

export interface AdminUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  isActive: boolean;
  isSuperAdmin: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  organization: { id: string; name: string };
}
