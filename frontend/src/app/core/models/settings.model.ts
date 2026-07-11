export type OrgSettingGroup = 'ai' | 'search' | 'email' | 'sms' | 'voice';
export type OrgSettingSource = 'org' | 'env' | 'unset';

export interface OrgSetting {
  key: string;
  label: string;
  group: OrgSettingGroup;
  secret: boolean;
  placeholder?: string;
  source: OrgSettingSource;
  configured: boolean;
  /** Present only for non-secret settings. */
  value?: string;
}

export interface OrgSettingsResponse {
  settings: OrgSetting[];
}

export type PlatformSettingSource = 'platform' | 'env' | 'default';

export interface PlatformSetting {
  key: string;
  label: string;
  type: 'number';
  value: number;
  source: PlatformSettingSource;
  default: number;
}

export interface PlatformSettingsResponse {
  settings: PlatformSetting[];
}
