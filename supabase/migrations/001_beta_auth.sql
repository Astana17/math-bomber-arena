create extension if not exists pgcrypto;

create table if not exists public.beta_players (
  id uuid primary key default gen_random_uuid(),
  display_name text not null,
  normalized_name text not null unique,
  pin_salt text not null,
  pin_hash text not null,
  created_at timestamptz not null default now(),
  last_login_at timestamptz
);

create table if not exists public.beta_sessions (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references public.beta_players(id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);

create index if not exists beta_sessions_player_id_idx on public.beta_sessions(player_id);
create index if not exists beta_sessions_expires_at_idx on public.beta_sessions(expires_at);

alter table public.beta_players enable row level security;
alter table public.beta_sessions enable row level security;

-- The Node backend should use SUPABASE_SERVICE_ROLE_KEY for beta auth operations.
-- Do not expose service role keys to Netlify/frontend code.
