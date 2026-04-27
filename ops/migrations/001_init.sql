create table if not exists runs (
  id uuid primary key default gen_random_uuid(),
  hermes_run_id text unique,
  identity_id text,
  task text not null,
  mode text not null default 'mixed',
  state text not null default 'created',
  started_at timestamptz default now(),
  finished_at timestamptz,
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists tool_calls (
  id uuid primary key default gen_random_uuid(),
  run_id uuid references runs(id) on delete cascade,
  idx integer,
  mcp_server text,
  tool_name text not null,
  input jsonb not null default '{}'::jsonb,
  output jsonb not null default '{}'::jsonb,
  started_at timestamptz default now(),
  finished_at timestamptz
);

create table if not exists submissions (
  id uuid primary key default gen_random_uuid(),
  run_id uuid references runs(id) on delete set null,
  kind text not null check (kind in ('claim', 'submit')),
  idempotency_key text unique not null,
  request jsonb not null default '{}'::jsonb,
  response jsonb not null default '{}'::jsonb,
  status text not null default 'created',
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists receipts (
  id uuid primary key default gen_random_uuid(),
  run_id uuid unique references runs(id) on delete cascade,
  payload jsonb not null,
  signature text not null,
  signed_at timestamptz default now()
);

create table if not exists skills_observed (
  id uuid primary key default gen_random_uuid(),
  file_path text not null,
  sha256 text not null,
  content text not null,
  written_at timestamptz,
  ingested_at timestamptz default now(),
  hermes_run_id_origin text,
  unique(file_path, sha256)
);

create table if not exists budgets (
  date date primary key,
  usd_spent numeric not null default 0
);

create table if not exists approvals (
  id uuid primary key default gen_random_uuid(),
  run_id uuid references runs(id) on delete set null,
  kind text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'expired')),
  reason text,
  request jsonb not null default '{}'::jsonb,
  response jsonb not null default '{}'::jsonb,
  created_at timestamptz default now(),
  decided_at timestamptz
);

create table if not exists kill_switches (
  name text primary key,
  active boolean not null default false,
  reason text,
  set_at timestamptz default now()
);

create table if not exists auth_sessions (
  wallet text primary key,
  jwt text not null,
  expires_at timestamptz
);

create index if not exists tool_calls_run_idx on tool_calls(run_id, idx);
create index if not exists skills_observed_file_idx on skills_observed(file_path);
