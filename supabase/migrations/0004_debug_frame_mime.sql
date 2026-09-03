-- Debug-overlay frame JPEGs (uploaded by pipeline-v2.ts's persistVisionResult)
-- go into the same 'videos' bucket, under <user>/<analysisId>/debug/, as the
-- source video files. But the bucket's original MIME allow-list (see
-- 0002_storage.sql) only included video types — so every debug-frame upload
-- was silently rejected by Storage's own server-side MIME check, and the
-- debug page always reported "no debug frames were persisted" even on a
-- fully successful pipeline run. Add image/jpeg so debug frames can upload.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'videos',
  'videos',
  false,
  2147483648,
  array['video/mp4', 'video/quicktime', 'video/webm', 'video/x-msvideo', 'video/x-matroska', 'image/jpeg']
)
on conflict (id) do update set
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
