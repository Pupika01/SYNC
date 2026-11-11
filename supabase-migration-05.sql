-- SYNC migration 0.5 (combined upgrade)
-- Includes all 0.4 avatar + room-state setup, then 0.5 one-name social changes.
-- Safe to run if migration 0.4 was already applied: objects are guarded or recreated intentionally.

-- SYNC migration 0.4: profile avatars + persistent room media state + Google profile metadata.
-- Run this once in Supabase Dashboard -> SQL Editor -> New query.

-- 1) Profile picture URL.
alter table public.sync_profiles
  add column if not exists avatar_url text;

-- Update the existing auth trigger so Google metadata (name/picture) is used for new accounts.
create or replace function public.sync_create_profile_for_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  chosen_username text;
  chosen_name text;
  chosen_avatar text;
begin
  chosen_username := lower(coalesce(new.raw_user_meta_data ->> 'username', 'user_' || substr(new.id::text, 1, 8)));
  chosen_name := coalesce(
    nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''),
    nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
    nullif(trim(new.raw_user_meta_data ->> 'name'), ''),
    'Новый пользователь'
  );
  chosen_avatar := coalesce(
    nullif(new.raw_user_meta_data ->> 'avatar_url', ''),
    nullif(new.raw_user_meta_data ->> 'picture', '')
  );
  if chosen_username !~ '^[a-z0-9_]{3,20}$' then
    chosen_username := 'user_' || substr(new.id::text, 1, 8);
  end if;
  insert into public.sync_profiles (id, username, display_name, avatar_url)
  values (new.id, chosen_username, left(chosen_name, 24), chosen_avatar)
  on conflict (id) do update
    set avatar_url = coalesce(public.sync_profiles.avatar_url, excluded.avatar_url),
        display_name = case
          when public.sync_profiles.display_name = 'Новый пользователь' then excluded.display_name
          else public.sync_profiles.display_name
        end;
  return new;
end;
$$;

-- Backfill existing accounts from Supabase Auth metadata (for users created before this migration).
update public.sync_profiles as profile
set avatar_url = coalesce(profile.avatar_url, nullif(auth_user.raw_user_meta_data ->> 'avatar_url', ''), nullif(auth_user.raw_user_meta_data ->> 'picture', '')),
    display_name = case
      when profile.display_name = 'Новый пользователь' then left(coalesce(
        nullif(trim(auth_user.raw_user_meta_data ->> 'display_name'), ''),
        nullif(trim(auth_user.raw_user_meta_data ->> 'full_name'), ''),
        nullif(trim(auth_user.raw_user_meta_data ->> 'name'), ''),
        profile.display_name
      ), 24)
      else profile.display_name
    end
from auth.users as auth_user
where auth_user.id = profile.id;

-- 2) Persist the selected video so someone who joins later sees the same title and position.
create table if not exists public.sync_room_state (
  room_id uuid primary key references public.sync_rooms(id) on delete cascade,
  current_video jsonb,
  updated_by uuid references public.sync_profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table public.sync_room_state enable row level security;
drop policy if exists "SYNC room members can read room state" on public.sync_room_state;
create policy "SYNC room members can read room state"
on public.sync_room_state for select to authenticated
using (exists (
  select 1 from public.sync_room_members rm
  where rm.room_id = sync_room_state.room_id and rm.user_id = auth.uid()
));

drop policy if exists "SYNC room members can create room state" on public.sync_room_state;
create policy "SYNC room members can create room state"
on public.sync_room_state for insert to authenticated
with check (exists (
  select 1 from public.sync_room_members rm
  where rm.room_id = sync_room_state.room_id and rm.user_id = auth.uid()
));

drop policy if exists "SYNC room members can update room state" on public.sync_room_state;
create policy "SYNC room members can update room state"
on public.sync_room_state for update to authenticated
using (exists (
  select 1 from public.sync_room_members rm
  where rm.room_id = sync_room_state.room_id and rm.user_id = auth.uid()
))
with check (exists (
  select 1 from public.sync_room_members rm
  where rm.room_id = sync_room_state.room_id and rm.user_id = auth.uid()
));

grant select, insert, update on public.sync_room_state to authenticated;

-- 3) Public avatar bucket. Each user can upload/update/delete only files inside their own UUID folder.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('sync-avatars', 'sync-avatars', true, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update
set public = true,
    file_size_limit = 5242880,
    allowed_mime_types = array['image/jpeg','image/png','image/webp'];

drop policy if exists "SYNC avatars are publicly readable" on storage.objects;
create policy "SYNC avatars are publicly readable"
on storage.objects for select to public
using (bucket_id = 'sync-avatars');

drop policy if exists "Users can upload their own SYNC avatar" on storage.objects;
create policy "Users can upload their own SYNC avatar"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'sync-avatars'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "Users can update their own SYNC avatar" on storage.objects;
create policy "Users can update their own SYNC avatar"
on storage.objects for update to authenticated
using (
  bucket_id = 'sync-avatars'
  and (storage.foldername(name))[1] = auth.uid()::text
)
with check (
  bucket_id = 'sync-avatars'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "Users can delete their own SYNC avatar" on storage.objects;
create policy "Users can delete their own SYNC avatar"
on storage.objects for delete to authenticated
using (
  bucket_id = 'sync-avatars'
  and (storage.foldername(name))[1] = auth.uid()::text
);

-- SYNC migration 0.5
-- Adds friend requests by profile ID, so the UI only needs one public name field.
-- Keeps existing username column and old RPC for compatibility.

create or replace function public.send_friend_request_by_id(p_target_id uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  caller_id uuid := auth.uid();
  target_id uuid := p_target_id;
  existing_row public.sync_friend_requests%rowtype;
begin
  if caller_id is null then raise exception 'Нужно войти в аккаунт'; end if;
  if target_id is null then raise exception 'Не выбран пользователь'; end if;
  if not exists (select 1 from public.sync_profiles where id = target_id) then
    raise exception 'Пользователь не найден';
  end if;
  if target_id = caller_id then raise exception 'Нельзя добавить самого себя'; end if;

  select * into existing_row
  from public.sync_friend_requests
  where (from_user = caller_id and to_user = target_id)
     or (from_user = target_id and to_user = caller_id)
  limit 1;

  if found then
    if existing_row.status = 'accepted' then return 'already_friends'; end if;
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

revoke all on function public.send_friend_request_by_id(uuid) from public, anon;
grant execute on function public.send_friend_request_by_id(uuid) to authenticated;

-- Improve low-resolution Google profile pictures already stored in profiles.
update public.sync_profiles
set avatar_url = regexp_replace(avatar_url, '=s[0-9]+-c$', '=s512-c')
where avatar_url ~ '=s[0-9]+-c$';
