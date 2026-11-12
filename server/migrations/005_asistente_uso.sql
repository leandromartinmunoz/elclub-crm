-- Consumo de Claude por respuesta (tokens), para controlar el costo del asistente.
ALTER TABLE assistant_messages ADD COLUMN usage jsonb;
