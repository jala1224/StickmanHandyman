CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS accounts (
  id BIGSERIAL PRIMARY KEY,
  account_key UUID NOT NULL DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  address TEXT NOT NULL,
  name_normalized TEXT NOT NULL,
  address_normalized TEXT NOT NULL,
  lookup_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  stripe_customer_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_key),
  UNIQUE (lookup_hash)
);

CREATE INDEX IF NOT EXISTS idx_accounts_lookup_hash ON accounts (lookup_hash);

CREATE TABLE IF NOT EXISTS invoices (
  id BIGSERIAL PRIMARY KEY,
  account_id BIGINT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  invoice_number TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  currency CHAR(3) NOT NULL DEFAULT 'usd',
  status TEXT NOT NULL DEFAULT 'draft',
  due_date DATE,
  stripe_payment_intent_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (invoice_number)
);

CREATE INDEX IF NOT EXISTS idx_invoices_account_id ON invoices (account_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices (status);

CREATE TABLE IF NOT EXISTS contracts (
  id BIGSERIAL PRIMARY KEY,
  account_id BIGINT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  contract_number TEXT NOT NULL,
  title TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  billing_cycle TEXT NOT NULL DEFAULT 'monthly',
  start_date DATE,
  package_type TEXT CHECK (package_type IS NULL OR package_type IN ('single_home', 'portfolio', 'custom')),
  package_level TEXT CHECK (package_level IS NULL OR package_level IN ('basic', 'pro', 'premium')),
  package_monthly_cost_cents INTEGER CHECK (package_monthly_cost_cents IS NULL OR package_monthly_cost_cents >= 0),
  package_retainer_hours NUMERIC(7,2) CHECK (package_retainer_hours IS NULL OR package_retainer_hours >= 0),
  package_rollover_hours NUMERIC(7,2) CHECK (package_rollover_hours IS NULL OR package_rollover_hours >= 0),
  package_discount_percent NUMERIC(5,2) CHECK (package_discount_percent IS NULL OR package_discount_percent BETWEEN 0 AND 100),
  package_priority_scheduling BOOLEAN NOT NULL DEFAULT FALSE,
  package_annual_inspection BOOLEAN NOT NULL DEFAULT FALSE,
  package_quarterly_inspection BOOLEAN NOT NULL DEFAULT FALSE,
  package_on_call_service BOOLEAN NOT NULL DEFAULT FALSE,
  package_tenant_coordination BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (contract_number)
);

ALTER TABLE contracts ADD COLUMN IF NOT EXISTS package_type TEXT;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS package_level TEXT;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS package_monthly_cost_cents INTEGER;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS package_retainer_hours NUMERIC(7,2);
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS package_rollover_hours NUMERIC(7,2);
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS package_discount_percent NUMERIC(5,2);
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS package_priority_scheduling BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS package_annual_inspection BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS package_quarterly_inspection BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS package_on_call_service BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS package_tenant_coordination BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE contracts DROP CONSTRAINT IF EXISTS contracts_package_type_check;
ALTER TABLE contracts ADD CONSTRAINT contracts_package_type_check
  CHECK (package_type IS NULL OR package_type IN ('single_home', 'portfolio', 'custom'));

CREATE INDEX IF NOT EXISTS idx_contracts_account_id ON contracts (account_id);
CREATE INDEX IF NOT EXISTS idx_contracts_status ON contracts (status);

ALTER TABLE contracts ALTER COLUMN title DROP NOT NULL;

CREATE TABLE IF NOT EXISTS admin_users (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  id BIGSERIAL PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  admin_user_id BIGINT NOT NULL REFERENCES admin_users (id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_admin_user_id ON admin_sessions (admin_user_id);

CREATE TABLE IF NOT EXISTS client_users (
  id BIGSERIAL PRIMARY KEY,
  account_id BIGINT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  notifications_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  autopay_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  email_verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id)
);

CREATE INDEX IF NOT EXISTS idx_client_users_account_id ON client_users (account_id);

CREATE TABLE IF NOT EXISTS client_sessions (
  id BIGSERIAL PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  client_user_id BIGINT NOT NULL REFERENCES client_users (id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_client_sessions_client_user_id ON client_sessions (client_user_id);

CREATE TABLE IF NOT EXISTS audit_events (
  id BIGSERIAL PRIMARY KEY,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_events_created_at ON audit_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_entity ON audit_events (entity_type, entity_id);