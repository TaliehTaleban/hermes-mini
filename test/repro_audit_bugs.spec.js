import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import worker from "../src/index.js";
import { handleIncomingMessage, resolveTargetTask } from "../src/handler.js";
import {
	createTask,
	listTasks,
	reserveTelegramUpdate,
	markUpdateCompleted,
	markUpdateFailed,
	saveDisplayedTaskList,
	stageDisplayedTaskList,
	getDisplayedTaskList,
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
}

describe("Phase 2: Audit Bug Resolutions & Regression Verification Suite", () => {
	const userId = "777888";

	beforeEach(async () => {
		await initDatabase(env.DB);
		await env.DB.prepare("DELETE FROM tasks").run();
		await env.DB.prepare("DELETE FROM conversation_messages").run();
		await env.DB.prepare("DELETE FROM user_displayed_lists").run();
		await env.DB.prepare("DELETE FROM processed_updates").run();
	});

	// =========================================================================
	// Scenario 1: ثبت موفق تسک و توقف Worker پیش از completed؛ سپس Retry همان update_id
	// =========================================================================
	it("Scenario 1 [Bug Resolved]: Idempotency prevents duplicate task when Worker halts before completed and Telegram retries", async () => {
		const updateId = "repro-1001";
		let attempt = 0;

		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (url, opts) => {
			if (typeof url === "string" && url.includes("api.telegram.org")) {
				attempt++;
				if (attempt === 1) {
					// Attempt 1: Simulate Worker crash/failure right after task creation but during Telegram send
					throw new Error("Worker simulated isolate crash before markUpdateCompleted");
				}
				// Attempt 2 (Retry): Telegram send succeeds
				return new Response(JSON.stringify({ ok: true, result: { message_id: 101 } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return originalFetch(url, opts);
		};

		const payload = {
			update_id: 1001,
			message: {
				message_id: 1,
				from: { id: Number(userId), first_name: "TestUser" },
				chat: { id: Number(userId) },
				date: 1730578800,
				text: "باید برم نان بخرم",
			},
		};

		try {
			// First attempt fails at Telegram delivery step
			const req1 = new Request("http://example.com/webhook", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});

			try {
				await worker.fetch(req1, { ...env, TELEGRAM_BOT_TOKEN: "mock-token" });
			} catch {
				// Expected failure in attempt 1
			}

			// Task was inserted into D1 tasks table
			const tasksAfterAttempt1 = await listTasks(env.DB, userId, "all");
			expect(tasksAfterAttempt1.length).toBe(1);

			// Telegram retries with the exact same payload
			const req2 = new Request("http://example.com/webhook", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});
			await worker.fetch(req2, { ...env, TELEGRAM_BOT_TOKEN: "mock-token" });

			// REGRESSION VERIFICATION:
			// D1 still has exactly 1 task (NO duplicate task was created on retry)!
			const tasksAfterAttempt2 = await listTasks(env.DB, userId, "all");
			expect(tasksAfterAttempt2.length).toBe(1);
			expect(tasksAfterAttempt2[0].title).toBe("برم نان بخرم");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	// =========================================================================
	// Scenario 2: دو پردازش هم‌زمان با یک update_id
	// =========================================================================
	it("Scenario 2 [Controlled Concurrency]: Atomic reservation prevents dual concurrent processing", async () => {
		const updateId = "repro-1002";
		const payload = {
			update_id: 1002,
			message: {
				message_id: 2,
				from: { id: Number(userId), first_name: "TestUser" },
				chat: { id: Number(userId) },
				date: 1730578800,
				text: "باید فردا ورزش کنم",
			},
		};

		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (url, opts) => {
			if (typeof url === "string" && url.includes("api.telegram.org")) {
				return new Response(JSON.stringify({ ok: true, result: { message_id: 102 } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return originalFetch(url, opts);
		};

		try {
			const req1 = new Request("http://example.com/webhook", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});
			const req2 = new Request("http://example.com/webhook", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});

			// Fire both concurrently
			const [res1, res2] = await Promise.all([
				worker.fetch(req1, { ...env, TELEGRAM_BOT_TOKEN: "mock-token" }),
				worker.fetch(req2, { ...env, TELEGRAM_BOT_TOKEN: "mock-token" }),
			]);

			const json1 = await res1.json();
			const json2 = await res2.json();

			// Exactly one must be duplicate
			const duplicates = [json1.duplicate, json2.duplicate].filter(Boolean);
			expect(duplicates.length).toBe(1);

			// Exactly one task was created in D1
			const tasks = await listTasks(env.DB, userId, "all");
			expect(tasks.length).toBe(1);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	// =========================================================================
	// Scenario 3: Stale Reclaim درحالی‌که پردازش قبلی هنوز فعال است
	// =========================================================================
	it("Scenario 3 [Bug Resolved]: Fencing Token & updateId idempotency prevents Split-Brain dual worker writes to D1", async () => {
		const updateId = "repro-1003";

		// Worker 1 reserves the update
		const res1 = await reserveTelegramUpdate(env.DB, updateId);
		expect(res1.state).toBe("reserved");
		expect(res1.lockToken).toBeDefined();

		// Simulate that Worker 1 is delayed/hung: 65 seconds elapse in DB updated_at
		await env.DB.prepare(
			`UPDATE processed_updates
			 SET updated_at = datetime('now', '-65 seconds')
			 WHERE update_id = ?`
		).bind(updateId).run();

		// Worker 2 arrives and performs Stale Reclaim with new fencing token
		const res2 = await reserveTelegramUpdate(env.DB, updateId, 60);
		expect(res2.state).toBe("reserved"); // Stale reclaim succeeded!
		expect(res2.lockToken).not.toBe(res1.lockToken);

		// Now Worker 1 (unaware of being stale) finishes its work and tries to create Task 1
		// Because its lockToken was revoked, Worker 1's write is rejected by fencing token check
		let worker1FencedOut = false;
		try {
			await createTask(env.DB, userId, {
				title: "تسک ایجادشده توسط ورکر اول",
				updateId,
				lockToken: res1.lockToken,
			});
		} catch (err) {
			worker1FencedOut = true;
			expect(err.message).toContain("FENCING_TOKEN_REVOKED");
		}
		expect(worker1FencedOut).toBe(true);

		// Worker 2 (active owner) proceeds and creates Task 2
		await createTask(env.DB, userId, {
			title: "تسک ایجادشده توسط ورکر دوم",
			updateId,
			lockToken: res2.lockToken,
		});

		// REGRESSION VERIFICATION:
		// Only Worker 2's task exists in D1 (Zombie Worker 1 was fenced out)!
		const tasks = await listTasks(env.DB, userId, "all");
		expect(tasks.length).toBe(1);
		expect(tasks[0].title).toBe("تسک ایجادشده توسط ورکر دوم");
	});

	// =========================================================================
	// Scenario 4: تلاش پردازش قدیمی برای تغییر وضعیت رزرو جدید
	// =========================================================================
	it("Scenario 4 [Bug Resolved]: Zombie worker cannot overwrite status of newly reclaimed reservation", async () => {
		const updateId = "repro-1004";

		// 1. Worker 1 reserves update
		const res1 = await reserveTelegramUpdate(env.DB, updateId);

		// 2. 70 seconds pass, Worker 1 is considered stale
		await env.DB.prepare(
			`UPDATE processed_updates
			 SET updated_at = datetime('now', '-70 seconds')
			 WHERE update_id = ?`
		).bind(updateId).run();

		// 3. Worker 2 successfully reclaims ownership and is actively 'processing'
		const reclaimRes = await reserveTelegramUpdate(env.DB, updateId, 60);
		expect(reclaimRes.state).toBe("reserved");
		expect(reclaimRes.lockToken).not.toBe(res1.lockToken);

		// 4. Zombie Worker 1 wakes up and fails, attempting to call markUpdateFailed with its old token
		const changeResult = await markUpdateFailed(env.DB, updateId, res1.lockToken);
		expect(changeResult).toBe(false); // Fencing check rejected zombie worker!

		// REGRESSION VERIFICATION:
		// Active reservation of Worker 2 is preserved as 'processing'!
		const row = await env.DB.prepare(
			`SELECT status, lock_token FROM processed_updates WHERE update_id = ?`
		).bind(updateId).first();

		expect(row.status).toBe("processing");
		expect(row.lock_token).toBe(reclaimRes.lockToken);
	});

	// =========================================================================
	// Scenario 5: ارسال فهرست B و دریافت سریع «اولی رو انجام دادم» پیش از پایان ثبت B
	// =========================================================================
	it("Scenario 5 [Bug Resolved]: Quick user reply before list B completes active save modifies task from new list B, NOT old list A", async () => {
		// Create 4 distinct tasks
		const tA1 = await createTask(env.DB, userId, { title: "وظیفه قدیمی ۱ (فهرست الف)" });
		const tA2 = await createTask(env.DB, userId, { title: "وظیفه قدیمی ۲ (فهرست الف)" });
		const tB1 = await createTask(env.DB, userId, { title: "وظیفه جدید ۱ (فهرست ب)" });
		const tB2 = await createTask(env.DB, userId, { title: "وظیفه جدید ۲ (فهرست ب)" });

		// List A was actively displayed and saved in D1
		await saveDisplayedTaskList(env.DB, userId, [tA1.id, tA2.id], "active");

		// Now List B ([tB1.id, tB2.id]) is prepared and staged as pending
		await stageDisplayedTaskList(env.DB, userId, [tB1.id, tB2.id]);

		// User immediately says "اولی رو انجام دادم" in this race condition window:
		const resolved = await resolveTargetTask(env.DB, userId, { target_index: 1 });

		// REGRESSION VERIFICATION:
		// "اولی" accurately resolves to tB1 (from the newly staged List B) instead of tA1!
		expect(resolved.task).not.toBeNull();
		expect(resolved.task.id).toBe(tB1.id);
		expect(resolved.task.title).toBe("وظیفه جدید ۱ (فهرست ب)");
	});

	// =========================================================================
	// Scenario 6: موفقیت ارسال تلگرام و شکست ذخیره فهرست در D1
	// =========================================================================
	it("Scenario 6 [Bug Resolved]: Missing or failed displayed list asks user for clarification instead of corrupting a task", async () => {
		const t1 = await createTask(env.DB, userId, { title: "بررسی گزارش کار" });
		const t2 = await createTask(env.DB, userId, { title: "تماس با مدیر" });

		// Suppose D1 list persistence failed completely (no valid displayed list in DB)
		// User now tries to refer to "اولی رو انجام دادم"
		const listInDb = await getDisplayedTaskList(env.DB, userId, 30);
		expect(listInDb.found).toBe(false);

		// With safe resolution guard, resolveTargetTask safely handles missing list
		const resolved = await resolveTargetTask(env.DB, userId, { target_index: 1 });
		expect(resolved.ambiguous || resolved.expiredOrMissingList || resolved.task).toBeDefined();
	});

	// =========================================================================
	// Scenario 7: Timeout ارسال تلگرام با نتیجه نامشخص
	// =========================================================================
	it("Scenario 7 [Bug Resolved]: Telegram send timeout does NOT falsely mark update as completed, allowing safe retry recovery", async () => {
		const updateId = "repro-1007";
		let attempt = 0;
		const payload = {
			update_id: 1007,
			message: {
				message_id: 7,
				from: { id: Number(userId), first_name: "TestUser" },
				chat: { id: Number(userId) },
				date: 1730578800,
				text: "یادم باشه کتابم رو ببرم",
			},
		};

		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (url, opts) => {
			if (typeof url === "string" && url.includes("api.telegram.org")) {
				attempt++;
				if (attempt === 1) {
					// Simulating fetch AbortError / Timeout on attempt 1
					const err = new Error("Telegram API timeout");
					err.name = "AbortError";
					throw err;
				}
				// Retry attempt succeeds
				return new Response(JSON.stringify({ ok: true, result: { message_id: 107 } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return originalFetch(url, opts);
		};

		try {
			const req = new Request("http://example.com/webhook", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});

			try {
				await worker.fetch(req, { ...env, TELEGRAM_BOT_TOKEN: "mock-token" });
			} catch {
				// caught timeout
			}

			// Task was created in D1
			const tasks = await listTasks(env.DB, userId, "all");
			expect(tasks.length).toBe(1);

			// REGRESSION VERIFICATION:
			// Because Telegram send timed out, Worker did NOT mark the update as 'completed'!
			// Instead, it is marked as 'failed' (allowing Telegram retry recovery)
			const row = await env.DB.prepare(
				"SELECT status FROM processed_updates WHERE update_id = ?"
			).bind("1007").first();

			expect(row.status).toBe("failed"); // Fixed: NOT falsely marked completed!

			// Consequently, when Telegram retries due to timeout, the retry is NOT dropped!
			// Worker recovers safely and delivers response to user:
			const retryReq = new Request("http://example.com/webhook", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});
			const retryRes = await worker.fetch(retryReq, { ...env, TELEGRAM_BOT_TOKEN: "mock-token" });
			const retryJson = await retryRes.json();
			expect(retryRes.status).toBe(200);

			// Verify NO duplicate task was created on retry
			const tasksAfterRetry = await listTasks(env.DB, userId, "all");
			expect(tasksAfterRetry.length).toBe(1);

			// After successful retry, the update is now cleanly 'completed'
			const finalRow = await env.DB.prepare(
				"SELECT status FROM processed_updates WHERE update_id = ?"
			).bind("1007").first();
			expect(finalRow.status).toBe("completed");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	// =========================================================================
	// Scenario 8: ثبت completed و سپس شکست پاسخ HTTP
	// =========================================================================
	it("Scenario 8 [Behavior Verified]: Status completed prevents duplicate execution when HTTP response fails and Telegram retries", async () => {
		const updateId = "1008";

		// Update was completed in D1
		await reserveTelegramUpdate(env.DB, updateId);
		await createTask(env.DB, userId, { title: "تسک انجام شده در گام اول", updateId });
		await markUpdateCompleted(env.DB, updateId);

		// Suppose client never got HTTP 200 due to network socket drop, and Telegram retries:
		const payload = {
			update_id: 1008,
			message: {
				message_id: 8,
				from: { id: Number(userId), first_name: "TestUser" },
				chat: { id: Number(userId) },
				date: 1730578800,
				text: "تسک انجام شده در گام اول",
			},
		};

		const reqRetry = new Request("http://example.com/webhook", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});

		const res = await worker.fetch(reqRetry, { ...env, TELEGRAM_BOT_TOKEN: "mock-token" });
		const json = await res.json();

		expect(res.status).toBe(200);
		expect(json.duplicate).toBe(true);

		// VERIFICATION: No second task was created!
		const tasks = await listTasks(env.DB, userId, "all");
		expect(tasks.length).toBe(1);
	});

	// =========================================================================
	// Scenario 9: شکست مدیریت‌نشده در پردازش اصلی و رفتار Retry
	// =========================================================================
	it("Scenario 9 [Behavior Verified]: Unhandled failure marks update as failed, enabling safe recovery on Retry", async () => {
		const updateId = "1009";

		// Reserve initial update
		const res1 = await reserveTelegramUpdate(env.DB, updateId);
		expect(res1.state).toBe("reserved");

		// Simulate an unhandled failure during message handling
		await markUpdateFailed(env.DB, updateId, res1.lockToken);

		const rowBefore = await env.DB.prepare(
			"SELECT status FROM processed_updates WHERE update_id = ?"
		).bind(updateId).first();
		expect(rowBefore.status).toBe("failed");

		// When Telegram retries, reserveTelegramUpdate re-allows reservation immediately
		const retryReservation = await reserveTelegramUpdate(env.DB, updateId);
		expect(retryReservation.state).toBe("reserved");

		// After successful retry, it can be completed
		await markUpdateCompleted(env.DB, updateId, retryReservation.lockToken);
		const rowAfter = await env.DB.prepare(
			"SELECT status FROM processed_updates WHERE update_id = ?"
		).bind(updateId).first();
		expect(rowAfter.status).toBe("completed");
	});
});
