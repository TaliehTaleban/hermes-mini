import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { handleIncomingMessage } from "../src/handler.js";
import { createTask, listTasks, findTaskByQuery, findTasksByQuery, ensurePendingClarificationsTable } from "../src/db.js";
import worker from "../src/index.js";

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

	await ensurePendingClarificationsTable(db);
}

describe("Hermes Mini - 12 Acceptance Scenarios", () => {
	const userId = "12345678";

	beforeEach(async () => {
		await initDatabase(env.DB);
		await env.DB.prepare("DELETE FROM tasks").run();
		await env.DB.prepare("DELETE FROM conversation_messages").run();
		await env.DB.prepare("DELETE FROM user_displayed_lists").run();
		await env.DB.prepare("DELETE FROM processed_updates").run();
		await env.DB.prepare("DELETE FROM pending_clarifications").run();
	});

	// Scenario 1: ثبت «فردا باید برای امتحان درس بخونم» بدون Gemini
	it("1. Adds «فردا باید برای امتحان درس بخونم» without invoking Gemini", async () => {
		let geminiCalled = false;
		const mockFetch = async () => {
			geminiCalled = true;
			throw new Error("Gemini should not be called!");
		};

		const res = await handleIncomingMessage(
			{ ...env, LLM_API_KEY: "test-key" },
			{ userId, text: "فردا باید برای امتحان درس بخونم" },
			{ fetch: mockFetch }
		);

		expect(geminiCalled).toBe(false); // Gemini was NOT called!
		expect(res.authorized).toBe(true);
		expect(res.replyText).toContain("با موفقیت ثبت شد");

		// D1 verification
		const tasks = await listTasks(env.DB, userId, "all");
		expect(tasks.length).toBe(1);
		expect(tasks[0].title).toBe("برای امتحان درس بخونم");
		expect(tasks[0].is_completed).toBe(0);
	});

	// Scenario 2: ثبت «باید فردا به مادرم زنگ بزنم» با تاریخ صحیح
	it("2. Adds «باید فردا به مادرم زنگ بزنم» with proper due_date without Gemini", async () => {
		let geminiCalled = false;
		const mockFetch = async () => {
			geminiCalled = true;
			throw new Error("Gemini should not be called!");
		};

		const res = await handleIncomingMessage(
			{ ...env, LLM_API_KEY: "test-key" },
			{ userId, text: "باید فردا به مادرم زنگ بزنم" },
			{ fetch: mockFetch }
		);

		expect(geminiCalled).toBe(false);
		expect(res.authorized).toBe(true);
		expect(res.replyText).toContain("به مادرم زنگ بزنم");

		// D1 verification
		const tasks = await listTasks(env.DB, userId, "all");
		expect(tasks.length).toBe(1);
		expect(tasks[0].title).toBe("به مادرم زنگ بزنم");
		expect(tasks[0].due_date).not.toBeNull();
		expect(tasks[0].due_date).toMatch(/^\d{4}-\d{2}-\d{2}/);
	});

	// Scenario 3: نمایش فهرست با «کارام رو نمایش بده» بدون Gemini
	it("3. Displays task list with «کارام رو نمایش بده» without invoking Gemini", async () => {
		await createTask(env.DB, userId, { title: "خرید نان" });
		await createTask(env.DB, userId, { title: "مطالعه کتاب" });

		let geminiCalled = false;
		const mockFetch = async () => {
			geminiCalled = true;
			throw new Error("Gemini should not be called!");
		};

		const res = await handleIncomingMessage(
			{ ...env, LLM_API_KEY: "test-key" },
			{ userId, text: "کارام رو نمایش بده" },
			{ fetch: mockFetch }
		);

		expect(geminiCalled).toBe(false);
		expect(res.authorized).toBe(true);
		expect(res.replyText).toContain("1. ⬜️ خرید نان");
		expect(res.replyText).toContain("2. ⬜️ مطالعه کتاب");
		// Verify DB ID is never leaked to the user
		expect(res.replyText).not.toContain("#");
	});

	// Scenario 4: نمایش فهرست و سپس «اولی رو انجام دادم» بدون Gemini
	it("4. Displays list and resolves «اولی رو انجام دادم» based on exact displayed IDs without Gemini", async () => {
		const t1 = await createTask(env.DB, userId, { title: "ورزش صبحگاهی" });
		const t2 = await createTask(env.DB, userId, { title: "کدنویسی پایتون" });

		let geminiCalled = false;
		const mockFetch = async () => {
			geminiCalled = true;
			throw new Error("Gemini should not be called!");
		};

		// 1. User views list
		const listRes = await handleIncomingMessage(
			{ ...env, LLM_API_KEY: "test-key" },
			{ userId, text: "کارام رو نشون بده" },
			{ fetch: mockFetch }
		);
		expect(listRes.replyText).toContain("ورزش صبحگاهی");

		// 2. User marks first item done
		const doneRes = await handleIncomingMessage(
			{ ...env, LLM_API_KEY: "test-key" },
			{ userId, text: "اولی رو انجام دادم" },
			{ fetch: mockFetch }
		);

		expect(geminiCalled).toBe(false);
		expect(doneRes.replyText).toContain("ورزش صبحگاهی");
		expect(doneRes.replyText).toContain("انجام شد");

		// D1 verification: exact ID updated
		const refreshedT1 = await findTaskByQuery(env.DB, userId, "ورزش");
		const refreshedT2 = await findTaskByQuery(env.DB, userId, "پایتون");
		expect(refreshedT1.is_completed).toBe(1);
		expect(refreshedT2.is_completed).toBe(0);
	});

	// Scenario 5: تغییر وضعیت با «تیک بزن ریاضی»
	it("5. Changes status with «تیک بزن ریاضی» without Gemini", async () => {
		await createTask(env.DB, userId, { title: "تمرین درس ریاضی" });

		let geminiCalled = false;
		const mockFetch = async () => {
			geminiCalled = true;
			throw new Error("Gemini should not be called!");
		};

		const res = await handleIncomingMessage(
			{ ...env, LLM_API_KEY: "test-key" },
			{ userId, text: "تیک بزن ریاضی" },
			{ fetch: mockFetch }
		);

		expect(geminiCalled).toBe(false);
		expect(res.replyText).toContain("تمرین درس ریاضی");
		expect(res.replyText).toContain("انجام شد");

		// D1 verification
		const task = await findTaskByQuery(env.DB, userId, "ریاضی");
		expect(task.is_completed).toBe(1);
	});

	// Scenario 6: جلوگیری از حذف اشتباه بین دو تسک مشابه (Ambiguity Guard)
	it("6. Prevents dangerous deletion when multiple tasks match query and asks for clarification", async () => {
		await createTask(env.DB, userId, { title: "ملاقات دکتر پوست" });
		await createTask(env.DB, userId, { title: "ملاقات دکتر دندانپزشک" });

		const res = await handleIncomingMessage(
			env,
			{ userId, text: "دکتر رو حذف کن" }
		);

		// Must clarify and NOT delete either task!
		expect(res.intent).toBe("clarify");
		expect(res.replyText).toContain("چند تسک با عنوان مشابه پیدا شد");
		expect(res.replyText).toContain("دکتر پوست");
		expect(res.replyText).toContain("دکتر دندانپزشک");

		// D1 verification: BOTH tasks remain intact in D1!
		const tasks = await listTasks(env.DB, userId, "all");
		expect(tasks.length).toBe(2);
	});

	// Scenario 7: ویرایش دقیق یک تسک مشخص
	it("7. Accurately edits a specific task", async () => {
		const original = await createTask(env.DB, userId, { title: "درس خوندن" });

		let geminiCalled = false;
		const mockFetch = async () => {
			geminiCalled = true;
			return new Response(
				JSON.stringify({
					choices: [{
						message: {
							content: JSON.stringify({
								intent: "edit",
								task: { target_query: "درس", title: "درس آمار و احتمال", due_date: "2026-11-20T12:00:00+03:30" },
								reply: "ویرایش شد",
							}),
						},
					}],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } }
			);
		};

		const res = await handleIncomingMessage(
			{ ...env, LLM_API_KEY: "key" },
			{ userId, text: "ساعت و عنوان درس خوندن رو ببر ۱۲ و بکن آمار" },
			{ fetch: mockFetch }
		);

		expect(geminiCalled).toBe(true);
		expect(res.replyText).toContain("ویرایش شد");

		// D1 verification
		const updated = await findTaskByQuery(env.DB, userId, "آمار");
		expect(updated).not.toBeNull();
		expect(updated.id).toBe(original.id);
		expect(updated.title).toBe("درس آمار و احتمال");
	});

	// Scenario 8: رفتار صحیح در صورت نبود تسک
	it("8. Returns respectful message when target task does not exist", async () => {
		const res = await handleIncomingMessage(
			env,
			{ userId, text: "شستن ماشین رو انجام دادم" }
		);

		expect(res.replyText).toContain("تسکی با مشخصات «شستن ماشین» برای انجام پیدا نشد");
	});

	// Scenario 9: رفتار صحیح در خطای D1
	it("9. Handles D1 failures gracefully without crashing", async () => {
		const brokenDb = {
			prepare() {
				throw new Error("D1 connection lost");
			},
		};

		const res = await handleIncomingMessage(
			{ ...env, DB: brokenDb },
			{ userId, text: "کارام رو نمایش بده" }
		);

		expect(res.isError).toBe(true);
		expect(res.replyText).toContain("دیتابیس");
	});

	// Scenario 10: جلوگیری از پردازش دوباره یک update_id
	it("10. Deduplicates Telegram requests based on update_id", async () => {
		const payload = {
			update_id: 998877,
			message: {
				message_id: 101,
				from: { id: 12345678, first_name: "Test" },
				chat: { id: 12345678 },
				text: "تسک شماره تست اول",
			},
		};

		const req1 = new Request("http://example.com/webhook", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});

		// First delivery
		const res1 = await worker.fetch(req1, env);
		const json1 = await res1.json();
		expect(json1.ok).toBe(true);
		expect(json1.duplicate).toBeUndefined();

		// Second delivery of same update_id
		const req2 = new Request("http://example.com/webhook", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});
		const res2 = await worker.fetch(req2, env);
		const json2 = await res2.json();
		expect(json2.ok).toBe(true);
		expect(json2.duplicate).toBe(true); // Successfully deduplicated!

		// D1 verification: only 1 task created, not 2!
		const tasks = await listTasks(env.DB, "12345678", "all");
		expect(tasks.length).toBe(1);
	});

	// Scenario 11: رفتار صحیح هنگام خطای 503 و timeout جمینای
	it("11. Still executes core operations when Gemini returns 503 or times out", async () => {
		const mockFetch = async () => {
			return new Response(JSON.stringify({ error: "503 Service Unavailable" }), { status: 503 });
		};

		// Add task works 100% locally even with Gemini 503
		const res = await handleIncomingMessage(
			{ ...env, LLM_API_KEY: "test-key" },
			{ userId, text: "فردا ساعت ۱۰ جلسه کاری دارم" },
			{ fetch: mockFetch }
		);

		expect(res.replyText).toContain("منظورتان ساعت ۱۰ صبح است یا ۱۰ شب؟");

		const tasksBefore = await listTasks(env.DB, userId, "all");
		expect(tasksBefore.length).toBe(0);

		// Clarify morning:
		const clarifyRes = await handleIncomingMessage(
			{ ...env, LLM_API_KEY: "test-key" },
			{ userId, text: "صبح" },
			{ fetch: mockFetch }
		);

		expect(clarifyRes.replyText).toContain("با موفقیت ثبت شد");
		const tasks = await listTasks(env.DB, userId, "all");
		expect(tasks.length).toBe(1);
		expect(tasks[0].title).toBe("جلسه کاری دارم");
		expect(tasks[0].due_date).toContain("10:00:00+03:30");
	});

	// Scenario 12: عدم تبدیل پیام‌های عادی و مکالمه‌ای به تسک بدون تشخیص قصد کاربر
	it("12. Does NOT convert conversational or ambiguous statements into tasks", async () => {
		const casualChats = [
			"سلام هرمس جان چطوری؟",
			"یه جوک بگو برام",
			"امروز خیلی خسته‌ام و حوصله ندارم",
			"ممنون از کمکت",
		];

		for (const chat of casualChats) {
			const res = await handleIncomingMessage(env, { userId, text: chat });
			expect(res.intent).toBe("chat");
			expect(res.replyText).toBeDefined();
		}

		// D1 verification: ZERO tasks were created from casual chat!
		const tasks = await listTasks(env.DB, userId, "all");
		expect(tasks.length).toBe(0);
	});
});
