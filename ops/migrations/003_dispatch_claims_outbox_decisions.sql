create table if not exists dispatch_lease (
  lease_id text primary key default 'global',
  holder text not null,
  acquired_at timestamptz not null,
  expires_at timestamptz not null
);

create table if not exists agent_task_dispatch_claims (
  work_item_id text not null,
  task_version integer not null check (task_version > 0),
  approved_task_hash text not null,
  intended_run_id uuid not null,
  claim_state text not null,
  claimed_at timestamptz not null,
  lease_expires_at timestamptz,
  primary key (work_item_id, task_version)
);

create table if not exists agent_task_run_outbox (
  work_item_id text primary key,
  harness_run_id uuid not null,
  run_manifest_ref jsonb,
  run_manifest_hash text,
  bound_at timestamptz not null
);

create table if not exists hermes_decision_records (
  decision_id text primary key,
  correlation_id text not null,
  work_item_id text,
  decision_type text not null,
  generated_at timestamptz not null,
  record jsonb not null
);

create index if not exists hermes_decision_records_correlation_id_idx
  on hermes_decision_records(correlation_id);

create index if not exists hermes_decision_records_work_item_id_idx
  on hermes_decision_records(work_item_id);
