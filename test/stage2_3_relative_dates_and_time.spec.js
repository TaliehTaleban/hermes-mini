import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { handleIncomingMessage, executeListTasks } from "../src/handler.js";
import { createTask, listTasks, ensurePendingClarificationsTable } from "../src/db.js";
import { dispatchLocalAction, detectLocalListIntent } from "../src/localDispatcher.js";
import {
	extractPersianDateTime,
	formatPersianDateTime,
	isDayAfterTomorrowInTehran,
	isTomorrowInTehran,
	isTodayInTehran,
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

describe("Hermes Mini - Stage 2 & 3: Relative Dates, Day After Tomorrow & Hour Validation Suite", () => {
	const userId = "stage2_3_user_789";

	beforeEach(async () => {
		await initDatabase(env.DB);
		await env.DB.prepare("DELETE FROM tasks").run();
		await env.DB.prepare("DELETE FROM conversation_messages").run();
		await env.DB.prepare("DELETE FROM user_displayed_lists").run();
		await env.DB.prepare("DELETE FROM processed_updates").run();
		await env.DB.prepare("DELETE FROM pending_clarifications").run();
	});

	describe("Stage 2: Day After Tomorrow & Relative Dates", () => {
		it("detects «تسکهای فردا رو نشون بده» as filter: tomorrow", () => {
			const action = detectLocalListIntent("تسکهای فردا رو نشون بده");
			expect(action).not.toBeNull();
			expect(action.intent).toBe("list");
			expect(action.filter).toBe("tomorrow");
		});

		it("detects «تسکهای پس فردا رو نشون بده» as filter: day_after_tomorrow", () => {
			const action = detectLocalListIntent("تسکهای پس فردا رو نشون بده");
			expect(action).not.toBeNull();
			expect(action.intent).toBe("list");
			expect(action.filter).toBe("day_after_tomorrow");
		});

		it("detects «تسکهای پسفردا رو نشون بده» as filter: day_after_tomorrow", () => {
			const action = detectLocalListIntent("تسکهای پسفردا رو نشون بده");
			expect(action).not.toBeNull();
			expect(action.intent).toBe("list");
			expect(action.filter).toBe("day_after_tomorrow");
		});

		it("detects «کارهای پس‌فردا رو نشون بده» as filter: day_after_tomorrow", () => {
			const action = detectLocalListIntent("کارهای پس‌فردا رو نشون بده");
			expect(action).not.toBeNull();
			expect(action.intent).toBe("list");
			expect(action.filter).toBe("day_after_tomorrow");
		});

		it("executeListTasks filters correctly for day_after_tomorrow", async () => {
			const now = new Date();
			const tehranParts = getTehranDateParts(now);

			// Tomorrow
			const tomorrowDate = new Date(Date.UTC(tehranParts.year, tehranParts.month - 1, tehranParts.day + 1));
			const tomorrowIso = `${tomorrowDate.getUTCFullYear()}-${String(tomorrowDate.getUTCMonth() + 1).padStart(2, "0")}-${String(tomorrowDate.getUTCDate()).padStart(2, "0")}T10:00:00+03:30`;

			// Day after tomorrow
			const dayAfterDate = new Date(Date.UTC(tehranParts.year, tehranParts.month - 1, tehranParts.day + 2));
			const dayAfterIso = `${dayAfterDate.getUTCFullYear()}-${String(dayAfterDate.getUTCMonth() + 1).padStart(2, "0")}-${String(dayAfterDate.getUTCDate()).padStart(2, "0")}T11:00:00+03:30`;

			await createTask(env.DB, userId, { title: "کار فردا", dueDate: tomorrowIso });
			await createTask(env.DB, userId, { title: "کار پس‌فردا", dueDate: dayAfterIso });

			const listRes = await executeListTasks(env.DB, userId, "day_after_tomorrow");
			expect(listRes.text).toContain("📅 کارهای پس‌فردا:");
			expect(listRes.text).toContain("کار پس‌فردا");
			expect(listRes.text).not.toContain("کار فردا");
		});

		it("returns dedicated empty message when no tasks exist for day_after_tomorrow", async () => {
			const listRes = await executeListTasks(env.DB, userId, "day_after_tomorrow");
			expect(listRes.text).toBe("📅 برای پس‌فردا هیچ تسکی ثبت نشده است.");
		});

		it("extracts «روز بعد» as +1 day offset", () => {
			const baseDate = new Date("2026-11-04T10:00:00Z");
			const timeInfo = extractPersianDateTime("یه تسک برای روز بعد ساعت ۱۰ ثبت کن", baseDate);
			expect(timeInfo.hasDate).toBe(true);
			expect(timeInfo.isInvalidTime).toBe(false);
			expect(timeInfo.isAmbiguousTime).toBe(true);
			expect(timeInfo.ambiguousHour).toBe(10);
			expect(timeInfo.needsClarification).toBe(true);
			expect(timeInfo.isoDueDate).toBeNull();
			expect(isTomorrowInTehran(timeInfo.targetDateStr, baseDate)).toBe(true);
		});

		it("extracts «دو روز بعد» as +2 days offset", () => {
			const baseDate = new Date("2026-11-04T10:00:00Z");
			const timeInfo = extractPersianDateTime("یه تسک برای دو روز بعد ساعت ۱۰ ثبت کن", baseDate);
			expect(timeInfo.hasDate).toBe(true);
			expect(timeInfo.isInvalidTime).toBe(false);
			expect(timeInfo.isAmbiguousTime).toBe(true);
			expect(timeInfo.ambiguousHour).toBe(10);
			expect(timeInfo.needsClarification).toBe(true);
			expect(timeInfo.isoDueDate).toBeNull();
			expect(isDayAfterTomorrowInTehran(timeInfo.targetDateStr, baseDate)).toBe(true);
		});
	});

	describe("Stage 3: Hour Validation (00:00 to 23:59)", () => {
		it("rejects hour 24:00 with invalid_time error", async () => {
			const res = await handleIncomingMessage(env, {
				userId,
				text: "یه تسک به اسم تست نیمه شب برای ساعت ۲۴:۰۰ ثبت کن",
			});
			expect(res.replyText).toContain("ساعت واردشده نامعتبر است");
			expect(res.replyText).toContain("۰۰:۰۰ تا ۲۳:۵۹");

			// Confirm task was NOT created in DB
			const allTasks = await listTasks(env.DB, userId, "all");
			expect(allTasks.length).toBe(0);
		});

		it("rejects hour 25:00 with invalid_time error", async () => {
			const res = await handleIncomingMessage(env, {
				userId,
				text: "یه تسک برای ساعت ۲۵:۰۰ ثبت کن",
			});
			expect(res.replyText).toContain("ساعت واردشده نامعتبر است");

			const allTasks = await listTasks(env.DB, userId, "all");
			expect(allTasks.length).toBe(0);
		});

		it("accepts hour 00:00 (midnight)", async () => {
			const res = await handleIncomingMessage(env, {
				userId,
				text: "یه تسک به اسم تست نیمه شب برای فردا ساعت ۰۰:۰۰ ثبت کن",
			});
			expect(res.replyText).toContain("با موفقیت ثبت شد");
			expect(res.replyText).toContain("تست نیمه شب");
			expect(res.replyText).toContain("۰۰:۰۰");

			const allTasks = await listTasks(env.DB, userId, "all");
			expect(allTasks.length).toBe(1);
			expect(allTasks[0].title).toBe("تست نیمه شب");
			expect(allTasks[0].due_date).toContain("00:00:00+03:30");
		});

		it("accepts hour 23:59", async () => {
			const res = await handleIncomingMessage(env, {
				userId,
				text: "یه تسک به اسم پایان روز برای ساعت ۲۳:۵۹ ثبت کن",
			});
			expect(res.replyText).toContain("با موفقیت ثبت شد");
			expect(res.replyText).toContain("۲۳:۵۹");

			const allTasks = await listTasks(env.DB, userId, "all");
			expect(allTasks.length).toBe(1);
			expect(allTasks[0].due_date).toContain("23:59:00+03:30");
		});
	});
});
