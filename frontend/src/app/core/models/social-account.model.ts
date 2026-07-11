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

export interface ValidateSocialAccountResponse {
  id: string;
  status: SocialAccountStatus;
  lastValidatedAt?: string;
  live: boolean;
}
