import type { AuthContext } from '../auth/types.js';
import type { NormalizedDeliveryStatus } from './status.js';

export interface TenantRecord {
  id: string;
  name: string;
  createdAt: Date;
}

export interface UserRecord {
  id: string;
  tenantId: string;
  externalSubject: string;
  displayName: string | null;
  createdAt: Date;
}

export type IntegrationStatus = 'active' | 'disabled';
export type IntegrationEnvironment = 'sandbox' | 'production';

export interface DoorDashIntegrationRecord {
  id: string;
  tenantId: string;
  status: IntegrationStatus;
  environment: IntegrationEnvironment;
  createdAt: Date;
  updatedAt: Date;
}

export interface DeliveryRecord {
  id: string;
  tenantId: string;
  doordashDeliveryIdHash: string;
  doordashDeliveryIdEncrypted: string | null;
  externalOrderReference: string | null;
  merchantName: string | null;
  status: NormalizedDeliveryStatus;
  providerStatus: string | null;
  etaAt: Date | null;
  lastEventAt: Date | null;
  lastReceivedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type DeliveryAccessRelationship = 'customer' | 'operator' | 'support';

export interface DeliveryAccessRecord {
  deliveryId: string;
  userId: string;
  relationship: DeliveryAccessRelationship;
  createdAt: Date;
}

export interface DeliveryEventRecord {
  id: string;
  deliveryId: string;
  providerEventId: string;
  eventType: string;
  providerStatus: string | null;
  normalizedStatus: NormalizedDeliveryStatus;
  occurredAt: Date;
  receivedAt: Date;
  sanitizedPayload: Record<string, unknown>;
}

export interface NewDeliveryEvent {
  deliveryId: string;
  providerEventId: string;
  eventType: string;
  providerStatus: string | null;
  normalizedStatus: NormalizedDeliveryStatus;
  occurredAt: Date;
  receivedAt: Date;
  sanitizedPayload: Record<string, unknown>;
}

export type AuditOutcome = 'success' | 'denied' | 'error' | 'ignored' | 'duplicate' | 'stale';

export interface AuditEntry {
  tenantId: string;
  userId: string | null;
  action: string;
  deliveryId: string | null;
  outcome: AuditOutcome;
  requestId: string;
  metadata?: Record<string, unknown>;
}

export interface DeliveryProjection {
  status: NormalizedDeliveryStatus;
  providerStatus: string | null;
  etaAt: Date | null;
  lastEventAt: Date | null;
}

export interface NormalizedDeliveryEvent {
  normalizedStatus: NormalizedDeliveryStatus;
  providerStatus: string | null;
  occurredAt: Date;
  etaAt: Date | null;
  safeSummary: string;
  isTerminal: boolean;
  orderingTimestamp: number;
}

export type TransitionReason =
  | 'initial'
  | 'updated'
  | 'stale_ignored'
  | 'terminal_protected'
  | 'tie_break_rejected';

export interface TransitionDecision {
  changed: boolean;
  reason: TransitionReason;
  projection: DeliveryProjection;
}

export interface FreshnessThresholds {
  delayedAfterSeconds: number;
  staleAfterSeconds: number;
}

export type DataFreshness = 'fresh' | 'delayed' | 'stale' | 'unknown';

export interface GetDeliveryStatusInput {
  delivery_ref: string;
}

export interface GetDeliveryStatusOutput {
  delivery_ref: string;
  merchant_name: string | null;
  status: NormalizedDeliveryStatus;
  summary: string;
  eta_at: string | null;
  eta_minutes: number | null;
  last_updated_at: string;
  is_terminal: boolean;
  data_freshness: DataFreshness;
}

export interface ListActiveDeliveriesInput {
  include_recent_delivered?: boolean;
}

export interface DeliveryListItem {
  delivery_ref: string;
  merchant_name: string | null;
  status: NormalizedDeliveryStatus;
  summary: string;
  eta_at: string | null;
  last_updated_at: string;
  is_terminal: boolean;
}

export interface ListActiveDeliveriesOutput {
  deliveries: DeliveryListItem[];
}

export interface DeliveryStatusService {
  getDeliveryStatus(auth: AuthContext, input: GetDeliveryStatusInput): Promise<GetDeliveryStatusOutput>;
  listActiveDeliveries(auth: AuthContext, input: ListActiveDeliveriesInput): Promise<ListActiveDeliveriesOutput>;
}
