create table if not exists agent_task_dispatch_quarantines (
  work_item_id text not null,
  task_version integer not null check (task_version > 0),
  reason text not null,
  fingerprint text not null,
  cycle_count integer not null check (cycle_count > 0),
  quarantined_at timestamptz not null,
  cleared_at timestamptz,
  cleared_by text,
  primary key (work_item_id, task_version)
);

create index if not exists agent_task_dispatch_quarantines_active_idx
  on agent_task_dispatch_quarantines (quarantined_at)
  where cleared_at is null;
