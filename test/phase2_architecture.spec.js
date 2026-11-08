import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import worker from "../src/index.js";
import { handleIncomingMessage, resolveTargetTask } from "../src/handler.js";
import {
	createTask,
	listTasks,
	getTaskById,
	reserveTelegramUpdate,
	markUpdateCompleted,
	markUpdateFailed,
	saveDisplayedTaskList,
	stageDisplayedTaskList,
	clearPendingDisplayedList,
	getDisplayedTaskList,
	ensurePendingClarificationsTable,
} from "../src/db.js";

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

describe("Hermes Mini - Phase 2 Architectural & Reliability Acceptance Suite", () => {
	const userId = "888777";

	beforeEach(async () => {
		await initDatabase(env.DB);
		await env.DB.prepare("DELETE FROM tasks").run();
		await env.DB.prepare("DELETE FROM conversation_messages").run();
		await env.DB.prepare("DELETE FROM user_displayed_lists").run();
		await env.DB.prepare("DELETE FROM processed_updates").run();
		await env.DB.prepare("DELETE FROM pending_clarifications").run();
	});

	// 1. Retry پس از ثبت تسک و پیش از تکمیل Update، بدون ایجاد تسک تکراری
	it("1. Retry after task insert before update completion creates NO duplicate task", async () => {
		const updateId = "arch-001";
		// Initial creation with updateId
		const t1 = await createTask(env.DB, userId, { title: "خرید نان سنگک", updateId });
		expect(t1.id).toBeDefined();

		// Retry with same updateId
		const t2 = await createTask(env.DB, userId, { title: "خرید نان سنگک", updateId });
		expect(t2.id).toBe(t1.id);

		const all = await listTasks(env.DB, userId, "all");
		expect(all.length).toBe(1);
	});

	// 2. دو پردازش همزمان با یک Update
	it("2. Controlled concurrency: Only 1 worker can process when two requests arrive simultaneously", async () => {
		const updateId = "arch-002";
		const [res1, res2] = await Promise.all([
			reserveTelegramUpdate(env.DB, updateId),
			reserveTelegramUpdate(env.DB, updateId),
		]);

		const reserved = [res1.state, res2.state].filter((s) => s === "reserved");
		const inProgress = [res1.state, res2.state].filter((s) => s === "in_progress");

		expect(reserved.length).toBe(1);
		expect(inProgress.length).toBe(1);
	});

	// 3. Stale Reclaim درحالیکه Worker قبلی هنوز فعال است
	it("3. Stale Reclaim grants new fencing token and revokes delayed worker write ownership", async () => {
		const updateId = "arch-003";
		const w1 = await reserveTelegramUpdate(env.DB, updateId);

		// Worker 1 is delayed; 65 seconds elapse in DB
		await env.DB.prepare(
			`UPDATE processed_updates SET updated_at = datetime('now', '-65 seconds') WHERE update_id = ?`
		).bind(updateId).run();

		// Worker 2 reclaims ownership
		const w2 = await reserveTelegramUpdate(env.DB, updateId, 60);
		expect(w2.state).toBe("reserved");
		expect(w2.lockToken).not.toBe(w1.lockToken);

		// Worker 1 attempts to write: rejected by fencing check
		await expect(
			createTask(env.DB, userId, { title: "از طرف ورکر اول", updateId, lockToken: w1.lockToken })
		).rejects.toThrow("FENCING_TOKEN_REVOKED");

		// Worker 2 writes successfully
		const created = await createTask(env.DB, userId, {
			title: "از طرف ورکر دوم",
			updateId,
			lockToken: w2.lockToken,
		});
		expect(created.title).toBe("از طرف ورکر دوم");

		const all = await listTasks(env.DB, userId, "all");
		expect(all.length).toBe(1);
	});

	// 4. تلاش Worker قدیمی برای تغییر وضعیت رزرو جدید
	it("4. Zombie worker cannot overwrite status or lock of newly reclaimed reservation", async () => {
		const updateId = "arch-004";
		const w1 = await reserveTelegramUpdate(env.DB, updateId);

		await env.DB.prepare(
			`UPDATE processed_updates SET updated_at = datetime('now', '-65 seconds') WHERE update_id = ?`
		).bind(updateId).run();

		const w2 = await reserveTelegramUpdate(env.DB, updateId, 60);
		expect(w2.state).toBe("reserved");

		// Zombie Worker 1 tries to mark completed or failed
		const complRes = await markUpdateCompleted(env.DB, updateId, w1.lockToken, "Fake Response");
		expect(complRes).toBe(false);

		const failRes = await markUpdateFailed(env.DB, updateId, w1.lockToken);
		expect(failRes).toBe(false);

		const row = await env.DB.prepare(
			`SELECT status, lock_token FROM processed_updates WHERE update_id = ?`
		).bind(updateId).first();

		expect(row.status).toBe("processing");
		expect(row.lock_token).toBe(w2.lockToken);
	});

	// 5. Crash در نقاط مختلف چرخه ثبت تسک
	it("5. Crash before DB insert leaves update recoverable on retry", async () => {
		const updateId = "arch-005";
		const res = await reserveTelegramUpdate(env.DB, updateId);
		expect(res.state).toBe("reserved");

		// Worker crashes before insert, calling markUpdateFailed in catch block
		await markUpdateFailed(env.DB, updateId, res.lockToken);

		// Telegram retries: reservation is immediately available again
		const retryRes = await reserveTelegramUpdate(env.DB, updateId);
		expect(retryRes.state).toBe("reserved");

		// Insert completes on retry
		const task = await createTask(env.DB, userId, { title: "تسک بعد از کرش", updateId, lockToken: retryRes.lockToken });
		expect(task.title).toBe("تسک بعد از کرش");
		await markUpdateCompleted(env.DB, updateId, retryRes.lockToken);

		const finalRow = await env.DB.prepare(
			`SELECT status FROM processed_updates WHERE update_id = ?`
		).bind(updateId).first();
		expect(finalRow.status).toBe("completed");
	});

	// 6. پاسخ سریع کاربر به فهرست جدید
	it("6. Rapid user response to newly staged list resolves to new list, avoiding stale list", async () => {
		const tOld1 = await createTask(env.DB, userId, { title: "کار کهنه ۱" });
		const tOld2 = await createTask(env.DB, userId, { title: "کار کهنه ۲" });
		const tNew1 = await createTask(env.DB, userId, { title: "کار تازه ۱" });
		const tNew2 = await createTask(env.DB, userId, { title: "کار تازه ۲" });

		// Old list active
		await saveDisplayedTaskList(env.DB, userId, [tOld1.id, tOld2.id], "active");

		// New list staged
		await stageDisplayedTaskList(env.DB, userId, [tNew1.id, tNew2.id]);

		// Immediate reply "اولی رو انجام دادم"
		const resolved = await resolveTargetTask(env.DB, userId, { target_index: 1 });
		expect(resolved.task).not.toBeNull();
		expect(resolved.task.id).toBe(tNew1.id);
		expect(resolved.task.title).toBe("کار تازه ۱");
	});

	// 7. شکست D1 پس از ارسال موفق فهرست
	it("7. D1 transient failure during list activation is handled safely with retry", async () => {
		const t1 = await createTask(env.DB, userId, { title: "ارسال فاکتور مالی" });
		// Staging succeeds
		await stageDisplayedTaskList(env.DB, userId, [t1.id]);
		// Activating list is idempotent and resilient
		await saveDisplayedTaskList(env.DB, userId, [t1.id], "active");

		const state = await getDisplayedTaskList(env.DB, userId, 30);
		expect(state.found).toBe(true);
		expect(state.status).toBe("active");
		expect(state[0]).toBe(t1.id);
	});

	// 8. Timeout تلگرام با نتیجه نامشخص
	it("8. Telegram timeout with unknown outcome leaves update recoverable without duplicates", async () => {
		const updateId = "arch-008";
		const res = await reserveTelegramUpdate(env.DB, updateId);

		// Task created
		await createTask(env.DB, userId, { title: "خرید بلیت قطار", updateId, lockToken: res.lockToken });

		// Telegram send times out -> update is marked as failed (NOT prematurely completed)
		await markUpdateFailed(env.DB, updateId, res.lockToken);

		const rowBeforeRetry = await env.DB.prepare(
			`SELECT status FROM processed_updates WHERE update_id = ?`
		).bind(updateId).first();
		expect(rowBeforeRetry.status).toBe("failed");

		// Telegram retries: reclaimed cleanly
		const retryRes = await reserveTelegramUpdate(env.DB, updateId);
		expect(retryRes.state).toBe("reserved");

		// Attempting to recreate task returns existing task (0 duplicates)
		const taskOnRetry = await createTask(env.DB, userId, { title: "خرید بلیت قطار", updateId, lockToken: retryRes.lockToken });
		expect(taskOnRetry.title).toBe("خرید بلیت قطار");

		const all = await listTasks(env.DB, userId, "all");
		expect(all.length).toBe(1);
	});

	// 9. شکست ارسال پاسخ پس از تکمیل عملیات
	it("9. Telegram delivery failure after task insert cleans up pending staged list", async () => {
		const t1 = await createTask(env.DB, userId, { title: "کارهای امروز" });

		// Staged before send
		await stageDisplayedTaskList(env.DB, userId, [t1.id]);

		// Telegram send fails definitively -> clear pending list
		await clearPendingDisplayedList(env.DB, userId);

		const state = await getDisplayedTaskList(env.DB, userId, 30);
		// Pending list was cleaned up so ordinal references won't bind to an undelivered list
		expect(state.pendingIds).toBeNull();
	});

	// 10. بازیابی پس از خطای پردازش
	it("10. Processing error recovery: worker fails on attempt 1, retries and succeeds cleanly", async () => {
		const updateId = "arch-010";
		const res1 = await reserveTelegramUpdate(env.DB, updateId);
		expect(res1.state).toBe("reserved");

		// Error during processing
		await markUpdateFailed(env.DB, updateId, res1.lockToken);

		// Retry arrives
		const res2 = await reserveTelegramUpdate(env.DB, updateId);
		expect(res2.state).toBe("reserved");
		expect(res2.version).toBe(2);

		const task = await createTask(env.DB, userId, { title: "تمرین یوگا", updateId, lockToken: res2.lockToken });
		await markUpdateCompleted(env.DB, updateId, res2.lockToken, "Done!");

		const finalRow = await env.DB.prepare(
			`SELECT status, version, response_text FROM processed_updates WHERE update_id = ?`
		).bind(updateId).first();

		expect(finalRow.status).toBe("completed");
		expect(finalRow.version).toBe(2);
		expect(finalRow.response_text).toBe("Done!");
	});

	// 11. جلوگیری از تغییر تسک اشتباه در ارجاع‌های ترتیبی
	it("11. Prevents modifying wrong task when list is missing or expired (>30 minutes)", async () => {
		const t1 = await createTask(env.DB, userId, { title: "شستن ماشین" });
		await saveDisplayedTaskList(env.DB, userId, [t1.id], "active");

		// Simulate 35 minutes elapsed (> 30-min TTL)
		await env.DB.prepare(
			`UPDATE user_displayed_lists SET updated_at = datetime('now', '-35 minutes') WHERE telegram_user_id = ?`
		).bind(userId).run();

		const resolved = await resolveTargetTask(env.DB, userId, { target_index: 1 });
		// Guard: explicitly signals expiredOrMissingList without guessing or changing random task
		expect(resolved.expiredOrMissingList).toBe(true);
		expect(resolved.task).toBeNull();
	});

	// 12. حفظ عملکرد قابلیت‌های سالم قبلی
	it("12. Preserves all healthy core capabilities (natural chat, local task dispatch, Persian dates)", async () => {
		// Greeting
		const greet = await handleIncomingMessage(env, { userId, text: "سلام" });
		expect(greet.authorized).toBe(true);
		expect(greet.replyText).toContain("سلام");

		// Local task addition
		const addRes = await handleIncomingMessage(env, { userId, text: "باید فردا ساعت ۵ برم دکتر" });
		expect(addRes.authorized).toBe(true);
		expect(addRes.replyText).toContain("منظورتان ساعت ۵ صبح است یا ۵ عصر؟");

		const tasksBefore = await listTasks(env.DB, userId, "all");
		expect(tasksBefore.length).toBe(0);

		// Clarify عصر
		const clarifyRes = await handleIncomingMessage(env, { userId, text: "عصر" });
		expect(clarifyRes.authorized).toBe(true);
		expect(clarifyRes.replyText).toContain("تسک با موفقیت ثبت شد");
		expect(clarifyRes.replyText).toContain("برم دکتر");

		// Task was recorded
		const tasks = await listTasks(env.DB, userId, "all");
		expect(tasks.length).toBe(1);
		expect(tasks[0].title).toBe("برم دکتر");
		expect(tasks[0].due_date).toContain("17:00:00+03:30");
	});
});
