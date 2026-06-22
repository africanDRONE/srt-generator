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
