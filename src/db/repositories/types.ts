import type {
  AuditOutcome,
  DeliveryAccessRelationship,
  DeliveryAccessRecord,
  DeliveryEventRecord,
  DeliveryProjection,
  DeliveryRecord,
  DoorDashIntegrationRecord,
  IntegrationEnvironment,
  IntegrationStatus,
  NewDeliveryEvent,
  TenantRecord,
  UserRecord,
} from '../../domain/types.js';
import type { NormalizedDeliveryStatus } from '../../domain/status.js';

export interface TenantRepository {
  create(input: { name: string }): Promise<TenantRecord>;
  findById(id: string): Promise<TenantRecord | null>;
  ensure(input: { id: string; name: string }): Promise<TenantRecord>;
}

export interface UserRepository {
  create(input: {
    tenantId: string;
    externalSubject: string;
    displayName?: string | null;
  }): Promise<UserRecord>;
  findById(id: string): Promise<UserRecord | null>;
  findByExternalSubject(tenantId: string, externalSubject: string): Promise<UserRecord | null>;
  ensure(input: {
    tenantId: string;
    externalSubject: string;
    displayName?: string | null;
  }): Promise<UserRecord>;
}

export interface IntegrationRepository {
  create(input: {
    tenantId: string;
    environment: IntegrationEnvironment;
  }): Promise<DoorDashIntegrationRecord>;
  findActiveByTenantId(tenantId: string): Promise<DoorDashIntegrationRecord | null>;
  setStatus(id: string, status: IntegrationStatus): Promise<void>;
}

export interface CreateDeliveryInput {
  tenantId: string;
  doordashDeliveryIdHash: string;
  doordashDeliveryIdEncrypted?: string | null;
  externalOrderReference?: string | null;
  merchantName?: string | null;
  status?: NormalizedDeliveryStatus;
  providerStatus?: string | null;
  etaAt?: Date | null;
  lastEventAt?: Date | null;
}

export interface ListAccessibleOptions {
  includeRecentDelivered?: boolean;
  recentWindowHours?: number;
  now?: Date;
  limit?: number;
}

export interface ApplyProjectionInput {
  deliveryId: string;
  expectedLastEventAt: Date | null;
  projection: DeliveryProjection;
  receivedAt: Date;
}

export interface DeliveryRepository {
  create(input: CreateDeliveryInput): Promise<DeliveryRecord>;
  findById(id: string): Promise<DeliveryRecord | null>;
  findAccessibleForUser(deliveryId: string, userId: string): Promise<DeliveryRecord | null>;
  findByDoordashDeliveryIdHash(hash: string): Promise<DeliveryRecord | null>;
  listAccessibleForUser(userId: string, options?: ListAccessibleOptions): Promise<DeliveryRecord[]>;
  applyEventProjection(input: ApplyProjectionInput): Promise<{ updated: boolean }>;
  touchLastReceived(deliveryId: string, receivedAt: Date): Promise<void>;
}

export interface DeliveryAccessRepository {
  create(input: {
    deliveryId: string;
    userId: string;
    relationship: DeliveryAccessRelationship;
  }): Promise<DeliveryAccessRecord>;
  find(deliveryId: string, userId: string): Promise<DeliveryAccessRecord | null>;
}

export interface DeliveryEventRepository {
  insertIfAbsent(input: NewDeliveryEvent): Promise<{ inserted: boolean; event: DeliveryEventRecord }>;
  listByDelivery(deliveryId: string, options?: { limit?: number }): Promise<DeliveryEventRecord[]>;
}

export interface AuditEntryInput {
  tenantId: string;
  userId: string | null;
  action: string;
  deliveryId: string | null;
  outcome: AuditOutcome;
  requestId: string;
  metadata: Record<string, unknown>;
}

export interface AuditLogRepository {
  insert(input: AuditEntryInput): Promise<void>;
}

export interface Repositories {
  tenants: TenantRepository;
  users: UserRepository;
  integrations: IntegrationRepository;
  deliveries: DeliveryRepository;
  deliveryEvents: DeliveryEventRepository;
  deliveryAccess: DeliveryAccessRepository;
  auditLogs: AuditLogRepository;
}
