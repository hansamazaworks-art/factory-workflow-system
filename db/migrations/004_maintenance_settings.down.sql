-- Rollback of 004. The KPI Dashboard falls back to its built-in targets
-- (4 / 24 / 72 / 168 hours) when this table is missing.
DROP TABLE IF EXISTS maintenance_settings;
