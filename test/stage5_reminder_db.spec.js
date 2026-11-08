import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import {
	createTask,
	getTaskById,
	updateTaskStatus,
	editTask,
	ensureReminderColumns,
	sweepMissedReminders,
	getDueTasksForReminder,
	claimTaskForReminder,
	markReminderSuccess,
	markReminderFailure,
} from "../src/db.js";

async function initStage5Database(db) {
	// Base tasks table
	await db.prepare(
		`CREATE TABLE IF NOT EXISTS tasks (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			telegram_user_id TEXT NOT NULL,
			title TEXT NOT NULL,
			is_completed INTEGER NOT NULL DEFAULT 0,
			due_date TEXT,
			telegram_update_id TEXT,
			reminder_sent INTEGER NOT NULL DEFAULT 0,
			reminder_status TEXT NOT NULL DEFAULT 'pending',
			reminder_token TEXT,
			reminder_claimed_at INTEGER,
			reminder_retry_count INTEGER NOT NULL DEFAULT 0,
			reminder_retry_after INTEGER NOT NULL DEFAULT 0,
			reminded_at TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		)`
	).run();

	await db.prepare(
		`CREATE INDEX IF NOT EXISTS idx_tasks_reminders_active 
		 ON tasks (reminder_sent, is_completed, reminder_status, due_date)`
	).run();
}

describe("Stage 5: Task Reminders Repository & Lifecycle Tests", () => {
	const userId = "test_user_777";

	beforeEach(async () => {
		await initStage5Database(env.DB);
		await env.DB.prepare("DELETE FROM tasks").run();
	});

	// Helper to format ISO with Tehran offset
	function getIsoOffsetDate(secondsFromNow = 0) {
		const d = new Date(Date.now() + secondsFromNow * 1000);
		// Format to YYYY-MM-DDTHH:mm:ss+03:30 or use ISO with Z
		return d.toISOString();
	}

	it("1. Verifies schema and default columns for task reminders", async () => {
		await ensureReminderColumns(env.DB);

		const task = await createTask(env.DB, userId, {
			title: "جلسه کاری",
			dueDate: "2026-11-04T15:00:00+03:30",
		});

		const row = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(task.id).first();
		expect(row.reminder_sent).toBe(0);
		expect(row.reminder_status).toBe("pending");
		expect(row.reminder_token).toBeNull();
		expect(row.reminder_claimed_at).toBeNull();
		expect(row.reminder_retry_count).toBe(0);
		expect(row.reminder_retry_after).toBe(0);
		expect(row.reminded_at).toBeNull();
	});

	it("2. Filters due tasks correctly (time, date-only, completed, sent, window)", async () => {
		// Task 1: Valid due 5 minutes ago (should be picked)
		const duePast = getIsoOffsetDate(-300);
		await env.DB.prepare(
			`INSERT INTO tasks (telegram_user_id, title, due_date, reminder_status) VALUES (?, ?, ?, 'pending')`
		).bind(userId, "تسکه موعد گذشته", duePast).run();

		// Task 2: Future due in 10 minutes (should NOT be picked)
		const dueFuture = getIsoOffsetDate(600);
		await env.DB.prepare(
			`INSERT INTO tasks (telegram_user_id, title, due_date, reminder_status) VALUES (?, ?, ?, 'pending')`
		).bind(userId, "تسک آینده", dueFuture).run();

		// Task 3: Date-only without time (should NOT be picked)
		await env.DB.prepare(
			`INSERT INTO tasks (telegram_user_id, title, due_date, reminder_status) VALUES (?, ?, '2026-11-04', 'pending')`
		).bind(userId, "تسک بدون ساعت").run();

		// Task 4: NULL due_date (should NOT be picked)
		await env.DB.prepare(
			`INSERT INTO tasks (telegram_user_id, title, due_date, reminder_status) VALUES (?, ?, NULL, 'pending')`
		).bind(userId, "تسک بدون موعد").run();

		// Task 5: Completed task (should NOT be picked)
		await env.DB.prepare(
			`INSERT INTO tasks (telegram_user_id, title, due_date, is_completed, reminder_status) VALUES (?, ?, ?, 1, 'pending')`
		).bind(userId, "تسک تکمیل شده", duePast).run();

		// Task 6: Already sent reminder (should NOT be picked)
		await env.DB.prepare(
			`INSERT INTO tasks (telegram_user_id, title, due_date, reminder_sent, reminder_status) VALUES (?, ?, ?, 1, 'sent')`
		).bind(userId, "تسک ارسال شده", duePast).run();

		// Task 7: Missed/abandoned/disabled status (should NOT be picked)
		await env.DB.prepare(
			`INSERT INTO tasks (telegram_user_id, title, due_date, reminder_status) VALUES (?, ?, ?, 'abandoned')`
		).bind(userId, "تسک متوقف شده", duePast).run();

		// Task 8: Older than 72 hours (e.g. 75 hours ago) -> should NOT be picked by due tasks (handled by sweep)
		const dueOld75h = getIsoOffsetDate(-75 * 3600);
		await env.DB.prepare(
			`INSERT INTO tasks (telegram_user_id, title, due_date, reminder_status) VALUES (?, ?, ?, 'pending')`
		).bind(userId, "تسک خیلی قدیمی", dueOld75h).run();

		const dueTasks = await getDueTasksForReminder(env.DB, 10);
		expect(dueTasks.length).toBe(1);
		expect(dueTasks[0].title).toBe("تسکه موعد گذشته");
	});

	it("3. Enforces atomic claim and prevents dual worker race condition", async () => {
		const dueDate = getIsoOffsetDate(-60);
		const { meta } = await env.DB.prepare(
			`INSERT INTO tasks (telegram_user_id, title, due_date, reminder_status) VALUES (?, 'تسک تست کلیم', ?, 'pending')`
		).bind(userId, dueDate).run();
		const taskId = meta.last_row_id;

		// Worker 1 claims task
		const claimed1 = await claimTaskForReminder(env.DB, taskId, dueDate, "worker_token_111");
		expect(claimed1).toBe(true);

		// Worker 2 attempts concurrent claim on same task
		const claimed2 = await claimTaskForReminder(env.DB, taskId, dueDate, "worker_token_222");
		expect(claimed2).toBe(false);

		// DB row confirms Worker 1 ownership and processing state
		const row = await env.DB.prepare("SELECT reminder_status, reminder_token, reminder_claimed_at FROM tasks WHERE id = ?").bind(taskId).first();
		expect(row.reminder_status).toBe("processing");
		expect(row.reminder_token).toBe("worker_token_111");
		expect(row.reminder_claimed_at).toBeGreaterThan(0);
	});

	it("4. Recovers stale leases after 120 seconds", async () => {
		const dueDate = getIsoOffsetDate(-60);
		const nowSeconds = Math.floor(Date.now() / 1000);
		// Task claimed 130 seconds ago (expired lease)
		const { meta } = await env.DB.prepare(
			`INSERT INTO tasks (telegram_user_id, title, due_date, reminder_status, reminder_token, reminder_claimed_at)
			 VALUES (?, 'تسک کرش شده', ?, 'processing', 'dead_token_000', ?)`
		).bind(userId, dueDate, nowSeconds - 130).run();
		const taskId = meta.last_row_id;

		// Should appear in getDueTasksForReminder as eligible for recovery
		const dueTasks = await getDueTasksForReminder(env.DB, 5);
		expect(dueTasks.some(t => t.id === taskId)).toBe(true);

		// New Worker claims it
		const recovered = await claimTaskForReminder(env.DB, taskId, dueDate, "new_worker_token_999");
		expect(recovered).toBe(true);

		const updatedRow = await env.DB.prepare("SELECT reminder_token, reminder_claimed_at FROM tasks WHERE id = ?").bind(taskId).first();
		expect(updatedRow.reminder_token).toBe("new_worker_token_999");
		expect(updatedRow.reminder_claimed_at).toBeGreaterThanOrEqual(nowSeconds - 1);
	});

	it("5. Marks reminder success and prevents zombie worker duplicate delivery", async () => {
		const dueDate = getIsoOffsetDate(-60);
		const { meta } = await env.DB.prepare(
			`INSERT INTO tasks (telegram_user_id, title, due_date, reminder_status) VALUES (?, 'تسک موفقیت', ?, 'pending')`
		).bind(userId, dueDate).run();
		const taskId = meta.last_row_id;

		const token = "active_token_abc";
		await claimTaskForReminder(env.DB, taskId, dueDate, token);

		// Zombie worker tries with invalid token -> fails
		const zombieSuccess = await markReminderSuccess(env.DB, taskId, dueDate, "zombie_token_xyz");
		expect(zombieSuccess).toBe(false);

		// Legitimate worker marks success -> succeeds
		const validSuccess = await markReminderSuccess(env.DB, taskId, dueDate, token);
		expect(validSuccess).toBe(true);

		// Second call fails (idempotent / cannot re-mark sent)
		const repeatSuccess = await markReminderSuccess(env.DB, taskId, dueDate, token);
		expect(repeatSuccess).toBe(false);

		const row = await env.DB.prepare("SELECT reminder_sent, reminder_status, reminder_token, reminder_claimed_at, reminded_at FROM tasks WHERE id = ?").bind(taskId).first();
		expect(row.reminder_sent).toBe(1);
		expect(row.reminder_status).toBe("sent");
		expect(row.reminder_token).toBeNull();
		expect(row.reminder_claimed_at).toBeNull();
		expect(row.reminded_at).not.toBeNull();
	});

	it("6. Rejects in-flight worker when user reschedules due date", async () => {
		const initialDueDate = getIsoOffsetDate(-60);
		const { meta } = await env.DB.prepare(
			`INSERT INTO tasks (telegram_user_id, title, due_date, reminder_status) VALUES (?, 'تسک تغییر موعد', ?, 'pending')`
		).bind(userId, initialDueDate).run();
		const taskId = meta.last_row_id;

		const token = "flight_token_123";
		await claimTaskForReminder(env.DB, taskId, initialDueDate, token);

		// User edits due date while worker is in flight
		const newDueDate = getIsoOffsetDate(7200); // 2 hours later
		await editTask(env.DB, userId, taskId, { dueDate: newDueDate });

		// Worker attempts to mark success for the old due date -> REJECTED
		const success = await markReminderSuccess(env.DB, taskId, initialDueDate, token);
		expect(success).toBe(false);

		// Worker attempts to mark failure for the old due date -> REJECTED
		const failure = await markReminderFailure(env.DB, taskId, initialDueDate, token);
		expect(failure).toBe(false);

		// Task in DB retains new due date and reset pending state
		const row = await env.DB.prepare("SELECT due_date, reminder_status, reminder_sent FROM tasks WHERE id = ?").bind(taskId).first();
		expect(row.due_date).toBe(newDueDate);
		expect(row.reminder_status).toBe("pending");
		expect(row.reminder_sent).toBe(0);
	});

	it("7. Disables reminders when task is completed and rejects in-flight worker", async () => {
		const dueDate = getIsoOffsetDate(-60);
		const { meta } = await env.DB.prepare(
			`INSERT INTO tasks (telegram_user_id, title, due_date, reminder_status) VALUES (?, 'تسک تکمیل شده در پرواز', ?, 'pending')`
		).bind(userId, dueDate).run();
		const taskId = meta.last_row_id;

		const token = "in_flight_token";
		await claimTaskForReminder(env.DB, taskId, dueDate, token);

		// User completes task
		await updateTaskStatus(env.DB, userId, taskId, 1);

		// In-flight worker completion is rejected
		const success = await markReminderSuccess(env.DB, taskId, dueDate, token);
		expect(success).toBe(false);

		const row = await env.DB.prepare("SELECT is_completed, reminder_status, reminder_token FROM tasks WHERE id = ?").bind(taskId).first();
		expect(row.is_completed).toBe(1);
		expect(row.reminder_status).toBe("disabled");
		expect(row.reminder_token).toBeNull();
	});

	it("8. Restores reminder status across three time horizons when task is uncompleted", async () => {
		// Horizon 1: Task without specific time -> status becomes disabled
		const { meta: meta1 } = await env.DB.prepare(
			`INSERT INTO tasks (telegram_user_id, title, due_date, is_completed, reminder_status) VALUES (?, 'تسک بی ساعت', '2026-11-04', 1, 'disabled')`
		).bind(userId).run();
		await updateTaskStatus(env.DB, userId, meta1.last_row_id, 0);
		const row1 = await env.DB.prepare("SELECT reminder_status FROM tasks WHERE id = ?").bind(meta1.last_row_id).first();
		expect(row1.reminder_status).toBe("disabled");

		// Horizon 2: Task with future or recent due date (within 72h) -> becomes pending
		const recentDue = getIsoOffsetDate(-3600); // 1 hour ago
		const { meta: meta2 } = await env.DB.prepare(
			`INSERT INTO tasks (telegram_user_id, title, due_date, is_completed, reminder_status, reminder_sent) VALUES (?, 'تسک تازه', ?, 1, 'disabled', 1)`
		).bind(userId, recentDue).run();
		await updateTaskStatus(env.DB, userId, meta2.last_row_id, 0);
		const row2 = await env.DB.prepare("SELECT reminder_status, reminder_sent FROM tasks WHERE id = ?").bind(meta2.last_row_id).first();
		expect(row2.reminder_status).toBe("pending");
		expect(row2.reminder_sent).toBe(0);

		// Horizon 3: Task older than 72 hours -> becomes missed
		const ancientDue = getIsoOffsetDate(-80 * 3600); // 80 hours ago
		const { meta: meta3 } = await env.DB.prepare(
			`INSERT INTO tasks (telegram_user_id, title, due_date, is_completed, reminder_status) VALUES (?, 'تسک باستانی', ?, 1, 'disabled')`
		).bind(userId, ancientDue).run();
		await updateTaskStatus(env.DB, userId, meta3.last_row_id, 0);
		const row3 = await env.DB.prepare("SELECT reminder_status FROM tasks WHERE id = ?").bind(meta3.last_row_id).first();
		expect(row3.reminder_status).toBe("missed");
	});

	it("9. Handles retry count, exponential backoff, and transitions to abandoned after 3 attempts", async () => {
		const dueDate = getIsoOffsetDate(-60);
		const { meta } = await env.DB.prepare(
			`INSERT INTO tasks (telegram_user_id, title, due_date, reminder_status) VALUES (?, 'تسک تلاش مجدد', ?, 'pending')`
		).bind(userId, dueDate).run();
		const taskId = meta.last_row_id;

		// Attempt 1 Failure
		await claimTaskForReminder(env.DB, taskId, dueDate, "tok_att_1");
		const fail1 = await markReminderFailure(env.DB, taskId, dueDate, "tok_att_1");
		expect(fail1).toBe(true);

		let row = await env.DB.prepare("SELECT reminder_status, reminder_retry_count, reminder_retry_after FROM tasks WHERE id = ?").bind(taskId).first();
		expect(row.reminder_status).toBe("failed");
		expect(row.reminder_retry_count).toBe(1);
		const nowEpoch = Math.floor(Date.now() / 1000);
		expect(row.reminder_retry_after).toBeGreaterThanOrEqual(nowEpoch + 55);

		// Advance retry_after to now for test simulation
		await env.DB.prepare("UPDATE tasks SET reminder_retry_after = 0 WHERE id = ?").bind(taskId).run();

		// Attempt 2 Failure
		await claimTaskForReminder(env.DB, taskId, dueDate, "tok_att_2");
		const fail2 = await markReminderFailure(env.DB, taskId, dueDate, "tok_att_2");
		expect(fail2).toBe(true);

		row = await env.DB.prepare("SELECT reminder_status, reminder_retry_count, reminder_retry_after FROM tasks WHERE id = ?").bind(taskId).first();
		expect(row.reminder_status).toBe("failed");
		expect(row.reminder_retry_count).toBe(2);
		expect(row.reminder_retry_after).toBeGreaterThanOrEqual(nowEpoch + 170);

		// Advance retry_after to now
		await env.DB.prepare("UPDATE tasks SET reminder_retry_after = 0 WHERE id = ?").bind(taskId).run();

		// Attempt 3 Failure -> Transitions to abandoned
		await claimTaskForReminder(env.DB, taskId, dueDate, "tok_att_3");
		const fail3 = await markReminderFailure(env.DB, taskId, dueDate, "tok_att_3");
		expect(fail3).toBe(true);

		row = await env.DB.prepare("SELECT reminder_status, reminder_retry_count, reminder_retry_after FROM tasks WHERE id = ?").bind(taskId).first();
		expect(row.reminder_status).toBe("abandoned");
		expect(row.reminder_retry_count).toBe(3);
		expect(row.reminder_retry_after).toBe(0);
	});

	it("10. Transitions immediately to abandoned on permanent error (400/403)", async () => {
		const dueDate = getIsoOffsetDate(-60);
		const { meta } = await env.DB.prepare(
			`INSERT INTO tasks (telegram_user_id, title, due_date, reminder_status) VALUES (?, 'تسک خطای دائمی', ?, 'pending')`
		).bind(userId, dueDate).run();
		const taskId = meta.last_row_id;

		await claimTaskForReminder(env.DB, taskId, dueDate, "perm_token");
		const failed = await markReminderFailure(env.DB, taskId, dueDate, "perm_token", { isPermanent: true });
		expect(failed).toBe(true);

		const row = await env.DB.prepare("SELECT reminder_status, reminder_retry_count, reminder_retry_after FROM tasks WHERE id = ?").bind(taskId).first();
		expect(row.reminder_status).toBe("abandoned");
		expect(row.reminder_retry_count).toBe(1);
		expect(row.reminder_retry_after).toBe(0);
	});

	it("11. Supports custom retryAfterSeconds (e.g. from Telegram HTTP 429)", async () => {
		const dueDate = getIsoOffsetDate(-60);
		const { meta } = await env.DB.prepare(
			`INSERT INTO tasks (telegram_user_id, title, due_date, reminder_status) VALUES (?, 'تسک ریت لیمیت', ?, 'pending')`
		).bind(userId, dueDate).run();
		const taskId = meta.last_row_id;

		await claimTaskForReminder(env.DB, taskId, dueDate, "rate_limit_token");
		const failed = await markReminderFailure(env.DB, taskId, dueDate, "rate_limit_token", { retryAfterSeconds: 45 });
		expect(failed).toBe(true);

		const nowEpoch = Math.floor(Date.now() / 1000);
		const row = await env.DB.prepare("SELECT reminder_status, reminder_retry_after FROM tasks WHERE id = ?").bind(taskId).first();
		expect(row.reminder_status).toBe("failed");
		expect(row.reminder_retry_after).toBeGreaterThanOrEqual(nowEpoch + 44);
		expect(row.reminder_retry_after).toBeLessThanOrEqual(nowEpoch + 47);
	});

	it("12. Sweep moves expired and old tasks (>72h) to missed but never touches active leases", async () => {
		const nowSeconds = Math.floor(Date.now() / 1000);
		const dueOld75h = getIsoOffsetDate(-75 * 3600); // 75h ago
		const dueRecent10h = getIsoOffsetDate(-10 * 3600); // 10h ago

		// Task A: 75h ago, pending -> should be swept to missed
		const { meta: metaA } = await env.DB.prepare(
			`INSERT INTO tasks (telegram_user_id, title, due_date, reminder_status) VALUES (?, 'تسک A قدیمی', ?, 'pending')`
		).bind(userId, dueOld75h).run();

		// Task B: 75h ago, failed -> should be swept to missed
		const { meta: metaB } = await env.DB.prepare(
			`INSERT INTO tasks (telegram_user_id, title, due_date, reminder_status) VALUES (?, 'تسک B ناموفق', ?, 'failed')`
		).bind(userId, dueOld75h).run();

		// Task C: 75h ago, processing with EXPIRED lease (150s ago) -> should be swept to missed
		const { meta: metaC } = await env.DB.prepare(
			`INSERT INTO tasks (telegram_user_id, title, due_date, reminder_status, reminder_claimed_at, reminder_token)
			 VALUES (?, 'تسک C منقضی', ?, 'processing', ?, 'stale_tok')`
		).bind(userId, dueOld75h, nowSeconds - 150).run();

		// Task D: 75h ago, processing with ACTIVE lease (20s ago) -> should NOT be swept
		const { meta: metaD } = await env.DB.prepare(
			`INSERT INTO tasks (telegram_user_id, title, due_date, reminder_status, reminder_claimed_at, reminder_token)
			 VALUES (?, 'تسک D فعال', ?, 'processing', ?, 'active_tok')`
		).bind(userId, dueOld75h, nowSeconds - 20).run();

		// Task E: 10h ago, pending (within 72h) -> should NOT be swept
		const { meta: metaE } = await env.DB.prepare(
			`INSERT INTO tasks (telegram_user_id, title, due_date, reminder_status) VALUES (?, 'تسک E تازه', ?, 'pending')`
		).bind(userId, dueRecent10h).run();

		// Task F: 75h ago, already sent -> should NOT be swept
		const { meta: metaF } = await env.DB.prepare(
			`INSERT INTO tasks (telegram_user_id, title, due_date, reminder_status, reminder_sent) VALUES (?, 'تسک F ارسال شده', ?, 'sent', 1)`
		).bind(userId, dueOld75h).run();

		const sweptCount = await sweepMissedReminders(env.DB, 72);
		expect(sweptCount).toBe(3); // Tasks A, B, C

		const statusA = (await env.DB.prepare("SELECT reminder_status FROM tasks WHERE id = ?").bind(metaA.last_row_id).first()).reminder_status;
		const statusB = (await env.DB.prepare("SELECT reminder_status FROM tasks WHERE id = ?").bind(metaB.last_row_id).first()).reminder_status;
		const statusC = (await env.DB.prepare("SELECT reminder_status FROM tasks WHERE id = ?").bind(metaC.last_row_id).first()).reminder_status;
		const statusD = (await env.DB.prepare("SELECT reminder_status FROM tasks WHERE id = ?").bind(metaD.last_row_id).first()).reminder_status;
		const statusE = (await env.DB.prepare("SELECT reminder_status FROM tasks WHERE id = ?").bind(metaE.last_row_id).first()).reminder_status;
		const statusF = (await env.DB.prepare("SELECT reminder_status FROM tasks WHERE id = ?").bind(metaF.last_row_id).first()).reminder_status;

		expect(statusA).toBe("missed");
		expect(statusB).toBe("missed");
		expect(statusC).toBe("missed");
		expect(statusD).toBe("processing"); // Active lease preserved!
		expect(statusE).toBe("pending");    // Recent task preserved!
		expect(statusF).toBe("sent");       // Sent task preserved!
	});

	it("13. Resets reminder lifecycle on editTask when date is removed or changed to date-only", async () => {
		const dueDate = getIsoOffsetDate(-60);
		const { meta } = await env.DB.prepare(
			`INSERT INTO tasks (telegram_user_id, title, due_date, reminder_status, reminder_token) VALUES (?, 'تسک حذف تاریخ', ?, 'processing', 'some_tok')`
		).bind(userId, dueDate).run();
		const taskId = meta.last_row_id;

		// Remove due date (dueDate: null)
		await editTask(env.DB, userId, taskId, { dueDate: null });

		let row = await env.DB.prepare("SELECT due_date, reminder_status, reminder_token FROM tasks WHERE id = ?").bind(taskId).first();
		expect(row.due_date).toBeNull();
		expect(row.reminder_status).toBe("disabled");
		expect(row.reminder_token).toBeNull();

		// Change to date-only (no time)
		await editTask(env.DB, userId, taskId, { dueDate: "2026-11-05" });
		row = await env.DB.prepare("SELECT due_date, reminder_status FROM tasks WHERE id = ?").bind(taskId).first();
		expect(row.due_date).toBe("2026-11-05");
		expect(row.reminder_status).toBe("disabled");
	});
});
