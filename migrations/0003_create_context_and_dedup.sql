-- Migration: 0003_create_context_and_dedup.sql
-- Description: Create tables for atomic update deduplication and displayed task list persistence

CREATE TABLE IF NOT EXISTS processed_updates (
    update_id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'processing', -- 'processing', 'completed', 'failed'
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_displayed_lists (
    telegram_user_id TEXT PRIMARY KEY,
    task_ids_json TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
