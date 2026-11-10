-- SYNC social layer for Supabase
-- Run the entire script in Supabase Dashboard -> SQL Editor -> New query.
-- This script uses the authenticated user's session and never needs service_role in the browser.

-- 1) Profiles: one public username per Supabase Auth account.
create table if not exists public.sync_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique check (username ~ '^[a-z0-9_]{3,20}$'),
  display_name text not null check (char_length(display_name) between 2 and 24),
  created_at timestamptz not null default now()
);

create or replace function public.sync_create_profile_for_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  chosen_username text;
  chosen_name text;
begin
  chosen_username := lower(coalesce(new.raw_user_meta_data ->> 'username', 'user_' || substr(new.id::text, 1, 8)));
  chosen_name := coalesce(nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''), 'Новый пользователь');
  if chosen_username !~ '^[a-z0-9_]{3,20}$' then
    chosen_username := 'user_' || substr(new.id::text, 1, 8);
  end if;
  insert into public.sync_profiles (id, username, display_name)
  values (new.id, chosen_username, left(chosen_name, 24))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists sync_auth_user_profile on auth.users;
create trigger sync_auth_user_profile
after insert on auth.users
for each row execute procedure public.sync_create_profile_for_user();

-- 2) Friend requests. An accepted row represents a friendship in both directions.
create table if not exists public.sync_friend_requests (
  id uuid primary key default gen_random_uuid(),
  from_user uuid not null references public.sync_profiles(id) on delete cascade,
  to_user uuid not null references public.sync_profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted')),
  created_at timestamptz not null default now(),
  constraint sync_friend_requests_not_self check (from_user <> to_user),
  constraint sync_friend_requests_unique_pair unique (from_user, to_user)
);
create index if not exists sync_friend_requests_to_status_idx on public.sync_friend_requests (to_user, status);
create index if not exists sync_friend_requests_from_status_idx on public.sync_friend_requests (from_user, status);

create or replace function public.send_friend_request(p_username text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  caller_id uuid := auth.uid();
  target_id uuid;
  existing_row public.sync_friend_requests%rowtype;
begin
  if caller_id is null then raise exception 'Нужно войти в аккаунт'; end if;
  select id into target_id from public.sync_profiles where username = lower(trim(p_username));
  if target_id is null then raise exception 'Пользователь с таким ником не найден'; end if;
  if target_id = caller_id then raise exception 'Нельзя добавить самого себя'; end if;

  select * into existing_row
  from public.sync_friend_requests
  where (from_user = caller_id and to_user = target_id)
     or (from_user = target_id and to_user = caller_id)
  limit 1;

  if found then
    if existing_row.status = 'accepted' then return 'already_friends'; end if;
    -- If the other person already requested you, accept their request automatically.
    if existing_row.from_user = target_id then
      update public.sync_friend_requests set status = 'accepted' where id = existing_row.id;
      return 'accepted';
    end if;
    return 'pending';
  end if;

  insert into public.sync_friend_requests (from_user, to_user, status)
  values (caller_id, target_id, 'pending');
  return 'sent';
end;
$$;

-- 3) Rooms: room IDs are database identifiers; the invite token is the secret in the shared URL.
create table if not exists public.sync_rooms (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.sync_profiles(id) on delete cascade,
  invite_token text not null unique default replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
  created_at timestamptz not null default now()
);

create table if not exists public.sync_room_members (
  room_id uuid not null references public.sync_rooms(id) on delete cascade,
  user_id uuid not null references public.sync_profiles(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  primary key (room_id, user_id)
);
create index if not exists sync_room_members_user_idx on public.sync_room_members (user_id);

create or replace function public.create_sync_room()
returns table(room_id uuid, invite_token text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  caller_id uuid := auth.uid();
  created_room public.sync_rooms%rowtype;
begin
  if caller_id is null then raise exception 'Нужно войти в аккаунт'; end if;
  insert into public.sync_rooms (owner_id) values (caller_id) returning * into created_room;
  insert into public.sync_room_members (room_id, user_id, role)
  values (created_room.id, caller_id, 'owner');
  return query select created_room.id, created_room.invite_token;
end;
$$;

create or replace function public.join_sync_room(p_room_id uuid, p_invite_token text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  caller_id uuid := auth.uid();
begin
  if caller_id is null then raise exception 'Нужно войти в аккаунт'; end if;
  if not exists (
    select 1 from public.sync_rooms r
    where r.id = p_room_id and r.invite_token = p_invite_token
  ) then
    raise exception 'Ссылка-приглашение недействительна';
  end if;
  insert into public.sync_room_members (room_id, user_id, role)
  select p_room_id, caller_id,
    case when r.owner_id = caller_id then 'owner' else 'member' end
  from public.sync_rooms r where r.id = p_room_id
  on conflict (room_id, user_id) do nothing;
  return true;
end;
$$;

-- 4) Row Level Security.
alter table public.sync_profiles enable row level security;
alter table public.sync_friend_requests enable row level security;
alter table public.sync_rooms enable row level security;
alter table public.sync_room_members enable row level security;

drop policy if exists "Signed-in users can find profiles" on public.sync_profiles;
create policy "Signed-in users can find profiles"
on public.sync_profiles for select to authenticated using (true);

drop policy if exists "Users can update their own profile" on public.sync_profiles;
create policy "Users can update their own profile"
on public.sync_profiles for update to authenticated
using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists "Users can view their friend requests" on public.sync_friend_requests;
create policy "Users can view their friend requests"
on public.sync_friend_requests for select to authenticated
using (from_user = auth.uid() or to_user = auth.uid());

drop policy if exists "Recipients can accept friend requests" on public.sync_friend_requests;
create policy "Recipients can accept friend requests"
on public.sync_friend_requests for update to authenticated
using (to_user = auth.uid() and status = 'pending')
with check (to_user = auth.uid() and status = 'accepted');

drop policy if exists "Either friend can remove friendship" on public.sync_friend_requests;
create policy "Either friend can remove friendship"
on public.sync_friend_requests for delete to authenticated
using (from_user = auth.uid() or to_user = auth.uid());

drop policy if exists "Room members can view their rooms" on public.sync_rooms;
create policy "Room members can view their rooms"
on public.sync_rooms for select to authenticated
using (
  owner_id = auth.uid()
  or exists (
    select 1 from public.sync_room_members rm
    where rm.room_id = sync_rooms.id and rm.user_id = auth.uid()
  )
);

drop policy if exists "Users can view their own room membership" on public.sync_room_members;
create policy "Users can view their own room membership"
on public.sync_room_members for select to authenticated
using (user_id = auth.uid());

drop policy if exists "Users can leave their own room" on public.sync_room_members;
create policy "Users can leave their own room"
on public.sync_room_members for delete to authenticated
using (user_id = auth.uid());

-- No direct INSERT policies for rooms/members/friend requests: SECURITY DEFINER RPCs validate actions.
grant usage on schema public to authenticated;
revoke all on function public.sync_create_profile_for_user() from public, anon;
revoke all on function public.send_friend_request(text) from public, anon;
revoke all on function public.create_sync_room() from public, anon;
revoke all on function public.join_sync_room(uuid, text) from public, anon;
grant select, update on public.sync_profiles to authenticated;
grant select, delete on public.sync_friend_requests to authenticated;
grant update (status) on public.sync_friend_requests to authenticated;
grant select on public.sync_rooms to authenticated;
grant select, delete on public.sync_room_members to authenticated;
grant execute on function public.send_friend_request(text) to authenticated;
grant execute on function public.create_sync_room() to authenticated;
grant execute on function public.join_sync_room(uuid, text) to authenticated;

-- Realtime presence and broadcast are used for online indicators, room members and the temporary room chat.
-- There is no persistent message table in this starter version.


-- 5) Private Realtime authorization.
-- The browser creates private channels. The room topic is accessible only to members
-- recorded by join_sync_room(); the global online topic is limited to authenticated users.
-- Do NOT ALTER realtime.messages: Supabase owns that table and already has RLS enabled.
drop policy if exists "SYNC room members can receive private room events" on realtime.messages;
create policy "SYNC room members can receive private room events"
on realtime.messages for select to authenticated
using (
  extension in ('broadcast', 'presence')
  and exists (
    select 1 from public.sync_room_members rm
    where rm.user_id = auth.uid()
      and realtime.topic() = 'sync-room:' || rm.room_id::text
  )
);

drop policy if exists "SYNC room members can send private room events" on realtime.messages;
create policy "SYNC room members can send private room events"
on realtime.messages for insert to authenticated
with check (
  extension in ('broadcast', 'presence')
  and exists (
    select 1 from public.sync_room_members rm
    where rm.user_id = auth.uid()
      and realtime.topic() = 'sync-room:' || rm.room_id::text
  )
);

drop policy if exists "SYNC signed-in users can receive online presence" on realtime.messages;
create policy "SYNC signed-in users can receive online presence"
on realtime.messages for select to authenticated
using (extension = 'presence' and realtime.topic() = 'sync-online-presence');

drop policy if exists "SYNC signed-in users can publish online presence" on realtime.messages;
create policy "SYNC signed-in users can publish online presence"
on realtime.messages for insert to authenticated
with check (extension = 'presence' and realtime.topic() = 'sync-online-presence');
