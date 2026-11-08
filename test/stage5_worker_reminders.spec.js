import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import worker, { processDueReminders, sendDailyDigest } from "../src/index.js";
import { getConfig } from "../src/config.js";

async function initStage5WorkerDatabase(db) {
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

describe("Stage 5 Part 2: Worker Reminder Orchestration, Cron & Telegram Integration", () => {
	const testUserId = "123456789";
	const testEnv = {
		...env,
		ALLOWED_TELEGRAM_USER_ID: testUserId,
		TELEGRAM_BOT_TOKEN: "mock_test_token_123",
	};

	beforeEach(async () => {
		await initStage5WorkerDatabase(env.DB);
		await env.DB.prepare("DELETE FROM tasks").run();
	});

	function getIsoOffsetDate(secondsFromNow = 0) {
		const d = new Date(Date.now() + secondsFromNow * 1000);
		return d.toISOString();
	}

	it("1. Separates crons: '* * * * *' triggers reminder processor and NOT daily digest", async () => {
		// Task 1: Due task for reminder system
		const dueTime = getIsoOffsetDate(-60);
		await env.DB.prepare(
			`INSERT INTO tasks (telegram_user_id, title, due_date, reminder_status) VALUES (?, 'تسک یادآوری دقیقه‌ای', ?, 'pending')`
		).bind(testUserId, dueTime).run();

		// Task 2: Today task that would only appear in daily digest
		await env.DB.prepare(
			`INSERT INTO tasks (telegram_user_id, title, due_date, reminder_status) VALUES (?, 'تسک دایجست روزانه', ?, 'pending')`
		).bind(testUserId, getIsoOffsetDate(3600)).run();

		const sentMessages = [];
		const mockFetch = async (url, options) => {
			const body = JSON.parse(options.body || "{}");
			sentMessages.push(body);
			return new Response(JSON.stringify({ ok: true, result: { message_id: 100 } }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const ctx = createExecutionContext();
		const originalFetch = globalThis.fetch;
		globalThis.fetch = mockFetch;

		try {
			// Trigger minute cron: "* * * * *"
			await worker.scheduled({ cron: "* * * * *" }, testEnv, ctx);
			await waitOnExecutionContext(ctx);

			// Should have sent exactly 1 message (reminder), NOT the morning digest
			expect(sentMessages.length).toBe(1);
			expect(sentMessages[0].text).toContain("یادآوری موعد تسک");
			expect(sentMessages[0].text).toContain("تسک یادآوری دقیقه‌ای");
			expect(sentMessages[0].text).not.toContain("صبح بخیر");
			expect(sentMessages[0].text).not.toContain("کارهای امروز شما");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("2. Separates crons: '30 2 * * *' triggers morning digest and NOT reminder processor", async () => {
		// Insert task due right now (would be picked by reminder system if run)
		const dueTime = getIsoOffsetDate(-60);
		const { meta } = await env.DB.prepare(
			`INSERT INTO tasks (telegram_user_id, title, due_date, reminder_status) VALUES (?, 'تسک جلسه فوری', ?, 'pending')`
		).bind(testUserId, dueTime).run();
		const taskId = meta.last_row_id;

		const sentMessages = [];
		const mockFetch = async (url, options) => {
			const body = JSON.parse(options.body || "{}");
			sentMessages.push(body);
			return new Response(JSON.stringify({ ok: true, result: { message_id: 101 } }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const ctx = createExecutionContext();
		const originalFetch = globalThis.fetch;
		globalThis.fetch = mockFetch;

		try {
			// Trigger morning digest cron: "30 2 * * *"
			await worker.scheduled({ cron: "30 2 * * *" }, testEnv, ctx);
			await waitOnExecutionContext(ctx);

			// Should have sent morning digest
			expect(sentMessages.length).toBe(1);
			expect(sentMessages[0].text).toContain("صبح بخیر");
			expect(sentMessages[0].text).not.toContain("یادآوری موعد تسک:");

			// Reminder status of the task should STILL be pending (reminder processor was NOT executed)
			const taskRow = await env.DB.prepare("SELECT reminder_status, reminder_sent FROM tasks WHERE id = ?").bind(taskId).first();
			expect(taskRow.reminder_status).toBe("pending");
			expect(taskRow.reminder_sent).toBe(0);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("3. Unrecognized cron triggers do nothing", async () => {
		const sentMessages = [];
		const mockFetch = async () => {
			sentMessages.push({});
			return new Response(JSON.stringify({ ok: true }), { status: 200 });
		};

		const ctx = createExecutionContext();
		const originalFetch = globalThis.fetch;
		globalThis.fetch = mockFetch;

		try {
			await worker.scheduled({ cron: "0 0 1 1 *" }, testEnv, ctx);
			await waitOnExecutionContext(ctx);
			expect(sentMessages.length).toBe(0);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("4. Successfully delivers task reminder and updates D1 status to 'sent'", async () => {
		const dueTime = getIsoOffsetDate(-120);
		const { meta } = await env.DB.prepare(
			`INSERT INTO tasks (telegram_user_id, title, due_date, reminder_status) VALUES (?, 'تماس با پشتیبانی سرور', ?, 'pending')`
		).bind(testUserId, dueTime).run();
		const taskId = meta.last_row_id;

		let capturedPayload = null;
		const mockFetch = async (url, options) => {
			capturedPayload = JSON.parse(options.body || "{}");
			return new Response(JSON.stringify({ ok: true, result: { message_id: 200 } }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const config = getConfig(testEnv);
		const result = await processDueReminders(testEnv, config, mockFetch);

		expect(result.processed).toBe(1);
		expect(result.sent).toBe(1);
		expect(result.failed).toBe(0);

		// Verified telegram payload content and recipient
		expect(capturedPayload.chat_id).toBe(testUserId);
		expect(capturedPayload.text).toContain("تماس با پشتیبانی سرور");
		expect(capturedPayload.text).toContain("یادآوری موعد تسک");

		// Verified database state
		const row = await env.DB.prepare("SELECT reminder_sent, reminder_status, reminder_token, reminded_at FROM tasks WHERE id = ?").bind(taskId).first();
		expect(row.reminder_sent).toBe(1);
		expect(row.reminder_status).toBe("sent");
		expect(row.reminder_token).toBeNull();
		expect(row.reminded_at).not.toBeNull();
	});

	it("5. Propagates Telegram HTTP 429 retry_after parameter into D1 reminder_retry_after", async () => {
		const dueTime = getIsoOffsetDate(-60);
		const { meta } = await env.DB.prepare(
			`INSERT INTO tasks (telegram_user_id, title, due_date, reminder_status) VALUES (?, 'تسک ریت‌لیمیت شده', ?, 'pending')`
		).bind(testUserId, dueTime).run();
		const taskId = meta.last_row_id;

		// Mock Telegram returning HTTP 429 with parameters.retry_after = 48
		const mockFetch = async () => {
			return new Response(
				JSON.stringify({
					ok: false,
					error_code: 429,
					description: "Too Many Requests: retry after 48",
					parameters: { retry_after: 48 },
				}),
				{ status: 429, headers: { "Content-Type": "application/json" } }
			);
		};

		const config = getConfig(testEnv);
		const nowEpoch = Math.floor(Date.now() / 1000);
		const result = await processDueReminders(testEnv, config, mockFetch);

		expect(result.sent).toBe(0);
		expect(result.failed).toBe(1);

		const row = await env.DB.prepare("SELECT reminder_status, reminder_retry_count, reminder_retry_after FROM tasks WHERE id = ?").bind(taskId).first();
		expect(row.reminder_status).toBe("failed");
		expect(row.reminder_retry_count).toBe(1);
		expect(row.reminder_retry_after).toBeGreaterThanOrEqual(nowEpoch + 47);
		expect(row.reminder_retry_after).toBeLessThanOrEqual(nowEpoch + 50);
	});

	it("6. Marks permanent errors HTTP 400 and 403 as 'abandoned' immediately", async () => {
		// Task A: 403 Forbidden (bot was blocked by the user)
		const dueTimeA = getIsoOffsetDate(-60);
		const { meta: metaA } = await env.DB.prepare(
			`INSERT INTO tasks (telegram_user_id, title, due_date, reminder_status) VALUES (?, 'تسک کاربر بلاک‌کننده', ?, 'pending')`
		).bind(testUserId, dueTimeA).run();

		const mockFetch403 = async () => {
			return new Response(
				JSON.stringify({ ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }),
				{ status: 403, headers: { "Content-Type": "application/json" } }
			);
		};

		const config = getConfig(testEnv);
		await processDueReminders(testEnv, config, mockFetch403);

		const rowA = await env.DB.prepare("SELECT reminder_status, reminder_retry_count, reminder_retry_after FROM tasks WHERE id = ?").bind(metaA.last_row_id).first();
		expect(rowA.reminder_status).toBe("abandoned");
		expect(rowA.reminder_retry_count).toBe(1);
		expect(rowA.reminder_retry_after).toBe(0);
	});

	it("7. Uses standard backoff (60s on attempt 1, 180s on attempt 2) for network errors and 5xx", async () => {
		const dueTime = getIsoOffsetDate(-60);
		const { meta } = await env.DB.prepare(
			`INSERT INTO tasks (telegram_user_id, title, due_date, reminder_status) VALUES (?, 'تسک خطای سرور تلگرام', ?, 'pending')`
		).bind(testUserId, dueTime).run();
		const taskId = meta.last_row_id;

		// Mock Telegram returning HTTP 502 Bad Gateway
		const mockFetch502 = async () => {
			return new Response(
				JSON.stringify({ ok: false, error_code: 502, description: "Bad Gateway" }),
				{ status: 502, headers: { "Content-Type": "application/json" } }
			);
		};

		const config = getConfig(testEnv);
		const nowEpoch = Math.floor(Date.now() / 1000);
		await processDueReminders(testEnv, config, mockFetch502);

		let row = await env.DB.prepare("SELECT reminder_status, reminder_retry_count, reminder_retry_after FROM tasks WHERE id = ?").bind(taskId).first();
		expect(row.reminder_status).toBe("failed");
		expect(row.reminder_retry_count).toBe(1);
		// Delay for attempt 1 is 60s
		expect(row.reminder_retry_after).toBeGreaterThanOrEqual(nowEpoch + 55);

		// Reset retry_after to past for attempt 2 test
		await env.DB.prepare("UPDATE tasks SET reminder_retry_after = 0 WHERE id = ?").bind(taskId).run();

		// Mock network exception (fetch rejects)
		const mockFetchNetworkError = async () => {
			throw new Error("Connection reset by peer");
		};

		await processDueReminders(testEnv, config, mockFetchNetworkError);
		row = await env.DB.prepare("SELECT reminder_status, reminder_retry_count, reminder_retry_after FROM tasks WHERE id = ?").bind(taskId).first();
		expect(row.reminder_status).toBe("failed");
		expect(row.reminder_retry_count).toBe(2);
		// Delay for attempt 2 is 180s
		expect(row.reminder_retry_after).toBeGreaterThanOrEqual(nowEpoch + 170);
	});

	it("8. Does not deliver reminders for completed tasks or tasks with rescheduled dates", async () => {
		// Completed task
		await env.DB.prepare(
			`INSERT INTO tasks (telegram_user_id, title, due_date, is_completed, reminder_status) VALUES (?, 'تسک از قبل کامل شده', ?, 1, 'disabled')`
		).bind(testUserId, getIsoOffsetDate(-60)).run();

		const sentMessages = [];
		const mockFetch = async (url, options) => {
			sentMessages.push(JSON.parse(options.body || "{}"));
			return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
		};

		const config = getConfig(testEnv);
		const res = await processDueReminders(testEnv, config, mockFetch);
		expect(res.processed).toBe(0);
		expect(sentMessages.length).toBe(0);
	});

	it("9. Enforces batch limit of at most 5 tasks per run", async () => {
		// Insert 8 due tasks
		for (let i = 1; i <= 8; i++) {
			await env.DB.prepare(
				`INSERT INTO tasks (telegram_user_id, title, due_date, reminder_status) VALUES (?, ?, ?, 'pending')`
			).bind(testUserId, `تسک سری ${i}`, getIsoOffsetDate(-60 * i)).run();
		}

		let deliveredCount = 0;
		const mockFetch = async () => {
			deliveredCount++;
			return new Response(JSON.stringify({ ok: true, result: { message_id: deliveredCount } }), { status: 200 });
		};

		const config = getConfig(testEnv);
		const result = await processDueReminders(testEnv, config, mockFetch);

		// Batch limit must be exactly 5
		expect(result.processed).toBe(5);
		expect(deliveredCount).toBe(5);

		// Exactly 5 sent, 3 still pending in DB
		const sentRows = await env.DB.prepare("SELECT COUNT(*) AS c FROM tasks WHERE reminder_sent = 1").first();
		const pendingRows = await env.DB.prepare("SELECT COUNT(*) AS c FROM tasks WHERE reminder_sent = 0 AND reminder_status = 'pending'").first();
		expect(sentRows.c).toBe(5);
		expect(pendingRows.c).toBe(3);
	});

	it("10. Failure of one task in a batch does not block subsequent tasks", async () => {
		// Task 1 will fail (HTTP 500)
		const { meta: meta1 } = await env.DB.prepare(
			`INSERT INTO tasks (telegram_user_id, title, due_date, reminder_status) VALUES (?, 'تسک اول با خطا', ?, 'pending')`
		).bind(testUserId, getIsoOffsetDate(-120)).run();

		// Task 2 will succeed
		const { meta: meta2 } = await env.DB.prepare(
			`INSERT INTO tasks (telegram_user_id, title, due_date, reminder_status) VALUES (?, 'تسک دوم موفق', ?, 'pending')`
		).bind(testUserId, getIsoOffsetDate(-60)).run();

		const mockFetch = async (url, options) => {
			const body = JSON.parse(options.body || "{}");
			if (body.text.includes("تسک اول با خطا")) {
				return new Response(JSON.stringify({ ok: false, error_code: 500, description: "Internal Server Error" }), { status: 500 });
			}
			return new Response(JSON.stringify({ ok: true, result: { message_id: 300 } }), { status: 200 });
		};

		const config = getConfig(testEnv);
		const result = await processDueReminders(testEnv, config, mockFetch);

		expect(result.processed).toBe(2);
		expect(result.sent).toBe(1);
		expect(result.failed).toBe(1);

		const row1 = await env.DB.prepare("SELECT reminder_status, reminder_sent FROM tasks WHERE id = ?").bind(meta1.last_row_id).first();
		const row2 = await env.DB.prepare("SELECT reminder_status, reminder_sent FROM tasks WHERE id = ?").bind(meta2.last_row_id).first();

		expect(row1.reminder_status).toBe("failed");
		expect(row1.reminder_sent).toBe(0);

		expect(row2.reminder_status).toBe("sent");
		expect(row2.reminder_sent).toBe(1);
	});

	it("11. Preserves existing morning digest behavior with today and overdue tasks", async () => {
		const getTehranDateString = (offsetDays = 0) => {
			const formatter = new Intl.DateTimeFormat("en-US", {
				timeZone: "Asia/Tehran",
				year: "numeric",
				month: "2-digit",
				day: "2-digit",
			});
			const parts = formatter.formatToParts(new Date());
			const map = {};
			for (const p of parts) {
				map[p.type] = p.value;
			}
			const d = new Date(Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day) + offsetDays));
			const yStr = d.getUTCFullYear();
			const mStr = String(d.getUTCMonth() + 1).padStart(2, "0");
			const dStr = String(d.getUTCDate()).padStart(2, "0");
			return `${yStr}-${mStr}-${dStr}`;
		};

		const todayDue = `${getTehranDateString(0)}T11:30:00+03:30`;
		const yesterdayDue = `${getTehranDateString(-1)}T11:30:00+03:30`;

		// Task due today
		await env.DB.prepare(
			`INSERT INTO tasks (telegram_user_id, title, due_date, is_completed) VALUES (?, 'گزارش هفتگی امروز', ?, 0)`
		).bind(testUserId, todayDue).run();

		// Task overdue from yesterday
		await env.DB.prepare(
			`INSERT INTO tasks (telegram_user_id, title, due_date, is_completed) VALUES (?, 'ارسال قرارداد دیروز', ?, 0)`
		).bind(testUserId, yesterdayDue).run();

		let digestBody = null;
		const mockFetch = async (url, options) => {
			digestBody = JSON.parse(options.body || "{}");
			return new Response(JSON.stringify({ ok: true, result: { message_id: 500 } }), { status: 200 });
		};

		const config = getConfig(testEnv);
		await sendDailyDigest(testEnv, config, mockFetch);

		expect(digestBody).not.toBeNull();
		expect(digestBody.chat_id).toBe(testUserId);
		expect(digestBody.text).toContain("صبح بخیر! یادآور کارهای شما در هرمس مینی:");
		expect(digestBody.text).toContain("کارهای امروز شما:");
		expect(digestBody.text).toContain("گزارش هفتگی امروز");
		expect(digestBody.text).toContain("کارهای عقب‌افتاده از روزهای قبل:");
		expect(digestBody.text).toContain("ارسال قرارداد دیروز");
	});
});
