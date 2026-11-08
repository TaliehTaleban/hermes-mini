import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { handleIncomingMessage, resolveTargetTask, getRecentListContext } from "../src/handler.js";
import { findTaskByQuery, listTasks, createTask, saveConversationMessage, ensureReminderColumns } from "../src/db.js";
import { dispatchLocalAction } from "../src/localDispatcher.js";

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

describe("Hermes Mini - Natural Persian Message Handling", () => {
	const userId = "456789";

	beforeEach(async () => {
		await initDatabase(env.DB);
		await env.DB.prepare("DELETE FROM tasks").run();
		await env.DB.prepare("DELETE FROM conversation_messages").run();
	});

	it("handles «فردا ساعت ۵ باید برم دکتر» (Clarify ambiguous hour, no task saved)", async () => {
		const res = await handleIncomingMessage(env, {
			userId,
			text: "فردا ساعت ۵ باید برم دکتر",
		});

		expect(res.authorized).toBe(true);
		expect(res.intent).toBe("clarify");
		expect(res.replyText).toContain("ساعت ۵ صبح است یا ۵ عصر");

		const task = await findTaskByQuery(env.DB, userId, "دکتر");
		expect(task).toBeNull();
	});

	it("handles «یه تسک اضافه کن که امشب ریاضی بخونم» (Add task)", async () => {
		const res = await handleIncomingMessage(env, {
			userId,
			text: "یه تسک اضافه کن که امشب ریاضی بخونم",
		});

		expect(res.authorized).toBe(true);
		expect(res.replyText).toContain("ریاضی بخونم");

		const task = await findTaskByQuery(env.DB, userId, "ریاضی");
		expect(task).not.toBeNull();
	});

	it("handles «چه کارهایی برای امروز دارم؟» (List tasks)", async () => {
		// First add a task for today
		await handleIncomingMessage(env, {
			userId,
			text: "تسک برنامه نویسی رو اضافه کن",
		});

		const listRes = await handleIncomingMessage(env, {
			userId,
			text: "لیست کارهام رو نشون بده",
		});

		expect(listRes.authorized).toBe(true);
		expect(listRes.replyText).toContain("برنامه نویسی");
	});

	it("handles «تسک ریاضی رو انجام دادم» (Mark done)", async () => {
		// First add task
		await handleIncomingMessage(env, {
			userId,
			text: "تسک تمرین ریاضی",
		});

		// Mark done
		const doneRes = await handleIncomingMessage(env, {
			userId,
			text: "تسک ریاضی رو انجام دادم",
		});

		expect(doneRes.authorized).toBe(true);
		expect(doneRes.replyText).toContain("انجام شد");

		const task = await findTaskByQuery(env.DB, userId, "ریاضی");
		expect(task.is_completed).toBe(1);
	});

	it("handles «اون تسک رو دوباره انجام‌نشده کن» (Mark undone)", async () => {
		// Add and mark done
		await handleIncomingMessage(env, {
			userId,
			text: "تسک تمرین فیزیک",
		});
		await handleIncomingMessage(env, {
			userId,
			text: "تسک فیزیک رو انجام دادم",
		});

		// Mark undone
		const undoneRes = await handleIncomingMessage(env, {
			userId,
			text: "تسک فیزیک رو انجام‌نشده کن",
		});

		expect(undoneRes.authorized).toBe(true);
		expect(undoneRes.replyText).toContain("انجام‌نشده");

		const task = await findTaskByQuery(env.DB, userId, "فیزیک");
		expect(task.is_completed).toBe(0);
	});

	it("handles «تسک دکتر رو حذف کن» (Delete task)", async () => {
		// Add
		await handleIncomingMessage(env, {
			userId,
			text: "باید برم دکتر",
		});

		// Delete
		const delRes = await handleIncomingMessage(env, {
			userId,
			text: "تسک دکتر رو حذف کن",
		});

		expect(delRes.authorized).toBe(true);
		expect(delRes.replyText).toContain("حذف شد");

		const task = await findTaskByQuery(env.DB, userId, "دکتر");
		expect(task).toBeNull();
	});

	it("handles chat greeting «سلام»", async () => {
		const chatRes = await handleIncomingMessage(env, {
			userId,
			text: "سلام هرمس جان چطوری؟",
		});

		expect(chatRes.authorized).toBe(true);
		expect(chatRes.replyText).toContain("هرمس مینی");
	});

	it("responds naturally to casual conversation and does NOT create a task", async () => {
		const casualInputs = [
			"یه جوک بگو",
			"یه داستان کوتاه بگو برام",
			"امروز خیلی خسته‌ام و حوصله ندارم",
			"چیکار می‌کنی الان؟",
			"ممنون از کمکت",
			"خداحافظ تا فردا",
		];

		for (const input of casualInputs) {
			const res = await handleIncomingMessage(env, { userId, text: input });
			expect(res.authorized).toBe(true);
			expect(res.replyText).toBeDefined();
			expect(typeof res.replyText).toBe("string");
		}

		// Verify ZERO tasks were created from casual chat
		const allTasks = await listTasks(env.DB, userId, "all");
		expect(allTasks.length).toBe(0);
	});

	it("supports multi-turn interaction resolving ordinal task reference («دومی رو انجام دادم»)", async () => {
		// 1. Add two tasks
		await handleIncomingMessage(env, { userId, text: "تسک ۱: مطالعه درس ریاضی" });
		await handleIncomingMessage(env, { userId, text: "تسک ۲: تمرین برنامه‌نویسی" });

		// 2. Complete the second task using ordinal reference ("دومی")
		const doneRes = await handleIncomingMessage(env, {
			userId,
			text: "دومی رو انجام دادم",
		});

		expect(doneRes.authorized).toBe(true);
		expect(doneRes.replyText).toContain("انجام شد");

		// Task 1 should be incomplete, Task 2 should be completed
		const t1 = await findTaskByQuery(env.DB, userId, "ریاضی");
		const t2 = await findTaskByQuery(env.DB, userId, "برنامه‌نویسی");

		expect(t1.is_completed).toBe(0);
		expect(t2.is_completed).toBe(1);
	});

	it("resolves «اولی رو انجام دادم» based on the specific displayed list of today's tasks", async () => {
		const todayIso = new Date().toISOString();
		const tomorrowIso = new Date(Date.now() + 86400000).toISOString();

		// Task 1: Due tomorrow (older ID / first in global pending tasks)
		await createTask(env.DB, userId, { title: "خرید وسایل تولد", dueDate: tomorrowIso });
		// Task 2: Due today (1st item in today's list)
		await createTask(env.DB, userId, { title: "ورزش صبحگاهی", dueDate: todayIso });
		// Task 3: Due today (2nd item in today's list)
		await createTask(env.DB, userId, { title: "مطالعه درس ریاضی", dueDate: todayIso });

		// 1. User asks for today's tasks
		const listRes = await handleIncomingMessage(env, {
			userId,
			text: "کارای امروز چیه؟",
		});

		expect(listRes.replyText).toContain("ورزش صبحگاهی");
		expect(listRes.replyText).toContain("مطالعه درس ریاضی");
		expect(listRes.replyText).not.toContain("خرید وسایل تولد");

		// Record messages in conversation history (as done after successful Telegram sending)
		await saveConversationMessage(env.DB, userId, "user", "کارای امروز چیه؟", "list");
		await saveConversationMessage(env.DB, userId, "assistant", listRes.replyText, "list");

		// 2. User says "اولی رو انجام دادم" referring to item 1 of today's list ("ورزش صبحگاهی")
		const doneRes = await handleIncomingMessage(env, {
			userId,
			text: "اولی رو انجام دادم",
		});

		expect(doneRes.authorized).toBe(true);
		expect(doneRes.replyText).toContain("ورزش صبحگاهی");
		expect(doneRes.replyText).toContain("انجام شد");

		// Verify that Task 2 ("ورزش صبحگاهی") was completed, NOT Task 1 ("خرید وسایل تولد")
		const tBirth = await findTaskByQuery(env.DB, userId, "تولد");
		const tSport = await findTaskByQuery(env.DB, userId, "ورزش");
		const tMath = await findTaskByQuery(env.DB, userId, "ریاضی");

		expect(tSport.is_completed).toBe(1); // Item 1 of today's list completed
		expect(tBirth.is_completed).toBe(0); // Tomorrow's task remains untouched!
		expect(tMath.is_completed).toBe(0); // Other today task remains untouched!
	});

	it("extracts task items and filter accurately using getRecentListContext", () => {
		const history = [
			{ role: "user", content: "کارای امروز چیه؟", intent: "list" },
			{
				role: "assistant",
				content: "📅 کارهای امروز شما:\n\n1. ⬜ ورزش صبحگاهی (امروز ۰۸:۰۰)\n2. ⬜ مطالعه درس ریاضی (امروز ۱۲:۰۰)",
				intent: "list",
			},
		];

		const context = getRecentListContext(history);
		expect(context).not.toBeNull();
		expect(context.filter).toBe("today");
		expect(context.taskLines).toEqual([
			{ index: 1, title: "ورزش صبحگاهی" },
			{ index: 2, title: "مطالعه درس ریاضی" },
		]);
	});

	it("handles task editing («ساعت درس خوندن رو ببر ۱۲»)", async () => {
		// Add task
		await handleIncomingMessage(env, { userId, text: "فردا ساعت ۱۰ درس بخونم" });

		// Mock or simulated edit intent handled via handler
		const editRes = await handleIncomingMessage(env, {
			userId,
			text: "ساعت درس رو تغییر بده",
		});

		expect(editRes.authorized).toBe(true);
	});

	it("rejects unauthorized user silently when ALLOWED_TELEGRAM_USER_ID is set", async () => {
		const restrictedEnv = {
			...env,
			ALLOWED_TELEGRAM_USER_ID: "999888",
		};

		const res = await handleIncomingMessage(restrictedEnv, {
			userId: "111222", // Unauthorized
			text: "سلام",
		});

		expect(res.authorized).toBe(false);
		expect(res.replyText).toBeNull();
		expect(res.intent).toBe("unauthorized");
	});

	describe("Local List Intent Handler Behavior", () => {
		const testConfigEnv = {
			...env,
			LLM_API_KEY: "test-gemini-key",
			ALLOWED_TELEGRAM_USER_ID: userId,
		};

		it("does NOT call Gemini when user requests task list", async () => {
			let geminiCalled = false;
			const mockFetch = async () => {
				geminiCalled = true;
				return new Response(JSON.stringify({ choices: [] }), { status: 200 });
			};

			const res = await handleIncomingMessage(
				testConfigEnv,
				{ userId, text: "کارام چیه؟" },
				{ fetch: mockFetch }
			);

			expect(geminiCalled).toBe(false);
			expect(res.authorized).toBe(true);
			expect(res.intent).toBe("list");
			expect(res.isError).toBe(false);
		});

		it("succeeds for list request even when Gemini returns 503 error", async () => {
			// Add a task directly to DB
			await env.DB.prepare(
				"INSERT INTO tasks (telegram_user_id, title, is_completed) VALUES (?, ?, 0)"
			).bind(userId, "مطالعه زیست").run();

			let geminiCalled = false;
			const mockFetch = async () => {
				geminiCalled = true;
				return new Response(JSON.stringify({ error: "503 Unavailable" }), { status: 503 });
			};

			const res = await handleIncomingMessage(
				testConfigEnv,
				{ userId, text: "لیست کارهام" },
				{ fetch: mockFetch }
			);

			expect(geminiCalled).toBe(false);
			expect(res.authorized).toBe(true);
			expect(res.intent).toBe("list");
			expect(res.isError).toBe(false);
			expect(res.replyText).toContain("مطالعه زیست");
		});

		it("still routes normal chat and task creation requests to Gemini", async () => {
			let geminiCalls = [];
			const mockFetch = async (url, options) => {
				const body = JSON.parse(options.body);
				geminiCalls.push(body);
				return new Response(
					JSON.stringify({
						choices: [{
							message: {
								content: JSON.stringify({
									intent: "chat",
									reply: "پاسخ جمینای به چت",
									task: { title: null, target_query: null, target_index: null, due_date: null, filter: "all" },
								}),
							},
						}],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } }
				);
			};

			const chatRes = await handleIncomingMessage(
				testConfigEnv,
				{ userId, text: "سلام چطوری؟" },
				{ fetch: mockFetch }
			);

			expect(geminiCalls.length).toBe(1);
			expect(chatRes.authorized).toBe(true);
			expect(chatRes.replyText).toBe("پاسخ جمینای به چت");
		});
	});

	describe("Gemini Output Title Sanitization and Incomplete Title Protection", () => {
		const testConfigEnv = {
			...env,
			LLM_API_KEY: "test-gemini-key",
			ALLOWED_TELEGRAM_USER_ID: userId,
		};

		it("cleans command qualifiers from title when Gemini returns «خرید نان رو به کارهام اضافه کن»", async () => {
			const mockFetch = async () => {
				return new Response(
					JSON.stringify({
						choices: [{
							message: {
								content: JSON.stringify({
									intent: "add",
									task: {
										title: "خرید نان رو به کارهام اضافه کن",
										target_query: null,
										target_index: null,
										due_date: null,
										filter: "all",
									},
									reply: "تسک با موفقیت اضافه شد.",
								}),
							},
						}],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } }
				);
			};

			const res = await handleIncomingMessage(
				testConfigEnv,
				{ userId, text: "اگه ممکنه خرید نان رو توی برنامه بذار" },
				{ fetch: mockFetch }
			);

			expect(res.authorized).toBe(true);
			expect(res.intent).toBe("add");

			// D1 Database verification: title in DB must be clean "خرید نان", not "خرید نان رو به کارهام اضافه کن"
			const tasks = await listTasks(env.DB, userId, "all");
			expect(tasks.length).toBe(1);
			expect(tasks[0].title).toBe("خرید نان");
			expect(res.replyText).toContain("خرید نان");
			expect(res.replyText).not.toContain("به کارهام اضافه کن");
		});

		it("rejects incomplete title «تست نیمه‌شب برای» and asks for clarification without saving to DB", async () => {
			const mockFetch = async () => {
				return new Response(
					JSON.stringify({
						choices: [{
							message: {
								content: JSON.stringify({
									intent: "add",
									task: {
										title: "تست نیمه‌شب برای",
										target_query: null,
										target_index: null,
										due_date: null,
										filter: "all",
									},
									reply: "تسک با موفقیت اضافه شد.",
								}),
							},
						}],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } }
				);
			};

			const res = await handleIncomingMessage(
				testConfigEnv,
				{ userId, text: "تست نیمه‌شب برای" },
				{ fetch: mockFetch }
			);

			expect(res.authorized).toBe(true);
			// Must ask for clarification and NOT save incomplete title to DB
			expect(res.intent).toBe("clarify");

			// D1 Database verification: 0 tasks created in DB
			const tasks = await listTasks(env.DB, userId, "all");
			expect(tasks.length).toBe(0);
		});

		it("rejects invalid title «برای» during edit and halts execution without updating due_date in DB", async () => {
			// 1. Initial database state: Task with title "مطالعه درس ریاضی" and null due_date
			const initialTask = await createTask(env.DB, userId, {
				title: "مطالعه درس ریاضی",
			});
			expect(initialTask.id).toBeDefined();

			// 2. Direct database confirmation of initial state
			const initialRow = await env.DB.prepare(
				"SELECT id, title, due_date FROM tasks WHERE id = ?"
			).bind(initialTask.id).first();
			expect(initialRow).not.toBeNull();
			expect(initialRow.title).toBe("مطالعه درس ریاضی");
			expect(initialRow.due_date).toBeNull();

			// 3. Mock Gemini returning invalid title "برای" alongside a valid due_date
			const mockFetch = async () => {
				return new Response(
					JSON.stringify({
						choices: [{
							message: {
								content: JSON.stringify({
									intent: "edit",
									task: {
										target_query: "درس ریاضی",
										title: "برای",
										target_index: null,
										due_date: "2026-11-07T10:00:00+03:30",
										filter: "all",
									},
									reply: "تسک ویرایش شد",
								}),
							},
						}],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } }
				);
			};

			// 4. User request: compound edit with invalid title and valid time
			const res = await handleIncomingMessage(
				testConfigEnv,
				{ userId, text: "عنوان درس ریاضی رو بکن برای و ساعتش رو ببر فردا ۱۰" },
				{ fetch: mockFetch }
			);

			// 5. Assertions: authorization, clarify intent, and Persian text containing "عنوان"
			expect(res.authorized).toBe(true);
			expect(res.intent).toBe("clarify");
			expect(res.replyText).toContain("عنوان");

			// 6. Database verification: read record using same initial task ID to verify zero updates
			const finalRow = await env.DB.prepare(
				"SELECT id, title, due_date FROM tasks WHERE id = ?"
			).bind(initialTask.id).first();

			expect(finalRow).not.toBeNull();
			expect(finalRow.title).toBe("مطالعه درس ریاضی");
			expect(finalRow.due_date).toBeNull();
		});
	});

	describe("Edit Due Date Validation and Integrity (Gemini and Local)", () => {
		const testConfigEnv = {
			...env,
			LLM_API_KEY: "test-gemini-key",
			ALLOWED_TELEGRAM_USER_ID: userId,
		};

		it("rejects invalid due date (hour 25:00) from Gemini and prevents DB modification", async () => {
			const initialTask = await createTask(env.DB, userId, {
				title: "مطالعه شیمی",
				dueDate: "2026-11-06T10:00:00+03:30",
			});

			let geminiCalled = false;
			const mockFetch = async () => {
				geminiCalled = true;
				return new Response(
					JSON.stringify({
						choices: [{
							message: {
								content: JSON.stringify({
									intent: "edit",
									task: {
										target_query: "مطالعه شیمی",
										title: null,
										target_index: null,
										due_date: "2026-11-07T25:00:00+03:30",
										filter: "all",
									},
									reply: "تسک ویرایش شد",
								}),
							},
						}],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } }
				);
			};

			const res = await handleIncomingMessage(
				testConfigEnv,
				{ userId, text: "ساعت مطالعه شیمی رو بکن ۲۵" },
				{ fetch: mockFetch }
			);

			// 1. Independent check for Gemini invocation
			expect.soft(geminiCalled).toBe(true);
			expect.soft(res.authorized).toBe(true);

			// 2. Independent check for intent rejection
			expect.soft(["invalid_time", "clarify"]).toContain(res.intent);

			// 3. Independent DB check to verify DB was not corrupted with invalid hour
			const row = await env.DB.prepare(
				"SELECT id, title, due_date FROM tasks WHERE id = ?"
			).bind(initialTask.id).first();

			expect.soft(row.due_date).toBe("2026-11-06T10:00:00+03:30");
			expect.soft(row.due_date).not.toContain("25:00");
		});

		it("rejects unparseable date string from Gemini and prevents DB modification", async () => {
			const initialTask = await createTask(env.DB, userId, {
				title: "تمرین گیتار",
				dueDate: "2026-11-06T12:00:00+03:30",
			});

			let geminiCalled = false;
			const mockFetch = async () => {
				geminiCalled = true;
				return new Response(
					JSON.stringify({
						choices: [{
							message: {
								content: JSON.stringify({
									intent: "edit",
									task: {
										target_query: "تمرین گیتار",
										title: null,
										target_index: null,
										due_date: "not-a-valid-date-string",
										filter: "all",
									},
									reply: "تسک ویرایش شد",
								}),
							},
						}],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } }
				);
			};

			const res = await handleIncomingMessage(
				testConfigEnv,
				{ userId, text: "موعد تمرین گیتار رو بکن روز نامعلوم" },
				{ fetch: mockFetch }
			);

			// 1. Independent check for Gemini invocation
			expect.soft(geminiCalled).toBe(true);
			expect.soft(res.authorized).toBe(true);

			// 2. Independent check for intent rejection
			expect.soft(["invalid_time", "clarify"]).toContain(res.intent);

			// 3. Independent DB check to verify DB was not corrupted with invalid date string
			const row = await env.DB.prepare(
				"SELECT id, title, due_date FROM tasks WHERE id = ?"
			).bind(initialTask.id).first();

			expect.soft(row.due_date).toBe("2026-11-06T12:00:00+03:30");
			expect.soft(row.due_date).not.toBe("not-a-valid-date-string");
		});

		it("prevents partial update when title is valid but due_date is invalid", async () => {
			const initialTask = await createTask(env.DB, userId, {
				title: "درس ریاضی پایه",
				dueDate: "2026-11-06T10:00:00+03:30",
			});

			let geminiCalled = false;
			const mockFetch = async () => {
				geminiCalled = true;
				return new Response(
					JSON.stringify({
						choices: [{
							message: {
								content: JSON.stringify({
									intent: "edit",
									task: {
										target_query: "درس ریاضی پایه",
										title: "درس فیزیک پیشرفته",
										target_index: null,
										due_date: "2026-11-07T25:00:00+03:30",
										filter: "all",
									},
									reply: "تسک ویرایش شد",
								}),
							},
						}],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } }
				);
			};

			const res = await handleIncomingMessage(
				testConfigEnv,
				{ userId, text: "عنوان درس ریاضی پایه رو بکن درس فیزیک پیشرفته و ساعتش رو ببر ۲۵" },
				{ fetch: mockFetch }
			);

			// 1. Independent check for Gemini invocation
			expect.soft(geminiCalled).toBe(true);
			expect.soft(res.authorized).toBe(true);

			// 2. Independent check for intent rejection
			expect.soft(["invalid_time", "clarify"]).toContain(res.intent);

			// 3. Independent DB check to verify Atomicity (neither title nor due_date should change)
			const row = await env.DB.prepare(
				"SELECT id, title, due_date FROM tasks WHERE id = ?"
			).bind(initialTask.id).first();

			expect.soft(row.title).toBe("درس ریاضی پایه");
			expect.soft(row.due_date).toBe("2026-11-06T10:00:00+03:30");
		});

		it("clears existing due date when Gemini returns due_date: null", async () => {
			await ensureReminderColumns(env.DB);

			const initialTask = await createTask(env.DB, userId, {
				title: "خرید نان سنگک",
				dueDate: "2026-11-06T18:00:00+03:30",
			});

			const initialRow = await env.DB.prepare(
				"SELECT id, title, due_date, reminder_status FROM tasks WHERE id = ?"
			).bind(initialTask.id).first();
			expect.soft(initialRow.due_date).toBe("2026-11-06T18:00:00+03:30");
			expect.soft(initialRow.reminder_status).toBe("pending");

			let geminiCalled = false;
			const mockFetch = async () => {
				geminiCalled = true;
				return new Response(
					JSON.stringify({
						choices: [{
							message: {
								content: JSON.stringify({
									intent: "edit",
									task: {
										target_query: "خرید نان سنگک",
										title: null,
										target_index: null,
										due_date: null,
										filter: "all",
									},
									reply: "موعد تسک حذف شد",
								}),
							},
						}],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } }
				);
			};

			const res = await handleIncomingMessage(
				testConfigEnv,
				{ userId, text: "موعد خرید نان سنگک رو پاک کن و بکن بدون زمان" },
				{ fetch: mockFetch }
			);

			expect.soft(geminiCalled).toBe(true);
			expect.soft(res.authorized).toBe(true);
			expect.soft(res.intent).toBe("edit");

			const row = await env.DB.prepare(
				"SELECT id, title, due_date, reminder_status FROM tasks WHERE id = ?"
			).bind(initialTask.id).first();

			// Due date must be set to null in DB and reminder_status must be disabled
			expect.soft(row.due_date).toBeNull();
			expect.soft(row.reminder_status).toBe("disabled");
		});

		it("checks behavior for ambiguous hour in Local Dispatcher («موعد تسک خرید نان رو ببر برای فردا ساعت ۵»)", async () => {
			const initialTask = await createTask(env.DB, userId, {
				title: "خرید نان",
				dueDate: "2026-11-05T10:00:00+03:30",
			});

			// 1. Inspect full dispatchLocalAction output
			const localAction = dispatchLocalAction("موعد تسک خرید نان رو ببر برای فردا ساعت ۵");
			expect.soft(localAction).not.toBeNull();
			expect.soft(localAction.isLocal).toBe(true);
			expect.soft(localAction.intent).toBe("edit");
			expect.soft(localAction.isAmbiguousTime).toBe(true);
			expect.soft(localAction.ambiguousHour).toBe(5);
			expect.soft(localAction.needsClarification).toBe(true);
			expect.soft(localAction.clarificationType).toBe("ambiguous_time");

			// 2. Process through handler: requests clarification
			const res = await handleIncomingMessage(env, {
				userId,
				text: "موعد تسک خرید نان رو ببر برای فردا ساعت ۵",
			});

			expect.soft(res.authorized).toBe(true);
			expect.soft(res.intent).toBe("clarify");
			expect.soft(res.replyText).toContain("ساعت ۵ صبح است یا ۵ عصر");

			// 3. Database check: previous due date remains unchanged until user clarifies
			const row = await env.DB.prepare(
				"SELECT id, title, due_date FROM tasks WHERE id = ?"
			).bind(initialTask.id).first();

			expect.soft(row.due_date).toBe("2026-11-05T10:00:00+03:30");
		});

		it("preserves existing due date and reminder status when only editing title via Gemini", async () => {
			await ensureReminderColumns(env.DB);

			const initialTask = await createTask(env.DB, userId, {
				title: "درس ریاضی",
				dueDate: "2026-11-06T15:00:00+03:30",
			});

			let geminiCalled = false;
			const mockFetch = async () => {
				geminiCalled = true;
				return new Response(
					JSON.stringify({
						choices: [{
							message: {
								content: JSON.stringify({
									intent: "edit",
									task: {
										target_query: "درس ریاضی",
										title: "درس فیزیک پیشرفته",
										target_index: null,
										due_date: null,
										filter: "all",
									},
									reply: "عنوان تسک به درس فیزیک پیشرفته تغییر یافت.",
								}),
							},
						}],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } }
				);
			};

			const res = await handleIncomingMessage(
				testConfigEnv,
				{ userId, text: "عنوان درس ریاضی رو بکن درس فیزیک پیشرفته" },
				{ fetch: mockFetch }
			);

			expect.soft(geminiCalled).toBe(true);
			expect.soft(res.authorized).toBe(true);
			expect.soft(res.intent).toBe("edit");

			const row = await env.DB.prepare(
				"SELECT id, title, due_date, reminder_status FROM tasks WHERE id = ?"
			).bind(initialTask.id).first();

			// Title must be updated, but existing due_date and reminder_status must be preserved
			expect.soft(row.title).toBe("درس فیزیک پیشرفته");
			expect.soft(row.due_date).toBe("2026-11-06T15:00:00+03:30");
			expect.soft(row.reminder_status).toBe("pending");
		});

		it("applies both title change and due date removal simultaneously via Gemini", async () => {
			await ensureReminderColumns(env.DB);

			const initialTask = await createTask(env.DB, userId, {
				title: "پروژه برنامه نویسی",
				dueDate: "2026-11-06T17:00:00+03:30",
			});

			let geminiCalled = false;
			const mockFetch = async () => {
				geminiCalled = true;
				return new Response(
					JSON.stringify({
						choices: [{
							message: {
								content: JSON.stringify({
									intent: "edit",
									task: {
										target_query: "پروژه برنامه نویسی",
										title: "پروژه پایتون",
										target_index: null,
										due_date: null,
										filter: "all",
									},
									reply: "تسک ویرایش شد و موعد آن حذف گردید.",
								}),
							},
						}],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } }
				);
			};

			const res = await handleIncomingMessage(
				testConfigEnv,
				{ userId, text: "عنوان تسک پروژه برنامه نویسی رو بکن پروژه پایتون و موعدش رو پاک کن" },
				{ fetch: mockFetch }
			);

			expect.soft(geminiCalled).toBe(true);
			expect.soft(res.authorized).toBe(true);
			expect.soft(res.intent).toBe("edit");

			const row = await env.DB.prepare(
				"SELECT id, title, due_date, reminder_status FROM tasks WHERE id = ?"
			).bind(initialTask.id).first();

			// Both title update and due_date removal must be applied
			expect.soft(row.title).toBe("پروژه پایتون");
			expect.soft(row.due_date).toBeNull();
			expect.soft(row.reminder_status).toBe("disabled");
		});

		it("updates due date correctly and keeps reminder pending when editing valid due date via Gemini", async () => {
			await ensureReminderColumns(env.DB);

			const initialTask = await createTask(env.DB, userId, {
				title: "خرید نان",
				dueDate: "2026-11-20T10:00:00+03:30",
			});

			let geminiCalled = false;
			const mockFetch = async () => {
				geminiCalled = true;
				return new Response(
					JSON.stringify({
						choices: [{
							message: {
								content: JSON.stringify({
									intent: "edit",
									task: {
										target_query: "خرید نان",
										title: null,
										target_index: null,
										due_date: "2026-11-20T18:00:00+03:30",
										filter: "all",
									},
									reply: "موعد تسک به ۱۸:۰۰ تغییر یافت.",
								}),
							},
						}],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } }
				);
			};

			const res = await handleIncomingMessage(
				testConfigEnv,
				{ userId, text: "ساعت خرید نان رو بکن ۱۸" },
				{ fetch: mockFetch }
			);

			expect.soft(geminiCalled).toBe(true);
			expect.soft(res.authorized).toBe(true);
			expect.soft(res.intent).toBe("edit");

			const row = await env.DB.prepare(
				"SELECT id, title, due_date, reminder_status FROM tasks WHERE id = ?"
			).bind(initialTask.id).first();

			// Title preserved, due_date updated, reminder_status pending
			expect.soft(row.title).toBe("خرید نان");
			expect.soft(row.due_date).toBe("2026-11-20T18:00:00+03:30");
			expect.soft(row.reminder_status).toBe("pending");
		});
	});
});

