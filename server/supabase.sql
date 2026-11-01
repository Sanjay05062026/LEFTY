-- Lefty's chat history in Supabase. Run this once in your project's SQL editor (Supabase dashboard > SQL Editor),
-- then turn on Authentication > Sign In / Providers > "Allow anonymous sign-ins", and put the project's URL and
-- anon key in Lefty's .env:
--   SUPABASE_URL=https://your-project.supabase.co
--   SUPABASE_ANON_KEY=your-anon-key
-- Each Lefty install signs in as its own anonymous user; row level security keeps everyone to their own chats.
-- Only the chat text is stored: never screenshots, audio or what is on screen.

create table if not exists public.lefty_chats (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text not null default 'New chat' check (char_length(title) <= 80),
  project text check (char_length(project) <= 400),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.lefty_messages (
  id bigint generated always as identity primary key,
  chat_id uuid not null references public.lefty_chats (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  role text not null check (role in ('user', 'lefty')),
  text text not null check (char_length(text) <= 8000),
  created_at timestamptz not null default now()
);

create index if not exists lefty_chats_user_updated on public.lefty_chats (user_id, updated_at desc);
create index if not exists lefty_messages_chat on public.lefty_messages (chat_id, id);

alter table public.lefty_chats enable row level security;
alter table public.lefty_messages enable row level security;

drop policy if exists "own chats" on public.lefty_chats;
create policy "own chats" on public.lefty_chats for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists "own messages" on public.lefty_messages;
create policy "own messages" on public.lefty_messages for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and exists (select 1 from public.lefty_chats c where c.id = chat_id and c.user_id = (select auth.uid())));

-- A new message moves its chat to the top of the list.
create or replace function public.lefty_touch_chat() returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.lefty_chats set updated_at = now() where id = new.chat_id;
  return new;
end $$;
drop trigger if exists lefty_touch_chat on public.lefty_messages;
create trigger lefty_touch_chat after insert on public.lefty_messages for each row execute function public.lefty_touch_chat();

-- The storage bar: how big the whole database is (what the plan's limit counts) and how much is this user's chats.
create or replace function public.lefty_usage() returns json language sql stable security definer set search_path = public as $$
  select json_build_object(
    'database', pg_database_size(current_database()),
    'mine', coalesce((select sum(pg_column_size(m.*)) from public.lefty_messages m where m.user_id = auth.uid()), 0)
          + coalesce((select sum(pg_column_size(c.*)) from public.lefty_chats c where c.user_id = auth.uid()), 0)
  );
$$;
revoke all on function public.lefty_usage() from public, anon;
grant execute on function public.lefty_usage() to authenticated;
