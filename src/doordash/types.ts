export interface DoorDashWebhookEnvelope {
  eventId: string;
  eventType: string;
  providerDeliveryId: string;
  providerStatus: string;
  occurredAt: Date;
  etaAt: Date | null;
  merchantName: string | null;
  sanitizedPayload: Record<string, unknown>;
}

export interface WebhookVerificationInput {
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
}

export interface WebhookVerifier {
  verify(input: WebhookVerificationInput): Promise<void>;
}

export interface DoorDashJwtProvider {
  getToken(options?: { integrationId?: string | null }): Promise<string>;
}

export interface DoorDashDeliverySnapshot {
  providerDeliveryId: string;
  providerStatus: string;
  etaAt: Date | null;
  merchantName: string | null;
  occurredAt: Date;
}

export interface DoorDashClient {
  getDelivery(providerDeliveryId: string): Promise<DoorDashDeliverySnapshot>;
}

export interface WebhookTokenRequest {
  clientId: string;
  clientSecret: string;
}

export interface WebhookTokenIssuer {
  issue(request: WebhookTokenRequest): Promise<{ access_token: string; token_type: 'Bearer'; expires_in: number }>;
  verify(token: string): Promise<void>;
}
