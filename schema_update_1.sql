-- ============================================================
-- Actualización necesaria #1 — ejecutar UNA VEZ en el SQL Editor
-- ============================================================

-- 1) Columna que usa el sistema de alertas de WhatsApp para no
--    reenviar el mismo aviso más de una vez.
alter table processes add column if not exists wa_sent jsonb default '{}'::jsonb;

-- 2) Permisos para que los usuarios logueados puedan subir, ver
--    y borrar archivos dentro del bucket "documentos" de Storage.
--    (Sin esto, "Adjuntar archivo" fallará con error de permisos).
create policy "Autenticados leen documentos"
on storage.objects for select
to authenticated
using (bucket_id = 'documentos');

create policy "Autenticados suben documentos"
on storage.objects for insert
to authenticated
with check (bucket_id = 'documentos');

create policy "Autenticados borran documentos"
on storage.objects for delete
to authenticated
using (bucket_id = 'documentos');
