import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { handleIncomingMessage } from "../src/handler.js";
import { createTask, getTaskById, listTasks, ensurePendingClarificationsTable } from "../src/db.js";
import { dispatchLocalAction, cleanTargetQuery } from "../src/localDispatcher.js";

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

	await ensurePendingClarificationsTable(db);
}

describe("Hermes Mini - Stage 1: Edit & Clear Due Date Verification Suite", () => {
	const userId = "stage1_user_123";

	beforeEach(async () => {
		await initDatabase(env.DB);
		await env.DB.prepare("DELETE FROM tasks").run();
		await env.DB.prepare("DELETE FROM conversation_messages").run();
		await env.DB.prepare("DELETE FROM user_displayed_lists").run();
		await env.DB.prepare("DELETE FROM processed_updates").run();
		await env.DB.prepare("DELETE FROM pending_clarifications").run();
	});

	it("cleanTargetQuery strips command qualifiers (موعد، تاریخ، زمان، ساعت، تسک)", () => {
		expect(cleanTargetQuery("موعد تسک خرید نون")).toBe("خرید نون");
		expect(cleanTargetQuery("تاریخ تسک خرید نان")).toBe("خرید نان");
		expect(cleanTargetQuery("زمان خرید نون")).toBe("خرید نون");
		expect(cleanTargetQuery("ساعت جلسه")).toBe("جلسه");
		expect(cleanTargetQuery("تسک خرید نون")).toBe("خرید نون");
		expect(cleanTargetQuery("تسک موعد خرید نان")).toBe("خرید نان");
		expect(cleanTargetQuery("خرید نون")).toBe("خرید نون");
	});

	it("dispatches «موعد تسک خرید نون رو به فردا ساعت ۱۰ تغییر بده» without qualifier in target_query", () => {
		const action = dispatchLocalAction("موعد تسک خرید نون رو به فردا ساعت ۱۰ تغییر بده");
		expect(action).not.toBeNull();
		expect(action.intent).toBe("edit");
		expect(action.target_query).toBe("خرید نون");
		expect(action.isAmbiguousTime).toBe(true);
		expect(action.ambiguousHour).toBe(10);
		expect(action.needsClarification).toBe(true);
	});

	it("reschedules existing task when input is «موعد تسک خرید نون رو به فردا ساعت ۱۰ تغییر بده»", async () => {
		const created = await createTask(env.DB, userId, { title: "خرید نون", dueDate: "2026-11-04T18:00:00+03:30" });
		expect(created.id).toBeDefined();

		const res = await handleIncomingMessage(env, { userId, text: "موعد تسک خرید نون رو به فردا ساعت ۱۰ تغییر بده" });
		expect(res.replyText).toContain("منظورتان ساعت ۱۰ صبح است یا ۱۰ شب؟");

		const beforeClarify = await getTaskById(env.DB, userId, created.id);
		expect(beforeClarify.due_date).toBe("2026-11-04T18:00:00+03:30");

		const clarifyRes = await handleIncomingMessage(env, { userId, text: "صبح" });
		expect(clarifyRes.replyText).toContain("ویرایش شد");
		expect(clarifyRes.replyText).toContain("۱۰:۰۰");

		const updated = await getTaskById(env.DB, userId, created.id);
		expect(updated.title).toBe("خرید نون");
		expect(updated.due_date).toContain("10:00:00+03:30");
	});

	it("reschedules task that previously had no due date", async () => {
		const created = await createTask(env.DB, userId, { title: "تماس با استاد" });
		expect(created.due_date).toBeNull();

		const res = await handleIncomingMessage(env, { userId, text: "موعد تسک تماس با استاد رو به فردا ساعت ۱۰ تغییر بده" });
		expect(res.replyText).toContain("منظورتان ساعت ۱۰ صبح است یا ۱۰ شب؟");

		const beforeClarify = await getTaskById(env.DB, userId, created.id);
		expect(beforeClarify.due_date).toBeNull();

		const clarifyRes = await handleIncomingMessage(env, { userId, text: "صبح" });
		expect(clarifyRes.replyText).toContain("ویرایش شد");
		expect(clarifyRes.replyText).toContain("۱۰:۰۰");

		const updated = await getTaskById(env.DB, userId, created.id);
		expect(updated.title).toBe("تماس با استاد");
		expect(updated.due_date).toContain("10:00:00+03:30");
	});

	it("clears due date with «موعد خرید نان رو حذف کن» without deleting task", async () => {
		const created = await createTask(env.DB, userId, { title: "خرید نان", dueDate: "2026-11-05T09:00:00+03:30" });
		expect(created.due_date).not.toBeNull();

		const res = await handleIncomingMessage(env, { userId, text: "موعد خرید نان رو حذف کن" });
		expect(res.replyText).toContain("موعد تسک «خرید نان» با موفقیت حذف شد");

		// Task is still present in database, but due_date is null
		const task = await getTaskById(env.DB, userId, created.id);
		expect(task).not.toBeNull();
		expect(task.title).toBe("خرید نان");
		expect(task.due_date).toBeNull();
	});

	it("clears due date with «تاریخ تسک خرید نان رو پاک کن»", async () => {
		const created = await createTask(env.DB, userId, { title: "خرید نان", dueDate: "2026-11-05T09:00:00+03:30" });

		const res = await handleIncomingMessage(env, { userId, text: "تاریخ تسک خرید نان رو پاک کن" });
		expect(res.replyText).toContain("حذف شد");

		const task = await getTaskById(env.DB, userId, created.id);
		expect(task).not.toBeNull();
		expect(task.due_date).toBeNull();
	});

	it("strictly differentiates full task deletion from clear due date", async () => {
		const task1 = await createTask(env.DB, userId, { title: "خرید دارو", dueDate: "2026-11-05T12:00:00+03:30" });
		const task2 = await createTask(env.DB, userId, { title: "خرید شیر", dueDate: "2026-11-05T12:00:00+03:30" });

		// Clear due date for task1
		const res1 = await handleIncomingMessage(env, { userId, text: "موعد خرید دارو رو حذف کن" });
		expect(res1.replyText).toContain("موعد تسک");
		const dbTask1 = await getTaskById(env.DB, userId, task1.id);
		expect(dbTask1).not.toBeNull(); // Still exists!
		expect(dbTask1.due_date).toBeNull();

		// Full delete for task2
		const res2 = await handleIncomingMessage(env, { userId, text: "تسک خرید شیر رو حذف کن" });
		expect(res2.replyText).toContain("با موفقیت حذف شد");
		const dbTask2 = await getTaskById(env.DB, userId, task2.id);
		expect(dbTask2).toBeNull(); // Entirely deleted!
	});

	it("handles different word orders for rescheduling", async () => {
		const created = await createTask(env.DB, userId, { title: "جلسه با مدیر", dueDate: "2026-11-04T10:00:00+03:30" });

		// Alternate word order: "برای فردا ساعت ۱۰ موعد تسک جلسه با مدیر رو تغییر بده"
		const res = await handleIncomingMessage(env, { userId, text: "برای فردا ساعت ۱۰ موعد تسک جلسه با مدیر رو تغییر بده" });
		expect(res.replyText).toContain("منظورتان ساعت ۱۰ صبح است یا ۱۰ شب؟");

		const clarifyRes = await handleIncomingMessage(env, { userId, text: "صبح" });
		expect(clarifyRes.replyText).toContain("ویرایش شد");
		expect(clarifyRes.replyText).toContain("۱۰:۰۰");

		const updated = await getTaskById(env.DB, userId, created.id);
		expect(updated.due_date).toContain("10:00:00+03:30");
	});
});
