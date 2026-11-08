import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { handleIncomingMessage } from "../src/handler.js";
import { createTask, listTasks, getPendingConfirmation, setPendingConfirmation, clearPendingConfirmation } from "../src/db.js";

async function initDatabase(db) {
	await db.prepare(
		`CREATE TABLE IF NOT EXISTS tasks (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			telegram_user_id TEXT NOT NULL,
			title TEXT NOT NULL,
			is_completed INTEGER NOT NULL DEFAULT 0,
			due_date TEXT,
			telegram_update_id TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		)`
	).run();

	await db.prepare(
		`CREATE INDEX IF NOT EXISTS idx_tasks_user_update ON tasks(telegram_user_id, telegram_update_id)`
	).run();

	await db.prepare(
		`CREATE TABLE IF NOT EXISTS conversation_messages (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			telegram_user_id TEXT NOT NULL,
			role TEXT NOT NULL,
			content TEXT NOT NULL,
			intent TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		)`
	).run();

	await db.prepare(
		`CREATE TABLE IF NOT EXISTS user_displayed_lists (
			telegram_user_id TEXT PRIMARY KEY,
			task_ids_json TEXT NOT NULL,
			pending_ids_json TEXT,
			status TEXT NOT NULL DEFAULT 'active',
			list_version INTEGER NOT NULL DEFAULT 1,
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		)`
	).run();

	await db.prepare(
		`CREATE TABLE IF NOT EXISTS processed_updates (
			update_id TEXT PRIMARY KEY,
			status TEXT NOT NULL DEFAULT 'processing',
			lock_token TEXT,
			version INTEGER NOT NULL DEFAULT 1,
			response_text TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		)`
	).run();

	await db.prepare(
		`CREATE TABLE IF NOT EXISTS pending_confirmations (
			telegram_user_id TEXT PRIMARY KEY,
			action_type TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			expires_at INTEGER NOT NULL
		)`
	).run();
}

describe("Hermes Mini - Stage 4: Bulk Delete Security & State Management Suite", () => {
	const userId = "stage4_user_999";

	beforeEach(async () => {
		await initDatabase(env.DB);
		await env.DB.prepare("DELETE FROM tasks").run();
		await env.DB.prepare("DELETE FROM conversation_messages").run();
		await env.DB.prepare("DELETE FROM user_displayed_lists").run();
		await env.DB.prepare("DELETE FROM processed_updates").run();
		await env.DB.prepare("DELETE FROM pending_confirmations").run();
	});

	it("rejects «بله همه را حذف کن» without prior request, leaving tasks untouched", async () => {
		await createTask(env.DB, userId, { title: "تسک مهم ۱" });
		await createTask(env.DB, userId, { title: "تسک مهم ۲" });

		const res = await handleIncomingMessage(env, { userId, text: "بله همه را حذف کن" });
		expect(res.replyText).toContain("درخواستی برای حذف تمام تسک‌ها ثبت نشده است");

		const tasks = await listTasks(env.DB, userId, "all");
		expect(tasks.length).toBe(2);
	});

	it("executes bulk delete only when valid pending request exists", async () => {
		await createTask(env.DB, userId, { title: "تسک ۱" });
		await createTask(env.DB, userId, { title: "تسک ۲" });

		// Step 1: Request bulk delete
		const reqRes = await handleIncomingMessage(env, { userId, text: "همه تسک‌هام رو پاک کن" });
		expect(reqRes.replyText).toContain("آیا مطمئن هستید که می‌خواهید تمام");
		expect(reqRes.replyText).toContain("تسک خود را حذف کنید");
		expect(reqRes.replyText).toContain("مهلت تأیید: ۲ دقیقه");

		// Confirm pending confirmation exists in D1
		const pending = await getPendingConfirmation(env.DB, userId, "bulk_delete");
		expect(pending).not.toBeNull();

		// Step 2: Confirm bulk delete
		const confirmRes = await handleIncomingMessage(env, { userId, text: "بله همه را حذف کن" });
		expect(confirmRes.replyText).toContain("تمام تسک‌های شما با موفقیت حذف شدند");
		expect(confirmRes.replyText).toContain("پاک شد");

		// All tasks deleted
		const tasks = await listTasks(env.DB, userId, "all");
		expect(tasks.length).toBe(0);

		// Confirmation is consumed
		const afterPending = await getPendingConfirmation(env.DB, userId, "bulk_delete");
		expect(afterPending).toBeNull();
	});

	it("supports cancellation with «نه» and preserves tasks", async () => {
		await createTask(env.DB, userId, { title: "تسک اول" });

		// Request
		await handleIncomingMessage(env, { userId, text: "همه کارهام رو حذف کن" });

		// Cancel
		const cancelRes = await handleIncomingMessage(env, { userId, text: "نه" });
		expect(cancelRes.replyText).toContain("درخواست حذف تمام تسک‌ها لغو شد");

		// Confirmation consumed / cancelled
		const pending = await getPendingConfirmation(env.DB, userId, "bulk_delete");
		expect(pending).toBeNull();

		// Subsequent confirmation fails
		const confirmRes = await handleIncomingMessage(env, { userId, text: "بله همه را حذف کن" });
		expect(confirmRes.replyText).toContain("درخواستی برای حذف تمام تسک‌ها ثبت نشده است");

		// Task still safe
		const tasks = await listTasks(env.DB, userId, "all");
		expect(tasks.length).toBe(1);
	});

	it("supports cancellation with «لغو کن»", async () => {
		await createTask(env.DB, userId, { title: "تسک اول" });
		await handleIncomingMessage(env, { userId, text: "کل تسک‌ها رو دیلیت کن" });

		const cancelRes = await handleIncomingMessage(env, { userId, text: "لغو کن" });
		expect(cancelRes.replyText).toContain("درخواست حذف تمام تسک‌ها لغو شد");

		const tasks = await listTasks(env.DB, userId, "all");
		expect(tasks.length).toBe(1);
	});

	it("rejects confirmation when request has expired (> 120 seconds TTL)", async () => {
		await createTask(env.DB, userId, { title: "تسک مهم" });

		// Request bulk delete
		await handleIncomingMessage(env, { userId, text: "همه تسک‌هام رو پاک کن" });

		// Simulate time passage past expiration (121 seconds later)
		const expiredTime = Date.now() - 5000;
		await env.DB.prepare(
			`UPDATE pending_confirmations SET expires_at = ? WHERE telegram_user_id = ?`
		).bind(expiredTime, userId).run();

		// Try to confirm expired request
		const confirmRes = await handleIncomingMessage(env, { userId, text: "بله همه را حذف کن" });
		expect(confirmRes.replyText).toContain("منقضی شده است");

		// Tasks are preserved
		const tasks = await listTasks(env.DB, userId, "all");
		expect(tasks.length).toBe(1);
	});

	it("user A pending bulk delete does NOT allow user B to delete anything", async () => {
		const userA = "user_A_111";
		const userB = "user_B_222";

		await createTask(env.DB, userA, { title: "تسک A" });
		await createTask(env.DB, userB, { title: "تسک B" });

		// User A requests bulk delete
		await handleIncomingMessage(env, { userId: userA, text: "همه تسک‌هام رو پاک کن" });

		// User B tries to confirm
		const resB = await handleIncomingMessage(env, { userId: userB, text: "بله همه را حذف کن" });
		expect(resB.replyText).toContain("درخواستی برای حذف تمام تسک‌ها ثبت نشده است");

		// Both tasks intact
		expect((await listTasks(env.DB, userA, "all")).length).toBe(1);
		expect((await listTasks(env.DB, userB, "all")).length).toBe(1);
	});
});
