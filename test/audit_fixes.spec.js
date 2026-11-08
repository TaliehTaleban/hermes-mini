import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import worker from "../src/index.js";
import { handleIncomingMessage } from "../src/handler.js";
import {
	createTask,
	listTasks,
	reserveTelegramUpdate,
	markUpdateCompleted,
	markUpdateFailed,
	getDisplayedTaskList,
	saveDisplayedTaskList,
} from "../src/db.js";
import { dispatchLocalAction } from "../src/localDispatcher.js";
import { formatPersianDateTime } from "../src/dateUtils.js";

async function initDatabase(db) {
	await db.prepare(
		`CREATE TABLE IF NOT EXISTS tasks (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			telegram_user_id TEXT NOT NULL,
			title TEXT NOT NULL,
			is_completed INTEGER NOT NULL DEFAULT 0,
			due_date TEXT,
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
		`CREATE TABLE IF NOT EXISTS processed_updates (
			update_id TEXT PRIMARY KEY,
			status TEXT NOT NULL DEFAULT 'processing',
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		)`
	).run();
}

describe("Critical Audit Resolution Tests", () => {
	const userId = "888999";

	beforeEach(async () => {
		await initDatabase(env.DB);
		await env.DB.prepare("DELETE FROM tasks").run();
		await env.DB.prepare("DELETE FROM conversation_messages").run();
		await env.DB.prepare("DELETE FROM user_displayed_lists").run();
		await env.DB.prepare("DELETE FROM processed_updates").run();
	});

	describe("Stage 1: Atomic Deduplication & State Machine", () => {
		it("atomically reserves an update and blocks concurrent processing", async () => {
			const updateId = "audit-update-101";

			// First reservation succeeds
			const res1 = await reserveTelegramUpdate(env.DB, updateId);
			expect(res1.state).toBe("reserved");

			// Concurrent attempt is blocked with 'in_progress'
			const res2 = await reserveTelegramUpdate(env.DB, updateId);
			expect(res2.state).toBe("in_progress");

			// Completed update is never processed again
			await markUpdateCompleted(env.DB, updateId);
			const res3 = await reserveTelegramUpdate(env.DB, updateId);
			expect(res3.state).toBe("completed");
		});

		it("reclaims stale processing reservations (>60s) for safe recovery", async () => {
			const updateId = "audit-update-stale-102";

			// Insert a stuck update that started 90 seconds ago
			await env.DB.prepare(
				`INSERT INTO processed_updates (update_id, status, created_at, updated_at)
				 VALUES (?, 'processing', datetime('now', '-90 seconds'), datetime('now', '-90 seconds'))`
			).bind(updateId).run();

			// New worker instance reclaims the stale reservation
			const res = await reserveTelegramUpdate(env.DB, updateId, 60);
			expect(res.state).toBe("reserved");
		});

		it("allows immediate retry when an update failed", async () => {
			const updateId = "audit-update-failed-103";

			await reserveTelegramUpdate(env.DB, updateId);
			await markUpdateFailed(env.DB, updateId);

			// Reclaiming failed update succeeds immediately
			const res = await reserveTelegramUpdate(env.DB, updateId);
			expect(res.state).toBe("reserved");
		});
	});

	describe("Stage 2: Displayed List Lifecycle & TTL", () => {
		it("enforces 30-minute TTL on displayed task lists", async () => {
			// Save list from 35 minutes ago
			await env.DB.prepare(
				`INSERT INTO user_displayed_lists (telegram_user_id, task_ids_json, updated_at)
				 VALUES (?, ?, datetime('now', '-35 minutes'))`
			).bind(userId, JSON.stringify([10, 20, 30])).run();

			const list = await getDisplayedTaskList(env.DB, userId, 30);
			expect(list.isExpired).toBe(true);
			expect(list.length).toBe(0);
		});

		it("asks for clarification rather than guessing when list is expired", async () => {
			// Create real tasks
			const t1 = await createTask(env.DB, userId, { title: "ورزش" });
			const t2 = await createTask(env.DB, userId, { title: "مطالعه" });

			// Expired list entry in DB
			await env.DB.prepare(
				`INSERT INTO user_displayed_lists (telegram_user_id, task_ids_json, updated_at)
				 VALUES (?, ?, datetime('now', '-40 minutes'))`
			).bind(userId, JSON.stringify([t1.id, t2.id])).run();

			const res = await handleIncomingMessage(env, {
				userId,
				text: "اولی رو انجام دادم",
			});

			expect(res.replyText).toContain("فهرست قبلی شما منقضی شده");
			
			// Verification: Task status was NOT altered blindly
			const freshT1 = await listTasks(env.DB, userId, "all");
			expect(freshT1[0].is_completed).toBe(0);
		});

		it("does NOT update user_displayed_lists when Telegram send fails", async () => {
			const originalFetch = globalThis.fetch;
			globalThis.fetch = async (url) => {
				if (typeof url === "string" && url.includes("api.telegram.org")) {
					return new Response(JSON.stringify({ ok: false, description: "Bad Gateway" }), {
						status: 502,
						headers: { "Content-Type": "application/json" },
					});
				}
				return originalFetch(url);
			};

			try {
				await createTask(env.DB, userId, { title: "کار شماره ۱" });

				const payload = {
					update_id: 9911,
					message: {
						message_id: 1,
						from: { id: Number(userId), first_name: "User" },
						chat: { id: Number(userId) },
						date: 1730578800,
						text: "کارام رو نشون بده",
					},
				};

				const req = new Request("http://example.com/webhook", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(payload),
				});

				await worker.fetch(req, { ...env, TELEGRAM_BOT_TOKEN: "mock-bot-token" });

				// Verification: Because Telegram failed, user_displayed_lists must be empty
				const displayed = await env.DB.prepare(
					"SELECT * FROM user_displayed_lists WHERE telegram_user_id = ?"
				).bind(userId).first();

				expect(displayed).toBeNull();
			} finally {
				globalThis.fetch = originalFetch;
			}
		});
	});

	describe("Stage 3: Local Dispatcher Tuning", () => {
		it("detects task addition when preceded by conversational greeting", () => {
			const action1 = dispatchLocalAction("سلام فردا ساعت ۵ باید برم دکتر");
			expect(action1).not.toBeNull();
			expect(action1.intent).toBe("add");
			expect(action1.title).toContain("برم دکتر");
			expect(action1.due_date).toBeDefined();

			const action2 = dispatchLocalAction("سلام، فردا باید برای امتحان درس بخونم");
			expect(action2).not.toBeNull();
			expect(action2.intent).toBe("add");
			expect(action2.title).toContain("درس بخونم");
		});

		it("detects «ریاضی تمومه» as done status intent", () => {
			const action = dispatchLocalAction("ریاضی تمومه");
			expect(action).not.toBeNull();
			expect(action.intent).toBe("done");
			expect(action.target_query).toBe("ریاضی");
		});

		it("does NOT convert question starting with «میخوام بدونم» into a task", () => {
			const action = dispatchLocalAction("میخوام بدونم فردا تعطیله یا نه");
			expect(action).not.toBeNull();
			expect(action.intent).not.toBe("add");
		});
	});

	describe("Stage 4: Date & Time Normalization", () => {
		it("does NOT display fake 00:00 time for date-only tasks", () => {
			// Date-only string (tomorrow)
			const now = new Date();
			const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
			const yStr = tomorrow.getFullYear();
			const mStr = String(tomorrow.getMonth() + 1).padStart(2, "0");
			const dStr = String(tomorrow.getDate()).padStart(2, "0");
			const iso = `${yStr}-${mStr}-${dStr}`;
			const formatted = formatPersianDateTime(iso);

			expect(formatted).not.toContain("00:00");
			expect(formatted).not.toContain("۰۰:۰۰");
			expect(formatted).toContain("فردا");
		});
	});
});
