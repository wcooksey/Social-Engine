export type SocialPlatform = 'LINKEDIN' | 'FACEBOOK' | 'INSTAGRAM' | 'X';

/** Lowercase platform id as accepted by the connect endpoint. */
export type SocialPlatformParam = 'linkedin' | 'facebook' | 'instagram' | 'x';

export type SocialAccountStatus = 'CONNECTED' | 'EXPIRED' | 'ERROR';

export interface SocialAccount {
  id: string;
  platform: SocialPlatform;
  label?: string;
  status: SocialAccountStatus;
  lastValidatedAt?: string;
  lastUsedAt?: string;
  createdAt: string;
}

export interface SocialAccountsResponse {
  accounts: SocialAccount[];
  encryptionConfigured: boolean;
}

export interface ConnectSocialAccountResponse {
  id: string;
  platform: SocialPlatform;
  label?: string;
  status: SocialAccountStatus;
}

/** Why a session check failed — a checkpoint and a dead cookie need opposite fixes. */
export type ValidationReason =
  | 'ok'
  | 'checkpoint'
  | 'login_wall'
  | 'unreadable_state'
  | 'browser_error';

export interface ValidateSocialAccountResponse {
  id: string;
  status: SocialAccountStatus;
  lastValidatedAt?: string;
  live: boolean;
  reason?: ValidationReason;
  /** Operator-facing next step. */
  detail?: string;
  finalUrl?: string;
}
