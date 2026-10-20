CREATE TABLE users (
  id         bigserial PRIMARY KEY,
  phone      text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Only a SHA-256 of the session token is stored; the raw token lives in the cookie.
CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id    bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE otp_codes (
  id          bigserial PRIMARY KEY,
  phone       text NOT NULL,
  code_hash   text NOT NULL,
  attempts    int NOT NULL DEFAULT 0,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX otp_codes_phone_idx ON otp_codes (phone, created_at DESC);

CREATE TYPE portrait_status AS ENUM ('queued', 'running', 'succeeded', 'failed');

-- A portrait row is also its own job: the queue columns live next to the data.
CREATE TABLE portraits (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name             text NOT NULL,
  style            text NOT NULL,
  photo_key        text NOT NULL,
  result_key       text,
  status           portrait_status NOT NULL DEFAULT 'queued',
  attempts         int NOT NULL DEFAULT 0,
  max_attempts     int NOT NULL,
  run_after        timestamptz NOT NULL DEFAULT now(),
  lease_token      uuid,
  lease_expires_at timestamptz,
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  CONSTRAINT lease_only_when_running CHECK ((status = 'running') = (lease_token IS NOT NULL))
);
CREATE INDEX portraits_claimable_idx ON portraits (run_after, created_at) WHERE status = 'queued';
CREATE INDEX portraits_running_idx ON portraits (lease_expires_at) WHERE status = 'running';
CREATE INDEX portraits_user_idx ON portraits (user_id, created_at DESC);
