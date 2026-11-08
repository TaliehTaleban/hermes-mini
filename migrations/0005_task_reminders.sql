-- Migration: 0005_task_reminders.sql
-- Description: Add reminder tracking, atomic leasing, retry backoff, and index to tasks

ALTER TABLE tasks ADD COLUMN reminder_sent INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN reminder_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE tasks ADD COLUMN reminder_token TEXT;
ALTER TABLE tasks ADD COLUMN reminder_claimed_at INTEGER;
ALTER TABLE tasks ADD COLUMN reminder_retry_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN reminder_retry_after INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN reminded_at TEXT;

CREATE INDEX IF NOT EXISTS idx_tasks_reminders_active 
ON tasks (reminder_sent, is_completed, reminder_status, due_date);
