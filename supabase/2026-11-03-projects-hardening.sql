-- Run this in the Supabase SQL editor BEFORE deploying the billing server that writes projects.bytes.
alter table public.projects add column if not exists bytes int not null default 0;
drop policy if exists "own projects" on public.projects;
create policy "own projects" on public.projects
  for select using (auth.uid() = owner);
-- Give rows saved before the size column a size, so the storage cap counts them. Postgres
-- prints jsonb with a space after each colon and comma, so this slightly overcounts until
-- the project is next saved, when the server writes its exact size.
update public.projects set bytes = octet_length(data::text) where bytes = 0;
