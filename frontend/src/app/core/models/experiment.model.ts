export type ExperimentChannel = 'EMAIL' | 'SMS' | 'VOICE' | 'SOCIAL';
export type ExperimentStatus = 'ACTIVE' | 'PAUSED' | 'COMPLETED';

export interface ExperimentVariant {
  id: string;
  label: string;
  content: string;
  sends: number;
  responses: number;
  positiveResponses: number;
  /** 0..1 */
  responseRate: number;
}

export interface Experiment {
  groupId?: string | null;
  campaignId?: string | null;
  id: string;
  name: string;
  channel: ExperimentChannel;
  goal?: string;
  status: ExperimentStatus;
  winnerVariantId?: string | null;
  /** Only present on the detail response (GET /:id) once variants have >=8 sends. */
  leadingVariantId?: string | null;
  createdAt?: string;
  variants: ExperimentVariant[];
}
