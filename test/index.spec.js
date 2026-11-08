import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import worker from "../src";
import { sendTelegramMessage } from "../src/telegram.js";

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

describe("Hermes Mini Worker Endpoints", () => {
	beforeEach(async () => {
		await initDatabase(env.DB);
		await env.DB.prepare("DELETE FROM tasks").run();
		await env.DB.prepare("DELETE FROM conversation_messages").run();
		await env.DB.prepare("DELETE FROM user_displayed_lists").run();
		await env.DB.prepare("DELETE FROM processed_updates").run();
	});

	it("responds to GET / with running status", async () => {
		const request = new Request("http://example.com/");
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const text = await response.text();
		expect(text).toContain("Hermes Mini");
	});

	it("responds to GET /health with database and sanitized config status", async () => {
		const request = new Request("http://example.com/health");
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const json = await response.json();
		expect(json.status).toBe("healthy");
		expect(json.service).toBe("hermes-mini");
		expect(json.database.connected).toBe(true);
		expect(json.config).toBeDefined();
		expect(json.config.timezone).toBe("Asia/Tehran");
		expect(Array.isArray(json.config.llmModelFallbacks)).toBe(true);
		// Ensure no secrets leaked
		expect(json.config.llmApiKey).toBeUndefined();
		expect(json.config.telegramBotToken).toBeUndefined();
	});

	it("rejects unauthorized webhook requests if TELEGRAM_WEBHOOK_SECRET is set", async () => {
		const testEnv = {
			...env,
			TELEGRAM_WEBHOOK_SECRET: "my-secret-key-123",
		};

		const request = new Request("http://example.com/webhook", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				// Missing or wrong secret header
				"X-Telegram-Bot-Api-Secret-Token": "wrong-secret",
			},
			body: JSON.stringify({ update_id: 1 }),
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(403);
		const json = await response.json();
		expect(json.error).toBe("Unauthorized");

		// Also verify completely missing secret header returns 403
		const missingReq = new Request("http://example.com/webhook", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ update_id: 2 }),
		});
		const missingRes = await worker.fetch(missingReq, testEnv, ctx);
		expect(missingRes.status).toBe(403);
	});

	it("returns 400 on malformed JSON payload in webhook", async () => {
		const request = new Request("http://example.com/webhook", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "invalid-json{}}",
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(400);
	});

	it("handles valid Telegram message and adds a task", async () => {
		const telegramUpdate = {
			update_id: 1001,
			message: {
				message_id: 50,
				from: { id: 987654321, first_name: "Ali", is_bot: false },
				chat: { id: 987654321 },
				date: 1730578800,
				text: "تسک خواندن کتاب رو اضافه کن",
			},
		};

		const request = new Request("http://example.com/webhook", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(telegramUpdate),
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const json = await response.json();
		expect(json.ok).toBe(true);

		// Verify task was inserted in D1 database for user 987654321
		const row = await env.DB.prepare(
			"SELECT * FROM tasks WHERE telegram_user_id = ?"
		).bind("987654321").first();

		expect(row).not.toBeNull();
		expect(row.title).toContain("خواندن کتاب");
	});

	it("blocks unauthorized user when ALLOWED_TELEGRAM_USER_ID is set", async () => {
		let telegramMessageSent = false;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (url) => {
			if (String(url).includes("api.telegram.org")) {
				telegramMessageSent = true;
				return new Response(JSON.stringify({ ok: true, result: {} }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return originalFetch(url);
		};

		try {
			const testEnv = {
				...env,
				ALLOWED_TELEGRAM_USER_ID: "111222333", // Only this user allowed
				TELEGRAM_BOT_TOKEN: "mock-token",
			};

			const telegramUpdate = {
				update_id: 1002,
				message: {
					message_id: 51,
					from: { id: 999999999, first_name: "Attacker", is_bot: false }, // Different user
					chat: { id: 999999999 },
					date: 1730578800,
					text: "تسک اضافه کن",
				},
			};

			const request = new Request("http://example.com/webhook", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(telegramUpdate),
			});

			const ctx = createExecutionContext();
			const response = await worker.fetch(request, testEnv, ctx);
			await waitOnExecutionContext(ctx);

			expect(response.status).toBe(200);
			const resJson = await response.json();
			expect(resJson.ok).toBe(true);
			expect(resJson.ignored).toBe(true);

			// Ensure NO error message or reply was sent to the unauthorized user
			expect(telegramMessageSent).toBe(false);

			// Ensure NO task was inserted for unauthorized user
			const row = await env.DB.prepare(
				"SELECT * FROM tasks WHERE telegram_user_id = ?"
			).bind("999999999").first();

			expect(row).toBeNull();
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("returns 404 for unknown endpoints", async () => {
		const request = new Request("http://example.com/unknown-route");
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(404);
	});

	it("executes scheduled cron handler without errors", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, result: {} }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});

		try {
			const testEnv = {
				...env,
				ALLOWED_TELEGRAM_USER_ID: "111222333",
				TELEGRAM_BOT_TOKEN: "mock-token",
			};

			// Insert a task due today
			await env.DB.prepare(
				`INSERT INTO tasks (telegram_user_id, title, due_date, is_completed, created_at, updated_at)
				 VALUES (?, ?, ?, 0, datetime('now'), datetime('now'))`
			).bind("111222333", "تسک آزمایشی امروز", new Date().toISOString()).run();

			const ctx = createExecutionContext();
			// Execute scheduled cron
			await worker.scheduled({ cron: "30 2 * * *" }, testEnv, ctx);
			await waitOnExecutionContext(ctx);

			expect(true).toBe(true);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("saves conversation history only when Telegram sending succeeds and response is successful", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (url) => {
			if (String(url).includes("api.telegram.org")) {
				return new Response(JSON.stringify({ ok: true, result: { message_id: 101 } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return originalFetch(url);
		};

		try {
			const testEnv = {
				...env,
				TELEGRAM_BOT_TOKEN: "mock-token",
			};

			const telegramUpdate = {
				update_id: 2001,
				message: {
					message_id: 60,
					from: { id: 777111, first_name: "TestUser", is_bot: false },
					chat: { id: 777111 },
					date: 1730578800,
					text: "سلام هرمس جان",
				},
			};

			const request = new Request("http://example.com/webhook", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(telegramUpdate),
			});

			const ctx = createExecutionContext();
			const response = await worker.fetch(request, testEnv, ctx);
			await waitOnExecutionContext(ctx);

			expect(response.status).toBe(200);

			// History MUST be saved (2 rows: user and assistant)
			const messages = await env.DB.prepare(
				"SELECT role, content FROM conversation_messages WHERE telegram_user_id = ? ORDER BY id ASC"
			).bind("777111").all();

			expect(messages.results.length).toBe(2);
			expect(messages.results[0].role).toBe("user");
			expect(messages.results[0].content).toBe("سلام هرمس جان");
			expect(messages.results[1].role).toBe("assistant");
			expect(messages.results[1].content).toContain("هرمس مینی");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("does NOT save conversation history when Telegram send fails", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (url) => {
			if (String(url).includes("api.telegram.org")) {
				return new Response(JSON.stringify({ ok: false, description: "Forbidden: bot was blocked by the user" }), {
					status: 403,
					headers: { "Content-Type": "application/json" },
				});
			}
			return originalFetch(url);
		};

		try {
			const testEnv = {
				...env,
				TELEGRAM_BOT_TOKEN: "mock-token",
			};

			const telegramUpdate = {
				update_id: 2002,
				message: {
					message_id: 61,
					from: { id: 777222, first_name: "BlockedUser", is_bot: false },
					chat: { id: 777222 },
					date: 1730578800,
					text: "سلام",
				},
			};

			const request = new Request("http://example.com/webhook", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(telegramUpdate),
			});

			const ctx = createExecutionContext();
			const response = await worker.fetch(request, testEnv, ctx);
			await waitOnExecutionContext(ctx);

			expect(response.status).toBe(200);

			// History must NOT be saved because Telegram send failed
			const messages = await env.DB.prepare(
				"SELECT * FROM conversation_messages WHERE telegram_user_id = ?"
			).bind("777222").all();

			expect(messages.results.length).toBe(0);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("does NOT save conversation history when assistant response is an error", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (url) => {
			if (String(url).includes("api.telegram.org")) {
				return new Response(JSON.stringify({ ok: true, result: { message_id: 102 } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (String(url).includes("chat/completions")) {
				return new Response(JSON.stringify({ error: { code: 503, message: "Unavailable" } }), {
					status: 503,
					headers: { "Content-Type": "application/json" },
				});
			}
			return originalFetch(url);
		};

		try {
			const testEnv = {
				...env,
				TELEGRAM_BOT_TOKEN: "mock-token",
				LLM_API_KEY: "test-llm-key",
				LLM_API_BASE: "https://mock.llm/v1",
				LLM_MODEL: "gemini-3.8-flash",
			};

			const telegramUpdate = {
				update_id: 2003,
				message: {
					message_id: 62,
					from: { id: 777333, first_name: "ErrorUser", is_bot: false },
					chat: { id: 777333 },
					date: 1730578800,
					text: "برام توضیح بده چرا کهکشان‌ها حرکت می‌کنند؟",
				},
			};

			const request = new Request("http://example.com/webhook", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(telegramUpdate),
			});

			const ctx = createExecutionContext();
			const response = await worker.fetch(request, testEnv, ctx);
			await waitOnExecutionContext(ctx);

			expect(response.status).toBe(200);

			// History must NOT contain error messages
			const messages = await env.DB.prepare(
				"SELECT * FROM conversation_messages WHERE telegram_user_id = ?"
			).bind("777333").all();

			expect(messages.results.length).toBe(0);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("handles Telegram timeout gracefully with 5s timeout and returns ok: false", async () => {
		const abortingFetch = async (url, { signal }) => {
			return new Promise((_, reject) => {
				signal.addEventListener("abort", () => {
					reject(new Error("Telegram API timeout"));
				});
			});
		};

		const res = await sendTelegramMessage("token", "123", "hello", { timeoutMs: 10 }, abortingFetch);
		expect(res.ok).toBe(false);
		expect(res.description).toContain("timeout");
	});
});
