import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import {
	createTask,
	getTaskById,
	listTasks,
	updateTaskStatus,
	findTasksByQuery,
} from "../src/db.js";
import {
	detectLocalStatusIntent,
	detectLocalListIntent,
	dispatchLocalAction,
} from "../src/localDispatcher.js";
import {
	executeListTasks,
	handleIncomingMessage,
} from "../src/handler.js";
import {
	normalizeWeekday,
	isWeekdayInTehran,
	getTehranWeekdayIndex,
} from "../src/dateUtils.js";
import { validateLlmOutput } from "../src/llm.js";

async function initTestDatabase(db) {
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
			status TEXT NOT NULL,
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
			task_ids TEXT NOT NULL,
			updated_at INTEGER NOT NULL
		)`
	).run();
}

describe("Verification Suite: Bug 1 (Task Uncompleting & D1 LIKE Safety)", () => {
	const userId = "test_user_bug1";

	beforeEach(async () => {
		await initTestDatabase(env.DB);
		await env.DB.prepare("DELETE FROM tasks").run();
		await env.DB.prepare("DELETE FROM conversation_messages").run();
		await env.DB.prepare("DELETE FROM processed_updates").run();
	});

	it("1. Accurately parses 'خرید شیر رو دوباره به حالت انجام‌نشده برگردون' without polluting target_query", () => {
		const action = dispatchLocalAction("خرید شیر رو دوباره به حالت انجام‌نشده برگردون");
		expect(action).not.toBeNull();
		expect(action.intent).toBe("undone");
		expect(action.target_query).toBe("خرید شیر");
		expect(action.target_index).toBeNull();
	});

	it("2. Accurately parses variations of colloquial undone commands", () => {
		const samples = [
			{ text: "خرید شیر رو برگردون", expectedQuery: "خرید شیر" },
			{ text: "خرید شیر رو به حالت انجام نشده برگردون", expectedQuery: "خرید شیر" },
			{ text: "خرید شیر رو برگردون به حالت انجام‌نشده", expectedQuery: "خرید شیر" },
			{ text: "خرید شیر رو دوباره برگردون", expectedQuery: "خرید شیر" },
			{ text: "خرید شیر رو انجام‌نشده کن", expectedQuery: "خرید شیر" },
			{ text: "دوباره به حالت انجام‌نشده برگردون خرید شیر رو", expectedQuery: "خرید شیر" },
			{ text: "برگردون خرید شیر", expectedQuery: "خرید شیر" },
		];

		for (const s of samples) {
			const action = dispatchLocalAction(s.text);
			expect(action).not.toBeNull();
			expect(action.intent).toBe("undone");
			expect(action.target_query).toBe(s.expectedQuery);
		}
	});

	it("3. findTasksByQuery is resilient against long queries and prevents 'LIKE or GLOB pattern too complex'", async () => {
		// Insert test task
		await createTask(env.DB, userId, { title: "خرید شیر", dueDate: "2026-11-09" });

		// Search with a very long Persian query (>50 bytes)
		const longQuery = "یک متن بسیار طولانی برای تست عملکرد جستجوی دیتابیس که از پنجاه بایت و هفتاد بایت رد شده است";
		let error = null;
		let results = null;
		try {
			results = await findTasksByQuery(env.DB, userId, longQuery, false);
		} catch (err) {
			error = err;
		}

		expect(error).toBeNull();
		expect(Array.isArray(results)).toBe(true);
		expect(results.length).toBe(0);

		// Regular search works
		const match = await findTasksByQuery(env.DB, userId, "خرید شیر", false);
		expect(match.length).toBe(1);
		expect(match[0].title).toBe("خرید شیر");
	});

	it("4. End-to-end Handler: Changes task status from 1 to 0 on 'خرید شیر رو دوباره به حالت انجام‌نشده برگردون'", async () => {
		// 1. Create task
		const created = await createTask(env.DB, userId, {
			title: "خرید شیر",
			dueDate: "2026-11-09T18:00:00+03:30",
		});
		expect(created.id).toBeDefined();

		// 2. Mark completed
		await updateTaskStatus(env.DB, userId, created.id, true);
		const rowAfterDone = await getTaskById(env.DB, userId, created.id);
		expect(rowAfterDone.is_completed).toBe(1);

		// 3. Execute uncomplete via Handler
		const mockEnv = {
			DB: env.DB,
			ALLOWED_TELEGRAM_USER_ID: userId,
			TIMEZONE: "Asia/Tehran",
		};

		const res = await handleIncomingMessage(mockEnv, {
			userId,
			text: "خرید شیر رو دوباره به حالت انجام‌نشده برگردون",
			updateId: "upd_uncomplete_1",
		});

		expect(res.isError).toBe(false);
		expect(res.replyText).toContain("خرید شیر");
		expect(res.replyText).toContain("به حالت انجام‌نشده بازگردانده شد");

		// 4. Verify DB status is now 0
		const rowAfterUndone = await getTaskById(env.DB, userId, created.id);
		expect(rowAfterUndone.is_completed).toBe(0);

		// 5. Repeating command works cleanly without DB error
		const repeatRes = await handleIncomingMessage(mockEnv, {
			userId,
			text: "خرید شیر رو برگردون",
			updateId: "upd_uncomplete_2",
		});
		expect(repeatRes.isError).toBe(false);
		expect(repeatRes.replyText).toContain("خرید شیر");
	});
});

describe("Verification Suite: Bug 2 (Weekday List Filtering)", () => {
	const userId = "test_user_bug2";

	beforeEach(async () => {
		await initTestDatabase(env.DB);
		await env.DB.prepare("DELETE FROM tasks").run();
		await env.DB.prepare("DELETE FROM conversation_messages").run();
	});

	it("1. Weekday normalization and index calculation for all 7 days in Asia/Tehran", () => {
		expect(normalizeWeekday("شنبه")).toBe("شنبه");
		expect(normalizeWeekday("یکشنبه")).toBe("یکشنبه");
		expect(normalizeWeekday("یک شنبه")).toBe("یکشنبه");
		expect(normalizeWeekday("دوشنبه")).toBe("دوشنبه");
		expect(normalizeWeekday("دو شنبه")).toBe("دوشنبه");
		expect(normalizeWeekday("سه‌شنبه")).toBe("سه‌شنبه");
		expect(normalizeWeekday("سه شنبه")).toBe("سه‌شنبه");
		expect(normalizeWeekday("سهشنبه")).toBe("سه‌شنبه");
		expect(normalizeWeekday("چهارشنبه")).toBe("چهارشنبه");
		expect(normalizeWeekday("چهار شنبه")).toBe("چهارشنبه");
		expect(normalizeWeekday("پنج‌شنبه")).toBe("پنج‌شنبه");
		expect(normalizeWeekday("پنج شنبه")).toBe("پنج‌شنبه");
		expect(normalizeWeekday("پنجشنبه")).toBe("پنج‌شنبه");
		expect(normalizeWeekday("جمعه")).toBe("جمعه");
		expect(normalizeWeekday("آدینه")).toBe("جمعه");

		// Dates from 2026-11-07 (Sat) to 2026-11-13 (Fri)
		expect(getTehranWeekdayIndex("2026-11-07")).toBe(6); // شنبه
		expect(getTehranWeekdayIndex("2026-11-08")).toBe(0); // یکشنبه
		expect(getTehranWeekdayIndex("2026-11-09")).toBe(1); // دوشنبه
		expect(getTehranWeekdayIndex("2026-11-10")).toBe(2); // سه‌شنبه
		expect(getTehranWeekdayIndex("2026-11-11")).toBe(3); // چهارشنبه
		expect(getTehranWeekdayIndex("2026-11-12")).toBe(4); // پنج‌شنبه
		expect(getTehranWeekdayIndex("2026-11-13")).toBe(5); // جمعه

		// Test isWeekdayInTehran
		expect(isWeekdayInTehran("2026-11-09T18:00:00+03:30", "دوشنبه")).toBe(true);
		expect(isWeekdayInTehran("2026-11-09T18:00:00+03:30", "سه شنبه")).toBe(false);
	});

	it("2. Local list intent recognizes all weekday variants including 'کارای', 'کارهای روز', 'برنامه'", () => {
		const samples = [
			{ text: "کارهای دوشنبه رو نشون بده", expectedFilter: "دوشنبه" },
			{ text: "کارهای سه شنبه رو نشون بده", expectedFilter: "سه‌شنبه" },
			{ text: "کارای پنجشنبه رو نشون بده", expectedFilter: "پنج‌شنبه" },
			{ text: "کار های سه شنبه رو نشون بده", expectedFilter: "سه‌شنبه" },
			{ text: "کارهای روز دوشنبه رو نشون بده", expectedFilter: "دوشنبه" },
			{ text: "کارای روز پنجشنبه رو نشون بده", expectedFilter: "پنج‌شنبه" },
			{ text: "کارهای دوشنبه", expectedFilter: "دوشنبه" },
			{ text: "برنامه دوشنبه", expectedFilter: "دوشنبه" },
			{ text: "برنامه روز دوشنبه", expectedFilter: "دوشنبه" },
			{ text: "لیست کارهای دوشنبه", expectedFilter: "دوشنبه" },
			{ text: "پنجشنبه کارام رو نشون بده", expectedFilter: "پنج‌شنبه" },
		];

		for (const s of samples) {
			const res = detectLocalListIntent(s.text);
			expect(res, `Failed for: ${s.text}`).not.toBeNull();
			expect(res.intent).toBe("list");
			expect(res.filter).toBe(s.expectedFilter);
		}
	});

	it("3. executeListTasks filters accurately for each day of the week and does NOT return all tasks", async () => {
		// Populate tasks across all 7 days of the week:
		// 2026-11-07 (Saturday) to 2026-11-13 (Friday)
		await createTask(env.DB, userId, { title: "تسک شنبه", dueDate: "2026-11-07T10:00:00+03:30" });
		await createTask(env.DB, userId, { title: "تسک یکشنبه", dueDate: "2026-11-08T10:00:00+03:30" });
		await createTask(env.DB, userId, { title: "تسک دوشنبه ۱", dueDate: "2026-11-09T10:00:00+03:30" });
		await createTask(env.DB, userId, { title: "تسک دوشنبه ۲", dueDate: "2026-11-09" }); // Date-only
		await createTask(env.DB, userId, { title: "تسک سه‌شنبه", dueDate: "2026-11-10T10:00:00+03:30" });
		await createTask(env.DB, userId, { title: "تسک چهارشنبه", dueDate: "2026-11-11T10:00:00+03:30" });
		await createTask(env.DB, userId, { title: "تسک پنج‌شنبه", dueDate: "2026-11-12T10:00:00+03:30" });
		await createTask(env.DB, userId, { title: "تسک جمعه", dueDate: "2026-11-13T10:00:00+03:30" });

		// Test Monday filter: must contain ONLY Monday tasks
		const mondayList = await executeListTasks(env.DB, userId, "دوشنبه");
		expect(mondayList.text).toContain("📅 کارهای دوشنبه:");
		expect(mondayList.text).toContain("تسک دوشنبه ۱");
		expect(mondayList.text).toContain("تسک دوشنبه ۲");
		expect(mondayList.text).not.toContain("تسک شنبه");
		expect(mondayList.text).not.toContain("تسک یکشنبه");
		expect(mondayList.text).not.toContain("تسک سه‌شنبه");
		expect(mondayList.text).not.toContain("تسک چهارشنبه");
		expect(mondayList.text).not.toContain("تسک پنج‌شنبه");
		expect(mondayList.text).not.toContain("تسک جمعه");
		expect(mondayList.displayedIds.length).toBe(2);

		// Test Thursday filter: must contain ONLY Thursday tasks
		const thursdayList = await executeListTasks(env.DB, userId, "پنج‌شنبه");
		expect(thursdayList.text).toContain("📅 کارهای پنج‌شنبه:");
		expect(thursdayList.text).toContain("تسک پنج‌شنبه");
		expect(thursdayList.displayedIds.length).toBe(1);

		// Test Friday filter: must contain ONLY Friday tasks
		const fridayList = await executeListTasks(env.DB, userId, "جمعه");
		expect(fridayList.text).toContain("📅 کارهای جمعه:");
		expect(fridayList.text).toContain("تسک جمعه");
		expect(fridayList.displayedIds.length).toBe(1);
	});

	it("4. executeListTasks displays appropriate empty message when no task exists for requested weekday", async () => {
		// Only a Saturday task exists
		await createTask(env.DB, userId, { title: "تسک شنبه", dueDate: "2026-11-07T10:00:00+03:30" });

		// Filter for Thursday (which has 0 tasks)
		const res = await executeListTasks(env.DB, userId, "پنج‌شنبه");
		expect(res.text).toBe("📅 برای پنج‌شنبه هیچ تسکی ثبت نشده است.");
		expect(res.displayedIds.length).toBe(0);
		// Crucially, must NOT return the Saturday task!
		expect(res.text).not.toContain("تسک شنبه");
		expect(res.text).not.toContain("📋 لیست تسک‌های شما");
	});

	it("5. Existing filters (all, today, tomorrow, day_after_tomorrow, completed, pending, overdue) preserve exact behavior", async () => {
		const allList = await executeListTasks(env.DB, userId, "all");
		expect(allList.text).toContain("لیست تسک‌های شما خالی است");

		await createTask(env.DB, userId, { title: "تسک انجام شده", dueDate: "2026-11-07" });
		const allTasks = await listTasks(env.DB, userId, "all");
		await updateTaskStatus(env.DB, userId, allTasks[0].id, true);

		const completedList = await executeListTasks(env.DB, userId, "completed");
		expect(completedList.text).toContain("✅ تسک‌های انجام‌شده:");
		expect(completedList.text).toContain("تسک انجام شده");
	});

	it("6. LLM response parser preserves Persian weekday filters and does not coerce them to 'all'", () => {
		const rawResponse = {
			intent: "list",
			task: {
				title: null,
				target_query: null,
				target_index: null,
				due_date: null,
				filter: "دوشنبه",
			},
			reply: "کارهای دوشنبه شما:",
		};

		const validated = validateLlmOutput(rawResponse);
		expect(validated.valid).toBe(true);
		expect(validated.data.task.filter).toBe("دوشنبه");

		// Test Thursday variant
		rawResponse.task.filter = "پنجشنبه";
		const validatedThursday = validateLlmOutput(rawResponse);
		expect(validatedThursday.valid).toBe(true);
		expect(validatedThursday.data.task.filter).toBe("پنج‌شنبه");
	});
});
