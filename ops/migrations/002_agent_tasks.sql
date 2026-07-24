create table if not exists agent_tasks (
  work_item_id text not null,
  task_version integer not null check (task_version > 0),
  correlation_id text not null,
  lifecycle text not null,
  executor_kind text not null,
  approved_task_hash text,
  deadline timestamptz not null,
  updated_at timestamptz not null,
  task jsonb not null,
  primary key (work_item_id, task_version)
);

create index if not exists agent_tasks_lifecycle_idx
  on agent_tasks(lifecycle);

create index if not exists agent_tasks_correlation_id_idx
  on agent_tasks(correlation_id);
