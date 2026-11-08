import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import {
	createTask,
	listTasks,
	findTaskByQuery,
	updateTaskStatus,
	deleteTask,
	editTask,
	saveConversationMessage,
	getRecentConversation,
	checkDatabaseConnection,
} from "../src/db.js";

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
	await db.prepare("CREATE INDEX IF NOT EXISTS idx_tasks_user_id ON tasks(telegram_user_id)").run();

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
}

describe("D1 Database Repository (tasks & conversation)", () => {
	beforeEach(async () => {
		await initDatabase(env.DB);
		await env.DB.prepare("DELETE FROM tasks").run();
		await env.DB.prepare("DELETE FROM conversation_messages").run();
	});

	it("verifies database connection alive", async () => {
		const status = await checkDatabaseConnection(env.DB);
		expect(status.connected).toBe(true);
	});

	it("creates and retrieves a new task", async () => {
		const task = await createTask(env.DB, "user_100", {
			title: "برم دکتر",
			dueDate: "2026-11-03T17:00:00+03:30",
		});

		expect(task.id).toBeDefined();
		expect(task.title).toBe("برم دکتر");
		expect(task.telegram_user_id).toBe("user_100");
		expect(task.is_completed).toBe(0);
	});

	it("lists pending and completed tasks accurately", async () => {
		const t1 = await createTask(env.DB, "user_100", { title: "تسک ۱" });
		const t2 = await createTask(env.DB, "user_100", { title: "تسک ۲" });

		await updateTaskStatus(env.DB, "user_100", t1.id, true);

		const pending = await listTasks(env.DB, "user_100", "pending");
		expect(pending.length).toBe(1);
		expect(pending[0].title).toBe("تسک ۲");

		const completed = await listTasks(env.DB, "user_100", "completed");
		expect(completed.length).toBe(1);
		expect(completed[0].title).toBe("تسک ۱");
	});

	it("finds task by substring and numeric id", async () => {
		const t1 = await createTask(env.DB, "user_100", { title: "مطالعه ریاضی کنکور" });
		const t2 = await createTask(env.DB, "user_100", { title: "خرید نان سنگک" });

		const foundBySubstring = await findTaskByQuery(env.DB, "user_100", "ریاضی");
		expect(foundBySubstring).not.toBeNull();
		expect(foundBySubstring.id).toBe(t1.id);

		const foundById = await findTaskByQuery(env.DB, "user_100", String(t2.id));
		expect(foundById).not.toBeNull();
		expect(foundById.title).toBe("خرید نان سنگک");
	});

	it("updates task status back and forth (done / undone)", async () => {
		const task = await createTask(env.DB, "user_100", { title: "ورزش صبحگاهی" });
		expect(task.is_completed).toBe(0);

		// Done
		const doneSuccess = await updateTaskStatus(env.DB, "user_100", task.id, true);
		expect(doneSuccess).toBe(true);

		const doneTask = await findTaskByQuery(env.DB, "user_100", "ورزش");
		expect(doneTask.is_completed).toBe(1);

		// Undone
		const undoneSuccess = await updateTaskStatus(env.DB, "user_100", task.id, false);
		expect(undoneSuccess).toBe(true);

		const undoneTask = await findTaskByQuery(env.DB, "user_100", "ورزش");
		expect(undoneTask.is_completed).toBe(0);
	});

	it("deletes a task successfully", async () => {
		const task = await createTask(env.DB, "user_100", { title: "تسک آزمایشی" });
		const deleted = await deleteTask(env.DB, "user_100", task.id);
		expect(deleted).toBe(true);

		const found = await findTaskByQuery(env.DB, "user_100", "تسک آزمایشی");
		expect(found).toBeNull();
	});

	it("enforces strict user isolation (no data leakage between users)", async () => {
		// User 1 creates a secret task
		const task1 = await createTask(env.DB, "user_1", { title: "کارهای شخصی کاربر اول" });

		// User 2 cannot see or search for User 1's task
		const user2List = await listTasks(env.DB, "user_2", "all");
		expect(user2List.length).toBe(0);

		const user2Search = await findTaskByQuery(env.DB, "user_2", "شخصی");
		expect(user2Search).toBeNull();

		// User 2 cannot mark User 1's task as done or delete it
		const user2Update = await updateTaskStatus(env.DB, "user_2", task1.id, true);
		expect(user2Update).toBe(false);

		const user2Delete = await deleteTask(env.DB, "user_2", task1.id);
		expect(user2Delete).toBe(false);

		// User 1's task is still untouched and intact
		const user1Task = await findTaskByQuery(env.DB, "user_1", "شخصی");
		expect(user1Task).not.toBeNull();
		expect(user1Task.is_completed).toBe(0);
	});

	it("edits an existing task title and due date", async () => {
		const task = await createTask(env.DB, "user_100", { title: "درس خوندن", dueDate: "2026-11-03T10:00:00+03:30" });
		const edited = await editTask(env.DB, "user_100", task.id, {
			title: "درس خواندن و مرور خلاصه",
			dueDate: "2026-11-03T12:00:00+03:30",
		});

		expect(edited).toBe(true);
		const updated = await findTaskByQuery(env.DB, "user_100", "مرور");
		expect(updated).not.toBeNull();
		expect(updated.title).toBe("درس خواندن و مرور خلاصه");
		expect(updated.due_date).toBe("2026-11-03T12:00:00+03:30");
	});

	it("saves and retrieves conversation history in chronological order with user isolation", async () => {
		await saveConversationMessage(env.DB, "user_A", "user", "سلام هرمس", "chat");
		await saveConversationMessage(env.DB, "user_A", "assistant", "سلام! چطور می‌تونم کمکت کنم؟", "chat");
		await saveConversationMessage(env.DB, "user_A", "user", "فردا ساعت ۱۰ درس بخونم", "add");

		// User B also sends a message
		await saveConversationMessage(env.DB, "user_B", "user", "پیام کاربر بی", "chat");

		const historyA = await getRecentConversation(env.DB, "user_A", 5);
		expect(historyA.length).toBe(3);
		expect(historyA[0].role).toBe("user");
		expect(historyA[0].content).toBe("سلام هرمس");
		expect(historyA[1].role).toBe("assistant");
		expect(historyA[2].content).toBe("فردا ساعت ۱۰ درس بخونم");

		// User B only sees their own message
		const historyB = await getRecentConversation(env.DB, "user_B", 5);
		expect(historyB.length).toBe(1);
		expect(historyB[0].content).toBe("پیام کاربر بی");
	});
});
