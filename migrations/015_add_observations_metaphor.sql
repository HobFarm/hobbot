-- Migration 015: Add metaphor_family column to observations
ALTER TABLE observations ADD COLUMN metaphor_family TEXT;
