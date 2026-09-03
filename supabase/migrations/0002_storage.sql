-- Private storage bucket for uploaded game footage, plus RLS-style storage
-- policies. Objects are stored under `${auth.uid()}/${analysisId}/${filename}`
-- so a single policy can scope access by the first path segment.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'videos',
  'videos',
  false, -- private bucket; access only via signed URLs or authenticated requests
  2147483648, -- 2 GiB hard cap enforced by Storage itself; app-level validation is stricter
  array['video/mp4', 'video/quicktime', 'video/webm', 'video/x-msvideo', 'video/x-matroska']
)
on conflict (id) do update set
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "videos_storage_select_own" on storage.objects;
create policy "videos_storage_select_own" on storage.objects
  for select using (
    bucket_id = 'videos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "videos_storage_insert_own" on storage.objects;
create policy "videos_storage_insert_own" on storage.objects
  for insert with check (
    bucket_id = 'videos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "videos_storage_update_own" on storage.objects;
create policy "videos_storage_update_own" on storage.objects
  for update using (
    bucket_id = 'videos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "videos_storage_delete_own" on storage.objects;
create policy "videos_storage_delete_own" on storage.objects
  for delete using (
    bucket_id = 'videos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
