/**
 * Hermes Mini - Message Handler
 * Coordinates local deterministic dispatch, D1 database operations, and conversational AI (Gemini).
 */

import { getConfig } from "./config.js";
import {
	formatPersianDateTime,
	isTodayInTehran,
	isTomorrowInTehran,
	isDayAfterTomorrowInTehran,
	isOverdueInTehran,
	isValidIsoDueDate,
	extractPersianDateTime,
	getTehranDateParts,
	gregorianToJalali,
	isBeyondCalendarOneYear,
	resolveAmbiguousHourResponse,
	isExplicitCancelText,
	normalizeWeekday,
	isWeekdayInTehran,
	getTaskStatusIcon,
} from "./dateUtils.js";
import {
	createTask,
	listTasks,
	getTaskById,
	findTaskByQuery,
	findTasksByQuery,
	updateTaskStatus,
	deleteTask,
	deleteAllTasks,
	deleteCompletedTasks,
	editTask,
	getRecentConversation,
	saveDisplayedTaskList,
	getDisplayedTaskList,
	setPendingConfirmation,
	getPendingConfirmation,
	clearPendingConfirmation,
	ensurePendingClarificationsTable,
	setPendingClarification,
	getPendingClarification,
	claimPendingClarification,
	consumePendingClarification,
	clearPendingClarification,
} from "./db.js";
import { fallbackPersianParser, parsePersianWithLLM } from "./llm.js";
import { dispatchLocalAction, cleanTaskTitle } from "./localDispatcher.js";

/**
 * Formats polite, natural Persian clarification question for ambiguous 12-hour values.
 * @param {number} hour
 * @returns {string}
 */
export function formatAmbiguousHourQuestion(hour) {
	const faDigits = ["۰", "۱", "۲", "۳", "۴", "۵", "۶", "۷", "۸", "۹"];
	const faHour = String(hour).replace(/\d/g, (d) => faDigits[Number(d)]);
	if (hour === 12) {
		return "منظورتان ساعت ۱۲ ظهر است یا ۱۲ شب؟";
	}
	if (hour >= 1 && hour <= 4) {
		return `منظورتان ساعت ${faHour} بامداد است یا ${faHour} بعدازظهر؟`;
	}
	if (hour >= 5 && hour <= 6) {
		return `منظورتان ساعت ${faHour} صبح است یا ${faHour} عصر؟`;
	}
	if (hour >= 7 && hour <= 11) {
		return `منظورتان ساعت ${faHour} صبح است یا ${faHour} شب؟`;
	}
	return `منظورتان ساعت ${faHour} صبح است یا شب؟`;
}

/**
 * Validates due date format, past date boundaries, and 1 calendar year maximum limit.
 * @param {string|null} dueDateStr
 * @param {Date} [baseDate=new Date()]
 * @returns {{ valid: boolean, reason?: string, reply?: string }}
 */
export function validateDueDateLimit(dueDateStr, baseDate = new Date()) {
	if (!dueDateStr) return { valid: true };
	if (!isValidIsoDueDate(dueDateStr)) {
		return { valid: false, reason: "INVALID_FORMAT", reply: "⚠️ ساعت یا تاریخ واردشده نامعتبر است. لطفاً زمان را به درستی مشخص کنید." };
	}
	if (isOverdueInTehran(dueDateStr, baseDate)) {
		return { valid: false, reason: "PAST_DATE", reply: "⚠️ تاریخ واردشده گذشته است. لطفاً تاریخی در آینده یا امروز را مشخص کنید." };
	}
	const gMatch = String(dueDateStr).match(/^(\d{4})-(\d{2})-(\d{2})/);
	if (gMatch) {
		const gy = parseInt(gMatch[1], 10);
		const gm = parseInt(gMatch[2], 10);
		const gd = parseInt(gMatch[3], 10);
		const sj = gregorianToJalali(gy, gm, gd);
		const baseParts = getTehranDateParts(baseDate);
		const baseJalali = gregorianToJalali(baseParts.year, baseParts.month, baseParts.day);
		if (isBeyondCalendarOneYear({ jy: sj.jy, jm: sj.jm, jd: sj.jd }, baseJalali)) {
			return { valid: false, reason: "BEYOND_ONE_YEAR", reply: "⚠️ موعد کار نمی‌تواند بیش از یک سال آینده باشد. لطفاً تاریخی حداکثر تا یک سال آینده مشخص کنید." };
		}
	}
	return { valid: true };
}

/**
 * Executes task listing with filtering, formatting, and displays task IDs persistence.
 */
export async function executeListTasks(db, userId, filter = "all", baseDate = new Date()) {
	let tasks = await listTasks(db, userId, filter === "completed" ? "completed" : filter === "pending" ? "pending" : "all");

	const isDateFilter = typeof filter === "string" && filter.startsWith("date:");
	let targetDateStr = null;
	let targetDateLabel = null;
	if (isDateFilter) {
		const parts = filter.split(":");
		targetDateStr = parts[1];
		targetDateLabel = parts.slice(2).join(":");
	}

	const canonicalWeekday = isDateFilter ? null : normalizeWeekday(filter);

	if (isDateFilter && targetDateStr) {
		tasks = tasks.filter((t) => Boolean(t.due_date) && t.due_date.startsWith(targetDateStr));
	} else if (canonicalWeekday) {
		tasks = tasks.filter((t) => Boolean(t.due_date) && isWeekdayInTehran(t.due_date, canonicalWeekday));
	} else if (filter === "today") {
		tasks = tasks.filter((t) => Boolean(t.due_date) && isTodayInTehran(t.due_date));
	} else if (filter === "tomorrow") {
		tasks = tasks.filter((t) => Boolean(t.due_date) && isTomorrowInTehran(t.due_date));
	} else if (filter === "day_after_tomorrow") {
		tasks = tasks.filter((t) => Boolean(t.due_date) && isDayAfterTomorrowInTehran(t.due_date));
	} else if (filter === "overdue") {
		tasks = tasks.filter((t) => Boolean(t.due_date) && !t.is_completed && isOverdueInTehran(t.due_date, baseDate));
	}

	if (!tasks || tasks.length === 0) {
		let emptyMsg = "📋 لیست تسک‌های شما خالی است! هر زمان کاری داشتی برام بفرست تا ثبت کنم. 🚀";
		if (isDateFilter && targetDateLabel) {
			emptyMsg = `📅 برای ${targetDateLabel} هیچ تسکی ثبت نشده است.`;
		} else if (canonicalWeekday) {
			emptyMsg = `📅 برای ${canonicalWeekday} هیچ تسکی ثبت نشده است.`;
		} else if (filter === "today") {
			emptyMsg = "📅 هیچ تسکی برای امروز ثبت نشده است. روز آرامی داشته باشید! ✨";
		} else if (filter === "tomorrow") {
			emptyMsg = "📅 برای فردا هیچ تسکی ثبت نشده است.";
		} else if (filter === "day_after_tomorrow") {
			emptyMsg = "📅 برای پس‌فردا هیچ تسکی ثبت نشده است.";
		} else if (filter === "overdue") {
			emptyMsg = "🎉 هیچ کار عقب‌افتاده‌ای ندارید! همه کارها به موقع انجام شده‌اند. ✨";
		}
		return {
			text: emptyMsg,
			displayedIds: [],
			toString() {
				return this.text;
			},
		};
	}

	const displayedIds = tasks.map((t) => t.id);

	const header = isDateFilter && targetDateLabel
		? `📅 کارهای ${targetDateLabel}:`
		: canonicalWeekday
		? `📅 کارهای ${canonicalWeekday}:`
		: filter === "today"
		? "📅 کارهای امروز شما:"
		: filter === "tomorrow"
			? "📅 کارهای فردا:"
			: filter === "day_after_tomorrow"
				? "📅 کارهای پس‌فردا:"
				: filter === "overdue"
					? "⏰ کارهای عقب‌افتاده:"
					: filter === "completed"
						? "✅ تسک‌های انجام‌شده:"
						: "📋 لیست تسک‌های شما:";

	const items = tasks.map((t, idx) => {
		const statusIcon = getTaskStatusIcon(t, baseDate);
		let line = `${idx + 1}. ${statusIcon} ${t.title}`;
		if (t.due_date) {
			line += ` (${formatPersianDateTime(t.due_date, baseDate)})`;
		}
		return line;
	});

	const fullText = `${header}\n\n${items.join("\n")}`;
	return {
		text: fullText,
		displayedIds,
		toString() {
			return this.text;
		},
	};
}

/**
 * Helper to extract recent list context from conversation history (fallback mechanism).
 */
export function getRecentListContext(history = []) {
	if (!Array.isArray(history) || history.length === 0) {
		return null;
	}

	for (let i = history.length - 1; i >= 0; i--) {
		const msg = history[i];
		if (!msg || !msg.content) continue;

		if (msg.role === "assistant") {
			const content = msg.content;
			const isToday = content.includes("کارهای امروز") || content.includes("تسک‌های امروز");
			const isTomorrow = content.includes("کارهای فردا") || content.includes("تسک‌های فردا");
			const isAll = content.includes("لیست تسک‌های شما") || content.includes("لیست کارهای شما");

			const taskLines = [];
			const lineRegex = /^\s*(\d+)\.\s*(?:[✅🟩🟥]|⬜️?)\s*(.+?)(?:\s*\([^)]+\))?\s*$/gm;
			let match;
			while ((match = lineRegex.exec(content)) !== null) {
				const index = parseInt(match[1], 10);
				const title = match[2].trim();
				if (title) {
					taskLines.push({ index, title });
				}
			}

			if (isToday || isTomorrow || isAll || taskLines.length > 0) {
				const filter = isToday ? "today" : (isTomorrow ? "tomorrow" : "all");
				return { filter, taskLines };
			}
		}
	}

	return null;
}

/**
 * Resolves target task by ordinal index or title/query.
 * Returns { task, ambiguous: boolean, matches: [] }
 */
export async function resolveTargetTask(db, userId, { target_index, target_query }, onlyIncomplete = false, history = []) {
	// 1. Ordinal reference (e.g. "اولی", "دومی", 1, 2)
	if (target_index && Number.isInteger(target_index) && target_index > 0) {
		// Priority 1: Persistent displayed task IDs from DB (valid within 30-minute TTL)
		try {
			const listState = await getDisplayedTaskList(db, userId, 30);
			if (listState && listState.isExpired) {
				// User previously viewed a list, but it expired (>30 minutes) -> ask to view current list
				return { task: null, ambiguous: false, expiredOrMissingList: true, matches: [] };
			}
			if (listState && listState.found) {
				if (listState.length >= target_index) {
					const targetId = listState[target_index - 1];
					const found = await getTaskById(db, userId, targetId);
					if (found) {
						return { task: found, ambiguous: false, matches: [found] };
					}
				}
				// Target index exceeded the displayed list
				return { task: null, ambiguous: false, expiredOrMissingList: false, matches: [] };
			}
		} catch {
			// fallback to secondary strategies
		}

		// Priority 2: In-message assistant list matching from recent history
		const listContext = getRecentListContext(history);
		if (listContext && Array.isArray(listContext.taskLines) && listContext.taskLines.length > 0) {
			const targetLine = listContext.taskLines.find((item) => item.index === target_index);
			if (targetLine && targetLine.title) {
				const foundByTitle = await findTaskByQuery(db, userId, targetLine.title, onlyIncomplete);
				if (foundByTitle) {
					return { task: foundByTitle, ambiguous: false, matches: [foundByTitle] };
				}
			}
		}

		// Priority 3: Fallback when no list was ever displayed to this user
		const pendingTasks = await listTasks(db, userId, onlyIncomplete ? "pending" : "all");
		if (pendingTasks && pendingTasks.length >= target_index) {
			return { task: pendingTasks[target_index - 1], ambiguous: false, matches: [pendingTasks[target_index - 1]] };
		}

		return { task: null, ambiguous: false, expiredOrMissingList: true, matches: [] };
	}

	// 2. Keyword or Title query
	if (target_query) {
		const matches = await findTasksByQuery(db, userId, target_query, onlyIncomplete);
		if (!matches || matches.length === 0) {
			return { task: null, ambiguous: false, matches: [] };
		}
		if (matches.length === 1) {
			return { task: matches[0], ambiguous: false, matches };
		}
		// Multiple matches found: mark as ambiguous so user can disambiguate
		return { task: null, ambiguous: true, matches };
	}

	return { task: null, ambiguous: false, matches: [] };
}

/**
 * Checks whether user message explicitly requests clearing/removing the due date or time.
 * Distinguishes explicit removal from title-only edits or unrelated phrases with "پاک".
 */
export function isExplicitClearDueDateRequest(text) {
	if (!text || typeof text !== "string") return false;
	const t = text.trim();
	// 1. Target keyword + optional qualifier + clear verb (e.g. موعد تسک فلان رو پاک کن, زمانش رو بردار, موعدش رو حذف کن)
	const p1 = /(?:^|[^\p{L}\p{N}])(?:موعد|تاریخ|زمان|ساعت)(?:ش|اش)?(?:\s+(?:تسک\s+|کار\s+)?[^\n\r]+?)?\s*(?:رو|را)?\s*(?:حذف\s*کن|پاک\s*کن|دیلیت\s*کن|بردار|لغو\s*کن|بردارید|پاکش\s*کن|حذفش\s*کن)(?=[^\p{L}\p{N}]|$)/iu;
	// 2. Clear verb + target keyword (e.g. حذف موعد تسک فلان, پاک کردن تاریخ فلان, لغو زمان)
	const p2 = /(?:^|[^\p{L}\p{N}])(?:حذف|پاک|دیلیت|برداشتن|لغو)(?:\s*کردن|\s*کن)?\s+(?:موعد|تاریخ|زمان|ساعت)(?:ش|اش)?(?=[^\p{L}\p{N}]|$)/iu;
	// 3. Without date/time (e.g. بدون موعد, بدون زمان, بدون تاریخ)
	const p3 = /(?:^|[^\p{L}\p{N}])بدون\s*(?:موعد|تاریخ|زمان|ساعت)(?=[^\p{L}\p{N}]|$)/iu;

	return p1.test(t) || p2.test(t) || p3.test(t);
}

/**
 * Handles incoming Telegram message update
 */
export async function handleIncomingMessage(env, update, options = {}) {
	const config = getConfig(env);
	const text = update?.text || "";
	const userId = update?.userId ? String(update.userId) : null;

	// Authorization Check: Enforce user whitelist (silently reject unauthorized users)
	const hasWhitelist = (config.allowedUserIds && config.allowedUserIds.length > 0) || Boolean(config.allowedUserId);
	if (hasWhitelist) {
		const isWhitelisted = Boolean(
			userId && (
				(config.allowedUserIds && config.allowedUserIds.includes(userId)) ||
				(config.allowedUserId && userId === config.allowedUserId)
			)
		);
		if (!isWhitelisted) {
			console.warn(`Unauthorized access attempt by Telegram user_id: ${userId}`);
			return {
				authorized: false,
				replyText: null,
				intent: "unauthorized",
				isError: false,
			};
		}
	}

	if (!text.trim()) {
		return {
			authorized: true,
			replyText: "پیام متنی ارسال نشده است.",
			intent: "empty",
			isError: false,
		};
	}

	const db = env.DB;
	const baseDate = options.baseDate || new Date();

	try {
		// =========================================================================
		// PENDING CLARIFICATION HANDLER (Ambiguous hour follow-up / Cancellation)
		// =========================================================================
		let pendingClarification = null;
		try {
			pendingClarification = await getPendingClarification(db, userId);
		} catch {
			pendingClarification = null;
		}

		if (pendingClarification) {
			// 1. Explicit cancellation
			if (isExplicitCancelText(text)) {
				await clearPendingClarification(db, userId);
				return {
					authorized: true,
					replyText: "❌ درخواست شما لغو شد.",
					intent: "cancel",
					isError: false,
				};
			}

			// 2. Ambiguous hour resolution attempt
			const targetDateStr = pendingClarification.payload?.targetDateStr;
			const ambHour = pendingClarification.payload?.ambiguousHour;
			if (ambHour !== undefined && ambHour !== null && targetDateStr) {
				const resolvedAns = resolveAmbiguousHourResponse(ambHour, text, targetDateStr);
				if (resolvedAns.resolved && resolvedAns.isoDueDate) {
					const claim = await claimPendingClarification(db, userId, 15000);
					if (claim && claim.success) {
						const actType = pendingClarification.actionType || pendingClarification.action_type;
						if (actType === "add") {
							const created = await createTask(db, userId, {
								title: pendingClarification.payload.title,
								dueDate: resolvedAns.isoDueDate,
								updateId: update?.updateId,
								lockToken: options?.lockToken,
							});
							await consumePendingClarification(db, userId, claim.claimToken);
							let msg = `✅ تسک با موفقیت ثبت شد:\n📌 ${created.title}\n⏰ موعد: ${formatPersianDateTime(created.due_date)}`;
							return {
								authorized: true,
								replyText: msg,
								intent: "add",
								isError: false,
							};
						} else if (actType === "edit") {
							const updated = await editTask(db, userId, pendingClarification.payload.targetTaskId, {
								title: pendingClarification.payload.newTitle || undefined,
								dueDate: resolvedAns.isoDueDate,
							});
							await consumePendingClarification(db, userId, claim.claimToken);
							let msg = `✏️ تسک «${pendingClarification.payload.newTitle || pendingClarification.payload.targetTaskTitle}» ویرایش شد.\n⏰ موعد جدید: ${formatPersianDateTime(resolvedAns.isoDueDate)}`;
							return {
								authorized: true,
								replyText: msg,
								intent: "edit",
								isError: false,
							};
						}
					}
				} else if (resolvedAns.isStillAmbiguous) {
					return {
						authorized: true,
						replyText: formatAmbiguousHourQuestion(ambHour),
						intent: "clarify",
						isError: false,
					};
				} else if (resolvedAns.isContradictory) {
					return {
						authorized: true,
						replyText: "⚠️ ساعت واردشده با ساعت قبلی همخوانی ندارد. لطفاً مشخص کنید صبح یا عصر؟",
						intent: "clarify",
						isError: false,
					};
				} else {
					// User sent a new command or different intent -> clear pending clarification and continue processing
					await clearPendingClarification(db, userId);
				}
			} else {
				await clearPendingClarification(db, userId);
			}
		}

		// =========================================================================
		// FAST PATH: Local Deterministic Dispatcher (0 Gemini Calls, instant execution)
		// =========================================================================
		const localAction = dispatchLocalAction(text, baseDate);

		if (localAction) {
			if (localAction.intent === "invalid_time") {
				return {
					authorized: true,
					replyText: localAction.reply || "⚠️ ساعت واردشده نامعتبر است. لطفاً ساعت را بین ۰۰:۰۰ تا ۲۳:۵۹ مشخص کنید.",
					intent: "invalid_time",
					isError: true,
				};
			}

			if (localAction.intent === "clarify") {
				return {
					authorized: true,
					replyText: localAction.reply || "منظورتان را متوجه نشدم؛ لطفاً مشخص کنید کدام تسک مد نظرتان است.",
					intent: "clarify",
					isError: false,
				};
			}

			if (localAction.intent === "bulk_delete_completed_request") {
				const completedTasks = await listTasks(db, userId, "completed");
				if (!completedTasks || completedTasks.length === 0) {
					return {
						authorized: true,
						replyText: "📋 هیچ تسک انجام‌شده‌ای برای حذف وجود ندارد.",
						intent: "bulk_delete_completed_request",
						isError: false,
					};
				}
				await setPendingConfirmation(db, userId, "bulk_delete_completed", 120);
				const faCount = String(completedTasks.length).replace(/\d/g, (d) => ["۰", "۱", "۲", "۳", "۴", "۵", "۶", "۷", "۸", "۹"][Number(d)]);
				return {
					authorized: true,
					replyText: `⚠️ آیا مطمئن هستید که می‌خواهید تمام کارهای انجام‌شده (${faCount} مورد) را از لیست حذف کنید؟\n\nبرای تأیید، عبارت «بله همه رو پاک کن» را ارسال کنید.\nبرای لغو، عبارت «نه» یا «لغو کن» را بفرستید. (مهلت تأیید: ۲ دقیقه)`,
					intent: "bulk_delete_completed_request",
					isError: false,
				};
			}

			if (localAction.intent === "bulk_delete_request") {
				const allTasks = await listTasks(db, userId, "all");
				if (!allTasks || allTasks.length === 0) {
					return {
						authorized: true,
						replyText: "📋 شما هیچ تسکی برای حذف کردن ندارید.",
						intent: "bulk_delete_request",
						isError: false,
					};
				}
				await setPendingConfirmation(db, userId, "bulk_delete", 120);
				return {
					authorized: true,
					replyText: `⚠️ آیا مطمئن هستید که می‌خواهید تمام ${allTasks.length} تسک خود را حذف کنید؟ این عملیات غیرقابل بازگشت است.\n\nبرای تأیید، عبارت «بله همه را حذف کن» را ارسال کنید.\nبرای لغو، عبارت «نه» یا «لغو کن» را بفرستید. (مهلت تأیید: ۲ دقیقه)`,
					intent: "bulk_delete_request",
					isError: false,
				};
			}

			if (localAction.intent === "bulk_delete_cancel") {
				const pendingCompleted = await getPendingConfirmation(db, userId, "bulk_delete_completed");
				if (pendingCompleted) {
					await clearPendingConfirmation(db, userId, "bulk_delete_completed");
					return {
						authorized: true,
						replyText: "❌ درخواست حذف کارهای انجام‌شده لغو شد. هیچ تسکی حذف نشد.",
						intent: "cancel",
						isError: false,
					};
				}
				const pending = await getPendingConfirmation(db, userId, "bulk_delete");
				if (pending) {
					await clearPendingConfirmation(db, userId, "bulk_delete");
					return {
						authorized: true,
						replyText: "❌ درخواست حذف تمام تسک‌ها لغو شد. هیچ تسکی حذف نشد.",
						intent: "cancel",
						isError: false,
					};
				}
				return {
					authorized: true,
					replyText: "درخواستی برای لغو وجود ندارد. چطور می‌تونم کمکتون کنم؟",
					intent: "chat",
					isError: false,
				};
			}

			if (localAction.intent === "bulk_delete_confirm") {
				const pendingCompleted = await getPendingConfirmation(db, userId, "bulk_delete_completed");
				if (pendingCompleted) {
					await clearPendingConfirmation(db, userId, "bulk_delete_completed");
					const deletedCount = await deleteCompletedTasks(db, userId);
					const faDelCount = String(deletedCount).replace(/\d/g, (d) => ["۰", "۱", "۲", "۳", "۴", "۵", "۶", "۷", "۸", "۹"][Number(d)]);
					return {
						authorized: true,
						replyText: `🗑️ تمام تسک‌های انجام‌شده با موفقیت حذف شدند. (${faDelCount} مورد پاک شد)`,
						intent: "delete",
						isError: false,
					};
				}

				const pending = await getPendingConfirmation(db, userId, "bulk_delete");
				if (!pending) {
					return {
						authorized: true,
						replyText: "⚠️ درخواستی برای حذف تمام تسک‌ها ثبت نشده است یا مهلت ۲ دقیقه‌ای تأیید آن منقضی شده است.\n\nاگر مایل به حذف تسک‌ها هستید، لطفاً ابتدا دستور «همه تسک‌هام رو پاک کن» یا «کارهای انجام شده رو حذف کن» را ارسال نمایید.",
						intent: "bulk_delete_confirm",
						isError: false,
					};
				}

				await clearPendingConfirmation(db, userId, "bulk_delete");
				const deletedCount = await deleteAllTasks(db, userId);
				return {
					authorized: true,
					replyText: `🗑 تمام تسک‌های شما با موفقیت حذف شدند. (${deletedCount} تسک پاک شد)`,
					intent: "delete",
					isError: false,
				};
			}

			if (localAction.intent === "chat") {
				if (!config.llmApiKey) {
					return {
						authorized: true,
						replyText: localAction.reply || "سلام! من هرمس مینی هستم 🚀 کارهای روزانه‌تان را به زبان عادی برام بفرستید تا سریع و مطمئن ثبت کنم.",
						intent: "chat",
						isError: false,
					};
				}
			} else if (localAction.intent === "list") {
				const listRes = await executeListTasks(db, userId, localAction.filter, baseDate);
				return {
					authorized: true,
					replyText: listRes.text,
					displayedTaskIds: listRes.displayedIds || [],
					intent: "list",
					isError: false,
				};
			}

			if (localAction.intent === "add") {
				const trimmedText = (text || "").trim();
				const INCOMPLETE_TRAILING_REGEX = /(?:^|[\s\u200c\u200b])(?:برای|به|واسه|تا|در|توی|با|از|روی|که|جهت|درباره)$/iu;
				const PURE_DIRECTIVE_REGEX = /^(?:تسک|کار|وظیفه|کارها|کارهای?|کارای|تسک‌ها|تسک\s*های?|تسکهای?|های|ها|ثبت|اضافه|یادداشت|ثبت\s*کن|اضافه\s*کن|یادداشت\s*کن|بنویس|بساز|ایجاد\s*کن|بذار|قرار\s*بده|ثبت\s*کنی|اضافه\s*کنی|یادداشت\s*کنی|بنویسی|بذاری|قرار\s*بدی)$/iu;

				if (INCOMPLETE_TRAILING_REGEX.test(trimmedText) || (localAction.title && INCOMPLETE_TRAILING_REGEX.test(localAction.title))) {
					return {
						authorized: true,
						replyText: "عنوان تسک ناقص است. لطفاً کاری که می‌خواهید انجام دهید را کامل بفرمایید.",
						intent: "clarify",
						isError: false,
					};
				}

				if (!localAction.title || localAction.title.length < 2 || PURE_DIRECTIVE_REGEX.test(localAction.title)) {
					return {
						authorized: true,
						replyText: "عنوان تسک مشخص نیست. لطفاً کاری که می‌خواید انجام بدید رو بنویسید.",
						intent: "clarify",
						isError: false,
					};
				}

				// 1. Common Date Validation
				if (localAction.isInvalidDate) {
					return {
						authorized: true,
						replyText: "⚠️ تاریخ شمسی واردشده نامعتبر است. لطفاً روز و ماه را به درستی مشخص کنید.",
						intent: "clarify",
						isError: false,
					};
				}

				if (localAction.isPastDate) {
					return {
						authorized: true,
						replyText: "⚠️ تاریخ واردشده گذشته است. لطفاً تاریخی در آینده یا امروز را مشخص کنید.",
						intent: "clarify",
						isError: false,
					};
				}

				if (localAction.isBeyondOneYear) {
					return {
						authorized: true,
						replyText: "⚠️ موعد کار نمی‌تواند بیش از یک سال آینده باشد. لطفاً تاریخی حداکثر تا یک سال آینده مشخص کنید.",
						intent: "clarify",
						isError: false,
					};
				}

				if (localAction.isAmbiguousTime || (localAction.needsClarification && localAction.clarificationType === "ambiguous_time")) {
					const ambiguousHour = localAction.ambiguousHour;
					const targetDateStr = localAction.targetDateStr;
					const targetParts = targetDateStr ? targetDateStr.split("-").map(Number) : null;
					const payload = {
						title: localAction.title,
						targetDateStr: targetDateStr,
						targetYear: localAction.targetYear || (targetParts ? targetParts[0] : baseDate.getFullYear()),
						targetMonth: localAction.targetMonth || (targetParts ? targetParts[1] : baseDate.getMonth() + 1),
						targetDay: localAction.targetDay || (targetParts ? targetParts[2] : baseDate.getDate()),
						ambiguousHour: ambiguousHour,
						rawHourStr: String(ambiguousHour),
						originalUserText: text,
					};
					await setPendingClarification(db, userId, "add", payload, 300);
					return {
						authorized: true,
						replyText: formatAmbiguousHourQuestion(ambiguousHour),
						intent: "clarify",
						isError: false,
					};
				}

				if (localAction.needsClarification) {
					return {
						authorized: true,
						replyText: localAction.reply || "منظورتان را متوجه نشدم؛ لطفاً روز یا زمان مشخصی را تعیین کنید.",
						intent: "clarify",
						isError: false,
					};
				}

				const dueDateToSave = localAction.isoDueDate || localAction.due_date || null;
				const limitCheck = validateDueDateLimit(dueDateToSave, baseDate);
				if (!limitCheck.valid) {
					return {
						authorized: true,
						replyText: limitCheck.reply || "⚠️ موعد کار نامعتبر است.",
						intent: limitCheck.reason === "INVALID_FORMAT" ? "invalid_time" : "clarify",
						isError: false,
					};
				}

				const created = await createTask(db, userId, {
					title: localAction.title,
					dueDate: dueDateToSave,
					updateId: update?.updateId,
					lockToken: options?.lockToken,
				});

				let msg = `✅ تسک با موفقیت ثبت شد:\n📌 ${created.title}`;
				if (created.due_date) {
					msg += `\n⏰ موعد: ${formatPersianDateTime(created.due_date)}`;
				}
				return {
					authorized: true,
					replyText: msg,
					intent: "add",
					isError: false,
				};
			}

			if (["done", "undone", "delete"].includes(localAction.intent)) {
				let history = [];
				try {
					history = await getRecentConversation(db, userId, 6);
				} catch {
					history = [];
				}

				const resolution = await resolveTargetTask(
					db,
					userId,
					{ target_index: localAction.target_index, target_query: localAction.target_query },
					localAction.intent === "done",
					history
				);

				// Ambiguity Guard: if multiple tasks matched, do NOT modify anything!
				if (resolution.ambiguous && resolution.matches.length > 1) {
					const lines = resolution.matches.map((t, idx) => `${idx + 1}. ${getTaskStatusIcon(t, baseDate)} ${t.title}`);
					return {
						authorized: true,
						replyText: `🔍 چند تسک با عنوان مشابه پیدا شد:\n\n${lines.join("\n")}\n\nلطفاً مشخص کنید کدام تسک مد نظرتان است (مثلاً: اولی یا دومی).`,
						displayedTaskIds: resolution.matches.map((t) => t.id),
						intent: "clarify",
						isError: false,
					};
				}

				if (resolution.expiredOrMissingList) {
					return {
						authorized: true,
						replyText: "🔍 فهرست قبلی شما منقضی شده یا در دسترس نیست. لطفاً ابتدا «کارام رو نشون بده» را بفرستید یا عنوان کار مورد نظر را بنویسید.",
						intent: localAction.intent,
						isError: false,
					};
				}

				const found = resolution.task;
				if (!found) {
					if (!localAction.target_index && !localAction.target_query) {
						return {
							authorized: true,
							replyText: "دقیقاً مشخص نکردید کدام تسک مد نظرتان است. لطفاً عنوان یا شماره تسک را بفرمایید.",
							intent: "clarify",
							isError: false,
						};
					}
					const desc = localAction.target_index
						? `شماره ${localAction.target_index}`
						: `«${localAction.target_query || ""}»`;
					const actionName = localAction.intent === "delete" ? "حذف" : localAction.intent === "undone" ? "بازگردانی" : "انجام";
					return {
						authorized: true,
						replyText: `🔍 تسکی با مشخصات ${desc} برای ${actionName} پیدا نشد.`,
						intent: localAction.intent,
						isError: false,
					};
				}

				if (localAction.intent === "done") {
					const updated = await updateTaskStatus(db, userId, found.id, true);
					if (!updated) {
						return {
							authorized: true,
							replyText: `⚠️ تغییر وضعیت تسک «${found.title}» در دیتابیس با مشکل مواجه شد.`,
							intent: "done",
							isError: true,
						};
					}
					return {
						authorized: true,
						replyText: `🎉 آفرین! تسک «${found.title}» انجام شد. ✅`,
						intent: "done",
						isError: false,
					};
				}

				if (localAction.intent === "undone") {
					const updated = await updateTaskStatus(db, userId, found.id, false);
					if (!updated) {
						return {
							authorized: true,
							replyText: `⚠️ تغییر وضعیت تسک «${found.title}» در دیتابیس با مشکل مواجه شد.`,
							intent: "undone",
							isError: true,
						};
					}
					return {
						authorized: true,
						replyText: `🔄 تسک «${found.title}» به حالت انجام‌نشده بازگردانده شد. ⬜`,
						intent: "undone",
						isError: false,
					};
				}

				if (localAction.intent === "delete") {
					const deleted = await deleteTask(db, userId, found.id);
					if (!deleted) {
						return {
							authorized: true,
							replyText: `⚠️ حذف تسک «${found.title}» در دیتابیس با مشکل مواجه شد.`,
							intent: "delete",
							isError: true,
						};
					}
					return {
						authorized: true,
						replyText: `🗑 تسک «${found.title}» با موفقیت حذف شد.`,
						intent: "delete",
						isError: false,
					};
				}
			}

			if (localAction.intent === "edit") {
				let history = [];
				try {
					history = await getRecentConversation(db, userId, 6);
				} catch {
					history = [];
				}

				const resolution = await resolveTargetTask(
					db,
					userId,
					{ target_index: localAction.target_index, target_query: localAction.target_query },
					false,
					history
				);

				if (resolution.ambiguous && resolution.matches.length > 1) {
					const lines = resolution.matches.map((t, idx) => `${idx + 1}. ${getTaskStatusIcon(t, baseDate)} ${t.title}`);
					return {
						authorized: true,
						replyText: `🔍 چند تسک با عنوان مشابه پیدا شد:\n\n${lines.join("\n")}\n\nلطفاً مشخص کنید کدام تسک مد نظرتان است (مثلاً: اولی یا دومی).`,
						displayedTaskIds: resolution.matches.map((t) => t.id),
						intent: "clarify",
						isError: false,
					};
				}

				if (resolution.expiredOrMissingList) {
					return {
						authorized: true,
						replyText: "🔍 فهرست قبلی شما منقضی شده یا در دسترس نیست. لطفاً ابتدا «کارام رو نشون بده» را بفرستید یا عنوان کار مورد نظر را بنویسید.",
						intent: "edit",
						isError: false,
					};
				}

				const found = resolution.task;
				if (!found) {
					if (!localAction.target_index && !localAction.target_query) {
						return {
							authorized: true,
							replyText: "دقیقاً مشخص نکردید کدام تسک مد نظرتان است. لطفاً عنوان یا شماره تسک را بفرمایید.",
							intent: "clarify",
							isError: false,
						};
					}
					const desc = localAction.target_index
						? `شماره ${localAction.target_index}`
						: `«${localAction.target_query || ""}»`;
					return {
						authorized: true,
						replyText: `🔍 تسکی با مشخصات ${desc} برای ویرایش پیدا نشد.`,
						intent: "edit",
						isError: false,
					};
				}

				// 1. Common Date Validation
				if (localAction.isInvalidDate) {
					return {
						authorized: true,
						replyText: "⚠️ تاریخ شمسی واردشده نامعتبر است. لطفاً روز و ماه را به درستی مشخص کنید.",
						intent: "clarify",
						isError: false,
					};
				}

				if (localAction.isPastDate) {
					return {
						authorized: true,
						replyText: "⚠️ تاریخ واردشده گذشته است. لطفاً تاریخی در آینده یا امروز را مشخص کنید.",
						intent: "clarify",
						isError: false,
					};
				}

				if (localAction.isBeyondOneYear) {
					return {
						authorized: true,
						replyText: "⚠️ موعد کار نمی‌تواند بیش از یک سال آینده باشد. لطفاً تاریخی حداکثر تا یک سال آینده مشخص کنید.",
						intent: "clarify",
						isError: false,
					};
				}

				if (localAction.isAmbiguousTime || (localAction.needsClarification && localAction.clarificationType === "ambiguous_time")) {
					const ambiguousHour = localAction.ambiguousHour;
					const payload = {
						targetTaskId: found.id,
						targetTaskTitle: found.title,
						targetTaskDueDate: found.due_date,
						targetTaskIsCompleted: Boolean(found.is_completed),
						newTitle: localAction.new_title || null,
						targetDateStr: localAction.targetDateStr,
						ambiguousHour: ambiguousHour,
						originalUserText: text,
					};
					await setPendingClarification(db, userId, "edit", payload, 300);
					return {
						authorized: true,
						replyText: formatAmbiguousHourQuestion(ambiguousHour),
						intent: "clarify",
						isError: false,
					};
				}

				if (localAction.needsClarification) {
					return {
						authorized: true,
						replyText: localAction.reply || "منظورتان را متوجه نشدم؛ لطفاً روز یا زمان مشخصی را تعیین کنید.",
						intent: "clarify",
						isError: false,
					};
				}

				const effectiveDueDate = localAction.isoDueDate !== undefined ? localAction.isoDueDate : localAction.due_date;
				const dueDateParam = localAction.clearDueDate
					? null
					: (localAction.hasDate || localAction.hasTime)
						? (effectiveDueDate || null)
						: undefined;

				if (dueDateParam && !localAction.clearDueDate) {
					const limitCheck = validateDueDateLimit(dueDateParam, baseDate);
					if (!limitCheck.valid) {
						return {
							authorized: true,
							replyText: limitCheck.reply || "⚠️ ساعت یا تاریخ واردشده نامعتبر است. لطفاً زمان را به درستی مشخص کنید.",
							intent: limitCheck.reason === "INVALID_FORMAT" ? "invalid_time" : "clarify",
							isError: false,
						};
					}
				}

				const updated = await editTask(db, userId, found.id, {
					title: localAction.new_title || undefined,
					dueDate: dueDateParam,
				});

				if (updated) {
					if (localAction.clearDueDate) {
						return {
							authorized: true,
							replyText: `⏰ موعد تسک «${found.title}» با موفقیت حذف شد.`,
							intent: "edit",
							isError: false,
						};
					}
					let editMsg = `✏️ تسک «${localAction.new_title || found.title}» ویرایش شد.`;
					if (dueDateParam) {
						editMsg += `\n⏰ موعد جدید: ${formatPersianDateTime(dueDateParam)}`;
					}
					return {
						authorized: true,
						replyText: editMsg,
						intent: "edit",
						isError: false,
					};
				} else {
					return {
						authorized: true,
						replyText: "تغییری برای اعمال روی تسک مشخص نشده است.",
						intent: "edit",
						isError: false,
					};
				}
			}
		}

		// =========================================================================
		// SECONDARY PATH: Natural language multi-turn understanding with Gemini
		// =========================================================================
		let history = [];
		try {
			history = await getRecentConversation(db, userId, 6);
		} catch {
			history = [];
		}

		const parsed = await parsePersianWithLLM(text, config, history, options);

		let intent = null;
		let task = { title: null, target_query: null, target_index: null, due_date: null, filter: "all" };
		let reply = null;

		if (parsed && parsed.ok) {
			intent = parsed.intent;
			task = parsed.task || task;
			reply = parsed.reply;
		} else {
			// LLM failed or offline: graceful friendly guidance, never generic server crash error
			if (localAction && localAction.intent === "chat") {
				return {
					authorized: true,
					replyText: localAction.reply || "سلام! من هرمس مینی هستم 🚀 کارهای روزانه‌تان را به زبان عادی برام بفرستید تا براتان ثبت کنم.",
					intent: "chat",
					isError: false,
				};
			}

			const fallback = fallbackPersianParser(text);
			if (["add", "list", "done", "undone", "delete"].includes(fallback.intent)) {
				intent = fallback.intent;
				task = fallback.task || task;
				reply = fallback.reply;
			} else {
				return {
					authorized: true,
					replyText: "منظورتان را متوجه نشدم؛ برای مثال می‌توانید بگویید:\n• «گوشیم رو بزنم به شارژ»\n• «کارام رو نشون بده»\n• «اولی رو انجام دادم»",
					intent: "clarify",
					isError: true,
				};
			}
		}

		let finalReply = "";
		let displayedTaskIds = [];

		switch (intent) {
			case "add": {
				const trimmedText = (text || "").trim();
				const rawTitle = (task.title || "").trim();

				// Guard against incomplete phrases ending in dangling prepositions/connectors
				const INCOMPLETE_TRAILING_REGEX = /(?:^|[\s\u200c\u200b])(?:برای|به|واسه|تا|در|توی|با|از|روی|که|جهت|درباره)$/iu;
				if (INCOMPLETE_TRAILING_REGEX.test(trimmedText) || INCOMPLETE_TRAILING_REGEX.test(rawTitle)) {
					intent = "clarify";
					finalReply = "عنوان تسک ناقص است. لطفاً کاری که می‌خواهید انجام دهید را کامل بفرمایید.";
					break;
				}

				const cleanedTitle = cleanTaskTitle(rawTitle);
				if (!cleanedTitle || cleanedTitle.length < 2 || /^(?:تسک|کار|وظیفه|کارها|کارهای?|کارای|تسک‌ها|تسک\s*های?|تسکهای?|های|ها)$/iu.test(cleanedTitle)) {
					intent = "clarify";
					finalReply = "عنوان تسک مشخص نیست. لطفاً کاری که می‌خواید انجام بدید رو بنویسید.";
					break;
				}

				// Common Date Validation on user's input text
				const timeInfo = extractPersianDateTime(trimmedText, baseDate);

				if (timeInfo.isInvalidDate) {
					intent = "clarify";
					finalReply = "⚠️ تاریخ شمسی واردشده نامعتبر است. لطفاً روز و ماه را به درستی مشخص کنید.";
					break;
				}

				if (timeInfo.isPastDate) {
					intent = "clarify";
					finalReply = "⚠️ تاریخ واردشده گذشته است. لطفاً تاریخی در آینده یا امروز را مشخص کنید.";
					break;
				}

				if (timeInfo.isBeyondOneYear) {
					intent = "clarify";
					finalReply = "⚠️ موعد کار نمی‌تواند بیش از یک سال آینده باشد. لطفاً تاریخی حداکثر تا یک سال آینده مشخص کنید.";
					break;
				}

				if (timeInfo.isAmbiguousTime || (timeInfo.needsClarification && timeInfo.clarificationType === "ambiguous_time")) {
					const ambiguousHour = timeInfo.ambiguousHour;
					const targetDateStr = timeInfo.targetDateStr;
					const targetParts = targetDateStr ? targetDateStr.split("-").map(Number) : null;
					const payload = {
						title: cleanedTitle,
						targetDateStr: targetDateStr,
						targetYear: timeInfo.targetYear || (targetParts ? targetParts[0] : baseDate.getFullYear()),
						targetMonth: timeInfo.targetMonth || (targetParts ? targetParts[1] : baseDate.getMonth() + 1),
						targetDay: timeInfo.targetDay || (targetParts ? targetParts[2] : baseDate.getDate()),
						ambiguousHour: ambiguousHour,
						rawHourStr: String(ambiguousHour),
						originalUserText: text,
					};
					await setPendingClarification(db, userId, "add", payload, 300);
					intent = "clarify";
					finalReply = formatAmbiguousHourQuestion(ambiguousHour);
					break;
				}

				if (timeInfo.needsClarification) {
					intent = "clarify";
					finalReply = reply || "منظورتان را متوجه نشدم؛ لطفاً روز یا زمان مشخصی را تعیین کنید.";
					break;
				}

				const dueDateToSave = task.due_date || timeInfo.isoDueDate || null;
				if (dueDateToSave) {
					const limitCheck = validateDueDateLimit(dueDateToSave, baseDate);
					if (!limitCheck.valid) {
						intent = limitCheck.reason === "INVALID_FORMAT" ? "invalid_time" : "clarify";
						finalReply = limitCheck.reply || "⚠️ موعد کار نامعتبر است.";
						break;
					}
				}

				const created = await createTask(db, userId, {
					title: cleanedTitle,
					dueDate: dueDateToSave,
					updateId: update?.updateId,
					lockToken: options?.lockToken,
				});

				let msg = `✅ تسک با موفقیت ثبت شد:\n📌 ${created.title}`;
				if (created.due_date) {
					msg += `\n⏰ موعد: ${formatPersianDateTime(created.due_date)}`;
				}
				finalReply = msg;
				break;
			}

			case "list": {
				const filter = task.filter || "all";
				const listRes = await executeListTasks(db, userId, filter, baseDate);
				finalReply = listRes.text;
				displayedTaskIds = listRes.displayedIds || [];
				break;
			}

			case "done":
			case "undone":
			case "delete":
			case "edit": {
				const resolution = await resolveTargetTask(db, userId, task, intent === "done", history);

				if (resolution.ambiguous && resolution.matches.length > 1) {
					const lines = resolution.matches.map((t, idx) => `${idx + 1}. ${getTaskStatusIcon(t, baseDate)} ${t.title}`);
					finalReply = `🔍 چند تسک با عنوان مشابه پیدا شد:\n\n${lines.join("\n")}\n\nلطفاً مشخص کنید کدام تسک مد نظرتان است (مثلاً: اولی یا دومی).`;
					displayedTaskIds = resolution.matches.map((t) => t.id);
					break;
				}

				const found = resolution.task;
				if (!found) {
					if (!task.target_index && !task.target_query) {
						finalReply = "دقیقاً مشخص نکردید کدام تسک مد نظرتان است. لطفاً عنوان یا شماره تسک را بفرمایید.";
						intent = "clarify";
						break;
					}
					const desc = task.target_index ? `شماره ${task.target_index}` : `«${task.target_query || ""}»`;
					finalReply = `🔍 تسکی با مشخصات ${desc} پیدا نشد.`;
					break;
				}

				if (intent === "done") {
					await updateTaskStatus(db, userId, found.id, true);
					finalReply = `🎉 آفرین! تسک «${found.title}» انجام شد. ✅`;
				} else if (intent === "undone") {
					await updateTaskStatus(db, userId, found.id, false);
					finalReply = `🔄 تسک «${found.title}» به حالت انجام‌نشده بازگردانده شد. ⬜`;
				} else if (intent === "delete") {
					await deleteTask(db, userId, found.id);
					finalReply = `🗑 تسک «${found.title}» با موفقیت حذف شد.`;
				} else if (intent === "edit") {
					let titleToUse = undefined;
					if (task.title) {
						const rawTitle = String(task.title).trim();
						const INCOMPLETE_TRAILING_REGEX = /(?:^|[\s\u200c\u200b])(?:برای|به|واسه|تا|در|توی|با|از|روی|که|جهت|درباره)$/iu;
						if (INCOMPLETE_TRAILING_REGEX.test(rawTitle)) {
							intent = "clarify";
							finalReply = "عنوان تسک ناقص است. لطفاً کاری که می‌خواهید انجام دهید را کامل بفرمایید.";
							break;
						}

						const cleanedTitle = cleanTaskTitle(rawTitle);
						if (!cleanedTitle || cleanedTitle.length < 2 || /^(?:تسک|کار|وظیفه|کارها|تسک‌ها)$/iu.test(cleanedTitle)) {
							intent = "clarify";
							finalReply = "عنوان تسک مشخص نیست. لطفاً کاری که می‌خواید انجام بدید رو بنویسید.";
							break;
						}

						titleToUse = cleanedTitle;
					}

					// Common Date Validation on user's input text
					const trimmedText = (text || "").trim();
					const timeInfo = extractPersianDateTime(trimmedText, baseDate);

					if (timeInfo.isInvalidDate) {
						intent = "clarify";
						finalReply = "⚠️ تاریخ شمسی واردشده نامعتبر است. لطفاً روز و ماه را به درستی مشخص کنید.";
						break;
					}

					if (timeInfo.isPastDate) {
						intent = "clarify";
						finalReply = "⚠️ تاریخ واردشده گذشته است. لطفاً تاریخی در آینده یا امروز را مشخص کنید.";
						break;
					}

					if (timeInfo.isBeyondOneYear) {
						intent = "clarify";
						finalReply = "⚠️ موعد کار نمی‌تواند بیش از یک سال آینده باشد. لطفاً تاریخی حداکثر تا یک سال آینده مشخص کنید.";
						break;
					}

					if (timeInfo.isAmbiguousTime || (timeInfo.needsClarification && timeInfo.clarificationType === "ambiguous_time")) {
						const ambiguousHour = timeInfo.ambiguousHour;
						const payload = {
							targetTaskId: found.id,
							targetTaskTitle: found.title,
							targetTaskDueDate: found.due_date,
							targetTaskIsCompleted: Boolean(found.is_completed),
							newTitle: titleToUse || null,
							targetDateStr: timeInfo.targetDateStr,
							ambiguousHour: ambiguousHour,
							originalUserText: text,
						};
						await setPendingClarification(db, userId, "edit", payload, 300);
						intent = "clarify";
						finalReply = formatAmbiguousHourQuestion(ambiguousHour);
						break;
					}

					if (timeInfo.needsClarification) {
						intent = "clarify";
						finalReply = reply || "منظورتان را متوجه نشدم؛ لطفاً روز یا زمان مشخصی را تعیین کنید.";
						break;
					}

					const isExplicitClearDueDate =
						task.due_date === null && isExplicitClearDueDateRequest(text);

					let dueDateToUse = isExplicitClearDueDate
						? null
						: (task.due_date ? task.due_date : (timeInfo.hasDate ? timeInfo.isoDueDate : undefined));

					if (dueDateToUse) {
						const limitCheck = validateDueDateLimit(dueDateToUse, baseDate);
						if (!limitCheck.valid) {
							intent = limitCheck.reason === "INVALID_FORMAT" ? "invalid_time" : "clarify";
							finalReply = limitCheck.reply || "⚠️ ساعت یا تاریخ واردشده نامعتبر است. لطفاً زمان را به درستی مشخص کنید.";
							break;
						}
					}

					const updated = await editTask(db, userId, found.id, {
						title: titleToUse,
						dueDate: dueDateToUse,
					});
					if (updated) {
						if (isExplicitClearDueDate && !titleToUse) {
							finalReply = `⏰ موعد تسک «${found.title}» با موفقیت حذف شد.`;
						} else if (isExplicitClearDueDate && titleToUse) {
							finalReply = `✏️ تسک «${titleToUse}» ویرایش شد و موعد آن با موفقیت حذف شد.`;
						} else {
							let editMsg = `✏️ تسک «${titleToUse || found.title}» ویرایش شد.`;
							if (dueDateToUse) {
								editMsg += `\n⏰ موعد جدید: ${formatPersianDateTime(dueDateToUse)}`;
							}
							finalReply = editMsg;
						}
					} else {
						finalReply = "تغییری برای اعمال روی تسک مشخص نشده است.";
					}
				}
				break;
			}

			case "clarify": {
				finalReply = reply || "منظورتون رو دقیق متوجه نشدم. می‌شه لطفاً بیشتر توضیح بدید؟";
				break;
			}

			case "chat":
			case "general_qa":
			default: {
				finalReply = reply || "سلام! من هرمس مینی هستم 🚀 کارهای روزانه‌تان را به زبان عادی برام بفرستید تا براتان ثبت کنم.";
				break;
			}
		}

		return {
			authorized: true,
			replyText: finalReply,
			displayedTaskIds,
			intent,
			isError: false,
		};
	} catch (err) {
		console.error("Handler error:", err.message);
		return {
			authorized: true,
			replyText: "⚠️ متأسفانه در ارتباط با دیتابیس خطایی رخ داد. لطفاً دوباره تلاش کنید.",
			intent: "error",
			isError: true,
		};
	}
}
