import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { handleIncomingMessage } from "../src/handler.js";
import { createTask, findTaskByQuery, listTasks, ensureReminderColumns } from "../src/db.js";
import { dispatchLocalAction } from "../src/localDispatcher.js";

async function initTestDatabase(db) {
	await db.prepare(
		`CREATE TABLE IF NOT EXISTS tasks (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			telegram_user_id TEXT NOT NULL,
			title TEXT NOT NULL,
			is_completed INTEGER DEFAULT 0,
			due_date TEXT,
			reminder_sent INTEGER DEFAULT 0,
			reminder_status TEXT DEFAULT 'pending',
			reminder_token TEXT,
			reminder_claimed_at INTEGER,
			reminder_retry_count INTEGER DEFAULT 0,
			reminder_retry_after INTEGER DEFAULT 0,
			reminded_at TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		)`
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
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		)`
	).run();

	await db.prepare(
		`CREATE TABLE IF NOT EXISTS pending_clarifications (
			telegram_user_id TEXT PRIMARY KEY,
			clarification_id TEXT NOT NULL,
			action_type TEXT NOT NULL,
			payload TEXT NOT NULL,
			claim_token TEXT,
			claimed_at INTEGER,
			created_at INTEGER NOT NULL,
			expires_at INTEGER NOT NULL
		)`
	).run();
}

describe("Phase 3 Audit Bug Fixes: Local Rename Due Date Preservation & Incomplete Titles Guard", () => {
	const userId = "user_audit_fixes_123";
	const baseDate = new Date("2026-11-07T10:00:00+03:30"); // 16 Aban 1405

	beforeEach(async () => {
		await initTestDatabase(env.DB);
		await env.DB.prepare("DELETE FROM tasks").run();
		await env.DB.prepare("DELETE FROM conversation_messages").run();
		await env.DB.prepare("DELETE FROM pending_clarifications").run();
	});

	describe("Bug 1: Preserving due date when renaming via Local Dispatcher", () => {
		it("1. creates a task with a specific due date, renames only the title locally, and verifies the previous due date is strictly preserved", async () => {
			const initialTask = await createTask(env.DB, userId, {
				title: "خرید نان",
				dueDate: "2026-11-20T10:00:00+03:30",
			});
			expect(initialTask.due_date).toBe("2026-11-20T10:00:00+03:30");

			// Rename via local dispatcher: "تسک خرید نان رو به خرید نان سنگک تغییر نام بده"
			const renameText = "تسک خرید نان رو به خرید نان سنگک تغییر نام بده";
			const localAction = dispatchLocalAction(renameText, baseDate);

			expect(localAction).not.toBeNull();
			expect(localAction.isLocal).toBe(true);
			expect(localAction.intent).toBe("edit");
			expect(localAction.new_title).toBe("خرید نان سنگک");
			expect(localAction.clearDueDate).toBe(false);
			expect(localAction.hasDate).toBe(false);
			expect(localAction.hasTime).toBe(false);
			expect(localAction.due_date).toBeUndefined();
			expect(localAction.isoDueDate).toBeUndefined();

			// Execute through handler
			const res = await handleIncomingMessage(env, {
				userId,
				text: renameText,
			}, { baseDate });

			expect(res.authorized).toBe(true);
			expect(res.intent).toBe("edit");
			expect(res.replyText).toContain("خرید نان سنگک");
			expect(res.replyText).toContain("ویرایش شد");
			expect(res.replyText).not.toContain("موعد جدید");

			// Verify in Database: title updated, due_date strictly preserved, reminder status remains pending
			const row = await env.DB.prepare(
				"SELECT id, title, due_date, reminder_status FROM tasks WHERE id = ?"
			).bind(initialTask.id).first();

			expect(row.title).toBe("خرید نان سنگک");
			expect(row.due_date).toBe("2026-11-20T10:00:00+03:30");
			expect(row.reminder_status).toBe("pending");
		});

		it("2. allows explicitly clearing the due date without regression", async () => {
			const initialTask = await createTask(env.DB, userId, {
				title: "خرید شیر",
				dueDate: "2026-11-22T09:00:00+03:30",
			});

			const clearText = "موعد تسک خرید شیر رو حذف کن";
			const res = await handleIncomingMessage(env, {
				userId,
				text: clearText,
			}, { baseDate });

			expect(res.authorized).toBe(true);
			expect(res.intent).toBe("edit");
			expect(res.replyText).toContain("با موفقیت حذف شد");

			const row = await env.DB.prepare(
				"SELECT id, title, due_date, reminder_status FROM tasks WHERE id = ?"
			).bind(initialTask.id).first();

			expect(row.due_date).toBeNull();
			expect(row.reminder_status).toBe("disabled");
		});

		it("3. allows rescheduling with a new valid due date in Local Dispatcher", async () => {
			const initialTask = await createTask(env.DB, userId, {
				title: "مطالعه کتاب",
				dueDate: "2026-11-20T10:00:00+03:30",
			});

			// Reschedule to 8 Azar 10 AM (2026-11-29T10:00:00+03:30)
			const rescheduleText = "موعد تسک مطالعه کتاب رو بذار ۸ آذر ساعت ۱۰ صبح";
			const res = await handleIncomingMessage(env, {
				userId,
				text: rescheduleText,
			}, { baseDate });

			expect(res.authorized).toBe(true);
			expect(res.intent).toBe("edit");
			expect(res.replyText).toContain("ویرایش شد");
			expect(res.replyText).toContain("موعد جدید");

			const row = await env.DB.prepare(
				"SELECT id, title, due_date, reminder_status FROM tasks WHERE id = ?"
			).bind(initialTask.id).first();

			expect(row.due_date).toBe("2026-11-29T10:00:00+03:30");
			expect(row.reminder_status).toBe("pending");
		});
	});

	describe("Bug 2: Incomplete Title and Directive Action Verb Guard in Local Path", () => {
		it("1. catches «یه تسک اضافه کن برای» in Local Dispatcher and prevents database creation", async () => {
			const text = "یه تسک اضافه کن برای";
			const localAction = dispatchLocalAction(text, baseDate);

			expect(localAction).not.toBeNull();
			expect(localAction.isLocal).toBe(true);
			expect(localAction.intent).toBe("clarify");

			const res = await handleIncomingMessage(env, {
				userId,
				text,
			}, { baseDate });

			expect(res.authorized).toBe(true);
			expect(res.intent).toBe("clarify");
			expect(res.replyText).toContain("ناقص است");

			const allTasks = await listTasks(env.DB, userId, "all");
			expect(allTasks.length).toBe(0);
		});

		it("2. catches «یه تسک بنویس برای» in Local Dispatcher and prevents database creation", async () => {
			const text = "یه تسک بنویس برای";
			const localAction = dispatchLocalAction(text, baseDate);

			expect(localAction).not.toBeNull();
			expect(localAction.isLocal).toBe(true);
			expect(localAction.intent).toBe("clarify");

			const res = await handleIncomingMessage(env, {
				userId,
				text,
			}, { baseDate });

			expect(res.authorized).toBe(true);
			expect(res.intent).toBe("clarify");
			expect(res.replyText).toContain("ناقص است");

			const allTasks = await listTasks(env.DB, userId, "all");
			expect(allTasks.length).toBe(0);
		});

		it("3. catches bare directive «یه تسک اضافه کن» and asks user to specify the task title", async () => {
			const text = "یه تسک اضافه کن";
			const res = await handleIncomingMessage(env, {
				userId,
				text,
			}, { baseDate });

			expect(res.authorized).toBe(true);
			expect(res.intent).toBe("clarify");
			expect(res.replyText).toContain("عنوان تسک مشخص نیست");

			const allTasks = await listTasks(env.DB, userId, "all");
			expect(allTasks.length).toBe(0);
		});

		it("4. preserves and accepts valid tasks without false positives", async () => {
			// Sample A: "برای فردا خرید نان"
			const resA = await handleIncomingMessage(env, {
				userId,
				text: "برای فردا خرید نان",
			}, { baseDate });

			expect(resA.authorized).toBe(true);
			expect(resA.intent).toBe("add");
			expect(resA.replyText).toContain("خرید نان");

			const taskA = await findTaskByQuery(env.DB, userId, "خرید نان");
			expect(taskA).not.toBeNull();
			expect(taskA.title).toBe("خرید نان");

			// Sample B: "یه تسک اضافه کن که فردا برم استخر"
			const resB = await handleIncomingMessage(env, {
				userId,
				text: "یه تسک اضافه کن که فردا برم استخر",
			}, { baseDate });

			expect(resB.authorized).toBe(true);
			expect(resB.intent).toBe("add");
			expect(resB.replyText).toContain("برم استخر");

			const taskB = await findTaskByQuery(env.DB, userId, "برم استخر");
			expect(taskB).not.toBeNull();

			// Sample C: "برای ۸ آذر خرید کتاب دارم"
			const resC = await handleIncomingMessage(env, {
				userId,
				text: "برای ۸ آذر خرید کتاب دارم",
			}, { baseDate });

			expect(resC.authorized).toBe(true);
			expect(resC.intent).toBe("add");
			expect(resC.replyText).toContain("خرید کتاب دارم");

			const taskC = await findTaskByQuery(env.DB, userId, "خرید کتاب دارم");
			expect(taskC).not.toBeNull();
			expect(taskC.due_date).toBe("2026-11-29");
		});
	});
});
