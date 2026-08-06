alter table agent_task_dispatch_claims
  add column if not exists claim_holder text,
  add column if not exists claim_generation integer not null default 1
    check (claim_generation > 0);

update agent_task_dispatch_claims
set claim_holder = coalesce(claim_holder, 'pre-int4c-migration'),
    lease_expires_at = coalesce(lease_expires_at, now())
where claim_state in ('claimed', 'submitted')
  and (claim_holder is null or lease_expires_at is null);

create index if not exists agent_task_dispatch_claims_expiry_idx
  on agent_task_dispatch_claims(lease_expires_at)
  where claim_state in ('claimed', 'submitted');

create table if not exists harness_dispatch_backpressure (
  state_id text primary key default 'global',
  active boolean not null,
  observed_inflight integer not null check (observed_inflight >= 0),
  max_inflight integer not null check (max_inflight > 0),
  changed_at timestamptz not null
);
