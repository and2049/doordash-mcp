CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  external_subject text NOT NULL,
  display_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, external_subject)
);
CREATE TABLE doordash_integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  environment text NOT NULL CHECK (environment IN ('sandbox', 'production')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  doordash_delivery_id_hash text NOT NULL UNIQUE,
  doordash_delivery_id_encrypted text,
  external_order_reference text,
  merchant_name text,
  status text NOT NULL CHECK (status IN ('scheduled', 'searching_for_driver', 'driver_assigned', 'at_restaurant', 'preparing_or_waiting', 'picked_up', 'out_for_delivery', 'arrived', 'delivered', 'cancelled', 'issue', 'unknown')),
  provider_status text,
  eta_at timestamptz,
  last_event_at timestamptz,
  last_received_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE delivery_access (
  delivery_id uuid NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  relationship text NOT NULL CHECK (relationship IN ('customer', 'operator', 'support')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (delivery_id, user_id)
);
CREATE TABLE delivery_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id uuid NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  provider_event_id text NOT NULL UNIQUE,
  event_type text NOT NULL,
  provider_status text,
  normalized_status text NOT NULL CHECK (normalized_status IN ('scheduled', 'searching_for_driver', 'driver_assigned', 'at_restaurant', 'preparing_or_waiting', 'picked_up', 'out_for_delivery', 'arrived', 'delivered', 'cancelled', 'issue', 'unknown')),
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  sanitized_payload jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  delivery_id uuid REFERENCES deliveries(id) ON DELETE SET NULL,
  outcome text NOT NULL,
  request_id text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX deliveries_tenant_status_idx ON deliveries (tenant_id, status);
CREATE INDEX delivery_events_delivery_occurred_idx ON delivery_events (delivery_id, occurred_at DESC);
CREATE INDEX audit_logs_tenant_created_idx ON audit_logs (tenant_id, created_at DESC);
CREATE INDEX doordash_integrations_tenant_status_idx ON doordash_integrations (tenant_id, status);
