/**
 * Hermes Mini - Configuration Module
 * Safely accesses and validates environment variables and secrets.
 */

export function getConfig(env = {}) {
	const defaultTimezone = env.DEFAULT_TIMEZONE || "Asia/Tehran";

	let allowedUserIds = [];
	if (env.ALLOWED_TELEGRAM_USER_ID) {
		const raw = String(env.ALLOWED_TELEGRAM_USER_ID).trim();
		if (raw) {
			allowedUserIds = raw
				.split(",")
				.map((id) => id.trim())
				.filter((id) => id.length > 0);
		}
	}
	const allowedUserId = allowedUserIds.length > 0 ? allowedUserIds[0] : null;

	const telegramBotToken = env.TELEGRAM_BOT_TOKEN ? String(env.TELEGRAM_BOT_TOKEN).trim() : null;
	const webhookSecret = env.TELEGRAM_WEBHOOK_SECRET ? String(env.TELEGRAM_WEBHOOK_SECRET).trim() : null;

	const llmApiBase = (env.LLM_API_BASE || "https://api.groq.com/openai/v1").replace(/\/+$/, "");
	const llmModel = env.LLM_MODEL || "llama-3.3-70b-versatile";
	const llmApiKey = env.LLM_API_KEY ? String(env.LLM_API_KEY).trim() : null;

	let llmModelFallbacks = [];
	if (env.LLM_MODEL_FALLBACKS) {
		const raw = Array.isArray(env.LLM_MODEL_FALLBACKS)
			? env.LLM_MODEL_FALLBACKS
			: (typeof env.LLM_MODEL_FALLBACKS === "string" ? env.LLM_MODEL_FALLBACKS.split(",") : []);

		for (const item of raw) {
			const clean = typeof item === "string" ? item.trim() : "";
			if (clean && clean !== llmModel && !llmModelFallbacks.includes(clean)) {
				llmModelFallbacks.push(clean);
				if (llmModelFallbacks.length >= 2) break;
			}
		}
	}

	return {
		defaultTimezone,
		allowedUserId,
		allowedUserIds,
		telegramBotToken,
		webhookSecret,
		llmApiBase,
		llmModel,
		llmModelFallbacks,
		llmApiKey,
	};
}

/**
 * Returns a sanitized view of configuration suitable for health check endpoint.
 * Never exposes secrets or tokens.
 */
export function getSanitizedConfig(env = {}) {
	const config = getConfig(env);
	return {
		timezone: config.defaultTimezone,
		hasAllowedUserId: Boolean(config.allowedUserId || config.allowedUserIds?.length),
		allowedUserCount: config.allowedUserIds?.length || 0,
		hasTelegramToken: Boolean(config.telegramBotToken),
		hasWebhookSecret: Boolean(config.webhookSecret),
		hasLlmApiKey: Boolean(config.llmApiKey),
		llmApiBase: config.llmApiBase,
		llmModel: config.llmModel,
		llmModelFallbacks: config.llmModelFallbacks,
	};
}
