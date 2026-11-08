/**
 * Hermes Mini - Cloudflare Worker Entrypoint
 * Telegram Bot for Daily Task Management using Persian Natural Language.
 */

import { getConfig, getSanitizedConfig } from "./config.js";
import {
	checkDatabaseConnection,
	listTasks,
	saveConversationMessage,
	saveDisplayedTaskList,
	clearPendingDisplayedList,
	reserveTelegramUpdate,
	markUpdateCompleted,
	markUpdateFailed,
	sweepMissedReminders,
	getDueTasksForReminder,
	claimTaskForReminder,
	markReminderSuccess,
	markReminderFailure,
} from "./db.js";
import { isTodayInTehran, isOverdueInTehran, formatPersianDateTime, getTaskStatusIcon } from "./dateUtils.js";
import { handleIncomingMessage } from "./handler.js";
import {
	verifyWebhookSecret,
	parseTelegramUpdate,
	sendTelegramMessage,
} from "./telegram.js";

export default {
	/**
	 * Main HTTP Request Handler
	 */
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		const method = request.method.toUpperCase();
		const config = getConfig(env);

		// 1. Health check endpoint
		if (method === "GET" && (url.pathname === "/health" || url.pathname === "/health/")) {
			const dbStatus = await checkDatabaseConnection(env.DB);
			const payload = {
				status: dbStatus.connected ? "healthy" : "degraded",
				service: "hermes-mini",
				timestamp: new Date().toISOString(),
				database: dbStatus,
				config: getSanitizedConfig(env),
			};
			return new Response(JSON.stringify(payload, null, 2), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}

		// 2. Root GET handler
		if (method === "GET" && url.pathname === "/") {
			return new Response("Hermes Mini Telegram Bot is running 🚀\nhttps://github.com/", {
				status: 200,
				headers: { "Content-Type": "text/plain; charset=utf-8" },
			});
		}

		// 3. Telegram Webhook (POST /webhook or POST /)
		if (method === "POST" && (url.pathname === "/webhook" || url.pathname === "/")) {
			// Webhook Secret Token Verification
			if (!verifyWebhookSecret(request, config.webhookSecret)) {
				return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
					status: 403,
					headers: { "Content-Type": "application/json" },
				});
			}

			let payload;
			try {
				payload = await request.json();
			} catch {
				return new Response(JSON.stringify({ ok: false, error: "Invalid JSON" }), {
					status: 400,
					headers: { "Content-Type": "application/json" },
				});
			}

			const update = parseTelegramUpdate(payload);
			if (!update || !update.chatId || !update.text) {
				// Acknowledge non-text or system updates gracefully
				return new Response(JSON.stringify({ ok: true, ignored: true }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}

			// Reject unauthorized user silently (no error message to user, no data operations)
			const hasWhitelist = (config.allowedUserIds && config.allowedUserIds.length > 0) || Boolean(config.allowedUserId);
			if (hasWhitelist) {
				const updateUserId = update.userId ? String(update.userId) : null;
				const isWhitelisted = Boolean(
					updateUserId && (
						(config.allowedUserIds && config.allowedUserIds.includes(updateUserId)) ||
						(config.allowedUserId && updateUserId === config.allowedUserId)
					)
				);
				if (!isWhitelisted) {
					console.warn(`Unauthorized access attempt rejected silently for Telegram user_id: ${update.userId || "unknown"}`);
					return new Response(JSON.stringify({ ok: true, ignored: true, unauthorized: true }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
			}

			// Atomic update reservation with fencing token to prevent concurrent duplicate processing
			let reservation = null;
			if (update.updateId && env.DB) {
				reservation = await reserveTelegramUpdate(env.DB, update.updateId);
				if (reservation.state === "completed" || reservation.state === "in_progress") {
					return new Response(JSON.stringify({ ok: true, duplicate: true, state: reservation.state }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
			}

			// Bounded overall deadline (~22 seconds) to prevent Cloudflare isolate cancellation
			const OVERALL_DEADLINE_MS = 22000;
			const overallDeadline = Date.now() + OVERALL_DEADLINE_MS;

			// Process message
			const processTask = async () => {
				const now = Date.now();
				const remainingForHandler = Math.max(1000, overallDeadline - now - 5000); // reserve 5s for Telegram send

				const result = await handleIncomingMessage(env, update, {
					deadline: overallDeadline - 5000,
					timeoutMs: Math.min(8000, remainingForHandler),
					lockToken: reservation?.lockToken,
				});

				// Stage displayed task list as pending prior to Telegram send
				if (result.displayedTaskIds && result.displayedTaskIds.length > 0 && env.DB && update.userId) {
					try {
						await saveDisplayedTaskList(env.DB, update.userId, result.displayedTaskIds, "pending");
					} catch (stageErr) {
						console.error("Failed to stage displayed task list:", stageErr.message);
					}
				}

				let sendResult = null;
				let sendTimedOut = false;

				if (config.telegramBotToken && result.replyText) {
					const remainingForTelegram = Math.max(1000, Math.min(5000, overallDeadline - Date.now()));
					try {
						sendResult = await sendTelegramMessage(
							config.telegramBotToken,
							update.chatId,
							result.replyText,
							{ timeoutMs: remainingForTelegram }
						);
					} catch (sendErr) {
						if (sendErr.name === "AbortError" || sendErr.message?.includes("timeout")) {
							sendTimedOut = true;
						}
					}
				}

				const isDeliverySuccessful = Boolean(
					(!config.telegramBotToken && result.replyText) || (sendResult && sendResult.ok)
				);

				if (isDeliverySuccessful) {
					// Activate displayed task list upon confirmed delivery
					if (result.displayedTaskIds && result.displayedTaskIds.length > 0 && env.DB && update.userId) {
						try {
							await saveDisplayedTaskList(env.DB, update.userId, result.displayedTaskIds, "active");
						} catch (listErr) {
							console.error("Failed to activate displayed task list:", listErr.message);
						}
					}

					// Save to conversation history ONLY on successful Telegram delivery and non-error assistant response
					if (!result.isError && result.authorized && env.DB && update.userId) {
						try {
							await saveConversationMessage(env.DB, update.userId, "user", update.text, result.intent);
							await saveConversationMessage(env.DB, update.userId, "assistant", result.replyText, result.intent);
						} catch (historyErr) {
							console.error("Failed to save conversation history:", historyErr.message);
						}
					}

					// Mark update completed only on confirmed delivery and successful execution
					if (update.updateId && env.DB) {
						try {
							await markUpdateCompleted(env.DB, update.updateId, reservation?.lockToken, result.replyText);
						} catch (dedupErr) {
							console.error("Failed to mark update completed:", dedupErr.message);
						}
					}
				} else {
					// Delivery failed or timed out: clear pending list so ordinal matching isn't corrupted
					if (result.displayedTaskIds && result.displayedTaskIds.length > 0 && env.DB && update.userId) {
						try {
							await clearPendingDisplayedList(env.DB, update.userId);
						} catch {}
					}

					// Mark update failed so that Telegram retries can safely re-attempt
					if (update.updateId && env.DB) {
						try {
							await markUpdateFailed(env.DB, update.updateId, reservation?.lockToken);
						} catch (dedupErr) {
							console.error("Failed to mark update failed:", dedupErr.message);
						}
					}
				}
			};

			const taskPromise = processTask();
			if (ctx && typeof ctx.waitUntil === "function") {
				ctx.waitUntil(taskPromise);
			}
			try {
				await taskPromise;
			} catch (taskErr) {
				console.error("Unhandled error during task processing:", taskErr.message);
				if (update.updateId && env.DB) {
					try {
						await markUpdateFailed(env.DB, update.updateId, reservation?.lockToken);
					} catch {}
				}
			}

			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}

		return new Response("Not Found", { status: 404 });
	},

	/**
	 * Scheduled Cron Handler
	 * Differentiates triggers based on controller.cron:
	 * - "* * * * *": Minute-by-minute individual task reminders
	 * - "0 5 * * *": Morning daily task digest
	 */
	async scheduled(controller, env, ctx) {
		const config = getConfig(env);
		const cron = controller?.cron || "";

		if (cron === "* * * * *") {
			await processDueReminders(env, config);
		} else if (cron === "30 2 * * *") {
			await sendDailyDigest(env, config);
		} else {
			console.log(`Scheduled trigger skipped: unrecognized cron pattern '${cron}'.`);
		}
	},
};

/**
 * Processes due reminders for tasks whose reminder time has arrived.
 * Limited to at most 5 tasks per batch.
 * @param {object} env
 * @param {object} config
 * @param {Function} [fetchImpl=fetch]
 * @returns {Promise<{ processed: number, sent: number, failed: number }>}
 */
export async function processDueReminders(env, config, fetchImpl = fetch) {
	const hasWhitelist = (config.allowedUserIds && config.allowedUserIds.length > 0) || Boolean(config.allowedUserId);
	if (!hasWhitelist || !config.telegramBotToken || !env.DB) {
		console.log("processDueReminders skipped: missing configuration or DB.");
		return { processed: 0, sent: 0, failed: 0 };
	}

	// 1. Sweep expired reminders older than 72 hours
	try {
		await sweepMissedReminders(env.DB, 72);
	} catch (sweepErr) {
		console.warn("sweepMissedReminders error:", sweepErr.message);
	}

	// 2. Fetch up to 5 due tasks
	let dueTasks = [];
	try {
		dueTasks = await getDueTasksForReminder(env.DB, 5);
	} catch (fetchErr) {
		console.error("getDueTasksForReminder error:", fetchErr.message);
		return { processed: 0, sent: 0, failed: 0 };
	}

	if (!dueTasks || dueTasks.length === 0) {
		return { processed: 0, sent: 0, failed: 0 };
	}

	let sentCount = 0;
	let failedCount = 0;

	// 3. Process each task independently (failures never block other batch items)
	for (const task of dueTasks) {
		const token =
			typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
				? crypto.randomUUID()
				: `tok_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

		try {
			// Atomic claim lease
			const claimed = await claimTaskForReminder(env.DB, task.id, task.due_date, token);
			if (!claimed) {
				// Task was already claimed, completed, or rescheduled
				continue;
			}

			// Verify recipient is an authorized user
			const recipientUserId = String(task.telegram_user_id || config.allowedUserId || "");
			const isRecipientAllowed = Boolean(
				recipientUserId && (
					(config.allowedUserIds && config.allowedUserIds.includes(recipientUserId)) ||
					(config.allowedUserId && recipientUserId === config.allowedUserId)
				)
			);

			if (!isRecipientAllowed) {
				console.warn(`Reminder for task ${task.id} belongs to unauthorized user ${recipientUserId}; abandoning.`);
				await markReminderFailure(env.DB, task.id, task.due_date, token, { isPermanent: true });
				continue;
			}

			// Format reminder message in Persian with Tehran time
			const formattedDate = formatPersianDateTime(task.due_date);
			const reminderText = `⏰ یادآوری موعد تسک:\n\n📌 ${task.title}\n📅 موعد: ${formattedDate}`;

			// Send directly to the owner of the task
			const sendResult = await sendTelegramMessage(
				config.telegramBotToken,
				recipientUserId,
				reminderText,
				{},
				fetchImpl
			);

			if (sendResult.ok) {
				await markReminderSuccess(env.DB, task.id, task.due_date, token);
				sentCount++;
			} else {
				failedCount++;
				if (sendResult.status === 400 || sendResult.status === 403) {
					// Permanent errors: immediately abandon
					await markReminderFailure(env.DB, task.id, task.due_date, token, { isPermanent: true });
				} else if (sendResult.status === 429) {
					// Rate limited: use Telegram retry_after if available
					await markReminderFailure(env.DB, task.id, task.due_date, token, {
						retryAfterSeconds: sendResult.retryAfter,
					});
				} else {
					// Transient network, timeout, or 5xx: standard backoff
					await markReminderFailure(env.DB, task.id, task.due_date, token, { isPermanent: false });
				}
			}
		} catch (taskErr) {
			console.error(`Unhandled error processing reminder for task ${task.id}:`, taskErr.message);
			failedCount++;
			try {
				await markReminderFailure(env.DB, task.id, task.due_date, token, { isPermanent: false });
			} catch {}
		}
	}

	return { processed: dueTasks.length, sent: sentCount, failed: failedCount };
}

/**
 * Sends the morning daily digest of today's and overdue tasks to all authorized users.
 * @param {object} env
 * @param {object} config
 * @param {Function} [fetchImpl=fetch]
 */
export async function sendDailyDigest(env, config, fetchImpl = fetch) {
	const allowedUsers = (config.allowedUserIds && config.allowedUserIds.length > 0)
		? config.allowedUserIds
		: (config.allowedUserId ? [config.allowedUserId] : []);

	if (allowedUsers.length === 0 || !config.telegramBotToken || !env.DB) {
		console.log("Daily digest skipped: missing configuration or DB.");
		return;
	}

	for (const targetUserId of allowedUsers) {
		try {
			const allTasks = await listTasks(env.DB, targetUserId, "all");
			const todayTasks = allTasks.filter((t) => isTodayInTehran(t.due_date));
			const overdueTasks = allTasks.filter((t) => !t.is_completed && isOverdueInTehran(t.due_date) && !isTodayInTehran(t.due_date));

			if (todayTasks.length === 0 && overdueTasks.length === 0) {
				const emptyMessage = "🌅 صبح بخیر! امروز هیچ کاری در برنامه شما نیست و کار معوقه‌ای هم از روزهای قبل ندارید. روز آرام و فوق‌العاده‌ای داشته باشید! ✨";
				await sendTelegramMessage(config.telegramBotToken, targetUserId, emptyMessage, {}, fetchImpl);
				continue;
			}

			const sections = [];

			if (todayTasks.length > 0) {
				const lines = todayTasks.map((t, idx) => {
					const statusIcon = getTaskStatusIcon(t);
					let line = `${idx + 1}. ${statusIcon} ${t.title}`;
					if (t.due_date) {
						line += ` (${formatPersianDateTime(t.due_date)})`;
					}
					return line;
				});
				sections.push(`📅 کارهای امروز شما:\n${lines.join("\n")}`);
			}

			if (overdueTasks.length > 0) {
				const lines = overdueTasks.map((t, idx) => {
					const statusIcon = getTaskStatusIcon(t);
					let line = `${idx + 1}. ${statusIcon} ${t.title}`;
					if (t.due_date) {
						line += ` (${formatPersianDateTime(t.due_date)})`;
					}
					return line;
				});
				sections.push(`⏰ کارهای عقب‌افتاده از روزهای قبل:\n${lines.join("\n")}`);
			}

			const message = `🌅 صبح بخیر! یادآور کارهای شما در هرمس مینی:\n\n${sections.join("\n\n")}`;

			await sendTelegramMessage(config.telegramBotToken, targetUserId, message, {}, fetchImpl);
		} catch (err) {
			console.error(`Daily digest error for user ${targetUserId}:`, err.message);
		}
	}
}
