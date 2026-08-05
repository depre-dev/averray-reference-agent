create table if not exists runs (
  run_id text primary key,
  outcome text,
  state text not null,
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp
);

create table if not exists domain_events (
  seq bigint generated always as identity primary key,
  run_id text not null,
  ts timestamptz not null
);
