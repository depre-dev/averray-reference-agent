create table if not exists harness_dispatch_policy_drift (
  work_item_id text not null,
  task_version integer not null check (task_version > 0),
  active boolean not null,
  approved_policy_version text not null,
  approved_policy_hash text not null,
  active_policy_version text not null,
  active_policy_hash text not null,
  changed_at timestamptz not null,
  alert_pending boolean not null default false,
  primary key (work_item_id, task_version)
);

create index if not exists harness_dispatch_policy_drift_active_idx
  on harness_dispatch_policy_drift(active)
  where active = true;
