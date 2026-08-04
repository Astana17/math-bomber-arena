create table if not exists public.beta_leaderboard (
  player_id uuid primary key references public.beta_players(id) on delete cascade,
  display_name text not null,
  total_score integer not null default 0,
  games_played integer not null default 0,
  wins integer not null default 0,
  math_solved integer not null default 0,
  best_score integer not null default 0,
  updated_at timestamptz not null default now()
);

create index if not exists beta_leaderboard_rank_idx
  on public.beta_leaderboard(total_score desc, wins desc, games_played asc);

alter table public.beta_leaderboard enable row level security;

-- Backend-only access through SUPABASE_SERVICE_ROLE_KEY. Do not expose this table
-- directly to the frontend until public RLS policies are intentionally designed.
