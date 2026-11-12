-- Rol "asistente": solo puede usar la sección Asistente (sin bandeja, equipo ni conexiones).
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'vendedor', 'recepcion', 'asistente'));
