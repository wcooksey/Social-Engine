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

/** One screenshot of the server-side login browser, for the interactive connect flow. */
export interface InteractiveLoginFrame {
  id: string;
  platform: SocialPlatformParam;
  url: string;
  /** JPEG as base64 (no data: prefix). */
  imageBase64: string;
  /** Browser viewport — clicks on the rendered image are mapped back to this. */
  viewport: { width: number; height: number };
}

export type InteractiveLoginInput =
  | { type: 'click'; x: number; y: number }
  | { type: 'type'; text: string }
  | { type: 'press'; key: string }
  | { type: 'scroll'; deltaY: number };

export interface CompleteInteractiveLoginResponse {
  connected: boolean;
  accountId?: string;
  /** Present when not yet logged in — the latest view so the user can continue. */
  frame?: InteractiveLoginFrame;
}

export interface ValidateSocialAccountResponse {
  id: string;
  status: SocialAccountStatus;
  lastValidatedAt?: string;
  live: boolean;
}
