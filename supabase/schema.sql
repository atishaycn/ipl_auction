create table if not exists public.rooms (
  room_id text primary key,
  invite_code text not null,
  admin_key text not null,
  admin_name text not null,
  state jsonb not null,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists rooms_invite_code_key on public.rooms (invite_code);
create index if not exists rooms_admin_key_idx on public.rooms (admin_key);
create index if not exists rooms_updated_at_idx on public.rooms (updated_at desc);

