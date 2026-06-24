-- SubCaptions accounts schema. Run once in the Supabase SQL editor.
-- One profile row per auth user, holding the subscription tier.

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  tier text not null default 'free',          -- 'free' | 'solo' | 'team'
  stripe_customer_id text,
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- A signed-in user can read their own profile (to show their tier in the app).
drop policy if exists "read own profile" on public.profiles;
create policy "read own profile" on public.profiles
  for select using (auth.uid() = id);

-- Writes happen only from the billing service using the service-role key,
-- which bypasses RLS. The client never writes tier directly.

-- Auto-create a profile whenever a new auth user signs up.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ===========================================================================
-- Cloud-saved caption projects (cross-device) + translator share links.
-- Run this block once in the Supabase SQL editor (it's idempotent).
-- ===========================================================================

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references auth.users(id) on delete cascade,
  source_key text not null,            -- stable per-source key (yt_/h5_/r2_/fio_...)
  source_url text,                     -- the pasted link (or r2://key)
  title text,
  thumb text,                          -- small thumbnail (for the resume list, avoids shipping full data)
  caption_count int not null default 0,
  data jsonb not null,                 -- { c: captions, t: translations, th: thumb, lang, ... }
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create unique index if not exists projects_owner_key on public.projects(owner, source_key);
create index if not exists projects_owner_updated on public.projects(owner, updated_at desc);

alter table public.projects enable row level security;
drop policy if exists "own projects" on public.projects;
create policy "own projects" on public.projects
  for all using (auth.uid() = owner) with check (auth.uid() = owner);
-- (The app server uses the service-role key and scopes every query by owner;
--  this policy is defense-in-depth for any direct client access.)

-- Scoped share links so a translator can work on ONE project without an account.
create table if not exists public.share_links (
  token text primary key,              -- random, unguessable
  project_id uuid not null references public.projects(id) on delete cascade,
  can_edit boolean not null default true,
  label text,
  created_at timestamptz not null default now(),
  expires_at timestamptz
);
create index if not exists share_links_project on public.share_links(project_id);
alter table public.share_links enable row level security;
-- No client policy: only the service-role app server reads/writes share_links.
