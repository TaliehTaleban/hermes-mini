import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import worker, { processDueReminders, sendDailyDigest } from "../src/index.js";
import { handleIncomingMessage } from "../src/handler.js";
import { getConfig } from "../src/config.js";
import { createTask, listTasks, getDueTasksForReminder } from "../src/db.js";

async function initMultiUserDb(db) {
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
		`CREATE TABLE IF NOT EXISTS pending_confirmations (
			telegram_user_id TEXT PRIMARY KEY,
			action_type TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			expires_at INTEGER NOT NULL
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

describe("Hermes Mini - Multi-User Concurrent Support Suite", () => {
	const studentId = "111222333";
	const professorId = "444555666";
	const unauthorizedId = "999888777";

	const multiUserEnv = {
		...env,
		ALLOWED_TELEGRAM_USER_ID: `${studentId}, ${professorId}`,
		TELEGRAM_BOT_TOKEN: "mock_multi_user_token",
		TELEGRAM_WEBHOOK_SECRET: "test_secret_token",
	};

	beforeEach(async () => {
		await initMultiUserDb(env.DB);
		await env.DB.prepare("DELETE FROM tasks").run();
		await env.DB.prepare("DELETE FROM conversation_messages").run();
		await env.DB.prepare("DELETE FROM processed_updates").run();
		await env.DB.prepare("DELETE FROM user_displayed_lists").run();
		await env.DB.prepare("DELETE FROM pending_confirmations").run();
		await env.DB.prepare("DELETE FROM pending_clarifications").run();
	});

	describe("1. Configuration & Parsing", () => {
		it("parses multiple comma-separated IDs with whitespace cleanly", () => {
			const cfg = getConfig({ ALLOWED_TELEGRAM_USER_ID: "  111222333 ,  444555666 ,  " });
			expect(cfg.allowedUserIds).toEqual(["111222333", "444555666"]);
			expect(cfg.allowedUserId).toBe("111222333");
		});

		it("preserves backward compatibility with single ID string", () => {
			const cfg = getConfig({ ALLOWED_TELEGRAM_USER_ID: "111222333" });
			expect(cfg.allowedUserIds).toEqual(["111222333"]);
			expect(cfg.allowedUserId).toBe("111222333");
		});

		it("handles empty or missing ALLOWED_TELEGRAM_USER_ID safely", () => {
			const cfg = getConfig({});
			expect(cfg.allowedUserIds).toEqual([]);
			expect(cfg.allowedUserId).toBeNull();
		});
	});

	describe("2. Webhook & Handler Whitelist Filtering", () => {
		it("accepts student (User 1) and processes message", async () => {
			const req = new Request("http://localhost/", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Telegram-Bot-Api-Secret-Token": "test_secret_token",
				},
				body: JSON.stringify({
					update_id: 1001,
					message: {
						message_id: 1,
						from: { id: Number(studentId), first_name: "Student" },
						chat: { id: Number(studentId) },
						text: "یه تسک به اسم خرید کتاب ثبت کن",
					},
				}),
			});

			const mockFetch = async () =>
				new Response(JSON.stringify({ ok: true, result: { message_id: 10 } }), { status: 200 });

			const originalFetch = globalThis.fetch;
			globalThis.fetch = mockFetch;
			try {
				const res = await worker.fetch(req, multiUserEnv, createExecutionContext());
				expect(res.status).toBe(200);
				const json = await res.json();
				expect(json.ok).toBe(true);
				expect(json.unauthorized).toBeUndefined();

				// Task created in DB for student
				const studentTasks = await listTasks(env.DB, studentId, "all");
				expect(studentTasks.length).toBe(1);
				expect(studentTasks[0].title).toBe("خرید کتاب");
			} finally {
				globalThis.fetch = originalFetch;
			}
		});

		it("accepts professor (User 2) and processes message", async () => {
			const req = new Request("http://localhost/", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Telegram-Bot-Api-Secret-Token": "test_secret_token",
				},
				body: JSON.stringify({
					update_id: 1002,
					message: {
						message_id: 2,
						from: { id: Number(professorId), first_name: "Professor" },
						chat: { id: Number(professorId) },
						text: "یه تسک به اسم بررسی پروژه ثبت کن",
					},
				}),
			});

			const mockFetch = async () =>
				new Response(JSON.stringify({ ok: true, result: { message_id: 20 } }), { status: 200 });

			const originalFetch = globalThis.fetch;
			globalThis.fetch = mockFetch;
			try {
				const res = await worker.fetch(req, multiUserEnv, createExecutionContext());
				expect(res.status).toBe(200);
				const json = await res.json();
				expect(json.ok).toBe(true);
				expect(json.unauthorized).toBeUndefined();

				// Task created in DB for professor
				const profTasks = await listTasks(env.DB, professorId, "all");
				expect(profTasks.length).toBe(1);
				expect(profTasks[0].title).toBe("بررسی پروژه");
			} finally {
				globalThis.fetch = originalFetch;
			}
		});

		it("silently rejects unauthorized user (User 3) without executing DB queries or sending messages", async () => {
			let fetchCalled = false;
			const mockFetch = async () => {
				fetchCalled = true;
				return new Response(JSON.stringify({ ok: true }));
			};

			const req = new Request("http://localhost/", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Telegram-Bot-Api-Secret-Token": "test_secret_token",
				},
				body: JSON.stringify({
					update_id: 1003,
					message: {
						message_id: 3,
						from: { id: Number(unauthorizedId), first_name: "Hacker" },
						chat: { id: Number(unauthorizedId) },
						text: "یه تسک به اسم خرید غیرمجاز ثبت کن",
					},
				}),
			});

			const originalFetch = globalThis.fetch;
			globalThis.fetch = mockFetch;
			try {
				const res = await worker.fetch(req, multiUserEnv, createExecutionContext());
				expect(res.status).toBe(200);
				const json = await res.json();
				expect(json.ok).toBe(true);
				expect(json.ignored).toBe(true);
				expect(json.unauthorized).toBe(true);

				// No fetch was sent to Telegram
				expect(fetchCalled).toBe(false);

				// No tasks were created
				const tasks = await listTasks(env.DB, unauthorizedId, "all");
				expect(tasks.length).toBe(0);
			} finally {
				globalThis.fetch = originalFetch;
			}
		});
	});

	describe("3. Strict User Data Isolation", () => {
		it("keeps student and professor tasks, lists, and operations 100% segregated", async () => {
			// Student creates task
			await handleIncomingMessage(multiUserEnv, {
				userId: studentId,
				chatId: studentId,
				text: "یه تسک به اسم خرید کتاب مهندسی ثبت کن",
			});

			// Professor creates task
			await handleIncomingMessage(multiUserEnv, {
				userId: professorId,
				chatId: professorId,
				text: "یه تسک به اسم بررسی مقالات ژورنال ثبت کن",
			});

			// Student lists tasks
			const studentListRes = await handleIncomingMessage(multiUserEnv, {
				userId: studentId,
				chatId: studentId,
				text: "کارام رو نشون بده",
			});
			expect(studentListRes.replyText).toContain("خرید کتاب مهندسی");
			expect(studentListRes.replyText).not.toContain("بررسی مقالات ژورنال");

			// Professor lists tasks
			const profListRes = await handleIncomingMessage(multiUserEnv, {
				userId: professorId,
				chatId: professorId,
				text: "کارام رو نشون بده",
			});
			expect(profListRes.replyText).toContain("بررسی مقالات ژورنال");
			expect(profListRes.replyText).not.toContain("خرید کتاب مهندسی");

			// Student completes their first task («اولی رو انجام دادم»)
			const studentDoneRes = await handleIncomingMessage(multiUserEnv, {
				userId: studentId,
				chatId: studentId,
				text: "اولی انجام شد",
			});
			expect(studentDoneRes.replyText).toContain("انجام شد");

			// Professor's tasks are completely unaffected
			const profTasks = await listTasks(env.DB, professorId, "pending");
			expect(profTasks.length).toBe(1);
			expect(profTasks[0].is_completed).toBe(0);
			expect(profTasks[0].title).toBe("بررسی مقالات ژورنال");
		});
	});

	describe("4. Minute-by-Minute Cron Reminders Isolation", () => {
		it("sends each task reminder strictly to its respective owner", async () => {
			const dueTime = new Date(Date.now() - 60000).toISOString();

			// Task 1 belongs to student
			await env.DB.prepare(
				`INSERT INTO tasks (telegram_user_id, title, due_date, reminder_status) VALUES (?, 'موعد گزارش دانشجو', ?, 'pending')`
			).bind(studentId, dueTime).run();

			// Task 2 belongs to professor
			await env.DB.prepare(
				`INSERT INTO tasks (telegram_user_id, title, due_date, reminder_status) VALUES (?, 'موعد جلسه استاد', ?, 'pending')`
			).bind(professorId, dueTime).run();

			const sentDeliveries = [];
			const mockFetch = async (url, options) => {
				const body = JSON.parse(options.body || "{}");
				sentDeliveries.push({
					chat_id: String(body.chat_id),
					text: body.text,
				});
				return new Response(JSON.stringify({ ok: true, result: { message_id: 101 } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			};

			const ctx = createExecutionContext();
			const originalFetch = globalThis.fetch;
			globalThis.fetch = mockFetch;

			try {
				await worker.scheduled({ cron: "* * * * *" }, multiUserEnv, ctx);
				await waitOnExecutionContext(ctx);

				expect(sentDeliveries.length).toBe(2);

				// Student received their own reminder
				const studentDelivery = sentDeliveries.find((d) => d.chat_id === studentId);
				expect(studentDelivery).toBeDefined();
				expect(studentDelivery.text).toContain("موعد گزارش دانشجو");
				expect(studentDelivery.text).not.toContain("موعد جلسه استاد");

				// Professor received their own reminder
				const profDelivery = sentDeliveries.find((d) => d.chat_id === professorId);
				expect(profDelivery).toBeDefined();
				expect(profDelivery.text).toContain("موعد جلسه استاد");
				expect(profDelivery.text).not.toContain("موعد گزارش دانشجو");
			} finally {
				globalThis.fetch = originalFetch;
			}
		});
	});

	describe("5. Morning Daily Digest (6 AM Cron) Multi-User Support", () => {
		it("sends independent morning digests to each authorized user with their own tasks", async () => {
			const todayIso = new Date().toISOString().slice(0, 10) + "T14:00:00+03:30";

			// Student has a task due today
			await env.DB.prepare(
				`INSERT INTO tasks (telegram_user_id, title, due_date, reminder_status) VALUES (?, 'تحویل پروژه هرمس مینی', ?, 'pending')`
			).bind(studentId, todayIso).run();

			// Professor has NO tasks
			// (Professor should get the friendly empty morning message)

			const digestDeliveries = [];
			const mockFetch = async (url, options) => {
				const body = JSON.parse(options.body || "{}");
				digestDeliveries.push({
					chat_id: String(body.chat_id),
					text: body.text,
				});
				return new Response(JSON.stringify({ ok: true, result: { message_id: 202 } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			};

			const ctx = createExecutionContext();
			const originalFetch = globalThis.fetch;
			globalThis.fetch = mockFetch;

			try {
				await worker.scheduled({ cron: "30 2 * * *" }, multiUserEnv, ctx);
				await waitOnExecutionContext(ctx);

				expect(digestDeliveries.length).toBe(2);

				// Student received their digest with their task
				const studentDigest = digestDeliveries.find((d) => d.chat_id === studentId);
				expect(studentDigest).toBeDefined();
				expect(studentDigest.text).toContain("تحویل پروژه هرمس مینی");

				// Professor received the empty morning message
				const profDigest = digestDeliveries.find((d) => d.chat_id === professorId);
				expect(profDigest).toBeDefined();
				expect(profDigest.text).toContain("امروز هیچ کاری در برنامه شما نیست");
				expect(profDigest.text).not.toContain("تحویل پروژه هرمس مینی");
			} finally {
				globalThis.fetch = originalFetch;
			}
		});
	});
});
