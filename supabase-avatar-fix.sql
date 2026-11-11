-- SYNC: add avatar support to an existing project.
-- Run this in Supabase Dashboard -> SQL Editor -> New query.

alter table public.sync_profiles
  add column if not exists avatar_url text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('sync-avatars', 'sync-avatars', true, 3145728, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "SYNC avatars are publicly readable" on storage.objects;
create policy "SYNC avatars are publicly readable"
on storage.objects for select
using (bucket_id = 'sync-avatars');

drop policy if exists "Users upload their own SYNC avatar" on storage.objects;
create policy "Users upload their own SYNC avatar"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'sync-avatars'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "Users update their own SYNC avatar" on storage.objects;
create policy "Users update their own SYNC avatar"
on storage.objects for update to authenticated
using (
  bucket_id = 'sync-avatars'
  and (storage.foldername(name))[1] = auth.uid()::text
)
with check (
  bucket_id = 'sync-avatars'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "Users delete their own SYNC avatar" on storage.objects;
create policy "Users delete their own SYNC avatar"
on storage.objects for delete to authenticated
using (
  bucket_id = 'sync-avatars'
  and (storage.foldername(name))[1] = auth.uid()::text
);
