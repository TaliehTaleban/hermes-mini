import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import worker, { processDueReminders, sendDailyDigest } from "../src/index.js";
import { handleIncomingMessage, executeListTasks } from "../src/handler.js";
import { dispatchLocalAction, cleanTaskTitle, detectLocalListIntent } from "../src/localDispatcher.js";
import { getTaskStatusIcon, isOverdueInTehran, getTehranDateParts } from "../src/dateUtils.js";
import { createTask, listTasks, updateTaskStatus } from "../src/db.js";

async function initTestDb(db) {
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
		`CREATE TABLE IF NOT EXISTS user_displayed_lists (
			telegram_user_id TEXT PRIMARY KEY,
			task_ids TEXT NOT NULL,
			updated_at INTEGER NOT NULL
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

	await db.prepare("DELETE FROM tasks").run();
	await db.prepare("DELETE FROM user_displayed_lists").run();
	await db.prepare("DELETE FROM pending_confirmations").run();
}

describe("Telegram Live Bug Verification Suite", () => {
	const userId = "test_user_telegram_live";
	const baseEnv = {
		...env,
		ALLOWED_TELEGRAM_USER_ID: userId,
		TELEGRAM_BOT_TOKEN: "mock_token",
		LLM_API_KEY: "mock_key",
	};

	beforeEach(async () => {
		await initTestDb(env.DB);
	});

	describe("1. Solar Date List vs Add Intent & Title Extraction", () => {
		it("detects «کارهای ۲۲ آبان» as a list intent, never creating a task titled «کارهای»", async () => {
			const action = dispatchLocalAction("کارهای ۲۲ آبان", new Date("2026-11-07T12:00:00+03:30"));
			expect(action).not.toBeNull();
			expect(action.intent).toBe("list");
			expect(action.filter).toContain("2026-11-13"); // 22 Aban 1405 = 2026-11-13
		});

		it("detects «کارهای ۲۲ آبان رو نشون بده» and «لیست کارهای ۲۲ آبان» as list intent", async () => {
			const a1 = dispatchLocalAction("کارهای ۲۲ آبان رو نشون بده", new Date("2026-11-07T12:00:00+03:30"));
			expect(a1).not.toBeNull();
			expect(a1.intent).toBe("list");

			const a2 = dispatchLocalAction("لیست کارهای ۲۲ آبان", new Date("2026-11-07T12:00:00+03:30"));
			expect(a2).not.toBeNull();
			expect(a2.intent).toBe("list");
		});

		it("strips command phrases cleanly for «خرید نان رو به کارهام اضافه کن» and «خرید نان رو برام یادداشت کن»", () => {
			const a1 = dispatchLocalAction("خرید نان رو به کارهام اضافه کن", new Date("2026-11-07T12:00:00+03:30"));
			expect(a1.intent).toBe("add");
			expect(a1.title).toBe("خرید نان");

			const a2 = dispatchLocalAction("خرید نان رو برام یادداشت کن", new Date("2026-11-07T12:00:00+03:30"));
			expect(a2.intent).toBe("add");
			expect(a2.title).toBe("خرید نان");
		});

		it("filters tasks by exact solar date and shows custom empty message when none exist", async () => {
			const baseDate = new Date("2026-11-07T12:00:00+03:30");
			// Task 1 on 22 Aban 1405 (2026-11-13)
			await createTask(env.DB, userId, { title: "تسک روز ۲۲ آبان", dueDate: "2026-11-13" });
			// Task 2 on 23 Aban 1405 (2026-11-14)
			await createTask(env.DB, userId, { title: "تسک روز ۲۳ آبان", dueDate: "2026-11-14" });

			// Listing 22 Aban: only Task 1 is returned with Solar header
			const res22 = await handleIncomingMessage(
				baseEnv,
				{ userId, text: "کارهای ۲۲ آبان رو نشون بده" },
				{ baseDate }
			);
			expect(res22.intent).toBe("list");
			expect(res22.replyText).toContain("تسک روز ۲۲ آبان");
			expect(res22.replyText).not.toContain("تسک روز ۲۳ آبان");
			expect(res22.replyText).toContain("۲۲ آبان");

			// Listing 19 Aban (empty): returns specific empty message without falling back to full list
			const res19 = await handleIncomingMessage(
				baseEnv,
				{ userId, text: "کارهای ۱۹ آبان رو نشون بده" },
				{ baseDate }
			);
			expect(res19.intent).toBe("list");
			expect(res19.replyText).toContain("هیچ تسکی ثبت نشده است");
			expect(res19.replyText).toContain("۱۹ آبان");
			expect(res19.replyText).not.toContain("تسک روز ۲۲ آبان");
		});

		it("does not automatically add a task when a pure solar date is sent alone", async () => {
			const res = await handleIncomingMessage(
				baseEnv,
				{ userId, text: "۲۲ آبان" },
				{ baseDate: new Date("2026-11-07T12:00:00+03:30") }
			);
			expect(res.intent).not.toBe("add");
			const allTasks = await listTasks(env.DB, userId, "all");
			expect(allTasks.length).toBe(0);
		});
	});

	describe("2. Task Renaming with «عنوان»", () => {
		it("correctly identifies target task and new title for «عنوان خرید نان رو به خرید شیر تغییر بده»", async () => {
			await createTask(env.DB, userId, { title: "خرید نان", dueDate: "2026-11-10T10:00:00+03:30" });

			const res = await handleIncomingMessage(
				baseEnv,
				{ userId, text: "عنوان خرید نان رو به خرید شیر تغییر بده" },
				{ baseDate: new Date("2026-11-07T12:00:00+03:30") }
			);

			expect(res.intent).toBe("edit");
			expect(res.replyText).toContain("خرید شیر");

			const tasks = await listTasks(env.DB, userId, "all");
			expect(tasks[0].title).toBe("خرید شیر");
			expect(tasks[0].due_date).toBe("2026-11-10T10:00:00+03:30"); // Existing due date preserved!
		});

		it("correctly renames task without the word «عنوان» (e.g. «خرید نان رو به خرید شیر تغییر بده»)", async () => {
			await createTask(env.DB, userId, { title: "خرید نان", dueDate: "2026-11-10T10:00:00+03:30" });

			const res = await handleIncomingMessage(
				baseEnv,
				{ userId, text: "خرید نان رو به خرید شیر تغییر بده" },
				{ baseDate: new Date("2026-11-07T12:00:00+03:30") }
			);

			expect(res.intent).toBe("edit");
			expect(res.replyText).toContain("خرید شیر");

			const tasks = await listTasks(env.DB, userId, "all");
			expect(tasks[0].title).toBe("خرید شیر");
			expect(tasks[0].due_date).toBe("2026-11-10T10:00:00+03:30");
		});
	});

	describe("3. Colloquial Done Detection", () => {
		it("marks task done for «واسه اذان بیدار شدم» matching «بیدار شدن برای اذان»", async () => {
			await createTask(env.DB, userId, { title: "بیدار شدن برای اذان", dueDate: "2026-11-08T05:00:00+03:30" });

			const res = await handleIncomingMessage(
				baseEnv,
				{ userId, text: "واسه اذان بیدار شدم" },
				{ baseDate: new Date("2026-11-07T12:00:00+03:30") }
			);

			expect(res.intent).toBe("done");
			expect(res.replyText).toContain("بیدار شدن برای اذان");

			const tasks = await listTasks(env.DB, userId, "all");
			expect(tasks[0].is_completed).toBe(1);
		});

		it("marks task done for colloquial «رفتم دکتر» matching pending task «دکتر»", async () => {
			await createTask(env.DB, userId, { title: "دکتر", dueDate: "2026-11-08T15:00:00+03:30" });

			const res = await handleIncomingMessage(
				baseEnv,
				{ userId, text: "رفتم دکتر" },
				{ baseDate: new Date("2026-11-07T12:00:00+03:30") }
			);

			expect(res.intent).toBe("done");
			expect(res.replyText).toContain("دکتر");

			const tasks = await listTasks(env.DB, userId, "all");
			expect(tasks[0].is_completed).toBe(1);
		});

		it("does NOT mark single pending task done for ambiguous «انجامش دادم» or «تموم شد» without title, and asks clarification", async () => {
			await createTask(env.DB, userId, { title: "تکلیف درس ریاضی" });

			const res = await handleIncomingMessage(
				baseEnv,
				{ userId, text: "انجامش دادم" },
				{ baseDate: new Date("2026-11-07T12:00:00+03:30") }
			);

			expect(res.intent).toBe("clarify");
			expect(res.replyText).toContain("مشخص نکردید");

			const tasks = await listTasks(env.DB, userId, "all");
			expect(tasks[0].is_completed).toBe(0);
		});

		it("marks task done when title is clearly specified in colloquial past-action «تکلیف درس ریاضی رو انجام دادم»", async () => {
			await createTask(env.DB, userId, { title: "تکلیف درس ریاضی" });

			const res = await handleIncomingMessage(
				baseEnv,
				{ userId, text: "تکلیف درس ریاضی رو انجام دادم" },
				{ baseDate: new Date("2026-11-07T12:00:00+03:30") }
			);

			expect(res.intent).toBe("done");
			expect(res.replyText).toContain("تکلیف درس ریاضی");

			const tasks = await listTasks(env.DB, userId, "all");
			expect(tasks[0].is_completed).toBe(1);
		});

		it("asks clarification when multiple pending tasks exist and user sends ambiguous «انجامش دادم»", async () => {
			await createTask(env.DB, userId, { title: "کار اول" });
			await createTask(env.DB, userId, { title: "کار دوم" });

			const res = await handleIncomingMessage(
				baseEnv,
				{ userId, text: "انجامش دادم" },
				{ baseDate: new Date("2026-11-07T12:00:00+03:30") }
			);

			expect(res.intent).toBe("clarify");
			expect(res.replyText).toContain("مشخص نکردید");
			const tasks = await listTasks(env.DB, userId, "all");
			// Neither task was modified
			expect(tasks.every((t) => t.is_completed === 0)).toBe(true);
		});
	});

	describe("4. Bulk Delete Completed Tasks", () => {
		it("prompts for confirmation on «کارهای انجام شده رو حذف کن» and deletes only completed tasks", async () => {
			await createTask(env.DB, userId, { title: "تسک انجام شده ۱" });
			await createTask(env.DB, userId, { title: "تسک انجام شده ۲" });
			await createTask(env.DB, userId, { title: "تسک باقی مانده" });

			const all = await listTasks(env.DB, userId, "all");
			await updateTaskStatus(env.DB, userId, all[0].id, true);
			await updateTaskStatus(env.DB, userId, all[1].id, true);

			// Step 1: Bulk delete request
			const reqRes = await handleIncomingMessage(
				baseEnv,
				{ userId, text: "کارهای انجام شده رو حذف کن" },
				{ baseDate: new Date("2026-11-07T12:00:00+03:30") }
			);

			expect(reqRes.intent).toBe("bulk_delete_completed_request");
			expect(reqRes.replyText).toContain("۲ مورد");
			expect(reqRes.replyText).toContain("انجام‌شده");

			// Step 2: Confirm deletion
			const confirmRes = await handleIncomingMessage(
				baseEnv,
				{ userId, text: "بله همه رو پاک کن" },
				{ baseDate: new Date("2026-11-07T12:00:00+03:30") }
			);

			expect(confirmRes.intent).toBe("delete");

			const remaining = await listTasks(env.DB, userId, "all");
			expect(remaining.length).toBe(1);
			expect(remaining[0].title).toBe("تسک باقی مانده");
			expect(remaining[0].is_completed).toBe(0);
		});

		it("reports no completed tasks when attempting bulk delete on zero completed tasks", async () => {
			await createTask(env.DB, userId, { title: "یک کار انجام نشده" });

			const res = await handleIncomingMessage(
				baseEnv,
				{ userId, text: "کارهای انجام شده رو حذف کن" },
				{ baseDate: new Date("2026-11-07T12:00:00+03:30") }
			);

			expect(res.intent).toBe("bulk_delete_completed_request");
			expect(res.replyText).toContain("هیچ تسک انجام‌شده‌ای برای حذف وجود ندارد");
		});

		it("cancels bulk delete of completed tasks when user sends «نه» or «لغو کن»", async () => {
			await createTask(env.DB, userId, { title: "تسک ۱" });
			const all = await listTasks(env.DB, userId, "all");
			await updateTaskStatus(env.DB, userId, all[0].id, true);

			// Request
			await handleIncomingMessage(
				baseEnv,
				{ userId, text: "کارهای انجام شده رو از لیست پاک کن" },
				{ baseDate: new Date("2026-11-07T12:00:00+03:30") }
			);

			// Cancel
			const cancelRes = await handleIncomingMessage(
				baseEnv,
				{ userId, text: "نه لغو کن" },
				{ baseDate: new Date("2026-11-07T12:00:00+03:30") }
			);

			expect(cancelRes.intent).toBe("cancel");
			expect(cancelRes.replyText).toContain("لغو شد");

			const tasks = await listTasks(env.DB, userId, "all");
			expect(tasks.length).toBe(1);
			expect(tasks[0].is_completed).toBe(1); // Task was preserved
		});
	});

	describe("5. Unified Status Icons (🟩 / 🟥 / ⬜️)", () => {
		it("formats 🟩 for completed, 🟥 for overdue, and ⬜️ for normal incomplete in executeListTasks", async () => {
			const baseDate = new Date("2026-11-07T20:15:00+03:30");

			// Task 1: Completed (even if overdue date) -> 🟩
			await createTask(env.DB, userId, { title: "تسک کامل شده", dueDate: "2026-11-06T10:00:00+03:30" });
			// Task 2: Incomplete and overdue (today 19:57 < 20:15) -> 🟥
			await createTask(env.DB, userId, { title: "تسک معوق امروز", dueDate: "2026-11-07T19:57:00+03:30" });
			// Task 3: Incomplete and normal (today 22:00 > 20:15) -> ⬜️
			await createTask(env.DB, userId, { title: "تسک آینده امروز", dueDate: "2026-11-07T22:00:00+03:30" });
			// Task 4: Incomplete and no date -> ⬜️
			await createTask(env.DB, userId, { title: "تسک بدون موعد" });

			const all = await listTasks(env.DB, userId, "all");
			await updateTaskStatus(env.DB, userId, all[0].id, true);

			const listRes = await executeListTasks(env.DB, userId, "all", baseDate);

			expect(listRes.text).toContain("1. 🟥 تسک معوق امروز");
			expect(listRes.text).toContain("2. ⬜️ تسک آینده امروز");
			expect(listRes.text).toContain("3. ⬜️ تسک بدون موعد");
			expect(listRes.text).toContain("4. 🟩 تسک کامل شده");
		});

		it("formats sendDailyDigest with ⬜️ for today tasks, 🟩 for completed today tasks, and 🟥 for overdue tasks without duplicates", async () => {
			const tehranNow = getTehranDateParts(new Date());
			const todayDue = tehranNow.dateString;
			const baseUtc = Date.UTC(tehranNow.year, tehranNow.month - 1, tehranNow.day);
			const yesterdayDue = `${getTehranDateParts(new Date(baseUtc - 24 * 3600 * 1000)).dateString}T12:00:00+03:30`;
			await createTask(env.DB, userId, { title: "تسک امروز صبحگاهی", dueDate: todayDue });
			const completedToday = await createTask(env.DB, userId, { title: "تسک انجام‌شده امروز", dueDate: todayDue });
			await updateTaskStatus(env.DB, userId, completedToday.id, true);
			await createTask(env.DB, userId, { title: "تسک دیروز صبحگاهی", dueDate: yesterdayDue });

			let digestBody = null;
			const mockFetch = async (url, options) => {
				digestBody = JSON.parse(options.body || "{}");
				return new Response(JSON.stringify({ ok: true, result: { message_id: 888 } }), { status: 200 });
			};

			await sendDailyDigest(env, { allowedUserId: userId, telegramBotToken: "mock_token" }, mockFetch);

			expect(digestBody).not.toBeNull();
			expect(digestBody.text).toContain("1. ⬜️ تسک امروز صبحگاهی");
			expect(digestBody.text).toContain("2. 🟩 تسک انجام‌شده امروز");
			expect(digestBody.text).toContain("1. 🟥 تسک دیروز صبحگاهی");
			// Ensure today's task is never duplicated in the overdue section
			const overdueSection = digestBody.text.split("کارهای عقب‌افتاده از روزهای قبل:")[1] || "";
			expect(overdueSection).not.toContain("تسک امروز صبحگاهی");
		});

		it("sends pleasant empty message in sendDailyDigest when no tasks exist today or from past days", async () => {
			let digestBody = null;
			const mockFetch = async (url, options) => {
				digestBody = JSON.parse(options.body || "{}");
				return new Response(JSON.stringify({ ok: true, result: { message_id: 889 } }), { status: 200 });
			};

			await sendDailyDigest(env, { allowedUserId: userId, telegramBotToken: "mock_token" }, mockFetch);

			expect(digestBody).not.toBeNull();
			expect(digestBody.text).toContain("صبح بخیر!");
			expect(digestBody.text).toContain("امروز هیچ کاری در برنامه شما نیست");
		});
	});

	describe("6. Scheduled Cron Reminder Testing via Official Interface", () => {
		it("dispatches due reminders when triggered via worker.scheduled('* * * * *')", async () => {
			// Task due 60 seconds ago
			const pastDue = new Date(Date.now() - 60 * 1000).toISOString();
			await env.DB.prepare(
				`INSERT INTO tasks (telegram_user_id, title, due_date, reminder_status) VALUES (?, 'تسک جلسه تستی', ?, 'pending')`
			).bind(userId, pastDue).run();

			const sentMessages = [];
			const mockFetch = async (url, options) => {
				const body = JSON.parse(options.body || "{}");
				sentMessages.push(body);
				return new Response(JSON.stringify({ ok: true, result: { message_id: 999 } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			};

			const originalFetch = globalThis.fetch;
			globalThis.fetch = mockFetch;
			const ctx = createExecutionContext();

			try {
				await worker.scheduled({ cron: "* * * * *" }, baseEnv, ctx);
				await waitOnExecutionContext(ctx);

				expect(sentMessages.length).toBe(1);
				expect(sentMessages[0].text).toContain("تسک جلسه تستی");
				expect(sentMessages[0].text).toContain("یادآوری موعد تسک");

				// DB status updated to 'sent'
				const row = await env.DB.prepare("SELECT reminder_status, reminder_sent FROM tasks WHERE title = 'تسک جلسه تستی'").first();
				expect(row.reminder_status).toBe("sent");
				expect(row.reminder_sent).toBe(1);
			} finally {
				globalThis.fetch = originalFetch;
			}
		});
	});
});
