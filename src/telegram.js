/**
 * Hermes Mini - Telegram API Client & Security
 * Handles webhook security verification, update parsing, and sending messages.
 */

const TELEGRAM_API_BASE = "https://api.telegram.org";

/**
 * Verifies that the webhook request contains the correct secret token header
 * Header: X-Telegram-Bot-Api-Secret-Token
 */
export function verifyWebhookSecret(request, expectedSecret) {
	if (!expectedSecret) {
		// If secret is not set in environment, allow (for easier initial development)
		return true;
	}
	const incomingSecret = request.headers.get("x-telegram-bot-api-secret-token");
	return Boolean(incomingSecret && incomingSecret === expectedSecret);
}

/**
 * Extracts relevant message info from Telegram update payload.
 * Always gets userId directly from the verified Telegram payload.
 */
export function parseTelegramUpdate(payload) {
	if (!payload || typeof payload !== "object") {
		return null;
	}

	const message = payload.message || payload.edited_message;
	if (!message) {
		return null;
	}

	const from = message.from || {};
	const chat = message.chat || {};

	return {
		updateId: payload.update_id,
		messageId: message.message_id,
		userId: from.id ? String(from.id) : null,
		chatId: chat.id ? String(chat.id) : null,
		username: from.username || null,
		firstName: from.first_name || "",
		text: typeof message.text === "string" ? message.text.trim() : "",
		isBot: Boolean(from.is_bot),
		date: message.date,
	};
}

/**
 * Sends a text message to a Telegram chat.
 * Never leaks bot token in error messages or logs.
 */
export async function sendTelegramMessage(botToken, chatId, text, options = {}, fetchImpl = fetch) {
	if (!botToken) {
		console.error("sendTelegramMessage: TELEGRAM_BOT_TOKEN is not configured.");
		return { ok: false, description: "Bot token not configured" };
	}
	if (!chatId) {
		return { ok: false, description: "Missing chatId" };
	}
	if (!text) {
		return { ok: false, description: "Missing text content" };
	}

	const url = `${TELEGRAM_API_BASE}/bot${botToken}/sendMessage`;
	const payload = {
		chat_id: chatId,
		text: String(text),
		parse_mode: options.parseMode || undefined,
		disable_web_page_preview: true,
	};

	const timeoutMs = options.timeoutMs || 10000;
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(new Error("Telegram API timeout")), timeoutMs);

	try {
		const response = await fetchImpl(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
			signal: controller.signal,
		});

		const result = await response.json().catch(() => null);
		if (!response.ok) {
			console.error(`Telegram API error HTTP ${response.status}:`, result?.description || "Unknown error");
			return {
				ok: false,
				status: response.status,
				description: result?.description,
				parameters: result?.parameters,
				retryAfter: result?.parameters?.retry_after,
			};
		}

		return { ok: true, result };
	} catch (err) {
		console.error("Telegram fetch error:", err.message || "Failed to reach Telegram API");
		const isTimeout = err.name === "AbortError" || err.message?.includes("timeout");
		return {
			ok: false,
			status: null,
			description: err.message,
			isTimeout: Boolean(isTimeout),
			isNetworkError: !isTimeout,
		};
	} finally {
		clearTimeout(timeoutId);
	}
}
