import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { handleIncomingMessage } from "../src/handler.js";
import { createTask, findTaskByQuery, getPendingClarification, ensurePendingClarificationsTable } from "../src/db.js";

async function initDatabase(db) {
	await db.prepare(
		`CREATE TABLE IF NOT EXISTS tasks (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			telegram_user_id TEXT NOT NULL,
			title TEXT NOT NULL,
			is_completed INTEGER NOT NULL DEFAULT 0,
			due_date TEXT,
			reminder_status TEXT DEFAULT 'pending',
			reminder_time TEXT,
			reminder_attempt_count INTEGER DEFAULT 0,
			reminder_retry_after TEXT,
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

	await ensurePendingClarificationsTable(db);
}

describe("Phase 3: Date Validation in Handler (Local Dispatcher and Gemini)", () => {
	const userId = "test_user_p3";
	// Fixed base: Friday 16 Aban 1405 (2026-11-06T12:00:00Z)
	const baseDate = new Date("2026-11-06T12:00:00Z");

	const geminiEnv = {
		...env,
		LLM_API_KEY: "test_key",
		ALLOWED_TELEGRAM_USER_ID: "",
	};

	beforeEach(async () => {
		await initDatabase(env.DB);
		await env.DB.prepare("DELETE FROM tasks").run();
		await env.DB.prepare("DELETE FROM conversation_messages").run();
		await env.DB.prepare("DELETE FROM pending_clarifications").run();
	});

	describe("1. Local Dispatcher Path Validation", () => {
		it("accepts valid solar date in Add («برای ۸ آذر خرید کتاب دارم»)", async () => {
			const res = await handleIncomingMessage(env, {
				userId,
				text: "برای ۸ آذر خرید کتاب دارم",
			}, { baseDate });

			expect(res.authorized).toBe(true);
			expect(res.intent).toBe("add");
			expect(res.replyText).toContain("خرید کتاب دارم");
			expect(res.replyText).toContain("۸ آذر");

			const task = await findTaskByQuery(env.DB, userId, "خرید کتاب");
			expect(task).not.toBeNull();
			expect(task.title).toBe("خرید کتاب دارم");
			expect(task.due_date).toBe("2026-11-29");
		});

		it("accepts valid relative date in Add («سه روز دیگه برم استخر»)", async () => {
			const res = await handleIncomingMessage(env, {
				userId,
				text: "سه روز دیگه برم استخر",
			}, { baseDate });

			expect(res.authorized).toBe(true);
			expect(res.intent).toBe("add");
			expect(res.replyText).toContain("برم استخر");

			const task = await findTaskByQuery(env.DB, userId, "استخر");
			expect(task).not.toBeNull();
			expect(task.due_date).toBe("2026-11-09");
		});

		it("rejects past solar date in Add («برای ۱۵ آبان ۱۴۰۴ خرید کتاب دارم»)", async () => {
			const res = await handleIncomingMessage(env, {
				userId,
				text: "برای ۱۵ آبان ۱۴۰۴ خرید کتاب دارم",
			}, { baseDate });

			expect(res.authorized).toBe(true);
			expect(res.intent).toBe("clarify");
			expect(res.replyText).toContain("گذشته است");

			const task = await findTaskByQuery(env.DB, userId, "خرید کتاب");
			expect(task).toBeNull();
		});

		it("rejects invalid solar date in Add («برای ۳۱ مهر خرید کتاب دارم»)", async () => {
			const res = await handleIncomingMessage(env, {
				userId,
				text: "برای ۳۱ مهر خرید کتاب دارم",
			}, { baseDate });

			expect(res.authorized).toBe(true);
			expect(res.intent).toBe("clarify");
			expect(res.replyText).toContain("نامعتبر است");

			const task = await findTaskByQuery(env.DB, userId, "خرید کتاب");
			expect(task).toBeNull();
		});

		it("rejects date beyond 1 calendar year in Add («برای ۱۵ آبان ۱۴۰۸ خرید کتاب دارم»)", async () => {
			const res = await handleIncomingMessage(env, {
				userId,
				text: "برای ۱۵ آبان ۱۴۰۸ خرید کتاب دارم",
			}, { baseDate });

			expect(res.authorized).toBe(true);
			expect(res.intent).toBe("clarify");
			expect(res.replyText).toContain("یک سال");

			const task = await findTaskByQuery(env.DB, userId, "خرید کتاب");
			expect(task).toBeNull();
		});

		it("handles ambiguous hour in Add: preserves targetDateStr, asks clarification, and resolves on follow-up", async () => {
			// Step 1: Send message with ambiguous hour 5
			const res1 = await handleIncomingMessage(env, {
				userId,
				text: "۸ آذر ساعت ۵ کلاس زبان دارم",
			}, { baseDate });

			expect(res1.authorized).toBe(true);
			expect(res1.intent).toBe("clarify");
			expect(res1.replyText).toContain("ساعت ۵ صبح است یا ۵ عصر");

			// Verify NO task was saved in DB
			const taskBefore = await findTaskByQuery(env.DB, userId, "کلاس زبان");
			expect(taskBefore).toBeNull();

			// Verify pending clarification was persisted with targetDateStr
			const pending = await getPendingClarification(env.DB, userId);
			expect(pending).not.toBeNull();
			expect(pending.actionType).toBe("add");
			expect(pending.payload.title).toContain("کلاس زبان");
			expect(pending.payload.targetDateStr).toBe("2026-11-29");
			expect(pending.payload.ambiguousHour).toBe(5);

			// Step 2: User responds with "عصر"
			const res2 = await handleIncomingMessage(env, {
				userId,
				text: "عصر",
			}, { baseDate });

			expect(res2.authorized).toBe(true);
			expect(res2.intent).toBe("add");
			expect(res2.replyText).toContain("موفقیت ثبت شد");

			// Verify task was saved with resolved ISO due date
			const taskAfter = await findTaskByQuery(env.DB, userId, "کلاس زبان");
			expect(taskAfter).not.toBeNull();
			expect(taskAfter.due_date).toBe("2026-11-29T17:00:00+03:30");

			// Verify pending clarification was consumed
			const pendingAfter = await getPendingClarification(env.DB, userId);
			expect(pendingAfter).toBeNull();
		});

		it("accepts valid solar date in Edit («موعد تسک خرید کتاب رو به ۸ آذر تغییر بده»)", async () => {
			await createTask(env.DB, userId, {
				title: "خرید کتاب",
				dueDate: "2026-11-06T10:00:00+03:30",
			});

			const res = await handleIncomingMessage(env, {
				userId,
				text: "موعد تسک خرید کتاب رو به ۸ آذر تغییر بده",
			}, { baseDate });

			expect(res.authorized).toBe(true);
			expect(res.intent).toBe("edit");
			expect(res.replyText).toContain("ویرایش شد");

			const task = await findTaskByQuery(env.DB, userId, "خرید کتاب");
			expect(task.due_date).toBe("2026-11-29");
		});

		it("rejects invalid solar date in Edit («موعد تسک خرید کتاب رو به ۳۱ مهر تغییر بده»)", async () => {
			const initial = await createTask(env.DB, userId, {
				title: "خرید کتاب",
				dueDate: "2026-11-20T10:00:00+03:30",
			});

			const res = await handleIncomingMessage(env, {
				userId,
				text: "موعد تسک خرید کتاب رو به ۳۱ مهر تغییر بده",
			}, { baseDate });

			expect(res.authorized).toBe(true);
			expect(res.intent).toBe("clarify");
			expect(res.replyText).toContain("نامعتبر است");

			// DB due date must remain unchanged
			const task = await findTaskByQuery(env.DB, userId, "خرید کتاب");
			expect(task.due_date).toBe(initial.due_date);
		});

		it("rejects past date in Edit («موعد تسک خرید کتاب رو به ۱۵ آبان ۱۴۰۴ تغییر بده»)", async () => {
			const initial = await createTask(env.DB, userId, {
				title: "خرید کتاب",
				dueDate: "2026-11-20T10:00:00+03:30",
			});

			const res = await handleIncomingMessage(env, {
				userId,
				text: "موعد تسک خرید کتاب رو به ۱۵ آبان ۱۴۰۴ تغییر بده",
			}, { baseDate });

			expect(res.authorized).toBe(true);
			expect(res.intent).toBe("clarify");
			expect(res.replyText).toContain("گذشته است");

			const task = await findTaskByQuery(env.DB, userId, "خرید کتاب");
			expect(task.due_date).toBe(initial.due_date);
		});

		it("rejects beyond 1-year date in Edit («موعد تسک خرید کتاب رو به ۱۵ آبان ۱۴۰۸ تغییر بده»)", async () => {
			const initial = await createTask(env.DB, userId, {
				title: "خرید کتاب",
				dueDate: "2026-11-20T10:00:00+03:30",
			});

			const res = await handleIncomingMessage(env, {
				userId,
				text: "موعد تسک خرید کتاب رو به ۱۵ آبان ۱۴۰۸ تغییر بده",
			}, { baseDate });

			expect(res.authorized).toBe(true);
			expect(res.intent).toBe("clarify");
			expect(res.replyText).toContain("یک سال");

			const task = await findTaskByQuery(env.DB, userId, "خرید کتاب");
			expect(task.due_date).toBe(initial.due_date);
		});

		it("handles ambiguous hour in Edit: preserves targetDateStr, asks clarification, and resolves on follow-up", async () => {
			const initial = await createTask(env.DB, userId, {
				title: "خرید کتاب",
				dueDate: "2026-11-20T10:00:00+03:30",
			});

			// Step 1: Send edit with ambiguous hour
			const res1 = await handleIncomingMessage(env, {
				userId,
				text: "موعد تسک خرید کتاب رو ببر برای فردا ساعت ۵",
			}, { baseDate });

			expect(res1.authorized).toBe(true);
			expect(res1.intent).toBe("clarify");
			expect(res1.replyText).toContain("ساعت ۵ صبح است یا ۵ عصر");

			// Task in DB must remain unmodified
			const taskDuring = await findTaskByQuery(env.DB, userId, "خرید کتاب");
			expect(taskDuring.due_date).toBe(initial.due_date);

			// Pending clarification exists for edit
			const pending = await getPendingClarification(env.DB, userId);
			expect(pending).not.toBeNull();
			expect(pending.actionType).toBe("edit");
			expect(pending.payload.targetTaskId).toBe(initial.id);
			expect(pending.payload.targetDateStr).toBe("2026-11-07");

			// Step 2: User responds with "۵ عصر"
			const res2 = await handleIncomingMessage(env, {
				userId,
				text: "۵ عصر",
			}, { baseDate });

			expect(res2.authorized).toBe(true);
			expect(res2.intent).toBe("edit");
			expect(res2.replyText).toContain("ویرایش شد");

			const taskAfter = await findTaskByQuery(env.DB, userId, "خرید کتاب");
			expect(taskAfter.due_date).toBe("2026-11-07T17:00:00+03:30");
		});

		it("rejects incomplete phrase in Add («تسک برای»)", async () => {
			const res = await handleIncomingMessage(env, {
				userId,
				text: "تسک برای",
			}, { baseDate });

			expect(res.authorized).toBe(true);
			expect(res.intent).toBe("clarify");
			expect(res.replyText).toContain("ناقص");

			const tasks = await env.DB.prepare("SELECT * FROM tasks WHERE telegram_user_id = ?").bind(userId).all();
			expect(tasks.results.length).toBe(0);
		});

		it("rejects empty title in Add with only date token («برای ۸ آذر»)", async () => {
			const res = await handleIncomingMessage(env, {
				userId,
				text: "برای ۸ آذر",
			}, { baseDate });

			expect(res.authorized).toBe(true);
			expect(res.intent).toBe("clarify");

			const tasks = await env.DB.prepare("SELECT * FROM tasks WHERE telegram_user_id = ?").bind(userId).all();
			expect(tasks.results.length).toBe(0);
		});
	});

	describe("2. Gemini Path Validation", () => {
		it("validates valid solar date output from Gemini in Add", async () => {
			const mockFetch = async () => new Response(JSON.stringify({
				choices: [{
					message: {
						content: JSON.stringify({
							intent: "add",
							task: {
								title: "خرید کتاب شیمی",
								due_date: "2026-11-29",
								filter: "all",
							},
							reply: "تسک خرید کتاب ثبت شد.",
						}),
					},
				}],
			}), { status: 200, headers: { "Content-Type": "application/json" } });

			const res = await handleIncomingMessage(geminiEnv, {
				userId,
				text: "می‌خوام برای ۸ آذر خرید کتاب شیمی داشته باشم",
			}, { fetch: mockFetch, baseDate });

			expect(res.authorized).toBe(true);
			expect(res.intent).toBe("add");
			expect(res.replyText).toContain("خرید کتاب شیمی");

			const task = await findTaskByQuery(env.DB, userId, "شیمی");
			expect(task).not.toBeNull();
			expect(task.due_date).toBe("2026-11-29");
		});

		it("prevents Gemini from registering a past date in Add", async () => {
			const mockFetch = async () => new Response(JSON.stringify({
				choices: [{
					message: {
						content: JSON.stringify({
							intent: "add",
							task: {
								title: "خرید کتاب",
								due_date: "2025-11-06",
								filter: "all",
							},
						}),
					},
				}],
			}), { status: 200, headers: { "Content-Type": "application/json" } });

			const res = await handleIncomingMessage(geminiEnv, {
				userId,
				text: "لطفاً برای ۱۵ آبان ۱۴۰۴ خرید کتاب ثبت کن",
			}, { fetch: mockFetch, baseDate });

			expect(res.authorized).toBe(true);
			expect(res.intent).toBe("clarify");
			expect(res.replyText).toContain("گذشته است");

			const tasks = await env.DB.prepare("SELECT * FROM tasks WHERE telegram_user_id = ?").bind(userId).all();
			expect(tasks.results.length).toBe(0);
		});

		it("prevents Gemini from registering an invalid solar date (۳۱ مهر) in Add", async () => {
			const mockFetch = async () => new Response(JSON.stringify({
				choices: [{
					message: {
						content: JSON.stringify({
							intent: "add",
							task: {
								title: "خرید کتاب",
								due_date: "2026-10-23",
								filter: "all",
							},
						}),
					},
				}],
			}), { status: 200, headers: { "Content-Type": "application/json" } });

			const res = await handleIncomingMessage(geminiEnv, {
				userId,
				text: "لطفاً برای ۳۱ مهر خرید کتاب ثبت کن",
			}, { fetch: mockFetch, baseDate });

			expect(res.authorized).toBe(true);
			expect(res.intent).toBe("clarify");
			expect(res.replyText).toContain("نامعتبر است");

			const tasks = await env.DB.prepare("SELECT * FROM tasks WHERE telegram_user_id = ?").bind(userId).all();
			expect(tasks.results.length).toBe(0);
		});

		it("prevents Gemini from registering a date beyond 1 calendar year in Add", async () => {
			const mockFetch = async () => new Response(JSON.stringify({
				choices: [{
					message: {
						content: JSON.stringify({
							intent: "add",
							task: {
								title: "خرید کتاب",
								due_date: "2029-11-05",
								filter: "all",
							},
						}),
					},
				}],
			}), { status: 200, headers: { "Content-Type": "application/json" } });

			const res = await handleIncomingMessage(geminiEnv, {
				userId,
				text: "لطفاً برای ۱۵ آبان ۱۴۰۸ خرید کتاب ثبت کن",
			}, { fetch: mockFetch, baseDate });

			expect(res.authorized).toBe(true);
			expect(res.intent).toBe("clarify");
			expect(res.replyText).toContain("یک سال");

			const tasks = await env.DB.prepare("SELECT * FROM tasks WHERE telegram_user_id = ?").bind(userId).all();
			expect(tasks.results.length).toBe(0);
		});

		it("prevents Gemini from guessing an ambiguous hour and forces clarification", async () => {
			// Even if Gemini attempts to guess 17:00:00 for "ساعت ۵"
			const mockFetch = async () => new Response(JSON.stringify({
				choices: [{
					message: {
						content: JSON.stringify({
							intent: "add",
							task: {
								title: "کلاس زبان",
								due_date: "2026-11-29T17:00:00+03:30",
								filter: "all",
							},
						}),
					},
				}],
			}), { status: 200, headers: { "Content-Type": "application/json" } });

			const res = await handleIncomingMessage(geminiEnv, {
				userId,
				text: "می‌خوام برای ۸ آذر ساعت ۵ کلاس زبان بذارم",
			}, { fetch: mockFetch, baseDate });

			expect(res.authorized).toBe(true);
			expect(res.intent).toBe("clarify");
			expect(res.replyText).toContain("ساعت ۵ صبح است یا ۵ عصر");

			// Task must NOT be saved in DB with the guessed time
			const task = await findTaskByQuery(env.DB, userId, "کلاس زبان");
			expect(task).toBeNull();

			// Pending clarification must be preserved with targetDateStr
			const pending = await getPendingClarification(env.DB, userId);
			expect(pending).not.toBeNull();
			expect(pending.payload.targetDateStr).toBe("2026-11-29");
		});

		it("prevents Gemini from turning an incomplete phrase into a valid task", async () => {
			const mockFetch = async () => new Response(JSON.stringify({
				choices: [{
					message: {
						content: JSON.stringify({
							intent: "add",
							task: {
								title: "برای",
								due_date: null,
								filter: "all",
							},
						}),
					},
				}],
			}), { status: 200, headers: { "Content-Type": "application/json" } });

			const res = await handleIncomingMessage(geminiEnv, {
				userId,
				text: "تسک برای",
			}, { fetch: mockFetch, baseDate });

			expect(res.authorized).toBe(true);
			expect(res.intent).toBe("clarify");
			expect(res.replyText).toContain("ناقص");

			const tasks = await env.DB.prepare("SELECT * FROM tasks WHERE telegram_user_id = ?").bind(userId).all();
			expect(tasks.results.length).toBe(0);
		});

		it("prevents Gemini from modifying task with an invalid solar date in Edit", async () => {
			const initial = await createTask(env.DB, userId, {
				title: "خرید نان",
				dueDate: "2026-11-20T10:00:00+03:30",
			});

			const mockFetch = async () => new Response(JSON.stringify({
				choices: [{
					message: {
						content: JSON.stringify({
							intent: "edit",
							task: {
								target_query: "خرید نان",
								title: null,
								due_date: "2026-10-23",
								filter: "all",
							},
						}),
					},
				}],
			}), { status: 200, headers: { "Content-Type": "application/json" } });

			const res = await handleIncomingMessage(geminiEnv, {
				userId,
				text: "می‌شه موعد خرید نان رو بذاری ۳۱ مهر",
			}, { fetch: mockFetch, baseDate });

			expect(res.authorized).toBe(true);
			expect(res.intent).toBe("clarify");
			expect(res.replyText).toContain("نامعتبر است");

			const task = await findTaskByQuery(env.DB, userId, "خرید نان");
			expect(task.due_date).toBe(initial.due_date);
		});

		it("prevents Gemini from modifying task with a past date in Edit", async () => {
			const initial = await createTask(env.DB, userId, {
				title: "خرید نان",
				dueDate: "2026-11-20T10:00:00+03:30",
			});

			const mockFetch = async () => new Response(JSON.stringify({
				choices: [{
					message: {
						content: JSON.stringify({
							intent: "edit",
							task: {
								target_query: "خرید نان",
								title: null,
								due_date: "2025-11-06",
								filter: "all",
							},
						}),
					},
				}],
			}), { status: 200, headers: { "Content-Type": "application/json" } });

			const res = await handleIncomingMessage(geminiEnv, {
				userId,
				text: "می‌شه موعد خرید نان رو بذاری ۱۵ آبان ۱۴۰۴",
			}, { fetch: mockFetch, baseDate });

			expect(res.authorized).toBe(true);
			expect(res.intent).toBe("clarify");
			expect(res.replyText).toContain("گذشته است");

			const task = await findTaskByQuery(env.DB, userId, "خرید نان");
			expect(task.due_date).toBe(initial.due_date);
		});

		it("prevents Gemini from guessing an ambiguous hour in Edit and forces clarification", async () => {
			const initial = await createTask(env.DB, userId, {
				title: "خرید نان",
				dueDate: "2026-11-20T10:00:00+03:30",
			});

			const mockFetch = async () => new Response(JSON.stringify({
				choices: [{
					message: {
						content: JSON.stringify({
							intent: "edit",
							task: {
								target_query: "خرید نان",
								title: null,
								due_date: "2026-11-29T17:00:00+03:30",
								filter: "all",
							},
						}),
					},
				}],
			}), { status: 200, headers: { "Content-Type": "application/json" } });

			const res = await handleIncomingMessage(geminiEnv, {
				userId,
				text: "می‌شه موعد خرید نان رو بذاری ۸ آذر ساعت ۵",
			}, { fetch: mockFetch, baseDate });

			expect(res.authorized).toBe(true);
			expect(res.intent).toBe("clarify");
			expect(res.replyText).toContain("ساعت ۵ صبح است یا ۵ عصر");

			const task = await findTaskByQuery(env.DB, userId, "خرید نان");
			expect(task.due_date).toBe(initial.due_date);

			const pending = await getPendingClarification(env.DB, userId);
			expect(pending).not.toBeNull();
			expect(pending.actionType).toBe("edit");
			expect(pending.payload.targetTaskId).toBe(initial.id);
			expect(pending.payload.targetDateStr).toBe("2026-11-29");
		});
	});
});
