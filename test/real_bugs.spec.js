import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { handleIncomingMessage, executeListTasks } from "../src/handler.js";
import {
	createTask,
	listTasks,
	findTaskByQuery,
	deleteAllTasks,
	getTaskById,
	ensurePendingClarificationsTable,
} from "../src/db.js";
import { cleanTaskTitle, dispatchLocalAction } from "../src/localDispatcher.js";
import {
	extractPersianDateTime,
	formatPersianDateTime,
	isTodayInTehran,
	isTomorrowInTehran,
	isOverdueInTehran,
	getTehranDateParts,
} from "../src/dateUtils.js";

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

describe("Hermes Mini - Real-world Telegram Bug Fixes Suite", () => {
	const userId = "555666777";

	beforeEach(async () => {
		await initDatabase(env.DB);
		await env.DB.prepare("DELETE FROM tasks").run();
		await env.DB.prepare("DELETE FROM conversation_messages").run();
		await env.DB.prepare("DELETE FROM user_displayed_lists").run();
		await env.DB.prepare("DELETE FROM processed_updates").run();
		await env.DB.prepare("DELETE FROM pending_clarifications").run();
	});

	// =========================================================================
	// Bug 1: استخراج اشتباه عنوان تسک (Title extraction)
	// =========================================================================
	describe("Bug 1: Title extraction without conversational & command filler", () => {
		it("extracts exact title from «یه تسک جدید به اسم خرید نون ثبت کن»", async () => {
			const action = dispatchLocalAction("یه تسک جدید به اسم خرید نون ثبت کن");
			expect(action).not.toBeNull();
			expect(action.intent).toBe("add");
			expect(action.title).toBe("خرید نون");

			const res = await handleIncomingMessage(env, { userId, text: "یه تسک جدید به اسم خرید نون ثبت کن" });
			expect(res.authorized).toBe(true);
			expect(res.replyText).toContain("خرید نون");
			expect(res.replyText).not.toContain("به اسم");

			const tasks = await listTasks(env.DB, userId, "all");
			expect(tasks.length).toBe(1);
			expect(tasks[0].title).toBe("خرید نون");
		});

		it("extracts exact title from «یه تسک به اسم خرید نون اضافه کن»", async () => {
			const action = dispatchLocalAction("یه تسک به اسم خرید نون اضافه کن");
			expect(action).not.toBeNull();
			expect(action.intent).toBe("add");
			expect(action.title).toBe("خرید نون");

			const res = await handleIncomingMessage(env, { userId, text: "یه تسک به اسم خرید نون اضافه کن" });
			expect(res.authorized).toBe(true);
			expect(res.replyText).toContain("خرید نون");

			const tasks = await listTasks(env.DB, userId, "all");
			expect(tasks.length).toBe(1);
			expect(tasks[0].title).toBe("خرید نون");
		});

		it("cleans prefixes like «لطفاً یه کار جدید به اسم...» and suffixes like «ثبت کن»", () => {
			expect(cleanTaskTitle("لطفاً یه تسک جدید به اسم مطالعه شیمی ثبت کن")).toBe("مطالعه شیمی");
			expect(cleanTaskTitle("ثبت کن یه تسک به اسم خرید تخم مرغ")).toBe("خرید تخم مرغ");
			expect(cleanTaskTitle("یه کار به اسم پرداخت قبوض اضافه کن")).toBe("پرداخت قبوض");
			expect(cleanTaskTitle("تسک پروژه رو ثبت کن")).toBe("پروژه");
		});
	});

	// =========================================================================
	// Bug 2: خرابی کامل قابلیت ویرایش (Edit capability breakdown)
	// =========================================================================
	describe("Bug 2: Edit capability (rescheduling & renaming) without creating new tasks", () => {
		it("reschedules date: «تسک پروژه رو بنداز برای فردا ساعت ۱۰»", async () => {
			// Create existing task first
			const initial = await createTask(env.DB, userId, { title: "پروژه" });

			const res = await handleIncomingMessage(env, { userId, text: "تسک پروژه رو بنداز برای فردا ساعت ۱۰" });
			expect(res.authorized).toBe(true);
			expect(res.intent).toBe("clarify");
			expect(res.replyText).toContain("منظورتان ساعت ۱۰ صبح است یا ۱۰ شب؟");

			const before = await getTaskById(env.DB, userId, initial.id);
			expect(before.due_date).toBeNull();

			// Clarify morning:
			const clarifyRes = await handleIncomingMessage(env, { userId, text: "صبح" });
			expect(clarifyRes.authorized).toBe(true);
			expect(clarifyRes.intent).toBe("edit");
			expect(clarifyRes.replyText).toContain("ویرایش شد");
			expect(clarifyRes.replyText).toContain("۱۰:۰۰");

			// Ensure NO new task was created and due_date was updated
			const tasks = await listTasks(env.DB, userId, "all");
			expect(tasks.length).toBe(1);
			expect(tasks[0].title).toBe("پروژه");
			expect(tasks[0].due_date).not.toBeNull();
			expect(tasks[0].due_date).toContain("10:00:00+03:30");
		});

		it("reschedules date: «تسک خرید نون رو برای فردا ساعت ۹ تغییر بده»", async () => {
			const initial = await createTask(env.DB, userId, { title: "خرید نون" });

			const res = await handleIncomingMessage(env, { userId, text: "تسک خرید نون رو برای فردا ساعت ۹ تغییر بده" });
			expect(res.authorized).toBe(true);
			expect(res.intent).toBe("clarify");
			expect(res.replyText).toContain("منظورتان ساعت ۹ صبح است یا ۹ شب؟");

			const before = await getTaskById(env.DB, userId, initial.id);
			expect(before.due_date).toBeNull();

			// Clarify morning:
			const clarifyRes = await handleIncomingMessage(env, { userId, text: "صبح" });
			expect(clarifyRes.authorized).toBe(true);
			expect(clarifyRes.intent).toBe("edit");
			expect(clarifyRes.replyText).toContain("ویرایش شد");
			expect(clarifyRes.replyText).toContain("۰۹:۰۰");

			const tasks = await listTasks(env.DB, userId, "all");
			expect(tasks.length).toBe(1);
			expect(tasks[0].title).toBe("خرید نون");
			expect(tasks[0].due_date).toContain("09:00:00+03:30");
		});

		it("renames title: «تسک خرید نون رو به خرید نون و شیر تغییر نام بده»", async () => {
			await createTask(env.DB, userId, { title: "خرید نون" });

			const res = await handleIncomingMessage(env, { userId, text: "تسک خرید نون رو به خرید نون و شیر تغییر نام بده" });
			expect(res.authorized).toBe(true);
			expect(res.intent).toBe("edit");
			expect(res.replyText).toContain("ویرایش شد");
			expect(res.replyText).toContain("خرید نون و شیر");

			const tasks = await listTasks(env.DB, userId, "all");
			expect(tasks.length).toBe(1);
			expect(tasks[0].title).toBe("خرید نون و شیر");
		});

		it("returns clear message and does NOT create task if target task not found", async () => {
			const res = await handleIncomingMessage(env, { userId, text: "تسک ورزش رو بنداز برای فردا ساعت ۱۰" });
			expect(res.authorized).toBe(true);
			expect(res.intent).toBe("edit");
			expect(res.replyText).toContain("پیدا نشد");

			// Ensure zero tasks were created in DB
			const tasks = await listTasks(env.DB, userId, "all");
			expect(tasks.length).toBe(0);
		});

		it("disambiguates multiple matching tasks without modifying either or creating new task", async () => {
			await createTask(env.DB, userId, { title: "خرید میوه" });
			await createTask(env.DB, userId, { title: "خرید سبزی" });

			const res = await handleIncomingMessage(env, { userId, text: "تسک خرید رو بنداز برای فردا ساعت ۱۰" });
			expect(res.authorized).toBe(true);
			expect(res.intent).toBe("clarify");
			expect(res.replyText).toContain("چند تسک با عنوان مشابه پیدا شد");
			expect(res.replyText).toContain("خرید میوه");
			expect(res.replyText).toContain("خرید سبزی");

			// Neither task was modified
			const tasks = await listTasks(env.DB, userId, "all");
			expect(tasks.length).toBe(2);
			expect(tasks[0].due_date).toBeNull();
			expect(tasks[1].due_date).toBeNull();
		});
	});

	// =========================================================================
	// Bug 3: اعتبارسنجی زمان (Time Validation: 00:00 vs invalid e.g. 25:00)
	// =========================================================================
	describe("Bug 3: Time validation: 00:00 preserved and 25:00 rejected", () => {
		it("rejects invalid time 25:00 with user-friendly error and does NOT create a task", async () => {
			const res = await handleIncomingMessage(env, { userId, text: "فردا ساعت ۲۵:۰۰ جلسه کاری دارم" });
			expect(res.authorized).toBe(true);
			expect(res.intent).toBe("invalid_time");
			expect(res.replyText).toContain("ساعت واردشده نامعتبر است");

			const tasks = await listTasks(env.DB, userId, "all");
			expect(tasks.length).toBe(0);
		});

		it("rejects invalid minute e.g. 14:75 without creating a task", async () => {
			const res = await handleIncomingMessage(env, { userId, text: "ساعت ۱۴:۷۵ تماس با دکتر" });
			expect(res.authorized).toBe(true);
			expect(res.intent).toBe("invalid_time");
			expect(res.replyText).toContain("ساعت واردشده نامعتبر است");

			const tasks = await listTasks(env.DB, userId, "all");
			expect(tasks.length).toBe(0);
		});

		it("accepts 00:00 (midnight) and explicitly displays «ساعت ۰۰:۰۰» in formatted reply", async () => {
			const res = await handleIncomingMessage(env, { userId, text: "فردا ساعت ۰۰:۰۰ مصرف دارو" });
			expect(res.authorized).toBe(true);
			expect(res.intent).toBe("add");
			expect(res.replyText).toContain("مصرف دارو");
			expect(res.replyText).toContain("۰۰:۰۰");

			const tasks = await listTasks(env.DB, userId, "all");
			expect(tasks.length).toBe(1);
			expect(tasks[0].title).toBe("مصرف دارو");
			expect(tasks[0].due_date).toContain("00:00:00+03:30");

			// Verify formatPersianDateTime includes 00:00
			const formatted = formatPersianDateTime(tasks[0].due_date);
			expect(formatted).toContain("۰۰:۰۰");
		});

		it("accepts «۱۲ شب» as 00:00 and displays «ساعت ۰۰:۰۰»", async () => {
			const res = await handleIncomingMessage(env, { userId, text: "فردا ساعت ۱۲ شب بک‌آپ سرور" });
			expect(res.authorized).toBe(true);
			expect(res.intent).toBe("add");
			expect(res.replyText).toContain("۰۰:۰۰");

			const tasks = await listTasks(env.DB, userId, "all");
			expect(tasks.length).toBe(1);
			expect(tasks[0].due_date).toContain("00:00:00+03:30");
		});
	});

	// =========================================================================
	// Bug 4: ثبت تاریخ در گذشته (Past date handling)
	// =========================================================================
	describe("Bug 4: Past date handling («دیروز») rejected for new task addition", () => {
		it("detects «دیروز» as past date and rejects adding new task", async () => {
			const fixedBase = new Date("2026-11-04T10:00:00Z");
			const timeInfo = extractPersianDateTime("دیروز باید گزارش پروژه رو می‌فرستادم", fixedBase);
			expect(timeInfo.hasDate).toBe(true);
			expect(timeInfo.cleanedText).not.toContain("دیروز");
			expect(timeInfo.isPastDate).toBe(true);
			expect(timeInfo.isoDueDate).toBeNull();

			const res = await handleIncomingMessage(env, { userId, text: "دیروز باید گزارش پروژه رو می‌فرستادم" });
			expect(res.authorized).toBe(true);
			expect(res.replyText).toContain("تاریخ واردشده گذشته است");

			const tasks = await listTasks(env.DB, userId, "all");
			expect(tasks.length).toBe(0);
		});
	});

	// =========================================================================
	// Bug 5: فیلتر لیست کارهای امروز و فردا (Today & tomorrow date filter)
	// =========================================================================
	describe("Bug 5: Strict Tehran date filtering for today, tomorrow, and overdue", () => {
		it("strictly separates today, tomorrow, day-after-tomorrow, yesterday, and no-date tasks", async () => {
			const yParts = (offsetDays) => {
				const tehranNow = getTehranDateParts(new Date());
				const d = new Date(Date.UTC(tehranNow.year, tehranNow.month - 1, tehranNow.day + offsetDays));
				const yStr = d.getUTCFullYear();
				const mStr = String(d.getUTCMonth() + 1).padStart(2, "0");
				const dStr = String(d.getUTCDate()).padStart(2, "0");
				return `${yStr}-${mStr}-${dStr}`;
			};

			// Task 1: Yesterday (-1 day)
			await createTask(env.DB, userId, { title: "تسک دیروز", dueDate: `${yParts(-1)}T10:00:00+03:30` });
			// Task 2: Today (0 days)
			await createTask(env.DB, userId, { title: "تسک امروز", dueDate: yParts(0) });
			// Task 3: Tomorrow (+1 day)
			await createTask(env.DB, userId, { title: "تسک فردا", dueDate: `${yParts(1)}T12:00:00+03:30` });
			// Task 4: Day after tomorrow (+2 days)
			await createTask(env.DB, userId, { title: "تسک پس‌فردا", dueDate: `${yParts(2)}T13:00:00+03:30` });
			// Task 5: No due date
			await createTask(env.DB, userId, { title: "تسک بدون موعد" });

			// Filter: Today
			const todayList = await executeListTasks(env.DB, userId, "today");
			expect(todayList.text).toContain("تسک امروز");
			expect(todayList.text).not.toContain("تسک دیروز");
			expect(todayList.text).not.toContain("تسک فردا");
			expect(todayList.text).not.toContain("تسک پس‌فردا");
			expect(todayList.text).not.toContain("تسک بدون موعد");

			// Filter: Tomorrow
			const tomorrowList = await executeListTasks(env.DB, userId, "tomorrow");
			expect(tomorrowList.text).toContain("تسک فردا");
			expect(tomorrowList.text).not.toContain("تسک پس‌فردا"); // Must NOT match "پس‌فردا"!
			expect(tomorrowList.text).not.toContain("تسک امروز");
			expect(tomorrowList.text).not.toContain("تسک دیروز");
			expect(tomorrowList.text).not.toContain("تسک بدون موعد");

			// Filter: Overdue
			const overdueList = await executeListTasks(env.DB, userId, "overdue");
			expect(overdueList.text).toContain("تسک دیروز");
			expect(overdueList.text).not.toContain("تسک امروز");
			expect(overdueList.text).not.toContain("تسک فردا");
		});
	});

	// =========================================================================
	// Bug 6: درخواست حذف گروهی (Bulk delete with 2-step confirmation)
	// =========================================================================
	describe("Bug 6: Bulk delete with explicit confirmation guard", () => {
		it("asks for confirmation on «همه تسک‌هام رو پاک کن» without deleting yet, then deletes on confirmation", async () => {
			await createTask(env.DB, userId, { title: "کار اول" });
			await createTask(env.DB, userId, { title: "کار دوم" });
			await createTask(env.DB, userId, { title: "کار سوم" });

			// Step 1: User asks for bulk delete
			const reqRes = await handleIncomingMessage(env, { userId, text: "همه تسک‌هام رو پاک کن" });
			expect(reqRes.authorized).toBe(true);
			expect(reqRes.intent).toBe("bulk_delete_request");
			expect(reqRes.replyText).toContain("آیا مطمئن هستید که می‌خواهید تمام 3 تسک خود را حذف کنید");
			expect(reqRes.replyText).toContain("بله همه را حذف کن");

			// Guard verification: NO tasks deleted yet!
			const tasksBeforeConfirm = await listTasks(env.DB, userId, "all");
			expect(tasksBeforeConfirm.length).toBe(3);

			// Step 2: User confirms
			const confirmRes = await handleIncomingMessage(env, { userId, text: "بله همه را حذف کن" });
			expect(confirmRes.authorized).toBe(true);
			expect(confirmRes.intent).toBe("delete");
			expect(confirmRes.replyText).toContain("تمام تسک‌های شما با موفقیت حذف شدند");

			// Guard verification: ALL tasks are now deleted
			const tasksAfterConfirm = await listTasks(env.DB, userId, "all");
			expect(tasksAfterConfirm.length).toBe(0);
		});

		it("handles bulk delete request when task list is already empty", async () => {
			const reqRes = await handleIncomingMessage(env, { userId, text: "تمام کارهام رو حذف کن" });
			expect(reqRes.authorized).toBe(true);
			expect(reqRes.replyText).toContain("هیچ تسکی برای حذف کردن ندارید");
		});
	});

	// =========================================================================
	// Round 2 Bug Fixes: Exact Title Extraction, Dates in Titles, Plural List Commands
	// =========================================================================
	describe("Round 2 Real-world Telegram Bug Fixes", () => {
		it("Bug 1: extracts «تست نیمه شب» without trailing «برای» from «یه تسک به اسم تست نیمه شب برای ساعت ۰۰:۰۰ ثبت کن»", async () => {
			const text = "یه تسک به اسم تست نیمه شب برای فردا ساعت ۰۰:۰۰ ثبت کن";

			const action = dispatchLocalAction(text);
			expect(action).not.toBeNull();
			expect(action.intent).toBe("add");
			expect(action.title).toBe("تست نیمه شب");
			expect(action.due_date).toContain("00:00:00+03:30");

			const res = await handleIncomingMessage(env, { userId, text });
			expect(res.authorized).toBe(true);
			expect(res.intent).toBe("add");
			expect(res.replyText).toContain("تست نیمه شب");
			expect(res.replyText).toContain("۰۰:۰۰");
			expect(res.replyText).not.toContain("تست نیمه شب برای");

			const tasks = await listTasks(env.DB, userId, "all");
			expect(tasks.length).toBe(1);
			expect(tasks[0].title).toBe("تست نیمه شب");
			expect(tasks[0].due_date).toContain("00:00:00+03:30");
		});

		it("Bug 2: extracts «تست دیروز» without stripping «دیروز» from title in «یه تسک به اسم تست دیروز برای دیروز ثبت کن»", async () => {
			const text = "یه تسک به اسم تست دیروز برای دیروز ثبت کن";

			const action = dispatchLocalAction(text);
			expect(action).not.toBeNull();
			expect(action.intent).toBe("add");
			expect(action.title).toBe("تست دیروز");
			expect(action.isPastDate).toBe(true);
			expect(action.due_date).toBeNull();

			const res = await handleIncomingMessage(env, { userId, text });
			expect(res.authorized).toBe(true);
			expect(res.replyText).toContain("تاریخ واردشده گذشته است");

			const tasks = await listTasks(env.DB, userId, "all");
			expect(tasks.length).toBe(0);
		});

		it("Bug 3: detects «تسکهای امروز رو نشون بده» as list intent without creating a task", async () => {
			// Pre-populate with a task for today
			const tehranParts = getTehranDateParts(new Date());
			const todayIso = `${tehranParts.year}-${String(tehranParts.month).padStart(2, "0")}-${String(tehranParts.day).padStart(2, "0")}T12:00:00+03:30`;
			await createTask(env.DB, userId, { title: "تسک تستی امروز", dueDate: todayIso });

			const text = "تسکهای امروز رو نشون بده";

			const action = dispatchLocalAction(text);
			expect(action).not.toBeNull();
			expect(action.intent).toBe("list");
			expect(action.filter).toBe("today");

			const res = await handleIncomingMessage(env, { userId, text });
			expect(res.authorized).toBe(true);
			expect(res.intent).toBe("list");
			expect(res.replyText).toContain("تسک تستی امروز");
			expect(res.replyText).not.toContain("های رو نشون بده");

			// Ensure zero tasks were added (count remains strictly 1)
			const tasks = await listTasks(env.DB, userId, "all");
			expect(tasks.length).toBe(1);
			expect(tasks[0].title).toBe("تسک تستی امروز");
		});

		it("handles plural task variations: «تسک‌های امروز رو نشون بده», «تسکهای فردا رو نشون بده», «نشون بده تسکهای امروز رو»", () => {
			const a1 = dispatchLocalAction("تسک‌های امروز رو نشون بده");
			expect(a1?.intent).toBe("list");
			expect(a1?.filter).toBe("today");

			const a2 = dispatchLocalAction("تسکهای فردا رو نشون بده");
			expect(a2?.intent).toBe("list");
			expect(a2?.filter).toBe("tomorrow");

			const a3 = dispatchLocalAction("نشون بده تسکهای امروز رو");
			expect(a3?.intent).toBe("list");
			expect(a3?.filter).toBe("today");

			const a4 = dispatchLocalAction("تسکهای امروز چیه؟");
			expect(a4?.intent).toBe("list");
			expect(a4?.filter).toBe("today");
		});
	});
});
