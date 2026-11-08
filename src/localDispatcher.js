/**
 * Hermes Mini - Local Deterministic Dispatcher
 * Executes core task operations locally and deterministically without calling Gemini.
 * Gemini is only invoked for truly ambiguous or conversational queries.
 */

import { extractPersianDateTime, toEnglishDigits, normalizeWeekday, SOLAR_MONTH_NAMES } from "./dateUtils.js";

/**
 * Normalizes Persian text for pattern matching
 */
export function normalizePersianText(text = "") {
	if (!text || typeof text !== "string") return "";
	return text
		.replace(/ي/g, "ی")
		.replace(/ك/g, "ک")
		.replace(/[\u200c\u200b]/g, " ")
		.replace(/[؟!?.,،؛:()\[\]{}"'«»\-_\/\\*~`^#@$%=+]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Strips leading conversational greeting from text if followed by task action.
 * e.g. "سلام فردا ساعت ۵ باید برم دکتر" -> "فردا ساعت ۵ باید برم دکتر"
 */
export function stripLeadingGreeting(text = "") {
	const trimmed = text.trim();
	return trimmed
		.replace(/^(?:سلام(?:\s+هرمس(?:\s+جان)?)?|درود|صبح\s*بخیر|عصر\s*بخیر|شب\s*بخیر)[،,\s]+/iu, "")
		.trim();
}

/**
 * Checks if the text is purely a conversational/chat message that should NEVER become a task.
 */
export function isExplicitChatMessage(text = "") {
	const trimmed = text.trim();
	const norm = normalizePersianText(trimmed);

	// Pure Greetings & Start (without tasks)
	// Supports "سلام", "سلام هرمس جان چطوری", "درود بر شما", "صبح بخیر", etc.
	if (/^(?:سلام|درود|صبح\s*بخیر|عصر\s*بخیر|شب\s*بخیر|چطوری|خوبی|چه\s*خبر|هرمس|راهنما|کمک|\/start|start|شروع)(?:\s+(?:هرمس|جان|عزیز|خوبی|چطوری|شما|عزیزم|رفیق|گل|بر\s*تو|بر\s*شما))*$/iu.test(norm)) {
		return true;
	}

	// Inquisitive or conversational phrases with "میخوام" / "میشه"
	if (/^(?:من\s*)?(?:می‌خواهم|میخواهم|می‌خوام|میخوام|میشه|می‌شه)\s+(?:بدونم|بپرسم|ببینم|نظرت|یک\s*چیزی|یه\s*چیزی|بگی)/iu.test(norm)) {
		return true;
	}

	// Jokes, Stories, Feelings, Thanks, Farewell, General Qs
	if (/(?:جوک|لطیفه|داستان|شعر)/iu.test(norm) && /(?:بگو|تعریف کن|بخون)/iu.test(norm)) {
		return true;
	}

	if (/(حوصله ندارم|خسته\s*ام|خسته ام|خوشحالم|ناراحتم|حالم خوب نیست|حالم بده)/iu.test(norm)) {
		return true;
	}

	if (/(چیکار می\s*کنی|چیکار میکنی|داری چیکار میکنی|تو کی هستی|اسمت چیه|خودتو معرفی کن)/iu.test(norm)) {
		return true;
	}

	if (/(ممنون|مرسی|دمت گرم|تشکر|دستت درد نکنه|دستت طلا|سپاس|خداحافظ|فعلا|شب خوش|روز خوش|قربانت)/iu.test(norm)) {
		return true;
	}

	if (/(پایتون چیه|هوش مصنوعی چیه|برنامه نویسی چیه|چند\s*شنبه\s*است|ساعت چنده|هوا چطوره|تعطیل|تعطیله|تعطیل\s*است|چندم|چندمه|مناسبت)/iu.test(norm)) {
		return true;
	}

	return false;
}

/**
 * Detects local list intent with comprehensive Persian variations
 */
export function detectLocalListIntent(text = "", baseDate = new Date()) {
	if (!text || typeof text !== "string") return null;
	const trimmed = stripLeadingGreeting(text);
	if (trimmed.length > 70) return null;
	const norm = normalizePersianText(trimmed);

	// Guard: Do not match if action keywords are present
	// (Allow status filter phrases "انجام شده" and "انجام نشده" unless followed by "کن")
	if (/(انجام(?!\s*(?:شده|نشده)(?!\s*کن))|تیک|حل|حذف|پاک|دیلیت|لغو|ویرایش|عوض|تغییر|اضافه|ثبت|جدید|بزن به شارژ|یادم|باید|بخونم|برم|بذار|بنداز)/i.test(norm)) {
		return null;
	}

	// 0. Specific Solar Date matching: "کارهای ۲۲ آبان", "لیست کارهای ۲۲ آبان", "کارهای ۲۲ آبان رو نشون بده", "کارهای ۱۹ آبان رو نشون بده"
	const engNorm = toEnglishDigits(norm);
	const solarMonth = "(?:فروردین|اردیبهشت|خرداد|تیر|مرداد|شهریور|مهر|آبان|آذر|دی|بهمن|اسفند)";
	const solarDatePattern = `(?:(?:روز\\s+)?\\d{1,2}\\s+${solarMonth}(?:\\s+\\d{4})?)`;
	const taskNounClause = "(?:تسک\\s*های?|تسکهای?|تسک\\s*هام|تسکام|کار\\s*های?|کارهای?|کار\\s*هام|کارام|کارای|وظایف|برنامه(?:\\s*های?|های?|\\s*هام|هام)?)";

	const isSolarListQuery =
		new RegExp(`^(?:لیست\\s+|فهرست\\s+)(?:${taskNounClause}\\s+)?${solarDatePattern}$`, "iu").test(engNorm) ||
		new RegExp(`^${taskNounClause}\\s+${solarDatePattern}$`, "iu").test(engNorm) ||
		new RegExp(`^(?:لیست\\s+|فهرست\\s+)?(?:${taskNounClause}\\s+)?${solarDatePattern}\\s*(?:رو|را)?\\s*(?:نمایش\\s*بده|نشون\\s*بده|بده|بگو)$`, "iu").test(engNorm) ||
		new RegExp(`^(?:لیست\\s+|فهرست\\s+)?${solarDatePattern}\\s+(?:${taskNounClause})\\s*(?:رو|را)?\\s*(?:نمایش\\s*بده|نشون\\s*بده|بده|بگو)$`, "iu").test(engNorm) ||
		new RegExp(`^(?:نمایش\\s*بده|نشون\\s*بده|بده|بگو)\\s+(?:لیست\\s+|فهرست\\s+)?(?:${taskNounClause}\\s+)?${solarDatePattern}(?:\\s+(?:رو|را))?$`, "iu").test(engNorm) ||
		new RegExp(`^(?:لیست\\s+|فهرست\\s+)?(?:${taskNounClause}\\s+)?${solarDatePattern}\\s*(?:چیه|چیست|چندتاست)$`, "iu").test(engNorm) ||
		new RegExp(`^(?:${solarDatePattern}\\s+)?(?:چه\\s*(?:کاری|کارای|کارایی|کار\\s*هایی|کارهایی|تسکی|تسکای|تسکایی|تسک\\s*هایی|تسکهایی)|چی\\s*کار|چیکار)\\s*${solarDatePattern}?\\s*دارم\\??$`, "iu").test(engNorm);

	if (isSolarListQuery) {
		const solarDateMatch = engNorm.match(new RegExp(`(\\d{1,2})\\s+(${solarMonth})`, "u"));
		const timeInfo = extractPersianDateTime(norm, baseDate);
		if (timeInfo && timeInfo.hasDate && timeInfo.targetDateStr) {
			const targetDate = new Date(`${timeInfo.targetDateStr}T12:00:00+03:30`);
			const weekdayName = new Intl.DateTimeFormat("fa-IR", { timeZone: "Asia/Tehran", weekday: "long" }).format(targetDate);
			const solarMonthNames = ["", "فروردین", "اردیبهشت", "خرداد", "تیر", "مرداد", "شهریور", "مهر", "آبان", "آذر", "دی", "بهمن", "اسفند"];
			const monthLabel = solarMonthNames[timeInfo.solarMonth] || (solarDateMatch ? solarDateMatch[2] : "");
			const faDay = String(timeInfo.solarDay).replace(/\d/g, (d) => ["۰", "۱", "۲", "۳", "۴", "۵", "۶", "۷", "۸", "۹"][Number(d)]);
			const dateLabel = `${weekdayName} ${faDay} ${monthLabel}`.trim();
			return {
				intent: "list",
				filter: `date:${timeInfo.targetDateStr}:${dateLabel}`,
			};
		}
	}

	let filter = "all";
	if (/(امروز|امروزم|امروزو)/i.test(norm)) {
		filter = "today";
	} else if (/(پس\s*فردا|پس‌فردا|پسفردا)/i.test(norm)) {
		filter = "day_after_tomorrow";
	} else if (/(فردا|فردام|فردا رو)/i.test(norm)) {
		filter = "tomorrow";
	} else if (/(عقب\s*افتاده|معوق|موعد\s*گذشته|موعدگذشته)/i.test(norm)) {
		filter = "overdue";
	} else if (/(انجام\s*نشده|انجام‌نشده)/i.test(norm)) {
		filter = "pending";
	} else if (/(انجام\s*شده|تکمیل\s*شده|انجام‌شده|تکمیل‌شده)/i.test(norm)) {
		filter = "completed";
	} else if (/(یک\s*شنبه|یکشنبه)/i.test(norm)) {
		filter = "یکشنبه";
	} else if (/(دو\s*شنبه|دوشنبه)/i.test(norm)) {
		filter = "دوشنبه";
	} else if (/(سه\s*شنبه|سه‌شنبه|سهشنبه)/i.test(norm)) {
		filter = "سه‌شنبه";
	} else if (/(چهار\s*شنبه|چهارشنبه)/i.test(norm)) {
		filter = "چهارشنبه";
	} else if (/(پنج\s*شنبه|پنج‌شنبه|پنجشنبه)/i.test(norm)) {
		filter = "پنج‌شنبه";
	} else if (/(جمعه|آدینه)/i.test(norm)) {
		filter = "جمعه";
	} else if (/(?:^|\s)شنبه(?:$|\s)/i.test(norm)) {
		filter = "شنبه";
	}

	const dayPattern = "(?:امروز|پس\\s*فردا|پس‌فردا|پسفردا|فردا|عقب\\s*افتاده|معوق|انجام\\s*نشده|موعد\\s*گذشته|موعدگذشته|انجام\\s*شده|تکمیل\\s*شده|(?:روز\\s+)?(?:یک\\s*شنبه|یکشنبه|دو\\s*شنبه|دوشنبه|سه\\s*شنبه|سه‌شنبه|سهشنبه|چهار\\s*شنبه|چهارشنبه|پنج\\s*شنبه|پنج‌شنبه|پنجشنبه|جمعه|آدینه|شنبه))";
	const taskNoun = "(?:تسک\\s*های?|تسکهای?|تسک\\s*هام|تسکام|کار\\s*های?|کارهای?|کار\\s*هام|کارام|کارای|وظایف|برنامه(?:\\s*های?|های?|\\s*هام|هام)?)";

	const resolvedFilter = normalizeWeekday(filter) || filter;

	// 1. Direct keywords: "کارهای شنبه", "لیست تسک‌های دوشنبه"
	const r1 = new RegExp(`^(?:لیست\\s+|فهرست\\s+)?(?:${dayPattern}\\s+)?${taskNoun}(?:\\s+${dayPattern})?$`, "i");
	if (r1.test(norm)) {
		return { intent: "list", filter: resolvedFilter };
	}

	// 2. "تسکهای امروز رو نشون بده", "یکشنبه کارهام رو نشون بده", "کارهای شنبه رو نشون بده"
	const r2 = new RegExp(`^(?:لیست\\s+|فهرست\\s+)?(?:${dayPattern}\\s+)?(?:${taskNoun})?(?:\\s+${dayPattern})?\\s*(?:رو|را)?\\s*(?:نمایش\\s*بده|نشون\\s*بده|بده|بگو)$`, "i");
	if (r2.test(norm)) {
		return { intent: "list", filter: resolvedFilter };
	}

	// 3. "نشون بده تسکهای امروز رو", "نشون بده تسکهای پس فردا رو", "نشون بده کارهای شنبه رو"
	const r3 = new RegExp(`^(?:نمایش\\s*بده|نشون\\s*بده|بده|بگو)\\s+(?:لیست\\s+|فهرست\\s+)?(?:${dayPattern}\\s+)?(?:${taskNoun})?(?:\\s+${dayPattern})?(?:\\s+(?:رو|را))?$`, "i");
	if (r3.test(norm)) {
		return { intent: "list", filter: resolvedFilter };
	}

	// 4. "کارام چیه؟", "تسک‌هام چیه؟", "تسکهای امروز چیه؟", "تسک‌های دوشنبه چیه؟"
	const r4 = new RegExp(`^(?:لیست\\s+|فهرست\\s+)?(?:${dayPattern}\\s+)?${taskNoun}(?:\\s+${dayPattern})?\\s*(?:چیه|چیست|چندتاست)$`, "i");
	if (r4.test(norm)) {
		return { intent: "list", filter: resolvedFilter };
	}

	// 5. "امروز چه کارایی دارم؟", "فردا چه کارایی دارم؟", "چهارشنبه چه کارایی دارم؟", "سه‌شنبه چه تسک‌هایی دارم؟"
	const r5 = new RegExp(`^${dayPattern}?\\s*(?:چه\\s*(?:کاری|کارای|کارایی|کار\\s*هایی|کارهایی|تسکی|تسکای|تسکایی|تسک\\s*هایی|تسکهایی)|چی\\s*کار|چیکار)\\s*${dayPattern}?\\s*دارم\\??$`, "i");
	if (r5.test(norm)) {
		return { intent: "list", filter: resolvedFilter };
	}

	return null;
}

/**
 * Resolves Persian ordinal word or task number to 1-based index (e.g. اولی -> 1, شماره ۲ -> 2)
 */
export function parseOrdinalIndex(word = "") {
	if (!word || typeof word !== "string") return null;
	let clean = toEnglishDigits(word).trim();
	clean = clean.replace(/^(?:تسک|کار|مورد|ردیف|آیتم)\s+/iu, "").trim();
	clean = clean.replace(/^(?:شماره\s*)/iu, "").trim();

	if (/^(اول|اولی|۱|1)$/i.test(clean)) return 1;
	if (/^(دوم|دومی|۲|2)$/i.test(clean)) return 2;
	if (/^(سوم|سومی|۳|3)$/i.test(clean)) return 3;
	if (/^(چهارم|چهارمی|۴|4)$/i.test(clean)) return 4;
	if (/^(پنجم|پنجمی|۵|5)$/i.test(clean)) return 5;
	if (/^(ششم|ششمی|۶|6)$/i.test(clean)) return 6;
	if (/^(هفتم|هفتمی|۷|7)$/i.test(clean)) return 7;
	if (/^(هشتم|هشتمی|۸|8)$/i.test(clean)) return 8;
	if (/^(نهم|نهمی|۹|9)$/i.test(clean)) return 9;
	if (/^(دهم|دهمی|۱۰|10)$/i.test(clean)) return 10;

	if (/^\d+$/.test(clean)) {
		const num = parseInt(clean, 10);
		if (!isNaN(num) && num >= 1 && num <= 100) {
			return num;
		}
	}
	return null;
}

/**
 * Detects local status change (done / undone)
 */
export function detectLocalStatusIntent(text = "") {
	if (!text || typeof text !== "string") return null;
	const trimmed = stripLeadingGreeting(text);

	// 1. Untick / Undone patterns:
	// "تیک خرید نون رو بردار", "تیک اولی رو بردار", "تیک تسک ۲ رو بردار", "تیک رو از روی خرید نون بردار"
	const untickMatch =
		trimmed.match(/^تیک\s*(?:رو\s*)?(?:از\s*روی\s+)?(?:تسک\s+|کار\s+)?(.+?)\s*(?:رو|را)?\s*(?:بردار|پاک\s*کن|حذف\s*کن|بردارید)$/iu) ||
		trimmed.match(/^(?:(.+?)\s*(?:رو|را)?\s*)تیکش\s*(?:رو|را)?\s*(?:بردار|پاک\s*کن|حذف\s*کن)$/iu);

	if (untickMatch) {
		const raw = (untickMatch[1] || "").replace(/^(تسک|کار|اون تسک|اون)\s*/iu, "").trim();
		const targetIndex = parseOrdinalIndex(raw);
		const cleanedQuery = targetIndex ? null : cleanTargetQuery(raw);
		if (!targetIndex && !cleanedQuery) {
			return null;
		}
		return {
			intent: "undone",
			target_index: targetIndex,
			target_query: targetIndex ? null : (cleanedQuery || null),
		};
	}

	// Colloquial undone:
	// "خرید نون هنوز انجام نشده", "خرید نون انجام نشده", "خرید نون انجام نشد", "خرید نون رو انجام ندادم",
	// "ریاضی رو انجام‌نشده کن", "اولی رو برگردون", "ناقص کن ریاضی", "دوباره فعال کن ریاضی",
	// "خرید شیر رو دوباره به حالت انجام‌نشده برگردون", "خرید شیر رو به حالت انجام نشده برگردون"
	const undoneMatch =
		trimmed.match(/^(?:(.+?)\s*(?:رو|را)?\s*)(?:هنوز\s+)?(?:(?:دوباره\s+)?(?:به\s+حالت\s+)?(?:انجام‌نشده|انجام\s*نشده|ناقص|ناتمام)\s*(?:کن|برگردون|قرار\s*بده)|(?:دوباره\s+)?برگردون(?:\s+(?:به\s+حالت\s+)?(?:انجام‌نشده|انجام\s*نشده|ناقص|ناتمام))?|انجام‌نشده کن|انجام نشده کن|ناقص کن|انجام\s*نشده|انجام\s*نشد|انجام\s*ندادم|دوباره\s*فعال\s*کن|(?<!دوباره\s*)فعال\s*کن)$/iu) ||
		trimmed.match(/^(?:(?:دوباره\s+)?(?:به\s+حالت\s+)?(?:انجام‌نشده|انجام\s*نشده|ناقص|ناتمام)\s*(?:کن|برگردون|قرار\s*بده)|(?:دوباره\s+)?برگردون(?:\s+(?:به\s+حالت\s+)?(?:انجام‌نشده|انجام\s*نشده|ناقص|ناتمام))?|انجام‌نشده کن|انجام نشده کن|ناقص کن|دوباره\s*فعال\s*کن|فعال\s*کن)\s*(?:تسک\s+|کار\s+)?(.+?)(?:\s*(?:رو|را))?$/iu);

	if (undoneMatch) {
		const raw = (undoneMatch[1] || "").replace(/^(تسک|کار|اون تسک|اون)\s*/iu, "").replace(/\s*(رو|را)$/iu, "").trim();
		const targetIndex = parseOrdinalIndex(raw);
		const cleanedQuery = targetIndex ? null : cleanTargetQuery(raw);
		if (!targetIndex && !cleanedQuery) {
			return null;
		}
		return {
			intent: "undone",
			target_index: targetIndex,
			target_query: targetIndex ? null : (cleanedQuery || null),
		};
	}

	// 2. Tick patterns for Done:
	// "تیک بزن فلان", "تیک بزن اولی", "خرید نون رو تیک بزن", "تسک ۲ رو تیک بزن"
	const tickMatch =
		trimmed.match(/^تیک\s*بزن\s*(?:تسک\s*)?(.+?)$/iu) ||
		trimmed.match(/^(?:(.+?)\s*(?:رو|را)?\s*)تیک\s*بزن$/iu) ||
		trimmed.match(/^تیک\s*(?:تسک\s*)?(.+?)\s*(?:رو|را)?\s*بزن$/iu);

	if (tickMatch) {
		const raw = (tickMatch[1] || "").replace(/\s*(رو|را)$/iu, "").replace(/^(تسک|کار|اون تسک|اون)\s*/iu, "").trim();
		const targetIndex = parseOrdinalIndex(raw);
		const cleanedQuery = targetIndex ? null : cleanTargetQuery(raw);
		return {
			intent: "done",
			target_index: targetIndex,
			target_query: targetIndex ? null : (cleanedQuery || null),
		};
	}

	// 3. Done suffix: "فلان کار رو انجام دادم", "ریاضی انجام شد", "ریاضی تموم شد", "ریاضی تمومه", "تسک شماره ۲ رو انجام دادم"
	const doneSuffixMatch = trimmed.match(/^(?:(.+?)\s*(?:رو|را)?\s*)?(انجام دادم|انجام دادمش|تموم کردم|تموم شد|تمومه|انجام شد|حل شد|پاس کردم|تیک زدم)$/iu);
	if (doneSuffixMatch) {
		const raw = (doneSuffixMatch[1] || "").replace(/^(تسک|کار|اون تسک|اون)\s*/iu, "").trim();
		const targetIndex = parseOrdinalIndex(raw);
		const cleanedQuery = targetIndex ? null : cleanTargetQuery(raw);
		if (!targetIndex && !cleanedQuery) {
			return {
				intent: "clarify",
				reply: "دقیقاً مشخص نکردید کدام تسک انجام شده است. لطفاً عنوان یا شماره تسک را بفرمایید.",
			};
		}
		return {
			intent: "done",
			target_index: targetIndex,
			target_query: targetIndex ? null : (cleanedQuery || null),
		};
	}

	// 4. Colloquial past action completions: "واسه اذان بیدار شدم", "برای اذان بیدار شدم", "رفتم دکتر", "دکتر رفتم"
	const pastColloquialMatch =
		trimmed.match(/^(?:واسه|برای)\s+(.+?)\s+(?:بیدار\s*شدم|رفتم|خریدم|انجام\s*دادم|خوندم)$/iu) ||
		trimmed.match(/^(?:رفتم|دیدم|خریدم|گرفتم)\s+(.+?)$/iu);
	if (pastColloquialMatch) {
		const raw = (pastColloquialMatch[1] || "").replace(/\s*(رو|را)$/iu, "").trim();
		const cleanedQuery = cleanTargetQuery(raw);
		return {
			intent: "done",
			target_index: null,
			target_query: cleanedQuery || null,
		};
	}

	// 5. Clitic completion verbs: "خریدمش", "خوندمش", "دادمش", "رفتمش", "انجامش دادم", "تمومش کردم"
	const cliticMatch = trimmed.match(/^(?:(.+?)\s*(?:رو|را)?\s*)?(خریدمش|خوندمش|دادمش|رفتمش|حلش\s*کردم|پاسش\s*کردم|انجامش\s*دادم|انجامش\s*دادمش|تمومش\s*کردم)$/iu);
	if (cliticMatch) {
		const raw = (cliticMatch[1] || "").replace(/^(تسک|کار|اون تسک|اون)\s*/iu, "").trim();
		const targetIndex = parseOrdinalIndex(raw);
		const cleanedQuery = targetIndex ? null : cleanTargetQuery(raw);
		if (!targetIndex && !cleanedQuery) {
			return {
				intent: "clarify",
				reply: "دقیقاً مشخص نکردید کدام تسک انجام شده است. لطفاً عنوان یا شماره تسک را بفرمایید.",
			};
		}
		return {
			intent: "done",
			target_index: targetIndex,
			target_query: targetIndex ? null : (cleanedQuery || null),
		};
	}

	return null;
}

/**
 * Cleans conversational prefixes and suffixes from task titles.
 */
export function cleanTaskTitle(text = "") {
	if (!text || typeof text !== "string") return "";
	let cleaned = text.trim();

	// 1. Remove polite greetings/prefixes at start
	cleaned = cleaned.replace(/^(?:لطفاً|لطفا)\s+/giu, "");

	// 2. Remove leading "من می‌خوام که", "می‌خوام که", "من میخوام", "میخوام"
	cleaned = cleaned.replace(/^(?:من\s*)?(?:می‌خواهم|میخواهم|می‌خوام|میخوام)\s+(?:که\s*)?/giu, "");

	// 3. Remove leading or embedded "یادم باشه که", "یادم بنداز که", "یادت نره که", "یادآوری کن که"
	cleaned = cleaned.replace(/(?:^|\s+)(?:یادم\s*باشه|یادم\s*بنداز|یادت\s*نره|یادآوری\s*کن)\s+(?:که\s*)?/giu, " ");

	// 4. Container pattern (e.g. به لیست کارهام, به لیست تسک‌هام, به لیست, به کارهام, برام, واسم)
	const containerPattern = "(?:(?:به|در|توی)\\s+(?:لیست(?:م|مون)?|فهرست(?:م|مون)?)(?:\\s+(?:کارهام|کارهایم|کارها|کارام|تسک‌هام|تسک‌هایم|تسکام|تسک‌ها))?|(?:به|در|توی)\\s+(?:کارهام|کارهایم|کارها|کارام|تسک‌هام|تسک‌هایم|تسکام|تسک‌ها)|(?:برام|واسم|برای\\s*من|واسه\\s*من|برای\\s*ما|واسه\\s*ما))";
	const addVerbsLeading = "(?:ثبت\\s*کن|اضافه\\s*کن|یادداشت\\s*کن|بنویس(?![\\p{L}\\p{N}])|بساز(?![\\p{L}\\p{N}])|ایجاد\\s*کن|بذار(?![\\p{L}\\p{N}])|قرار\\s*بده)";
	const addVerbsTrailing = "(?:ثبت\\s*کن|اضافه\\s*کن|یادداشت\\s*کن|بنویس(?![\\p{L}\\p{N}])|یادم\\s*بنداز|یادآوری\\s*کن|بساز(?![\\p{L}\\p{N}])|ایجاد\\s*کن|قرار\\s*بده|بذار(?![\\p{L}\\p{N}])|ثبت\\s*کنی|اضافه\\s*کنی|یادداشت\\s*کنی|بنویسی|بذاری|قرار\\s*بدی)";

	cleaned = cleaned.replace(new RegExp("^(?:" + containerPattern + "\\s+)?" + addVerbsLeading + "(?:\\s+" + containerPattern + ")?(?:\\s+(?:یه\\s+)?(?:تسک|کار|وظیفه))?(?:\\s+(?:جدید|به\\s+(?:اسم|نام)))?\\s*", "giu"), "");
	cleaned = cleaned.replace(new RegExp("^" + containerPattern + "\\s+(?:" + addVerbsLeading + "\\s*)?", "giu"), "");

	// 5. Remove "یه تسک جدید به اسم", "یه تسک به اسم", "یه کار به اسم", "تسک جدید به اسم", "تسک جدید"
	cleaned = cleaned.replace(/^(?:یه\s+)?(?:تسک|کار|وظیفه)\s+(?:جدید\s+)?(?:به\s+(?:اسم|نام)\s+|برای\s+|که\s+)?/giu, "");

	// 6. Remove "به اسم ...", "به نام ...", "با عنوان ..."
	cleaned = cleaned.replace(/^(?:به\s+(?:اسم|نام)|با\s+عنوان)\s+/giu, "");

	// 7. Remove boilerplate phrases (only as whole words, avoiding corruption of words like تسکهای)
	cleaned = cleaned.replace(/^(?:یه\s*تسک\s*اضافه\s*کن\s*که|تسک\s*اضافه\s*کن|تسک:|وظیفه:|تسک\s*[\d۰-۹]*\s*[:\s]*|(?:تسک|وظیفه|ثبت)(?:\s+|$))/giu, "");

	// 8. Remove leading "باید"
	cleaned = cleaned.replace(/^باید\s+/giu, "");

	// 9. Remove trailing commands: "ثبت کن", "اضافه کن", "یادداشت کن", "بنویس", "یادم بنداز", "ثبت کنی", "اضافه کنی"
	// Also with "به کارهام اضافه کن", "به لیست اضافه کن", etc.
	cleaned = cleaned.replace(new RegExp("(?:\\s+(?:رو|را))?\\s*(?:" + containerPattern + "\\s+)?" + addVerbsTrailing + "(?:\\s+" + containerPattern + ")?$", "giu"), "");

	// 10. Secondary removal if "به کارهام" remains trailing
	cleaned = cleaned.replace(new RegExp("(?:\\s+|[\u200c\u200b])" + containerPattern + "$", "giu"), "");

	// 11. Remove trailing prepositions/connectors: "برای", "به موعد", "واسه", "تا"
	cleaned = cleaned.replace(/(?:\s+|[\u200c\u200b])(?:برای|به\s*موعد|واسه|تا)$/giu, "");

	// 12. Remove trailing "رو / را" (must be preceded by whitespace or ZWNJ, preserving words like دارو or جارو)
	cleaned = cleaned.replace(/(?:\s+|[\u200c\u200b])(?:رو|را)$/giu, "");

	// 13. Tertiary pass for trailing prepositions in case of "برای رو"
	cleaned = cleaned.replace(/(?:\s+|[\u200c\u200b])(?:برای|به\s*موعد|واسه|تا)$/giu, "");

	// 14. Secondary strip of leading and trailing directive action verbs
	cleaned = cleaned.replace(new RegExp("^(?:" + containerPattern + "\\s+)?" + addVerbsLeading + "(?:\\s+" + containerPattern + ")?(?:\\s+(?:یه\\s+)?(?:تسک|کار|وظیفه))?(?:\\s+(?:جدید|به\\s+(?:اسم|نام)))?\\s*", "giu"), "");
	cleaned = cleaned.replace(new RegExp("(?:\\s+(?:رو|را))?\\s*(?:" + containerPattern + "\\s+)?" + addVerbsTrailing + "(?:\\s+" + containerPattern + ")?$", "giu"), "");
	cleaned = cleaned.replace(/(?:\s+|[\u200c\u200b])(?:برای|به\s*موعد|واسه|تا)$/giu, "");

	// 15. If the remaining title is just "رو" or "را" or pure directive verb, clear it
	const pureDirectiveCheck = /^(?:رو|را|تسک|کار|وظیفه|کارها|تسک‌ها|ثبت|اضافه|یادداشت|ثبت\s*کن|اضافه\s*کن|یادداشت\s*کن|بنویس|بساز|ایجاد\s*کن|بذار|قرار\s*بده|ثبت\s*کنی|اضافه\s*کنی|یادداشت\s*کنی|بنویسی|بذاری|قرار\s*بدی)$/iu;
	if (pureDirectiveCheck.test(cleaned.trim())) {
		cleaned = "";
	}

	return cleaned.replace(/\s+/g, " ").trim();
}

/**
 * Cleans conversational prefixes specifically from target queries in edit/delete intents.
 * Strips words like "موعد", "تاریخ", "زمان", "ساعت", "تسک", "کار" if used as command qualifiers.
 */
export function cleanTargetQuery(text = "") {
	if (!text || typeof text !== "string") return "";
	let cleaned = text.trim();
	// Repeatedly strip leading command qualifiers in any order, including attached clitics (موعدش, تسکش, تاریخش, عنوانش, اسمش)
	cleaned = cleaned.replace(/^(?:(?:موعد|تاریخ|زمان|ساعت|تسک|کار|عنوان|نام|اسم)(?:ش|ها|هام|هایم)?\s*)+/giu, "");
	// Strip conversational status qualifiers if leaked
	cleaned = cleaned.replace(/(?:\s+(?:رو|را))?\s*(?:دوباره\s+)?(?:به\s+حالت\s+)?(?:انجام‌نشده|انجام\s*نشده|ناقص|انجام\s*شده)$/giu, "");
	cleaned = cleaned.replace(/^(?:دوباره\s+)?(?:به\s+حالت\s+)?(?:انجام‌نشده|انجام\s*نشده|ناقص|انجام\s*شده)\s*(?:کن|برگردون)?\s*/giu, "");
	cleaned = cleaned.replace(/\s*(?:رو|را)$/giu, "");
	cleaned = cleanTaskTitle(cleaned);
	if (/^(?:رو|را|ش|اون|این|همون|تسک|کار|یکی|موعد|تاریخ|زمان|ساعت|دوباره|عنوان|نام|اسم)$/iu.test(cleaned)) {
		return "";
	}
	return cleaned;
}

/**
 * Detects local delete intent: single delete or bulk delete
 */
export function detectLocalDeleteIntent(text = "") {
	if (!text || typeof text !== "string") return null;
	const trimmed = stripLeadingGreeting(text);
	const norm = normalizePersianText(trimmed);

	// 1. Bulk Delete Completed: "کارهای انجام شده رو حذف کن", "کارهای انجام شده رو از لیست پاک کن", "تسک‌های تکمیل شده رو پاک کن"
	const bulkDeleteCompletedPattern =
		/^(?:کارهای?|تسک\s*های?|تسکهای?|وظایف)?\s*(?:انجام\s*شده|تکمیل\s*شده|انجام‌شده|تکمیل‌شده)\s*(?:رو|را)?\s*(?:از\s*لیست\s*)?(?:حذف\s*کن|پاک\s*کن|دیلیت\s*کن)$/iu;
	const bulkDeleteCompletedPrefixPattern =
		/^(?:حذف|پاک|دیلیت)\s+(?:کارهای?|تسک\s*های?|تسکهای?|وظایف)?\s*(?:انجام\s*شده|تکمیل\s*شده|انجام‌شده|تکمیل‌شده)(?:\s*(?:از\s*لیست))?(?:\s*(?:رو|را))?$/iu;
	if (bulkDeleteCompletedPattern.test(norm) || bulkDeleteCompletedPrefixPattern.test(norm)) {
		return {
			intent: "bulk_delete_completed_request",
		};
	}

	// 1.5. Bulk Delete Request: "همه تسک‌هام رو پاک کن", "تمام کارام رو حذف کن", "کل تسک‌ها رو دیلیت کن"
	const bulkDeletePattern = /^(?:همه|تمام|کل)\s+(?:تسک\s*هام|تسکام|تسک\s*ها|کارهام|کارام|کارها)\s*(?:رو|را)?\s*(?:حذف\s*کن|پاک\s*کن|دیلیت\s*کن)$/iu;
	const bulkDeletePrefixPattern = /^(?:حذف|پاک|دیلیت)\s+(?:همه|تمام|کل)\s*(?:تسک\s*هام|تسکام|تسک\s*ها|کارهام|کارام|کارها)(?:\s*(?:رو|را))?$/iu;
	if (bulkDeletePattern.test(norm) || bulkDeletePrefixPattern.test(norm)) {
		return {
			intent: "bulk_delete_request",
		};
	}

	// 2. Bulk Delete Confirm: "بله همه را حذف کن", "آره همه رو پاک کن", "تایید حذف همه"
	const bulkConfirmPattern = /^(?:بله|آره|اره)\s*(?:همه\s*(?:رو|را)?\s*)?(?:حذف|پاک|دیلیت)\s*کن$/iu;
	if (bulkConfirmPattern.test(norm) || /^(?:تایید|تأیید)\s*حذف\s*همه$/iu.test(norm)) {
		return {
			intent: "bulk_delete_confirm",
		};
	}

	// 2.5. Bulk Delete Cancel: "نه", "لغو کن", "کنسل کن", "نه لغو کن", "پشیمون شدم", "نه حذف نکن", "لغو", "کنسل"
	const bulkCancelPattern = /^(?:(?:نه|خیر)\s*(?:،|,)?\s*)?(?:لغو\s*کن|کنسل\s*کن|پشیمون\s*شدم|نمی‌خوام|نمیخوام|حذف\s*نکن|پاک\s*نکن|لغو|کنسل)$|^(?:نه|خیر)$/iu;
	if (bulkCancelPattern.test(norm)) {
		return {
			intent: "bulk_delete_cancel",
		};
	}

	// Guard: Do not intercept requests intended to clear due dates ("موعد خرید نان رو حذف کن", "تاریخ تسک رو پاک کن")
	if (/(?:^|\s)(?:موعد|تاریخ|زمان|ساعت)\s+(?:تسک\s+|کار\s+)?(.+?)\s*(?:رو|را)?\s*(?:حذف|پاک|دیلیت|بردار|لغو)/iu.test(trimmed) ||
		/^(?:حذف|پاک|دیلیت|برداشتن|لغو)(?:\s*کردن|\s*کن)?\s+(?:موعد|تاریخ|زمان|ساعت)/iu.test(trimmed) ||
		/(?:موعدش|تاریخش|زمانش|ساعتش)\s*(?:رو|را)?\s*(?:حذف|پاک|دیلیت|بردار|لغو)/iu.test(trimmed) ||
		/بدون\s*(?:موعد|تاریخ|زمان|ساعت)\s*کن/iu.test(trimmed)) {
		return null;
	}

	// 3. Single Delete: "دکتر رو حذف کن", "تسک دکتر رو پاک کن", "اولی رو حذف کن"
	const delMatch = trimmed.match(/^(?:(.+?)\s*(?:رو|را)?\s*)?(حذف کن|پاک کن|دیلیت کن)$/iu) ||
		trimmed.match(/^(?:حذف|پاک|دیلیت)\s*(?:کن)?\s*(?:تسک\s*)?(.+?)$/iu);

	if (delMatch) {
		const raw = (delMatch[1] || "").replace(/^(تسک|کار|اون تسک|اون)\s*/iu, "").trim();
		if (!raw || /^(اون|همون|کار|تسک|تسک‌ها|این)$/iu.test(raw)) {
			return { intent: "clarify", reply: "دقیقاً مشخص نکردید کدام تسک باید حذف شود. لطفاً عنوان یا شماره تسک را بفرمایید." };
		}
		const targetIndex = parseOrdinalIndex(raw);
		return {
			intent: "delete",
			target_index: targetIndex,
			target_query: targetIndex ? null : cleanTaskTitle(raw),
		};
	}

	return null;
}

/**
 * Detects local edit intent: rescheduling date/time, renaming title, or modifying tasks
 */
export function detectLocalEditIntent(text = "", baseDate = new Date()) {
	if (!text || typeof text !== "string") return null;
	const trimmed = stripLeadingGreeting(text);

	if (isExplicitChatMessage(trimmed)) return null;

	// Compound edits modifying both title and time (e.g. "ساعت و عنوان ... رو ببر ۱۲ و بکن آمار") require LLM
	if (/(?:و\s*(?:عنوان|اسم|نام|بکن))/iu.test(trimmed)) {
		return null;
	}

	// Reminders ("یادم بنداز ...", "یادم باشه ...") are Add commands, never Edits
	if (/(?:یادم\s*باشه|یادم\s*بنداز|یادت\s*نره|یادآوری\s*کن)/iu.test(trimmed)) {
		return null;
	}

	// 0. Clear Due Date Pattern: "موعد خرید نان رو حذف کن", "تاریخ تسک خرید نان رو پاک کن", "موعد اولی رو حذف کن"
	const clearDueDateMatch =
		trimmed.match(/^(?:موعد|تاریخ|زمان|ساعت)\s+(?:تسک\s+|کار\s+)?(.+?)\s*(?:رو|را)?\s*(?:حذف\s*کن|پاک\s*کن|دیلیت\s*کن|بردار|لغو\s*کن)$/iu) ||
		trimmed.match(/^(?:حذف|پاک|دیلیت|برداشتن|لغو)(?:\s*کردن|\s*کن)?\s+(?:موعد|تاریخ|زمان|ساعت)\s*(?:تسک\s+|کار\s+)?(.+?)(?:\s*(?:رو|را))?$/iu) ||
		trimmed.match(/^(?:تسک\s+|کار\s+)?(.+?)\s*(?:رو|را)?\s*(?:موعدش|تاریخش|زمانش|ساعتش)\s*(?:رو|را)?\s*(?:حذف\s*کن|پاک\s*کن|دیلیت\s*کن|بردار|لغو\s*کن)$/iu) ||
		trimmed.match(/^(?:تسک\s+|کار\s+)?(.+?)\s*(?:رو|را)?\s*بدون\s*(?:موعد|تاریخ|زمان|ساعت)\s*کن$/iu);

	if (clearDueDateMatch) {
		const rawTarget = cleanTargetQuery(clearDueDateMatch[1]);
		const targetIndex = parseOrdinalIndex(rawTarget);
		if (!rawTarget && !targetIndex) {
			return {
				intent: "clarify",
				reply: "دقیقاً مشخص نکردید موعد کدام تسک حذف شود. لطفاً عنوان یا شماره تسک را بفرمایید.",
			};
		}
		return {
			intent: "edit",
			clearDueDate: true,
			target_index: targetIndex,
			target_query: targetIndex ? null : rawTarget,
			due_date: null,
			isoDueDate: null,
			new_title: null,
			hasDate: false,
			hasTime: false,
			isAmbiguousTime: false,
			ambiguousHour: null,
			needsClarification: false,
			clarificationType: null,
			targetDateStr: null,
			targetYear: null,
			targetMonth: null,
			targetDay: null,
			solarYear: null,
			solarMonth: null,
			solarDay: null,
			isPastDate: false,
			isBeyondOneYear: false,
			isInvalidDate: false,
			invalidDateReason: null,
		};
	}

	// 1. Reschedule pattern A: "تسک پروژه رو بنداز برای فردا ساعت ۱۰" / "تسک پروژه رو بنداز فردا"
	const dropMatch = trimmed.match(/^(?:(?:موعد|تاریخ|زمان|ساعت)\s+)?(?:تسک\s+|کار\s+)?(.+?)\s*(?:رو|را)?\s*(?<!یادم\s*)بنداز\s+(?:برای|به|تا|روی)?\s*(.+)$/iu);
	if (dropMatch) {
		const rawTarget = cleanTargetQuery(dropMatch[1]);
		const rawDate = dropMatch[2].trim();
		const timeInfo = extractPersianDateTime(rawDate, baseDate);
		if (timeInfo.isInvalidTime) {
			return {
				intent: "invalid_time",
				reply: "⚠️ ساعت واردشده نامعتبر است. لطفاً ساعت را بین ۰۰:۰۰ تا ۲۳:۵۹ مشخص کنید.",
			};
		}
		const targetIndex = parseOrdinalIndex(rawTarget);
		if (!rawTarget && !targetIndex) {
			return {
				intent: "clarify",
				reply: "دقیقاً مشخص نکردید موعد کدام تسک تغییر کند. لطفاً عنوان یا شماره تسک را بفرمایید.",
			};
		}
		return {
			intent: "edit",
			target_index: targetIndex,
			target_query: targetIndex ? null : rawTarget,
			due_date: timeInfo.isoDueDate || null,
			isoDueDate: timeInfo.isoDueDate || null,
			new_title: null,
			hasDate: Boolean(timeInfo.hasDate),
			hasTime: Boolean(timeInfo.hasTime),
			isAmbiguousTime: Boolean(timeInfo.isAmbiguousTime),
			ambiguousHour: timeInfo.ambiguousHour !== undefined ? timeInfo.ambiguousHour : null,
			needsClarification: Boolean(timeInfo.needsClarification),
			clarificationType: timeInfo.clarificationType || null,
			targetDateStr: timeInfo.targetDateStr || null,
			targetYear: timeInfo.targetYear !== undefined ? timeInfo.targetYear : null,
			targetMonth: timeInfo.targetMonth !== undefined ? timeInfo.targetMonth : null,
			targetDay: timeInfo.targetDay !== undefined ? timeInfo.targetDay : null,
			solarYear: timeInfo.solarYear !== undefined ? timeInfo.solarYear : null,
			solarMonth: timeInfo.solarMonth !== undefined ? timeInfo.solarMonth : null,
			solarDay: timeInfo.solarDay !== undefined ? timeInfo.solarDay : null,
			isPastDate: Boolean(timeInfo.isPastDate),
			isBeyondOneYear: Boolean(timeInfo.isBeyondOneYear),
			isInvalidDate: Boolean(timeInfo.isInvalidDate),
			invalidDateReason: timeInfo.invalidDateReason || null,
		};
	}

	// 2. Move time pattern: "ساعت درس خوندن رو ببر ۱۲" / "ساعت تسک درس رو ببر برای فردا ۱۰"
	if (!/(?:و\s*(?:عنوان|اسم|نام|بکن))/iu.test(trimmed)) {
		const moveTimeMatch = trimmed.match(/^ساعت\s+(?:تسک\s*)?(.+?)\s*(?:رو|را)?\s*ببر(?![\p{L}\p{N}])\s*(?:به|برای|روی)?\s*(.+)$/iu);
		if (moveTimeMatch) {
			const rawTarget = cleanTargetQuery(moveTimeMatch[1]);
			const rawDate = moveTimeMatch[2].trim();
			const timeInfo = extractPersianDateTime(rawDate.includes("ساعت") ? rawDate : `ساعت ${rawDate}`, baseDate);
			if (timeInfo.isInvalidTime) {
				return {
					intent: "invalid_time",
					reply: "⚠️ ساعت واردشده نامعتبر است. لطفاً ساعت را بین ۰۰:۰۰ تا ۲۳:۵۹ مشخص کنید.",
				};
			}
			const targetIndex = parseOrdinalIndex(rawTarget);
			if (!rawTarget && !targetIndex) {
				return {
					intent: "clarify",
					reply: "دقیقاً مشخص نکردید ساعت کدام تسک تغییر کند. لطفاً عنوان یا شماره تسک را بفرمایید.",
				};
			}
			return {
				intent: "edit",
				target_index: targetIndex,
				target_query: targetIndex ? null : rawTarget,
				due_date: timeInfo.isoDueDate || null,
				isoDueDate: timeInfo.isoDueDate || null,
				new_title: null,
				hasDate: Boolean(timeInfo.hasDate),
				hasTime: Boolean(timeInfo.hasTime),
				isAmbiguousTime: Boolean(timeInfo.isAmbiguousTime),
				ambiguousHour: timeInfo.ambiguousHour !== undefined ? timeInfo.ambiguousHour : null,
				needsClarification: Boolean(timeInfo.needsClarification),
				clarificationType: timeInfo.clarificationType || null,
				targetDateStr: timeInfo.targetDateStr || null,
				targetYear: timeInfo.targetYear !== undefined ? timeInfo.targetYear : null,
				targetMonth: timeInfo.targetMonth !== undefined ? timeInfo.targetMonth : null,
				targetDay: timeInfo.targetDay !== undefined ? timeInfo.targetDay : null,
				solarYear: timeInfo.solarYear !== undefined ? timeInfo.solarYear : null,
				solarMonth: timeInfo.solarMonth !== undefined ? timeInfo.solarMonth : null,
				solarDay: timeInfo.solarDay !== undefined ? timeInfo.solarDay : null,
				isPastDate: Boolean(timeInfo.isPastDate),
				isBeyondOneYear: Boolean(timeInfo.isBeyondOneYear),
				isInvalidDate: Boolean(timeInfo.isInvalidDate),
				invalidDateReason: timeInfo.invalidDateReason || null,
			};
		}
	}

	// 3. Reschedule pattern B:
	// "تسک خرید نون رو برای فردا ساعت ۹ تغییر بده"
	// "موعد خرید نان رو بذار فردا ساعت ۵"
	// "خرید نان رو به فردا موکول کن"
	// "خرید نان رو موکول کن به فردا"
	// "موعد تسک خرید نون رو به فردا ساعت ۱۰ تغییر بده"
	const editPreps = "(?:برای|به|تا|روی)(?![\\p{L}\\p{N}])";
	const editVerbsEnd = "(?:تغییر\\s*بده|عوض\\s*کن|منتقل\\s*کن|ببر(?![\\p{L}\\p{N}])|بذار(?![\\p{L}\\p{N}])|قرار\\s*بده|تنظیم\\s*کن|موکول\\s*کن|عقب\\s*بنداز|جلو\\s*بنداز|تمدید\\s*کن|به\\s*تعویق\\s*بنداز)";
	const editVerbsPrefix = "(?:ببر(?![\\p{L}\\p{N}])|بذار(?![\\p{L}\\p{N}])|قرار\\s*بده|تنظیم\\s*کن|موکول\\s*کن|منتقل\\s*کن|عقب\\s*بنداز|جلو\\s*بنداز|تمدید\\s*کن|به\\s*تعویق\\s*بنداز)";
	const changeDateMatch =
		trimmed.match(new RegExp(`^(?:(?:موعد|تاریخ|زمان|ساعت)\\s+)?(?:تسک\\s+|کار\\s+)?(.+?)\\s*(?:رو|را)?\\s*${editPreps}\\s*(.+?)\\s*${editVerbsEnd}$`, "iu")) ||
		trimmed.match(new RegExp(`^(?:(?:موعد|تاریخ|زمان|ساعت)\\s+)?(?:تسک\\s+|کار\\s+)?(.+?)\\s*(?:رو|را)?\\s*${editVerbsPrefix}\\s*(?:${editPreps})?\\s*(.+)$`, "iu")) ||
		trimmed.match(new RegExp(`^${editPreps}\\s+(.+?)\\s+(?:موعد|تاریخ|زمان)(?:\\s+(?:تسک|کار))?\\s+(.+?)\\s*(?:رو|را)?\\s*${editVerbsEnd}$`, "iu"));

	if (changeDateMatch) {
		let rawTarget;
		let secondPart;
		if (trimmed.startsWith("برای") || trimmed.startsWith("به") || trimmed.startsWith("تا") || trimmed.startsWith("روی")) {
			secondPart = changeDateMatch[1].trim();
			rawTarget = cleanTargetQuery(changeDateMatch[2]);
		} else {
			rawTarget = cleanTargetQuery(changeDateMatch[1]);
			secondPart = changeDateMatch[2].trim();
		}

		const timeInfo = extractPersianDateTime(secondPart, baseDate);

		if (timeInfo.isInvalidTime) {
			return {
				intent: "invalid_time",
				reply: "⚠️ ساعت واردشده نامعتبر است. لطفاً ساعت را بین ۰۰:۰۰ تا ۲۳:۵۹ مشخص کنید.",
			};
		}

		const targetIndex = parseOrdinalIndex(rawTarget);
		if (!rawTarget && !targetIndex) {
			return {
				intent: "clarify",
				reply: "دقیقاً مشخص نکردید موعد کدام تسک تغییر کند. لطفاً عنوان یا شماره تسک را بفرمایید.",
			};
		}

		if (timeInfo.hasDate || timeInfo.isInvalidDate || timeInfo.isPastDate || timeInfo.isBeyondOneYear) {
			return {
				intent: "edit",
				target_index: targetIndex,
				target_query: targetIndex ? null : rawTarget,
				due_date: timeInfo.isoDueDate || null,
				isoDueDate: timeInfo.isoDueDate || null,
				new_title: null,
				hasDate: Boolean(timeInfo.hasDate),
				hasTime: Boolean(timeInfo.hasTime),
				isAmbiguousTime: Boolean(timeInfo.isAmbiguousTime),
				ambiguousHour: timeInfo.ambiguousHour !== undefined ? timeInfo.ambiguousHour : null,
				needsClarification: Boolean(timeInfo.needsClarification),
				clarificationType: timeInfo.clarificationType || null,
				targetDateStr: timeInfo.targetDateStr || null,
				targetYear: timeInfo.targetYear !== undefined ? timeInfo.targetYear : null,
				targetMonth: timeInfo.targetMonth !== undefined ? timeInfo.targetMonth : null,
				targetDay: timeInfo.targetDay !== undefined ? timeInfo.targetDay : null,
				solarYear: timeInfo.solarYear !== undefined ? timeInfo.solarYear : null,
				solarMonth: timeInfo.solarMonth !== undefined ? timeInfo.solarMonth : null,
				solarDay: timeInfo.solarDay !== undefined ? timeInfo.solarDay : null,
				isPastDate: Boolean(timeInfo.isPastDate),
				isBeyondOneYear: Boolean(timeInfo.isBeyondOneYear),
				isInvalidDate: Boolean(timeInfo.isInvalidDate),
				invalidDateReason: timeInfo.invalidDateReason || null,
			};
		} else if (/(?:موعد|تاریخ|زمان|ساعت)/iu.test(trimmed)) {
			return {
				intent: "clarify",
				reply: "تاریخ یا زمان جدید برای ویرایش تسک مشخص نشده است. لطفاً زمان جدید را مشخص کنید.",
			};
		}
	}

	// 4. Rename pattern: "تسک خرید نون رو به خرید نون و شیر تغییر نام بده" / "نام تسک فلان رو به بهمان تغییر بده" / "عنوان فلان رو به بهمان تغییر بده"
	const renameMatch =
		trimmed.match(/^(?:نام|اسم|عنوان)\s+(?:تسک\s+|کار\s+)?(.+?)\s*(?:رو|را)?\s*(?:به|رو\s*به)\s*(.+?)\s*(?:تغییر\s*(?:نام\s*)?بده|تغییر\s*نام|عوض\s*کن|بکن|بذار|قرار\s*بده|تغییر\s*بده)$/iu) ||
		trimmed.match(/^(?:تسک\s+|کار\s+)?(.+?)\s*(?:رو|را)?\s*(?:به|رو\s*به)\s*(.+?)\s*(?:تغییر\s*نام\s*بده|تغییر\s*نام|عوض\s*کن|تغییر\s*بده)$/iu);
	if (renameMatch) {
		const rawTarget = cleanTargetQuery(renameMatch[1]);
		const newTitle = cleanTaskTitle(renameMatch[2]);
		const targetIndex = parseOrdinalIndex(rawTarget);
		if (!rawTarget && !targetIndex) {
			return {
				intent: "clarify",
				reply: "دقیقاً مشخص نکردید کدام تسک تغییر نام پیدا کند. لطفاً عنوان یا شماره تسک را بفرمایید.",
			};
		}
		return {
			intent: "edit",
			target_index: targetIndex,
			target_query: targetIndex ? null : rawTarget,
			due_date: undefined,
			isoDueDate: undefined,
			new_title: newTitle,
			hasDate: false,
			hasTime: false,
			isAmbiguousTime: false,
			ambiguousHour: null,
			needsClarification: false,
			clarificationType: null,
			targetDateStr: null,
			targetYear: null,
			targetMonth: null,
			targetDay: null,
			solarYear: null,
			solarMonth: null,
			solarDay: null,
			isPastDate: false,
			isBeyondOneYear: false,
			isInvalidDate: false,
			invalidDateReason: null,
		};
	}

	return null;
}

const SPONTANEOUS_ROUTINE_REGEX = new RegExp(
	[
		// Ingestion / physiological bodily urges
		"(?:آب|غذا|ناهار|شام|صبحانه|چای|قهوه|میوه|خوراکی|شیرینی|ساندویچ|تنقلات)\\s+(?:بخورم|بخوریم|بنوشم|بزنیم|بخور)",
		"(?:خوابیدن|بخوابم|بخوابیم|چرت\\s*بزنم|استراحت\\s*کنم|دراز\\s*بکشم)",
		"(?:دستشویی|توالت|سرویس\\s*بهداشتی|حمام|حموم|دوش|وضو)(?:\\s+(?:برم|بروم|بگیرم))?",
		// Phone / device charging routine
		"(?:گوشی|گوشیم|موبایل|موبایلم|تلفن|تبلت|لپ‌تاپ|لپتاپ|هدفون|پاوربانک)?(?:\\s*(?:رو|را))?\\s*(?:بزنم|بگذارم|بذارم|متصل\\s*کنم)?\\s*(?:به|توی?|در)?\\s*شارژ(?:\\s*(?:بزنم|بذارم|بگذارم|وصل\\s*کنم))?",
		"(?:بزنم|بذارم)\\s+به\\s*شارژ",
		// Casual momentary urges
		"(?:تلویزیون|فیلم|سریال)\\s+(?:ببینم|نگاه\\s*کنم)",
		"(?:سیگار|قلیون)\\s+(?:بکشم)",
		"(?:اینستا|اینستاگرام|توییتر|تلگرام|یوتیوب)\\s+(?:بچرخم|چک\\s*کنم)",
	].join("|"),
	"iu"
);

const PLANNABLE_DOMAIN_REGEX = new RegExp(
	[
		// Education & learning
		"درس|مطالعه|امتحان|کنکور|تست|کتاب|دانشگاه|مدرسه|کلاس|تکلیف|تکالیف|مقاله|جزوه|پایان‌نامه|تحقیق|سمینار",
		// Work & meetings
		"جلسه|میتینگ|تماس|زنگ|قرار|پروژه|قرارداد|فاکتور|گزارش|نامه|ایمیل|ارسال|تحویل|پیگیری|هماهنگی|کد|برنامه‌نویسی|وظیفه",
		// Health & appointments
		"دکتر|پزشک|دندانپزشک|داروخانه|آزمایشگاه|ویزیت|فیزیوتراپی|کلینیک|بیمارستان|دارو",
		// Fitness & skills
		"تمرین|ورزش|باشگاه|دویدن|شنا|ساز|موسیقی|گیتار|پیانو|زبان",
		// Errands & shopping
		"خرید|خریدن|بخرم|بخریم|خریداری|نان|بانک|پرداخت|بپردازم|واریز|قبض|قسط|اجاره|بیمه|اداره|تعمیر|سرویس|ثبت\\s*نام",
	].join("|"),
	"iu"
);

/**
 * Detects conversational task creation without Gemini
 */
export function detectLocalAddIntent(text = "", baseDate = new Date()) {
	if (!text || typeof text !== "string") return null;
	const trimmed = stripLeadingGreeting(text);

	// Guard against chat & questions
	if (isExplicitChatMessage(trimmed)) {
		return null;
	}

	// Guard against list/inquiry commands and questions (MUST NEVER BE AN ADD)
	if (/(?:نشون بده|نمایش بده|بده ببینم|چی\s*دارم|چیکار دارم|چه\s*کاری\s*دارم|چه\s*تسکی\s*دارم|چیه|چیست|چندتاست|تعطیل|تعطیله|تعطیل\s*است|مناسبت)/iu.test(trimmed)) {
		return null;
	}
	if (/(?:^|\s)(?:لیست|فهرست)(?:\s+|$)/iu.test(trimmed) && !/(?:اضافه|ثبت|بنویس|یادداشت|بذار|قرار)/iu.test(trimmed)) {
		return null;
	}
	if (/^(?:کارهای?|کارای|تسک\s*های?|تسکهای?|وظایف)(?:\s+|$)/iu.test(trimmed) && !/(?:اضافه|ثبت|بنویس|یادداشت|بذار|قرار|یادم|می‌خوام|میخوام|باید)/iu.test(trimmed)) {
		return null;
	}

	// Guard against question marks unless explicitly an add command
	if (/[؟?]\s*$/iu.test(trimmed) && !/(?:ثبت\s*کن|اضافه\s*کن|یادداشت\s*کن|بنویس)/iu.test(trimmed)) {
		return null;
	}

	// Guard against edit intents (MUST NEVER BE TREATED AS ADD)
	if (!/(?:یادم\s*باشه|یادم\s*بنداز|یادت\s*نره|یادآوری\s*کن)/iu.test(trimmed)) {
		if (/(?:(?<!یادم\s*)بنداز|تغییر\s*بده|تغییر\s*نام|عوض\s*کن|ساعت.*ببر(?![\p{L}\p{N}])|ویرایش\s*کن|موکول\s*کن|منتقل\s*کن|عقب\s*بنداز|جلو\s*بنداز|تمدید\s*کن|به\s*تعویق|بدون\s*موعد|حذف\s*موعد|پاک\s*کردن\s*موعد|موعدش|تاریخش|زمانش|ساعتش)/iu.test(trimmed)) {
			return null;
		}
		if (/(?:موعد|تاریخ|زمان)\s+.*(?:بذار|قرار\s*بده|تنظیم\s*کن|عوض|تغییر|حذف|پاک|بردار)/iu.test(trimmed)) {
			return null;
		}
	}

	// Guard against status changes (done / undone)
	if (/(?:تیک\s*بزن|تیک.*بردار|انجام\s*دادم|تموم\s*کردم|انجام\s*شد|تموم\s*شد|تمومه|حل\s*شد|انجام\s*نشده|ناقص\s*کن|برگردون)/iu.test(trimmed)) {
		return null;
	}

	// Guard against bulk delete
	if (/(?:همه|تمام|کل)\s*(?:تسک|کار)/iu.test(trimmed)) {
		return null;
	}

	// Guard against conversational/inquisitive "میخوام بدونم...", "میخوام بپرسم..."
	if (/(?:می‌خواهم|میخواهم|می‌خوام|میخوام)\s+(?:بدونم|بپرسم|ببینم|نظرت|یک\s*چیزی|یه\s*چیزی|بگی)/iu.test(trimmed)) {
		return null;
	}

	// -------------------------------------------------------------------------
	// Explicit Named Task structure with date:
	// e.g. "یه تسک به اسم تست نیمه شب برای ساعت ۰۰:۰۰ ثبت کن"
	// e.g. "یه تسک به اسم تست دیروز برای دیروز ثبت کن"
	// -------------------------------------------------------------------------
	const explicitNamedWithDateMatch = trimmed.match(
		/^(?:ثبت\s*کن|اضافه\s*کن|یادداشت\s*کن|بنویس|لطفاً\s*|لطفا\s*)?(?:یه\s+)?(?:تسک|کار|وظیفه)?\s*(?:جدید\s+)?(?:به\s+(?:اسم|نام)|با\s+عنوان)\s+(.+?)\s+(?:برای|به\s*موعد|واسه|تا)\s+(.+?)(?:\s*(?:رو|را)?\s*(?:ثبت\s*کن|اضافه\s*کن|یادداشت\s*کن|بنویس))?$/iu
	);
	if (explicitNamedWithDateMatch) {
		const rawTitle = cleanTaskTitle(explicitNamedWithDateMatch[1]);
		const rawDate = explicitNamedWithDateMatch[2].trim();
		const dateInfo = extractPersianDateTime(rawDate, baseDate);
		if (dateInfo.isInvalidTime) {
			return {
				intent: "invalid_time",
				reply: "⚠️ ساعت واردشده نامعتبر است. لطفاً ساعت را بین ۰۰:۰۰ تا ۲۳:۵۹ مشخص کنید.",
			};
		}
		if (rawTitle && rawTitle.length >= 2) {
			return {
				intent: "add",
				title: rawTitle,
				due_date: dateInfo.hasDate ? dateInfo.isoDueDate : null,
				isoDueDate: dateInfo.isoDueDate || null,
				hasDate: Boolean(dateInfo.hasDate),
				hasTime: Boolean(dateInfo.hasTime),
				isAmbiguousTime: Boolean(dateInfo.isAmbiguousTime),
				ambiguousHour: dateInfo.ambiguousHour !== undefined ? dateInfo.ambiguousHour : null,
				needsClarification: Boolean(dateInfo.needsClarification),
				clarificationType: dateInfo.clarificationType || null,
				targetDateStr: dateInfo.targetDateStr || null,
				targetYear: dateInfo.targetYear !== undefined ? dateInfo.targetYear : null,
				targetMonth: dateInfo.targetMonth !== undefined ? dateInfo.targetMonth : null,
				targetDay: dateInfo.targetDay !== undefined ? dateInfo.targetDay : null,
				solarYear: dateInfo.solarYear !== undefined ? dateInfo.solarYear : null,
				solarMonth: dateInfo.solarMonth !== undefined ? dateInfo.solarMonth : null,
				solarDay: dateInfo.solarDay !== undefined ? dateInfo.solarDay : null,
				isPastDate: Boolean(dateInfo.isPastDate),
				isBeyondOneYear: Boolean(dateInfo.isBeyondOneYear),
				isInvalidDate: Boolean(dateInfo.isInvalidDate),
				invalidDateReason: dateInfo.invalidDateReason || null,
			};
		}
	}

	// -------------------------------------------------------------------------
	// Explicit Named Task structure without date:
	// e.g. "یه تسک به اسم خرید نون ثبت کن"
	// e.g. "یه تسک به اسم تست دیروز ثبت کن"
	// -------------------------------------------------------------------------
	const explicitNamedOnlyMatch = trimmed.match(
		/^(?:ثبت\s*کن|اضافه\s*کن|یادداشت\s*کن|بنویس|لطفاً\s*|لطفا\s*)?(?:یه\s+)?(?:تسک|کار|وظیفه)?\s*(?:جدید\s+)?(?:به\s+(?:اسم|نام)|با\s+عنوان)\s+(.+?)(?:\s*(?:رو|را)?\s*(?:ثبت\s*کن|اضافه\s*کن|یادداشت\s*کن|بنویس))?$/iu
	);
	if (explicitNamedOnlyMatch) {
		const rawTitle = cleanTaskTitle(explicitNamedOnlyMatch[1]);
		if (rawTitle && rawTitle.length >= 2 && !/^(تسک|کار|وظیفه)$/iu.test(rawTitle)) {
			return {
				intent: "add",
				title: rawTitle,
				due_date: null,
				isoDueDate: null,
				hasDate: false,
				hasTime: false,
				isAmbiguousTime: false,
				ambiguousHour: null,
				needsClarification: false,
				clarificationType: null,
				targetDateStr: null,
				targetYear: null,
				targetMonth: null,
				targetDay: null,
				solarYear: null,
				solarMonth: null,
				solarDay: null,
				isPastDate: false,
				isBeyondOneYear: false,
				isInvalidDate: false,
				invalidDateReason: null,
			};
		}
	}

	// 0. Guard against dangling trailing connectors/prepositions (e.g. "یه تسک اضافه کن برای", "تسک برای")
	const INCOMPLETE_TRAILING_REGEX = /(?:^|[\s\u200c\u200b])(?:برای|به|واسه|تا|در|توی|با|از|روی|که|جهت|درباره)$/iu;
	if (INCOMPLETE_TRAILING_REGEX.test(trimmed)) {
		return {
			intent: "clarify",
			reply: "عنوان تسک ناقص است. لطفاً کاری که می‌خواهید انجام دهید را کامل بفرمایید.",
		};
	}

	// Extract Persian date & time FIRST to check for invalid time
	const timeInfo = extractPersianDateTime(trimmed, baseDate);
	if (timeInfo.isInvalidTime) {
		return {
			intent: "invalid_time",
			reply: "⚠️ ساعت واردشده نامعتبر است. لطفاً ساعت را بین ۰۰:۰۰ تا ۲۳:۵۹ مشخص کنید.",
		};
	}

	// 1. Explicit task directive or reminder (e.g. "یادم بنداز ...", "ثبت کن ...", "به کارهام اضافه کن ...")
	const hasExplicitDirective =
		/(?:^|\s)(?:یادم\s*باشه|یادم\s*بنداز|یادت\s*نره|یادآوری\s*کن)(?:$|[\s\p{P}])/iu.test(trimmed) ||
		/(?:یادم\s*بنداز|یادآوری\s*کن)$/iu.test(trimmed) ||
		/^(?:ثبت\s*کن|اضافه\s*کن|یادداشت\s*کن|بنویس|بساز|ایجاد\s*کن|یه\s+تسک|یه\s+کار|وظیفه)(?:\s+|$)/iu.test(trimmed) ||
		/^(?:به|در|توی)\s+(?:لیست|فهرست|کارهام|کارهایم|کارام|کارها|تسک‌هام|تسک‌هایم|تسکام|تسک‌ها)/iu.test(trimmed) ||
		/(?:اضافه\s*کن|ثبت\s*کن|یادداشت\s*کن|بنویس|ثبت\s*کنی|اضافه\s*کنی|یادداشت\s*کنی|بنویسی)$/iu.test(trimmed);

	// 2. Scheduled date or time present
	const hasSchedule = Boolean(timeInfo.hasDate || timeInfo.isInvalidDate || timeInfo.isPastDate || timeInfo.isBeyondOneYear);

	let isCandidate = false;

	if (hasExplicitDirective || hasSchedule) {
		isCandidate = true;
	} else {
		// Bare statement without date or explicit directive:
		// 1. Spontaneous routine or physiological urges MUST NOT be added
		if (SPONTANEOUS_ROUTINE_REGEX.test(trimmed)) {
			return null;
		}

		// 2. Positive check for intention/obligation towards a plannable domain
		const hasIntention = /(?:می‌خواهم|میخواهم|می‌خوام|میخوام|باید|بایستی|قراره|قرار\s*هست)/iu.test(trimmed);
		if (hasIntention && PLANNABLE_DOMAIN_REGEX.test(trimmed)) {
			isCandidate = true;
		}
	}

	if (!isCandidate) {
		return null;
	}

	// Clean title using cleanTaskTitle
	const rawTitle = (timeInfo.hasDate || timeInfo.isInvalidDate || timeInfo.isPastDate || timeInfo.isBeyondOneYear || timeInfo.hasTime)
		? timeInfo.cleanedText
		: trimmed;
	const cleanTitle = cleanTaskTitle(rawTitle);

	const PURE_DIRECTIVE_REGEX = /^(?:تسک|کار|وظیفه|کارها|کارهای?|کارای|تسک‌ها|تسک\s*های?|تسکهای?|های|ها|ثبت|اضافه|یادداشت|ثبت\s*کن|اضافه\s*کن|یادداشت\s*کن|بنویس|بساز|ایجاد\s*کن|بذار|قرار\s*بده|ثبت\s*کنی|اضافه\s*کنی|یادداشت\s*کنی|بنویسی|بذاری|قرار\s*بدی)$/iu;

	if (hasExplicitDirective && (!cleanTitle || cleanTitle.length < 2 || PURE_DIRECTIVE_REGEX.test(cleanTitle) || INCOMPLETE_TRAILING_REGEX.test(rawTitle))) {
		return {
			intent: "clarify",
			reply: "عنوان تسک مشخص نیست. لطفاً کاری که می‌خواید انجام بدید رو بنویسید.",
		};
	}

	if (!cleanTitle || cleanTitle.length < 2 || /^(تسک|کار|وظیفه|کارها|کارهای?|کارای|تسک‌ها|تسک\s*های?|تسکهای?|های|ها)$/iu.test(cleanTitle) || PURE_DIRECTIVE_REGEX.test(cleanTitle)) {
		return null;
	}

	// Guard against adjective/state phrases that might have been left over
	if (/^(?:تعطیل|تعطیله|بارونی|بارانی|آفتابی|سرد|گرم|خوب|بد)$/iu.test(cleanTitle)) {
		return null;
	}

	return {
		intent: "add",
		title: cleanTitle,
		due_date: timeInfo.isoDueDate || null,
		isoDueDate: timeInfo.isoDueDate || null,
		hasDate: Boolean(timeInfo.hasDate),
		hasTime: Boolean(timeInfo.hasTime),
		isAmbiguousTime: Boolean(timeInfo.isAmbiguousTime),
		ambiguousHour: timeInfo.ambiguousHour !== undefined ? timeInfo.ambiguousHour : null,
		needsClarification: Boolean(timeInfo.needsClarification),
		clarificationType: timeInfo.clarificationType || null,
		targetDateStr: timeInfo.targetDateStr || null,
		targetYear: timeInfo.targetYear !== undefined ? timeInfo.targetYear : null,
		targetMonth: timeInfo.targetMonth !== undefined ? timeInfo.targetMonth : null,
		targetDay: timeInfo.targetDay !== undefined ? timeInfo.targetDay : null,
		solarYear: timeInfo.solarYear !== undefined ? timeInfo.solarYear : null,
		solarMonth: timeInfo.solarMonth !== undefined ? timeInfo.solarMonth : null,
		solarDay: timeInfo.solarDay !== undefined ? timeInfo.solarDay : null,
		isPastDate: Boolean(timeInfo.isPastDate),
		isBeyondOneYear: Boolean(timeInfo.isBeyondOneYear),
		isInvalidDate: Boolean(timeInfo.isInvalidDate),
		invalidDateReason: timeInfo.invalidDateReason || null,
	};
}

/**
 * Main Local Dispatcher
 * Evaluates text locally and returns structured action or null (if LLM is needed).
 */
export function dispatchLocalAction(text = "", baseDate = new Date()) {
	if (!text || typeof text !== "string") return null;
	const trimmed = text.trim();
	if (!trimmed) return null;

	// 1. List tasks (takes priority even if preceded by greeting)
	const listMatch = detectLocalListIntent(trimmed, baseDate);
	if (listMatch) {
		return {
			isLocal: true,
			intent: "list",
			filter: listMatch.filter,
		};
	}

	// 2. Status changes (done / undone)
	const statusMatch = detectLocalStatusIntent(trimmed);
	if (statusMatch) {
		return {
			isLocal: true,
			intent: statusMatch.intent,
			target_index: statusMatch.target_index,
			target_query: statusMatch.target_query,
			reply: statusMatch.reply,
		};
	}

	// 3. Delete task (Bulk or single)
	const delMatch = detectLocalDeleteIntent(trimmed);
	if (delMatch) {
		return {
			isLocal: true,
			intent: delMatch.intent,
			target_index: delMatch.target_index,
			target_query: delMatch.target_query,
			reply: delMatch.reply,
		};
	}

	// 4. Edit task
	const editMatch = detectLocalEditIntent(trimmed, baseDate);
	if (editMatch) {
		return {
			isLocal: true,
			intent: editMatch.intent,
			target_index: editMatch.target_index,
			target_query: editMatch.target_query,
			due_date: editMatch.due_date !== undefined ? editMatch.due_date : undefined,
			isoDueDate: editMatch.isoDueDate !== undefined ? editMatch.isoDueDate : (editMatch.due_date !== undefined ? editMatch.due_date : undefined),
			new_title: editMatch.new_title,
			clearDueDate: editMatch.clearDueDate || false,
			reply: editMatch.reply,
			hasDate: Boolean(editMatch.hasDate),
			hasTime: Boolean(editMatch.hasTime),
			isAmbiguousTime: Boolean(editMatch.isAmbiguousTime),
			ambiguousHour: editMatch.ambiguousHour !== undefined ? editMatch.ambiguousHour : null,
			needsClarification: Boolean(editMatch.needsClarification),
			clarificationType: editMatch.clarificationType || null,
			targetDateStr: editMatch.targetDateStr || null,
			targetYear: editMatch.targetYear !== undefined ? editMatch.targetYear : null,
			targetMonth: editMatch.targetMonth !== undefined ? editMatch.targetMonth : null,
			targetDay: editMatch.targetDay !== undefined ? editMatch.targetDay : null,
			solarYear: editMatch.solarYear !== undefined ? editMatch.solarYear : null,
			solarMonth: editMatch.solarMonth !== undefined ? editMatch.solarMonth : null,
			solarDay: editMatch.solarDay !== undefined ? editMatch.solarDay : null,
			isPastDate: Boolean(editMatch.isPastDate),
			isBeyondOneYear: Boolean(editMatch.isBeyondOneYear),
			isInvalidDate: Boolean(editMatch.isInvalidDate),
			invalidDateReason: editMatch.invalidDateReason || null,
		};
	}

	// 5. Add task
	const addMatch = detectLocalAddIntent(trimmed, baseDate);
	if (addMatch) {
		if (addMatch.intent === "clarify") {
			return {
				isLocal: true,
				intent: "clarify",
				reply: addMatch.reply,
			};
		}
		return {
			isLocal: true,
			intent: addMatch.intent,
			title: addMatch.title,
			due_date: addMatch.due_date,
			isoDueDate: addMatch.isoDueDate !== undefined ? addMatch.isoDueDate : (addMatch.due_date || null),
			hasDate: Boolean(addMatch.hasDate),
			hasTime: Boolean(addMatch.hasTime),
			isAmbiguousTime: Boolean(addMatch.isAmbiguousTime),
			ambiguousHour: addMatch.ambiguousHour !== undefined ? addMatch.ambiguousHour : null,
			needsClarification: Boolean(addMatch.needsClarification),
			clarificationType: addMatch.clarificationType || null,
			targetDateStr: addMatch.targetDateStr || null,
			targetYear: addMatch.targetYear !== undefined ? addMatch.targetYear : null,
			targetMonth: addMatch.targetMonth !== undefined ? addMatch.targetMonth : null,
			targetDay: addMatch.targetDay !== undefined ? addMatch.targetDay : null,
			solarYear: addMatch.solarYear !== undefined ? addMatch.solarYear : null,
			solarMonth: addMatch.solarMonth !== undefined ? addMatch.solarMonth : null,
			solarDay: addMatch.solarDay !== undefined ? addMatch.solarDay : null,
			isPastDate: Boolean(addMatch.isPastDate),
			isBeyondOneYear: Boolean(addMatch.isBeyondOneYear),
			isInvalidDate: Boolean(addMatch.isInvalidDate),
			invalidDateReason: addMatch.invalidDateReason || null,
			reply: addMatch.reply,
		};
	}

	// 6. Explicit chat only if no action matched!
	if (isExplicitChatMessage(trimmed)) {
		return {
			isLocal: true,
			intent: "chat",
			reply: "سلام! من هرمس مینی هستم 🚀 کارهای روزانه‌تان را به زبان عادی برام بفرستید تا سریع و مطمئن ثبت کنم.",
		};
	}

	// No local deterministic pattern matched -> escalate to Gemini
	return null;
}
