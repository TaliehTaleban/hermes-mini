-- Migration: 0004_fencing_and_idempotency.sql
-- Description: Add fencing token and version to processed_updates, telegram_update_id to tasks, and staging/version state to user_displayed_lists

-- 1. Idempotency for tasks table
ALTER TABLE tasks ADD COLUMN telegram_update_id TEXT;
CREATE INDEX IF NOT EXISTS idx_tasks_user_update ON tasks(telegram_user_id, telegram_update_id);

-- 2. Fencing token & versioning for processed_updates
ALTER TABLE processed_updates ADD COLUMN lock_token TEXT;
ALTER TABLE processed_updates ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE processed_updates ADD COLUMN response_text TEXT;

-- 3. Staging and active lifecycle for user_displayed_lists
ALTER TABLE user_displayed_lists ADD COLUMN pending_ids_json TEXT;
ALTER TABLE user_displayed_lists ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE user_displayed_lists ADD COLUMN list_version INTEGER NOT NULL DEFAULT 1;
