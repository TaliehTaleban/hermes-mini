/**
 * Hermes Mini - Date & Time Utilities
 * Timezone: Asia/Tehran (UTC+3:30 / IRST)
 */

export const TIMEZONE = "Asia/Tehran";
export const TEHRAN_OFFSET = "+03:30";

/**
 * Solar Hijri (Jalali) Month Names and 1-based Month Indices
 */
export const SOLAR_MONTH_NAMES = {
	"فروردین": 1,
	"اردیبهشت": 2,
	"خرداد": 3,
	"تیر": 4,
	"مرداد": 5,
	"شهریور": 6,
	"مهر": 7,
	"آبان": 8,
	"آذر": 9,
	"دی": 10,
	"بهمن": 11,
	"اسفند": 12,
};

/**
 * Persian Day Words to Day Numbers (1..31)
 */
export const PERSIAN_DAY_WORDS = {
	"اول": 1, "یکم": 1, "دوم": 2, "سوم": 3, "چهارم": 4, "پنجم": 5, "ششم": 6,
	"هفتم": 7, "هشتم": 8, "نهم": 9, "دهم": 10, "یازدهم": 11, "دوازدهم": 12,
	"سیزدهم": 13, "چهاردهم": 14, "پانزدهم": 15, "پونزدهم": 15, "شانزدهم": 16, "هفدهم": 17,
	"هجدهم": 18, "نوزدهم": 19, "بیستم": 20, "بیست و یکم": 21, "بیست و دوم": 22,
	"بیست و سوم": 23, "بیست و چهارم": 24, "بیست و پنجم": 25, "بیست و ششم": 26,
	"بیست و هفتم": 27, "بیست و هشتم": 28, "بیست و نهم": 29, "سی ام": 30, "سی‌ام": 30,
	"سی و یکم": 31,
};

/**
 * Persian Number Words for Relative Offsets
 */
export const PERSIAN_NUMBER_WORDS = {
	"یک": 1, "یه": 1, "دو": 2, "سه": 3, "چهار": 4, "پنج": 5, "شش": 6, "شیش": 6,
	"هفت": 7, "هشت": 8, "نه": 9, "ده": 10, "یازده": 11, "دوازده": 12, "سیزده": 13,
	"چهارده": 14, "پانزده": 15, "پونزده": 15, "شانزده": 16, "هفده": 17, "هجده": 18,
	"نوزده": 19, "بیست": 20, "بیست و پنج": 25, "سی": 30,
};

/**
 * Converts Jalali (Solar Hijri) date to Gregorian date.
 * Mathematically verified against Intl.DateTimeFormat('en-US-u-ca-persian') with 0 mismatches.
 * @param {number} jy Jalali year (e.g. 1405)
 * @param {number} jm Jalali month (1..12)
 * @param {number} jd Jalali day (1..31)
 * @returns {{ gy: number, gm: number, gd: number }}
 */
export function jalaliToGregorian(jy, jm, jd) {
	let gy, gm, gd, days;
	jy += 1595;
	days = -355668 + (365 * jy) + Math.floor(jy / 33) * 8 + Math.floor(((jy % 33) + 3) / 4) + jd + ((jm < 7) ? (jm - 1) * 31 : ((jm - 7) * 30) + 186);
	gy = 400 * Math.floor(days / 146097);
	days %= 146097;
	if (days > 36524) {
		gy += 100 * Math.floor(--days / 36524);
		days %= 36524;
		if (days >= 365) days++;
	}
	gy += 4 * Math.floor(days / 1461);
	days %= 1461;
	if (days > 365) {
		gy += Math.floor((days - 1) / 365);
		days = (days - 1) % 365;
	}
	gd = days + 1;
	const sal_m = [0, 31, ((gy % 4 === 0 && gy % 100 !== 0) || (gy % 400 === 0)) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
	for (gm = 1; gm <= 12; gm++) {
		const v = sal_m[gm];
		if (gd <= v) break;
		gd -= v;
	}
	return { gy, gm, gd };
}

/**
 * Converts Gregorian date to Jalali (Solar Hijri) date.
 * Mathematically verified against Intl.DateTimeFormat('en-US-u-ca-persian') with 0 mismatches.
 * @param {number} gy Gregorian year (e.g. 2026)
 * @param {number} gm Gregorian month (1..12)
 * @param {number} gd Gregorian day (1..31)
 * @returns {{ jy: number, jm: number, jd: number }}
 */
export function gregorianToJalali(gy, gm, gd) {
	let g_d_m = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
	let jy;
	if (gy > 1600) {
		jy = 979;
		gy -= 1600;
	} else {
		jy = 0;
		gy -= 621;
	}
	let gy2 = (gm > 2) ? (gy + 1) : gy;
	let days = (365 * gy) + Math.floor((gy2 + 3) / 4) - Math.floor((gy2 + 99) / 100) + Math.floor((gy2 + 399) / 400) - 80 + gd + g_d_m[gm - 1];
	jy += 33 * Math.floor(days / 12053);
	days %= 12053;
	jy += 4 * Math.floor(days / 1461);
	days %= 1461;
	if (days > 365) {
		jy += Math.floor((days - 1) / 365);
		days = (days - 1) % 365;
	}
	let jm, jd;
	if (days < 186) {
		jm = 1 + Math.floor(days / 31);
		jd = 1 + (days % 31);
	} else {
		jm = 7 + Math.floor((days - 186) / 30);
		jd = 1 + ((days - 186) % 30);
	}
	return { jy, jm, jd };
}

/**
 * Checks if a Jalali year is a leap year (366 days).
 * Handles the 33-year cycle and the 5-year break (e.g. 1395, 1399, 1403, 1408).
 * @param {number} jy Jalali year
 * @returns {boolean}
 */
export function isLeapJalaliYear(jy) {
	const g30 = jalaliToGregorian(jy, 12, 30);
	const gNext = jalaliToGregorian(jy + 1, 1, 1);
	const d1 = new Date(Date.UTC(g30.gy, g30.gm - 1, g30.gd));
	const d2 = new Date(Date.UTC(gNext.gy, gNext.gm - 1, gNext.gd));
	return Math.round((d2 - d1) / (1000 * 60 * 60 * 24)) === 1;
}

/**
 * Returns number of days in a given Jalali month (31, 30, 29, or 30).
 * @param {number} jy Jalali year
 * @param {number} jm Jalali month (1..12)
 * @returns {number}
 */
export function getJalaliMonthDays(jy, jm) {
	if (jm >= 1 && jm <= 6) return 31;
	if (jm >= 7 && jm <= 11) return 30;
	if (jm === 12) return isLeapJalaliYear(jy) ? 30 : 29;
	return 0;
}

/**
 * Validates a Jalali date strictly, including month limits and leap years for Esfand.
 * @param {number} jy Jalali year (1000..2500)
 * @param {number} jm Jalali month (1..12)
 * @param {number} jd Jalali day (1..31)
 * @returns {boolean}
 */
export function isValidJalaliDate(jy, jm, jd) {
	if (!Number.isInteger(jy) || jy < 1000 || jy > 2500) return false;
	if (!Number.isInteger(jm) || jm < 1 || jm > 12) return false;
	const maxD = getJalaliMonthDays(jy, jm);
	if (!Number.isInteger(jd) || jd < 1 || jd > maxD) return false;
	return true;
}

/**
 * Checks if a target Jalali date is beyond the calendar 1-year ceiling from base Jalali date.
 * Product rule: Due date is allowed up to the exact same calendar date next year (baseJy + 1, baseJm, baseJd).
 * Anything strictly after that calendar date is beyond one year.
 *
 * @param {{ jy: number, jm: number, jd: number }} targetJalali
 * @param {{ jy: number, jm: number, jd: number }} baseJalali
 * @returns {boolean}
 */
export function isBeyondCalendarOneYear(targetJalali, baseJalali) {
	if (!targetJalali || !baseJalali) return false;
	if (targetJalali.jy > baseJalali.jy + 1) {
		return true;
	}
	if (targetJalali.jy === baseJalali.jy + 1) {
		if (targetJalali.jm > baseJalali.jm) {
			return true;
		}
		if (targetJalali.jm === baseJalali.jm) {
			return targetJalali.jd > baseJalali.jd;
		}
	}
	return false;
}

/**
 * Returns full Persian (Solar Hijri) and Gregorian date parts in Asia/Tehran timezone.
 * @param {Date} [baseDate=new Date()]
 * @returns {{
 *   jy: number,
 *   jm: number,
 *   jd: number,
 *   year: number,
 *   month: number,
 *   day: number,
 *   hour: number,
 *   minute: number,
 *   second: number,
 *   persianDateString: string,
 *   gregorianDateString: string,
 *   timeString: string
 * }}
 */
export function getTehranPersianDateParts(baseDate = new Date()) {
	const gParts = getTehranDateParts(baseDate);
	const jParts = gregorianToJalali(gParts.year, gParts.month, gParts.day);
	return {
		jy: jParts.jy,
		jm: jParts.jm,
		jd: jParts.jd,
		year: gParts.year,
		month: gParts.month,
		day: gParts.day,
		hour: gParts.hour,
		minute: gParts.minute,
		second: gParts.second,
		persianDateString: `${jParts.jy}-${String(jParts.jm).padStart(2, "0")}-${String(jParts.jd).padStart(2, "0")}`,
		gregorianDateString: gParts.dateString,
		timeString: gParts.timeString,
	};
}

/**
 * Returns current Date object
 */
export function getNow() {
	return new Date();
}

/**
 * Returns date parts in Asia/Tehran timezone
 */
export function getTehranDateParts(date = new Date()) {
	const formatter = new Intl.DateTimeFormat("en-US", {
		timeZone: TIMEZONE,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	});

	const parts = formatter.formatToParts(date);
	const map = {};
	for (const p of parts) {
		map[p.type] = p.value;
	}

	return {
		year: Number(map.year),
		month: Number(map.month),
		day: Number(map.day),
		hour: Number(map.hour),
		minute: Number(map.minute),
		second: Number(map.second),
		dateString: `${map.year}-${map.month}-${map.day}`,
		timeString: `${map.hour}:${map.minute}`,
	};
}

/**
 * Returns formatted Persian (Solar Hijri) context string for LLM prompt
 */
export function getTehranContextString(date = new Date()) {
	const gregorian = getTehranDateParts(date);

	// Format Persian calendar info
	const faFormatter = new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
		timeZone: TIMEZONE,
		weekday: "long",
		year: "numeric",
		month: "long",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	});

	const faString = faFormatter.format(date);

	return {
		isoNow: date.toISOString(),
		tehranDate: gregorian.dateString,
		tehranTime: gregorian.timeString,
		persianFull: faString,
		weekday: new Intl.DateTimeFormat("fa-IR", { timeZone: TIMEZONE, weekday: "long" }).format(date),
	};
}

/**
 * Formats an ISO date string into a user-friendly Persian string
 */
export function formatPersianDateTime(isoString) {
	if (!isoString) return "";
	try {
		const targetDate = new Date(isoString);
		if (isNaN(targetDate.getTime())) return isoString;

		const targetParts = getTehranDateParts(targetDate);
		const nowParts = getTehranDateParts(new Date());

		// Format time in fa-IR
		const timeFormat = new Intl.DateTimeFormat("fa-IR", {
			timeZone: TIMEZONE,
			hour: "2-digit",
			minute: "2-digit",
			hour12: false,
		}).format(targetDate);

		// Format full Persian date
		const fullFormat = new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
			timeZone: TIMEZONE,
			weekday: "long",
			day: "numeric",
			month: "long",
		}).format(targetDate);

		// Compare days
		const nowDateStr = `${nowParts.year}-${String(nowParts.month).padStart(2, "0")}-${String(nowParts.day).padStart(2, "0")}`;
		const targetDateStr = `${targetParts.year}-${String(targetParts.month).padStart(2, "0")}-${String(targetParts.day).padStart(2, "0")}`;

		const nowUtcDay = Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day);
		const targetUtcDay = Date.UTC(targetParts.year, targetParts.month - 1, targetParts.day);
		const diffDays = Math.round((targetUtcDay - nowUtcDay) / (1000 * 60 * 60 * 24));

		let dayPrefix = fullFormat;
		if (diffDays === 0) {
			dayPrefix = "امروز";
		} else if (diffDays === 1) {
			dayPrefix = "فردا";
		} else if (diffDays === 2) {
			dayPrefix = "پس‌فردا";
		} else if (diffDays === -1) {
			dayPrefix = "دیروز";
		}

		// If string has no time component (e.g. "YYYY-MM-DD"), show only date without fake 00:00 time
		const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(isoString.trim());
		if (isDateOnly) {
			return dayPrefix;
		}

		return `${dayPrefix} ساعت ${timeFormat}`;
	} catch {
		return isoString;
	}
}

/**
 * Checks whether an ISO string is scheduled for today in Tehran
 */
export function isTodayInTehran(isoString, baseDate = new Date()) {
	if (!isoString) return false;
	try {
		const target = new Date(isoString);
		if (isNaN(target.getTime())) return false;
		const targetParts = getTehranDateParts(target);
		const baseParts = getTehranDateParts(baseDate);

		const baseUtcDay = Date.UTC(baseParts.year, baseParts.month - 1, baseParts.day);
		const targetUtcDay = Date.UTC(targetParts.year, targetParts.month - 1, targetParts.day);
		const diffDays = Math.round((targetUtcDay - baseUtcDay) / (1000 * 60 * 60 * 24));
		return diffDays === 0;
	} catch {
		return false;
	}
}

/**
 * Checks whether an ISO string is scheduled for tomorrow in Tehran
 */
export function isTomorrowInTehran(isoString, baseDate = new Date()) {
	if (!isoString) return false;
	try {
		const target = new Date(isoString);
		if (isNaN(target.getTime())) return false;
		const targetParts = getTehranDateParts(target);
		const baseParts = getTehranDateParts(baseDate);

		const baseUtcDay = Date.UTC(baseParts.year, baseParts.month - 1, baseParts.day);
		const targetUtcDay = Date.UTC(targetParts.year, targetParts.month - 1, targetParts.day);
		const diffDays = Math.round((targetUtcDay - baseUtcDay) / (1000 * 60 * 60 * 24));
		return diffDays === 1;
	} catch {
		return false;
	}
}

/**
 * Checks whether an ISO string is scheduled for the day after tomorrow in Tehran
 */
export function isDayAfterTomorrowInTehran(isoString, baseDate = new Date()) {
	if (!isoString) return false;
	try {
		const target = new Date(isoString);
		if (isNaN(target.getTime())) return false;
		const targetParts = getTehranDateParts(target);
		const baseParts = getTehranDateParts(baseDate);

		const baseUtcDay = Date.UTC(baseParts.year, baseParts.month - 1, baseParts.day);
		const targetUtcDay = Date.UTC(targetParts.year, targetParts.month - 1, targetParts.day);
		const diffDays = Math.round((targetUtcDay - baseUtcDay) / (1000 * 60 * 60 * 24));
		return diffDays === 2;
	} catch {
		return false;
	}
}

/**
 * Checks whether an ISO string represents a date/time before now in Tehran.
 * - For date-only ISO strings (YYYY-MM-DD): overdue only if calendar day is strictly before today in Tehran.
 * - For date-time ISO strings: overdue if the timestamp is strictly before the current Tehran timestamp.
 */
export function isOverdueInTehran(isoString, baseDate = new Date()) {
	if (!isoString) return false;
	try {
		const str = typeof isoString === "string" ? isoString.trim() : "";
		const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(str);

		const target = new Date(str);
		if (isNaN(target.getTime())) return false;

		const targetParts = getTehranDateParts(target);
		const baseParts = getTehranDateParts(baseDate);

		const baseUtcDay = Date.UTC(baseParts.year, baseParts.month - 1, baseParts.day);
		const targetUtcDay = Date.UTC(targetParts.year, targetParts.month - 1, targetParts.day);
		const diffDays = Math.round((targetUtcDay - baseUtcDay) / (1000 * 60 * 60 * 24));

		if (isDateOnly) {
			return diffDays < 0;
		}

		return target.getTime() < baseDate.getTime();
	} catch {
		return false;
	}
}

/**
 * Unified task status icon helper (Single Source of Truth)
 * - 🟩 Completed (always green, regardless of due date)
 * - 🟥 Incomplete AND overdue (due date or hour/min passed in Tehran)
 * - ⬜️ Incomplete AND not overdue (due in future, today before due time, or no due date)
 * @param {object} task
 * @param {Date} [baseDate=new Date()]
 * @returns {string} Status icon ("🟩", "🟥", or "⬜️")
 */
export function getTaskStatusIcon(task, baseDate = new Date()) {
	if (!task) return "⬜️";
	if (Boolean(task.is_completed)) {
		return "🟩";
	}
	if (task.due_date && isOverdueInTehran(task.due_date, baseDate)) {
		return "🟥";
	}
	return "⬜️";
}

export const PERSIAN_WEEKDAY_MAP = {
	"یکشنبه": 0,
	"یک شنبه": 0,
	"دوشنبه": 1,
	"دو شنبه": 1,
	"سهشنبه": 2,
	"سه شنبه": 2,
	"سه‌شنبه": 2,
	"چهارشنبه": 3,
	"چهار شنبه": 3,
	"پنجشنبه": 4,
	"پنج شنبه": 4,
	"پنج‌شنبه": 4,
	"جمعه": 5,
	"آدینه": 5,
	"شنبه": 6,
};

export const CANONICAL_WEEKDAY_NAMES = [
	"یکشنبه",
	"دوشنبه",
	"سه‌شنبه",
	"چهارشنبه",
	"پنج‌شنبه",
	"جمعه",
	"شنبه",
];

/**
 * Normalizes a Persian weekday name to its standard canonical representation.
 */
export function normalizeWeekday(weekday) {
	if (!weekday || typeof weekday !== "string") return null;
	const clean = weekday.replace(/[\u200c\u200b\s]+/g, "").trim();
	const map = {
		"یکشنبه": "یکشنبه",
		"دوشنبه": "دوشنبه",
		"سهشنبه": "سه‌شنبه",
		"سه‌شنبه": "سه‌شنبه",
		"چهارشنبه": "چهارشنبه",
		"پنجشنبه": "پنج‌شنبه",
		"پنج‌شنبه": "پنج‌شنبه",
		"جمعه": "جمعه",
		"آدینه": "جمعه",
		"شنبه": "شنبه",
	};
	return map[clean] || null;
}

/**
 * Calculates day-of-week index (0 for Sunday to 6 for Saturday) in Asia/Tehran timezone.
 */
export function getTehranWeekdayIndex(isoString) {
	if (!isoString) return null;
	try {
		const str = String(isoString).trim();
		const dateMatch = str.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2}))?/);
		if (!dateMatch) {
			const d = new Date(str);
			if (isNaN(d.getTime())) return null;
			const parts = getTehranDateParts(d);
			return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
		}
		const y = Number(dateMatch[1]);
		const m = Number(dateMatch[2]);
		const day = Number(dateMatch[3]);
		if (dateMatch[4] !== undefined) {
			const d = new Date(str);
			if (isNaN(d.getTime())) return null;
			const parts = getTehranDateParts(d);
			return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
		} else {
			return new Date(Date.UTC(y, m - 1, day)).getUTCDay();
		}
	} catch {
		return null;
	}
}

/**
 * Checks whether an ISO string's due date falls on the specified weekday in Tehran timezone.
 */
export function isWeekdayInTehran(isoString, weekdayFilter) {
	if (!isoString || !weekdayFilter) return false;
	const canonicalTarget = normalizeWeekday(weekdayFilter);
	if (!canonicalTarget) return false;

	const targetIndex = PERSIAN_WEEKDAY_MAP[canonicalTarget];
	if (targetIndex === undefined) return false;

	const taskDayIndex = getTehranWeekdayIndex(isoString);
	if (taskDayIndex === null) return false;

	return taskDayIndex === targetIndex;
}

/**
 * Converts Persian digits to English digits
 */
export function toEnglishDigits(str) {
	if (typeof str !== "string") return str;
	const fa = ["۰", "۱", "۲", "۳", "۴", "۵", "۶", "۷", "۸", "۹"];
	const ar = ["٠", "١", "٢", "٣", "٤", "٥", "٦", "٧", "٨", "٩"];
	let res = str;
	for (let i = 0; i < 10; i++) {
		res = res.replaceAll(fa[i], String(i)).replaceAll(ar[i], String(i));
	}
	return res;
}

/**
 * Extracts Persian date and time from text (e.g. فردا ساعت ۵ عصر, امروز ساعت ۱۰, پس‌فردا, دوشنبه ساعت ۸ صبح, ۱۵ آبان ۱۴۰۶, ۸ آذر, سه روز دیگر)
 * @param {string} text
 * @param {Date} [baseDate=new Date()]
 * @returns {{
 *   hasDate: boolean,
 *   isInvalidDate: boolean,
 *   invalidDateReason: string | null,
 *   isPastDate: boolean,
 *   isBeyondOneYear: boolean,
 *   isInvalidTime: boolean,
 *   isoDueDate: string | null,
 *   targetDateStr: string | null,
 *   targetYear: number | null,
 *   targetMonth: number | null,
 *   targetDay: number | null,
 *   solarYear: number | null,
 *   solarMonth: number | null,
 *   solarDay: number | null,
 *   cleanedText: string,
 *   hasTime: boolean,
 *   isAmbiguousTime: boolean,
 *   ambiguousHour: number | null,
 *   needsClarification: boolean,
 *   clarificationType: "ambiguous_time" | "weekend" | "next_week" | "past_date" | "beyond_one_year" | "invalid_solar_date" | null
 * }}
 */
export function extractPersianDateTime(text, baseDate = new Date()) {
	if (!text || typeof text !== "string") {
		return {
			hasDate: false,
			isInvalidDate: false,
			invalidDateReason: null,
			isPastDate: false,
			isBeyondOneYear: false,
			isInvalidTime: false,
			isoDueDate: null,
			targetDateStr: null,
			targetYear: null,
			targetMonth: null,
			targetDay: null,
			solarYear: null,
			solarMonth: null,
			solarDay: null,
			cleanedText: "",
			hasTime: false,
			isAmbiguousTime: false,
			ambiguousHour: null,
			needsClarification: false,
			clarificationType: null,
		};
	}

	let cleanedText = text;
	let hasDate = false;
	let isInvalidDate = false;
	let invalidDateReason = null;
	let isPastDate = false;
	let isBeyondOneYear = false;
	let isAmbiguousTime = false;
	let ambiguousHour = null;
	let needsClarification = false;
	let clarificationType = null;
	let hasEmshab = false;
	let isTargetDayToday = false;
	let isWeekdayMatched = false;

	// Calculate base Tehran date & parts
	const baseParts = getTehranDateParts(baseDate);
	const baseJalali = gregorianToJalali(baseParts.year, baseParts.month, baseParts.day);
	const baseUtcDay = Date.UTC(baseParts.year, baseParts.month - 1, baseParts.day);

	let targetYear = baseParts.year;
	let targetMonth = baseParts.month;
	let targetDay = baseParts.day;
	let solarYear = null;
	let solarMonth = null;
	let solarDay = null;
	let targetHour = null;
	let targetMinute = null;

	const dayWordsPattern = Object.keys(PERSIAN_DAY_WORDS).join("|");
	const monthNamesPattern = Object.keys(SOLAR_MONTH_NAMES).join("|");
	const numWordsPattern = Object.keys(PERSIAN_NUMBER_WORDS).join("|");

	// 1. Detect Weekend
	if (/(?:^|[^\p{L}\p{N}\u200c])(?:(?:برای|به[\s\u200c]*موعد|واسه|تا|روی|در|توی)[\s\u200c]+)?آخر[\s\u200c]*هفته(?=[^\p{L}\p{N}\u200c]|$)/iu.test(cleanedText)) {
		hasDate = true;
		needsClarification = true;
		clarificationType = "weekend";
		cleanedText = cleanedText.replace(/(?:(?:برای|به[\s\u200c]*موعد|واسه|تا|روی|در|توی)[\s\u200c]+)?آخر[\s\u200c]*هفته(?=[^\p{L}\p{N}\u200c]|$)/giu, " ");
	}
	// 2. Detect Solar Hijri Date (e.g. ۱۵ آبان ۱۴۰۶, ۸ آذر, ۲۵ اسفند, هشتم آذر, اول فروردین)
	else {
		const solarRegex = new RegExp(
			`(?:^|[^\\p{L}\\p{N}\\u200c])(?:(?:برای|به[\\s\\u200c]*موعد|واسه|تا|روی|در|توی)[\\s\\u200c]+)?` +
			`(?:روز[\\s\\u200c]+)?` +
			`([0-9۰-۹]{1,2}|${dayWordsPattern})` +
			`[\\s\\u200c]*(?:ام|ـام)?[\\s\\u200c]+` +
			`(${monthNamesPattern})` +
			`(?:[\\s\\u200c]+ماه)?` +
			`(?:[\\s\\u200c]+(?:سال[\\s\\u200c]+)?([0-9۰-۹]{4}))?` +
			`(?=[^\\p{L}\\p{N}\\u200c]|$)`,
			"iu"
		);

		const matchSolar = cleanedText.match(solarRegex);
		if (matchSolar) {
			hasDate = true;
			const rawDay = matchSolar[1].trim();
			const dayNum = PERSIAN_DAY_WORDS[rawDay] || parseInt(toEnglishDigits(rawDay), 10);
			const monthNum = SOLAR_MONTH_NAMES[matchSolar[2].trim()];
			const explicitYear = matchSolar[3] ? parseInt(toEnglishDigits(matchSolar[3]), 10) : null;

			solarMonth = monthNum;
			solarDay = dayNum;

			// Basic structural validation
			if (!Number.isInteger(dayNum) || dayNum < 1 || dayNum > 31 || (monthNum >= 7 && monthNum <= 11 && dayNum > 30) || (monthNum === 12 && dayNum > 30)) {
				isInvalidDate = true;
				invalidDateReason = "INVALID_SOLAR_DAY";
				needsClarification = true;
				clarificationType = "invalid_solar_date";
			} else {
				if (explicitYear !== null) {
					solarYear = explicitYear;
					if (!isValidJalaliDate(solarYear, solarMonth, solarDay)) {
						isInvalidDate = true;
						invalidDateReason = "INVALID_LEAP_DAY";
						needsClarification = true;
						clarificationType = "invalid_solar_date";
					} else {
						const g = jalaliToGregorian(solarYear, solarMonth, solarDay);
						targetYear = g.gy;
						targetMonth = g.gm;
						targetDay = g.gd;

						const targetUtc = Date.UTC(targetYear, targetMonth - 1, targetDay);
						if (targetUtc < baseUtcDay) {
							isPastDate = true;
							needsClarification = true;
							clarificationType = "past_date";
						} else if (isBeyondCalendarOneYear({ jy: solarYear, jm: solarMonth, jd: solarDay }, baseJalali)) {
							isBeyondOneYear = true;
							needsClarification = true;
							clarificationType = "beyond_one_year";
						} else if (targetUtc === baseUtcDay) {
							isTargetDayToday = true;
						}
					}
				} else {
					// No explicit year -> choose nearest upcoming occurrence
					let jy = baseJalali.jy;
					if (solarMonth < baseJalali.jm || (solarMonth === baseJalali.jm && solarDay < baseJalali.jd)) {
						jy += 1;
					}
					solarYear = jy;

					if (!isValidJalaliDate(solarYear, solarMonth, solarDay)) {
						isInvalidDate = true;
						invalidDateReason = "INVALID_LEAP_DAY";
						needsClarification = true;
						clarificationType = "invalid_solar_date";
					} else {
						const g = jalaliToGregorian(solarYear, solarMonth, solarDay);
						targetYear = g.gy;
						targetMonth = g.gm;
						targetDay = g.gd;

						const targetUtc = Date.UTC(targetYear, targetMonth - 1, targetDay);
						if (targetUtc === baseUtcDay) {
							isTargetDayToday = true;
						}
					}
				}
			}

			cleanedText = cleanedText.replace(solarRegex, " ");
		}
	}

	// 3. Detect Relative Offsets (N روز دیگر/بعد, N هفته دیگر/بعد, N ماه دیگر/بعد)
	if (!hasDate) {
		const relativeDaysRegex = new RegExp(
			`(?:^|[^\\p{L}\\p{N}\\u200c])(?:(?:برای|به[\\s\\u200c]*موعد|واسه|تا|روی|در|توی)[\\s\\u200c]+)?` +
			`([0-9۰-۹]{1,3}|${numWordsPattern})` +
			`[\\s\\u200c]+روز[\\s\\u200c]*(?:دیگر|دیگه|بعد|آینده)` +
			`(?=[^\\p{L}\\p{N}\\u200c]|$)`,
			"iu"
		);
		const relativeWeeksRegex = new RegExp(
			`(?:^|[^\\p{L}\\p{N}\\u200c])(?:(?:برای|به[\\s\\u200c]*موعد|واسه|تا|روی|در|توی)[\\s\\u200c]+)?` +
			`([0-9۰-۹]{1,2}|${numWordsPattern})` +
			`[\\s\\u200c]+هفته[\\s\\u200c]*(?:دیگر|دیگه|بعد|آینده)` +
			`(?=[^\\p{L}\\p{N}\\u200c]|$)`,
			"iu"
		);
		const relativeMonthsRegex = new RegExp(
			`(?:^|[^\\p{L}\\p{N}\\u200c])(?:(?:برای|به[\\s\\u200c]*موعد|واسه|تا|روی|در|توی)[\\s\\u200c]+)?` +
			`([0-9۰-۹]{1,2}|${numWordsPattern})` +
			`[\\s\\u200c]+ماه[\\s\\u200c]*(?:دیگر|دیگه|بعد|آینده)` +
			`(?=[^\\p{L}\\p{N}\\u200c]|$)`,
			"iu"
		);

		let mRel;
		if ((mRel = cleanedText.match(relativeDaysRegex))) {
			hasDate = true;
			const rawVal = mRel[1].trim();
			const count = PERSIAN_NUMBER_WORDS[rawVal] || parseInt(toEnglishDigits(rawVal), 10);
			const d = new Date(Date.UTC(baseParts.year, baseParts.month - 1, baseParts.day + count));
			targetYear = d.getUTCFullYear();
			targetMonth = d.getUTCMonth() + 1;
			targetDay = d.getUTCDate();

			const targetJalali = gregorianToJalali(targetYear, targetMonth, targetDay);
			if (isBeyondCalendarOneYear(targetJalali, baseJalali)) {
				isBeyondOneYear = true;
				needsClarification = true;
				clarificationType = "beyond_one_year";
			}
			cleanedText = cleanedText.replace(relativeDaysRegex, " ");
		} else if ((mRel = cleanedText.match(relativeWeeksRegex))) {
			hasDate = true;
			const rawVal = mRel[1].trim();
			const count = PERSIAN_NUMBER_WORDS[rawVal] || parseInt(toEnglishDigits(rawVal), 10);
			const d = new Date(Date.UTC(baseParts.year, baseParts.month - 1, baseParts.day + count * 7));
			targetYear = d.getUTCFullYear();
			targetMonth = d.getUTCMonth() + 1;
			targetDay = d.getUTCDate();

			const targetJalali = gregorianToJalali(targetYear, targetMonth, targetDay);
			if (isBeyondCalendarOneYear(targetJalali, baseJalali)) {
				isBeyondOneYear = true;
				needsClarification = true;
				clarificationType = "beyond_one_year";
			}
			cleanedText = cleanedText.replace(relativeWeeksRegex, " ");
		} else if ((mRel = cleanedText.match(relativeMonthsRegex))) {
			hasDate = true;
			const rawVal = mRel[1].trim();
			const count = PERSIAN_NUMBER_WORDS[rawVal] || parseInt(toEnglishDigits(rawVal), 10);

			// Advance Solar months
			let totalM = baseJalali.jm + count;
			let jy = baseJalali.jy + Math.floor((totalM - 1) / 12);
			let jm = ((totalM - 1) % 12) + 1;
			let jd = Math.min(baseJalali.jd, getJalaliMonthDays(jy, jm));

			const g = jalaliToGregorian(jy, jm, jd);
			targetYear = g.gy;
			targetMonth = g.gm;
			targetDay = g.gd;

			const targetJalali = { jy, jm, jd };
			if (isBeyondCalendarOneYear(targetJalali, baseJalali)) {
				isBeyondOneYear = true;
				needsClarification = true;
				clarificationType = "beyond_one_year";
			}
			cleanedText = cleanedText.replace(relativeMonthsRegex, " ");
		}
	}

	// 4. Existing relative days and weekdays
	if (!hasDate) {
		if (/(?:^|[^\p{L}\p{N}\u200c])(?:(?:برای|به[\s\u200c]*موعد|واسه|تا|روی|در|توی)[\s\u200c]+)?(?:پس[\s\u200c]*فردا|دو[\s\u200c]*روز[\s\u200c]*بعد)(?=[^\p{L}\p{N}\u200c]|$)/iu.test(cleanedText)) {
			hasDate = true;
			const d = new Date(Date.UTC(targetYear, targetMonth - 1, targetDay + 2));
			targetYear = d.getUTCFullYear();
			targetMonth = d.getUTCMonth() + 1;
			targetDay = d.getUTCDate();
			cleanedText = cleanedText.replace(/(?:(?:برای|به[\s\u200c]*موعد|واسه|تا|روی|در|توی)[\s\u200c]+)?(?:پس[\s\u200c]*فردا|دو[\s\u200c]*روز[\s\u200c]*بعد)(?=[^\p{L}\p{N}\u200c]|$)/giu, " ");
		} else if (/(?:^|[^\p{L}\p{N}\u200c])(?:(?:برای|به[\s\u200c]*موعد|واسه|تا|روی|در|توی)[\s\u200c]+)?(?:فردا|روز[\s\u200c]*بعد)(?=[^\p{L}\p{N}\u200c]|$)/iu.test(cleanedText)) {
			hasDate = true;
			const d = new Date(Date.UTC(targetYear, targetMonth - 1, targetDay + 1));
			targetYear = d.getUTCFullYear();
			targetMonth = d.getUTCMonth() + 1;
			targetDay = d.getUTCDate();
			cleanedText = cleanedText.replace(/(?:(?:برای|به[\s\u200c]*موعد|واسه|تا|روی|در|توی)[\s\u200c]+)?(?:فردا|روز[\s\u200c]*بعد)(?=[^\p{L}\p{N}\u200c]|$)/giu, " ");
		} else if (/(?:^|[^\p{L}\p{N}\u200c])(?:(?:برای|به[\s\u200c]*موعد|واسه|تا|روی|در|توی)[\s\u200c]+)?امشب(?=[^\p{L}\p{N}\u200c]|$)/iu.test(cleanedText)) {
			hasDate = true;
			hasEmshab = true;
			isTargetDayToday = true;
			cleanedText = cleanedText.replace(/(?:(?:برای|به[\s\u200c]*موعد|واسه|تا|روی|در|توی)[\s\u200c]+)?امشب(?=[^\p{L}\p{N}\u200c]|$)/giu, " ");
		} else if (/(?:^|[^\p{L}\p{N}\u200c])(?:(?:برای|به[\s\u200c]*موعد|واسه|تا|روی|در|توی)[\s\u200c]+)?امروز(?=[^\p{L}\p{N}\u200c]|$)/iu.test(cleanedText)) {
			hasDate = true;
			isTargetDayToday = true;
			cleanedText = cleanedText.replace(/(?:(?:برای|به[\s\u200c]*موعد|واسه|تا|روی|در|توی)[\s\u200c]+)?امروز(?=[^\p{L}\p{N}\u200c]|$)/giu, " ");
		} else if (/(?:^|[^\p{L}\p{N}\u200c])(?:(?:برای|به[\s\u200c]*موعد|واسه|تا|روی|در|توی)[\s\u200c]+)?دیروز(?=[^\p{L}\p{N}\u200c]|$)/iu.test(cleanedText)) {
			hasDate = true;
			const d = new Date(Date.UTC(targetYear, targetMonth - 1, targetDay - 1));
			targetYear = d.getUTCFullYear();
			targetMonth = d.getUTCMonth() + 1;
			targetDay = d.getUTCDate();
			isPastDate = true;
			needsClarification = true;
			clarificationType = "past_date";
			cleanedText = cleanedText.replace(/(?:(?:برای|به[\s\u200c]*موعد|واسه|تا|روی|در|توی)[\s\u200c]+)?دیروز(?=[^\p{L}\p{N}\u200c]|$)/giu, " ");
		} else if (/(?:^|[^\p{L}\p{N}\u200c])(?:(?:برای|به[\s\u200c]*موعد|واسه|تا|روی|در|توی)[\s\u200c]+)?پریروز(?=[^\p{L}\p{N}\u200c]|$)/iu.test(cleanedText)) {
			hasDate = true;
			const d = new Date(Date.UTC(targetYear, targetMonth - 1, targetDay - 2));
			targetYear = d.getUTCFullYear();
			targetMonth = d.getUTCMonth() + 1;
			targetDay = d.getUTCDate();
			isPastDate = true;
			needsClarification = true;
			clarificationType = "past_date";
			cleanedText = cleanedText.replace(/(?:(?:برای|به[\s\u200c]*موعد|واسه|تا|روی|در|توی)[\s\u200c]+)?پریروز(?=[^\p{L}\p{N}\u200c]|$)/giu, " ");
		} else {
			// Weekdays & next week
			const hasNextWeek = /(?:^|[^\p{L}\p{N}\u200c])(?:(?:برای|به[\s\u200c]*موعد|واسه|تا|روی|در|توی)[\s\u200c]+)?هفته[\s\u200c]*(?:بعد|آینده)(?=[^\p{L}\p{N}\u200c]|$)/iu.test(cleanedText);
			const weekdayRegex = /(?:^|[^\p{L}\p{N}\u200c])(?:(?:برای|به[\s\u200c]*موعد|واسه|تا|روی|در|توی)[\s\u200c]+)?(یک[\s\u200c]*شنبه|دو[\s\u200c]*شنبه|سه[\s\u200c]*شنبه|چهار[\s\u200c]*شنبه|پنج[\s\u200c]*شنبه|جمعه|شنبه)(?=[^\p{L}\p{N}\u200c]|$)/iu;
			const matchWeekday = cleanedText.match(weekdayRegex);

			if (matchWeekday) {
				hasDate = true;
				isWeekdayMatched = true;
				const rawDay = matchWeekday[1].replace(/[\s\u200c]+/g, "");
				const map = {
					"یکشنبه": 0,
					"دوشنبه": 1,
					"سهشنبه": 2,
					"چهارشنبه": 3,
					"پنجشنبه": 4,
					"جمعه": 5,
					"شنبه": 6,
				};
				const targetDayOfWeek = map[rawDay];
				const baseUtc = new Date(Date.UTC(baseParts.year, baseParts.month - 1, baseParts.day));
				const currentDayOfWeek = baseUtc.getUTCDay();
				let diff = targetDayOfWeek - currentDayOfWeek;
				if (diff < 0) diff += 7;
				if (diff === 0) {
					isTargetDayToday = true;
				}
				if (hasNextWeek && diff !== 0) {
					diff += 7;
				} else if (hasNextWeek && diff === 0) {
					diff = 7;
					isTargetDayToday = false;
				}
				const d = new Date(Date.UTC(targetYear, targetMonth - 1, targetDay + diff));
				targetYear = d.getUTCFullYear();
				targetMonth = d.getUTCMonth() + 1;
				targetDay = d.getUTCDate();

				cleanedText = cleanedText.replace(/(?:(?:برای|به[\s\u200c]*موعد|واسه|تا|روی|در|توی)[\s\u200c]+)?(?:یک[\s\u200c]*شنبه|دو[\s\u200c]*شنبه|سه[\s\u200c]*شنبه|چهار[\s\u200c]*شنبه|پنج[\s\u200c]*شنبه|جمعه|شنبه)(?=[^\p{L}\p{N}\u200c]|$)/giu, " ");
				if (hasNextWeek) {
					cleanedText = cleanedText.replace(/(?:(?:برای|به[\s\u200c]*موعد|واسه|تا|روی|در|توی)[\s\u200c]+)?هفته[\s\u200c]*(?:بعد|آینده)(?=[^\p{L}\p{N}\u200c]|$)/giu, " ");
				}
			} else if (hasNextWeek) {
				hasDate = true;
				needsClarification = true;
				clarificationType = "next_week";
				cleanedText = cleanedText.replace(/(?:(?:برای|به[\s\u200c]*موعد|واسه|تا|روی|در|توی)[\s\u200c]+)?هفته[\s\u200c]*(?:بعد|آینده)(?=[^\p{L}\p{N}\u200c]|$)/giu, " ");
			}
		}
	}

	// 5. Detect Time
	let isInvalidTime = false;
	const pWords = "(?:صبح|بامداد|ظهر|عصر|بعد(?:[\\s\\u200c]*از[\\s\\u200c]*)?ظهر|نیمه[\\s\\u200c]*شب|شب)";

	// Pattern 1: Period BEFORE hour, e.g. صبح ساعت ۹, عصر ساعت ۶, شب ساعت ۸, صبح ۹
	const pattern1 = new RegExp(
		"(?:(?:برای|به[\\s\\u200c]*موعد|واسه|تا|روی|در|توی)[\\s\\u200c]+)?(?:^|[^\\p{L}\\p{N}\\u200c])(" +
			pWords +
			")(?:[\\s\\u200c]+ساعت[\\s\\u200c]+|[\\s\\u200c]+)([0-9۰-۹]{1,2})(?::([0-9۰-۹]{2}))?(?=[^\\p{L}\\p{N}\\u200c]|$)",
		"iu"
	);

	// Pattern 2: Hour with optional 'ساعت' and Period AFTER, e.g. ساعت ۹ صبح, ۹ صبح, ساعت ۶ عصر, ۶ عصر, ۱۲ ظهر, ۱۲ شب
	const pattern2 = new RegExp(
		"(?:(?:برای|به[\\s\\u200c]*موعد|واسه|تا|روی|در|توی)[\\s\\u200c]+)?(?:ساعت[\\s\\u200c]+)?([0-9۰-۹]{1,2})(?::([0-9۰-۹]{2}))?[\\s\\u200c]*(" +
			pWords +
			")(?=[^\\p{L}\\p{N}\\u200c]|$)",
		"iu"
	);

	// Pattern 3: 'ساعت' with hour and optional minute (no period keyword), e.g. ساعت ۱۸:۳۰, ساعت ۵
	const pattern3 =
		/(?:(?:برای|به[\s\u200c]*موعد|واسه|تا|روی|در|توی)[\s\u200c]+)?(?:ساعت[\s\u200c]+)([0-9۰-۹]{1,2})(?::([0-9۰-۹]{2}))?(?=[^\p{L}\p{N}\u200c]|$)/iu;

	// Pattern 4: Standalone HH:mm (must have colon), e.g. 18:30
	const pattern4 =
		/(?:(?:برای|به[\s\u200c]*موعد|واسه|تا|روی|در|توی)[\s\u200c]+)?(?:^|[^\p{L}\p{N}\u200c])([0-9۰-۹]{1,2}):([0-9۰-۹]{2})(?=[^\p{L}\p{N}\u200c]|$)/u;

	let rawH;
	let rawM = 0;
	let period = null;
	let matchTime;

	if ((matchTime = cleanedText.match(pattern1))) {
		period = matchTime[1].trim();
		rawH = parseInt(toEnglishDigits(matchTime[2]), 10);
		rawM = matchTime[3] ? parseInt(toEnglishDigits(matchTime[3]), 10) : 0;
		cleanedText = cleanedText.replace(pattern1, " ");
	} else if ((matchTime = cleanedText.match(pattern2))) {
		rawH = parseInt(toEnglishDigits(matchTime[1]), 10);
		rawM = matchTime[2] ? parseInt(toEnglishDigits(matchTime[2]), 10) : 0;
		period = matchTime[3].trim();
		cleanedText = cleanedText.replace(pattern2, " ");
	} else if ((matchTime = cleanedText.match(pattern3))) {
		rawH = parseInt(toEnglishDigits(matchTime[1]), 10);
		rawM = matchTime[2] ? parseInt(toEnglishDigits(matchTime[2]), 10) : 0;
		if (hasEmshab) period = "شب";
		cleanedText = cleanedText.replace(pattern3, " ");
	} else if ((matchTime = cleanedText.match(pattern4))) {
		rawH = parseInt(toEnglishDigits(matchTime[1]), 10);
		rawM = parseInt(toEnglishDigits(matchTime[2]), 10);
		if (hasEmshab) period = "شب";
		cleanedText = cleanedText.replace(pattern4, " ");
	}

	if (rawH !== undefined) {
		if (rawH < 0 || rawH > 23 || rawM < 0 || rawM > 59) {
			isInvalidTime = true;
		} else {
			let h = rawH;
			let m = rawM;
			if (period) {
				if (/صبح|بامداد/iu.test(period)) {
					if (h === 12) h = 0;
				} else if (/ظهر/iu.test(period)) {
					if (h === 12) h = 12;
					else if (h < 12) h += 12;
				} else if (/(عصر|بعد(?:[\s\u200c]*از[\s\u200c]*)?ظهر)/iu.test(period)) {
					if (h === 12) h = 12;
					else if (h < 12) h += 12;
				} else if (/(?:نیمه[\s\u200c]*شب|شب)/iu.test(period)) {
					if (h === 12) h = 0;
					else if (h < 12) h += 12;
				}
				targetHour = h;
				targetMinute = m;
				hasDate = true;
			} else {
				if (h >= 13 && h <= 23) {
					targetHour = h;
					targetMinute = m;
					hasDate = true;
				} else if (h === 0) {
					targetHour = 0;
					targetMinute = m;
					hasDate = true;
				} else if (h >= 1 && h <= 12) {
					isAmbiguousTime = true;
					ambiguousHour = rawH;
					needsClarification = true;
					clarificationType = "ambiguous_time";
					hasDate = true;
				}
			}
		}
	}

	cleanedText = cleanedText.replace(/\s+/g, " ").trim();

	// Populate solar components if date resolved
	if (hasDate && !isInvalidDate && targetYear !== null && targetMonth !== null && targetDay !== null) {
		const sj = gregorianToJalali(targetYear, targetMonth, targetDay);
		solarYear = sj.jy;
		solarMonth = sj.jm;
		solarDay = sj.jd;
	}

	if (isInvalidDate) {
		return {
			hasDate: false,
			isInvalidDate: true,
			invalidDateReason,
			isPastDate: false,
			isBeyondOneYear: false,
			isInvalidTime: false,
			isoDueDate: null,
			targetDateStr: null,
			targetYear: null,
			targetMonth: null,
			targetDay: null,
			solarYear: null,
			solarMonth: null,
			solarDay: null,
			cleanedText,
			hasTime: false,
			isAmbiguousTime: false,
			ambiguousHour: null,
			needsClarification: true,
			clarificationType: clarificationType || "invalid_solar_date",
		};
	}

	if (isInvalidTime) {
		return {
			hasDate: false,
			isInvalidDate: false,
			invalidDateReason: null,
			isPastDate: false,
			isBeyondOneYear: false,
			isInvalidTime: true,
			isoDueDate: null,
			targetDateStr: null,
			targetYear: null,
			targetMonth: null,
			targetDay: null,
			solarYear: null,
			solarMonth: null,
			solarDay: null,
			cleanedText,
			hasTime: false,
			isAmbiguousTime: false,
			ambiguousHour: null,
			needsClarification: false,
			clarificationType: null,
		};
	}

	if (needsClarification || isAmbiguousTime) {
		const yStr = String(targetYear).padStart(4, "0");
		const mStr = String(targetMonth).padStart(2, "0");
		const dStr = String(targetDay).padStart(2, "0");

		return {
			hasDate: true,
			isInvalidDate: false,
			invalidDateReason: null,
			isPastDate,
			isBeyondOneYear,
			isInvalidTime: false,
			isoDueDate: null,
			targetDateStr: `${yStr}-${mStr}-${dStr}`,
			targetYear,
			targetMonth,
			targetDay,
			solarYear,
			solarMonth,
			solarDay,
			cleanedText,
			hasTime: false,
			isAmbiguousTime,
			ambiguousHour,
			needsClarification: true,
			clarificationType: clarificationType || (isAmbiguousTime ? "ambiguous_time" : null),
		};
	}

	// If no date was explicitly mentioned, but time was specified, default to today
	if (!hasDate && targetHour !== null) {
		hasDate = true;
		isTargetDayToday = true;
		const sj = gregorianToJalali(targetYear, targetMonth, targetDay);
		solarYear = sj.jy;
		solarMonth = sj.jm;
		solarDay = sj.jd;
	}

	// Rule 2: If target day is today and time has already passed today, advance to next week (+7 days)
	if (isTargetDayToday && targetHour !== null && !isAmbiguousTime) {
		const isPastTime =
			targetHour < baseParts.hour || (targetHour === baseParts.hour && targetMinute <= baseParts.minute);
		if (isPastTime) {
			const d = new Date(Date.UTC(targetYear, targetMonth - 1, targetDay + 7));
			targetYear = d.getUTCFullYear();
			targetMonth = d.getUTCMonth() + 1;
			targetDay = d.getUTCDate();
			const sj = gregorianToJalali(targetYear, targetMonth, targetDay);
			solarYear = sj.jy;
			solarMonth = sj.jm;
			solarDay = sj.jd;
		}
	}

	if (!hasDate) {
		return {
			hasDate: false,
			isInvalidDate: false,
			invalidDateReason: null,
			isPastDate: false,
			isBeyondOneYear: false,
			isInvalidTime: false,
			isoDueDate: null,
			targetDateStr: null,
			targetYear: null,
			targetMonth: null,
			targetDay: null,
			solarYear: null,
			solarMonth: null,
			solarDay: null,
			cleanedText,
			hasTime: false,
			isAmbiguousTime: false,
			ambiguousHour: null,
			needsClarification: false,
			clarificationType: null,
		};
	}

	const yStr = String(targetYear).padStart(4, "0");
	const mStr = String(targetMonth).padStart(2, "0");
	const dStr = String(targetDay).padStart(2, "0");

	let isoDueDate;
	const hasTime = targetHour !== null;

	if (hasTime) {
		const hrStr = String(targetHour).padStart(2, "0");
		const minStr = String(targetMinute !== null ? targetMinute : 0).padStart(2, "0");
		isoDueDate = `${yStr}-${mStr}-${dStr}T${hrStr}:${minStr}:00+03:30`;
	} else {
		// Date-only format without fake 00:00
		isoDueDate = `${yStr}-${mStr}-${dStr}`;
	}

	return {
		hasDate: true,
		isInvalidDate: false,
		invalidDateReason: null,
		isPastDate: false,
		isBeyondOneYear: false,
		isInvalidTime: false,
		isoDueDate,
		targetDateStr: `${yStr}-${mStr}-${dStr}`,
		targetYear,
		targetMonth,
		targetDay,
		solarYear,
		solarMonth,
		solarDay,
		cleanedText,
		hasTime,
		isAmbiguousTime: false,
		ambiguousHour: null,
		needsClarification: false,
		clarificationType: null,
	};
}

/**
 * Validates whether a string is a valid ISO 8601 due date format (date-only or date-time).
 * Rejects out-of-range hours (0-23), minutes (0-59), seconds (0-59),
 * invalid months (1-12), and invalid days for the given month/year (e.g. Feb 31, leap-year checks).
 * @param {string} isoString
 * @returns {boolean}
 */
export function isValidIsoDueDate(isoString) {
	if (!isoString || typeof isoString !== "string") {
		return false;
	}
	const str = isoString.trim();
	if (!str) {
		return false;
	}

	// Match ISO 8601: YYYY-MM-DD or YYYY-MM-DDTHH:mm(:ss(.sss))?(Z|[+-]HH:mm)?
	const match = str.match(
		/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/
	);
	if (!match) {
		return false;
	}

	const year = parseInt(match[1], 10);
	const month = parseInt(match[2], 10);
	const day = parseInt(match[3], 10);

	if (month < 1 || month > 12) {
		return false;
	}

	// Accurate days in month calculation including leap years
	const isLeapYear = (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
	const daysInMonth = [0, 31, isLeapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

	if (day < 1 || day > daysInMonth[month]) {
		return false;
	}

	// If time component is present, validate hours, minutes, seconds
	if (match[4] !== undefined) {
		const hour = parseInt(match[4], 10);
		const minute = parseInt(match[5], 10);
		const second = match[6] !== undefined ? parseInt(match[6], 10) : 0;

		if (hour < 0 || hour > 23) {
			return false;
		}
		if (minute < 0 || minute > 59) {
			return false;
		}
		if (second < 0 || second > 59) {
			return false;
		}
	}

	// Final verification using Date constructor
	const parsed = new Date(str);
	return !isNaN(parsed.getTime());
}

/**
 * Validates and converts a 12-hour or period-qualified hour into a valid 24-hour hour (0..23).
 * Returns null if the combination is invalid or contradictory (e.g. 12 صبح, 17 صبح, 5 ظهر, 8 ظهر).
 *
 * @param {number} h Hour (1..23)
 * @param {string} period Period qualifier (صبح, بامداد, ظهر, عصر, شب, نیمه‌شب)
 * @returns {number|null} 24-hour representation (0..23) or null if invalid
 */
function validateAndConvertPeriodHour(h, period) {
	if (!period || typeof period !== "string" || !Number.isInteger(h)) {
		return null;
	}
	const p = period.trim();

	// "صبح" or "بامداد": only valid for hours 1 to 11. (12 صبح or 17 صبح is invalid)
	if (/^(?:صبح|بامداد)$/iu.test(p)) {
		if (h >= 1 && h <= 11) {
			return h;
		}
		return null;
	}

	// "ظهر": only valid for hour 12 (12:00). (5 ظهر or 8 ظهر is invalid)
	if (/^ظهر$/iu.test(p)) {
		if (h === 12) {
			return 12;
		}
		return null;
	}

	// "عصر" or "بعدازظهر": only valid for hours 1 to 11 (returns 13 to 23). (12 عصر or 17 عصر is invalid)
	if (/^(?:عصر|بعد(?:[\s\u200c]*از[\s\u200c]*)?ظهر)$/iu.test(p)) {
		if (h >= 1 && h <= 11) {
			return h + 12;
		}
		return null;
	}

	// "شب" or "نیمه‌شب": 12 is 0 (00:00 midnight), 1 to 11 is h + 12 (13 to 23). (hours >= 13 are invalid)
	if (/^(?:نیمه[\s\u200c]*شب|شب)$/iu.test(p)) {
		if (h === 12) {
			return 0;
		}
		if (h >= 1 && h <= 11) {
			return h + 12;
		}
		return null;
	}

	return null;
}

/**
 * Resolves an ambiguous hour (1..12) given the user's clarification reply and preserved target date.
 * Enforces strict consistency with the original ambiguous hour, disallowing contradictory or ambiguous guesses.
 *
 * @param {number|string} ambiguousHour Raw ambiguous hour (1 to 12)
 * @param {string} replyText User's response text (e.g. "صبح", "عصر", "ساعت ۵ عصر", "۱۷", "لغو")
 * @param {string} targetDateStr Target date in YYYY-MM-DD format
 * @returns {{
 *   resolved: boolean,
 *   isoDueDate: string | null,
 *   hour: number | null,
 *   minute: number | null,
 *   targetDateStr: string | null,
 *   isContradictory: boolean,
 *   isStillAmbiguous: boolean,
 *   errorReason: "INVALID_INPUT" | "INVALID_TARGET_DATE" | "CONTRADICTORY_HOUR" | "STILL_AMBIGUOUS" | "UNRECOGNIZED_REPLY" | null
 * }}
 */
export function resolveAmbiguousHourResponse(ambiguousHour, replyText, targetDateStr) {
	// 1. Validate ambiguousHour (must be an integer 1..12)
	const rawH = parseInt(toEnglishDigits(String(ambiguousHour)), 10);
	if (isNaN(rawH) || rawH < 1 || rawH > 12) {
		return {
			resolved: false,
			isoDueDate: null,
			hour: null,
			minute: null,
			targetDateStr: null,
			isContradictory: false,
			isStillAmbiguous: false,
			errorReason: "INVALID_INPUT",
		};
	}

	// 2. Validate targetDateStr (must be valid YYYY-MM-DD)
	if (
		!targetDateStr ||
		typeof targetDateStr !== "string" ||
		!/^\d{4}-\d{2}-\d{2}$/.test(targetDateStr) ||
		!isValidIsoDueDate(targetDateStr)
	) {
		return {
			resolved: false,
			isoDueDate: null,
			hour: null,
			minute: null,
			targetDateStr: null,
			isContradictory: false,
			isStillAmbiguous: false,
			errorReason: "INVALID_TARGET_DATE",
		};
	}

	// 3. Validate replyText
	if (!replyText || typeof replyText !== "string" || !replyText.trim()) {
		return {
			resolved: false,
			isoDueDate: null,
			hour: null,
			minute: null,
			targetDateStr,
			isContradictory: false,
			isStillAmbiguous: false,
			errorReason: "INVALID_INPUT",
		};
	}

	let text = toEnglishDigits(replyText.trim());

	// Case 1: Pure period keyword (e.g. "صبح", "عصر", "شب", "ظهر", "نیمه‌شب")
	const purePeriodMatch = text.match(
		/^(?:برای|به|واسه)?[\s\u200c]*(صبح|بامداد|ظهر|عصر|بعد(?:[\s\u200c]*از[\s\u200c]*)?ظهر|نیمه[\s\u200c]*شب|شب)[\s\u200c]*(?:باشه|لطفا|لطفاً)?[.!\s]*$/iu
	);

	if (purePeriodMatch) {
		const periodWord = purePeriodMatch[1];
		const resolvedHour = validateAndConvertPeriodHour(rawH, periodWord);

		if (resolvedHour === null) {
			return {
				resolved: false,
				isoDueDate: null,
				hour: null,
				minute: null,
				targetDateStr,
				isContradictory: true,
				isStillAmbiguous: false,
				errorReason: "CONTRADICTORY_HOUR",
			};
		}

		const hStr = String(resolvedHour).padStart(2, "0");
		const mStr = "00";
		return {
			resolved: true,
			isoDueDate: `${targetDateStr}T${hStr}:${mStr}:00${TEHRAN_OFFSET}`,
			hour: resolvedHour,
			minute: 0,
			targetDateStr,
			isContradictory: false,
			isStillAmbiguous: false,
			errorReason: null,
		};
	}

	// Case 2: Numeric and composite replies
	const pWords = "(?:صبح|بامداد|ظهر|عصر|بعد(?:[\\s\\u200c]*از[\\s\\u200c]*)?ظهر|نیمه[\\s\\u200c]*شب|شب)";

	// Pattern 1: Period BEFORE hour, e.g. صبح ساعت ۵, عصر ۵
	const pattern1 = new RegExp(
		"(?:^|[^\\p{L}\\p{N}\\u200c])(" +
			pWords +
			")(?:[\\s\\u200c]+ساعت[\\s\\u200c]+|[\\s\\u200c]+)([0-9]{1,2})(?::([0-9]{1,2}))?(?=[^\\p{L}\\p{N}\\u200c]|$)",
		"iu"
	);

	// Pattern 2: Hour with optional 'ساعت' and period AFTER, e.g. ۵ عصر, ساعت ۵ عصر, ۱۲ ظهر
	const pattern2 = new RegExp(
		"(?:^|[^\\p{L}\\p{N}\\u200c])(?:ساعت[\\s\\u200c]+)?([0-9]{1,2})(?::([0-9]{1,2}))?[\\s\\u200c]*(" +
			pWords +
			")(?=[^\\p{L}\\p{N}\\u200c]|$)",
		"iu"
	);

	// Pattern 3: 'ساعت' with hour, e.g. ساعت ۱۷, ساعت ۸
	const pattern3 = /(?:^|[^\p{L}\p{N}\u200c])(?:ساعت[\s\u200c]+)([0-9]{1,2})(?::([0-9]{1,2}))?(?=[^\p{L}\p{N}\u200c]|$)/iu;

	// Pattern 4: Standalone HH:mm with colon, e.g. 17:00, 05:00
	const pattern4 = /(?:^|[^\p{L}\p{N}\u200c])([0-9]{1,2}):([0-9]{1,2})(?=[^\p{L}\p{N}\u200c]|$)/u;

	// Pattern 5: Standalone integer, e.g. 17, 8
	const pattern5 = /^(?:ساعت[\s\u200c]+)?([0-9]{1,2})$/u;

	let parsedH;
	let parsedM = 0;
	let parsedPeriod = null;
	let match;

	if ((match = text.match(pattern1))) {
		parsedPeriod = match[1].trim();
		parsedH = parseInt(match[2], 10);
		parsedM = match[3] !== undefined ? parseInt(match[3], 10) : 0;
	} else if ((match = text.match(pattern2))) {
		parsedH = parseInt(match[1], 10);
		parsedM = match[2] !== undefined ? parseInt(match[2], 10) : 0;
		parsedPeriod = match[3].trim();
	} else if ((match = text.match(pattern4))) {
		parsedH = parseInt(match[1], 10);
		parsedM = parseInt(match[2], 10);
	} else if ((match = text.match(pattern3))) {
		parsedH = parseInt(match[1], 10);
		parsedM = match[2] !== undefined ? parseInt(match[2], 10) : 0;
	} else if ((match = text.match(pattern5))) {
		parsedH = parseInt(match[1], 10);
		parsedM = 0;
	}

	if (parsedH === undefined) {
		return {
			resolved: false,
			isoDueDate: null,
			hour: null,
			minute: null,
			targetDateStr,
			isContradictory: false,
			isStillAmbiguous: false,
			errorReason: "UNRECOGNIZED_REPLY",
		};
	}

	if (parsedH < 0 || parsedH > 23 || parsedM < 0 || parsedM > 59) {
		return {
			resolved: false,
			isoDueDate: null,
			hour: null,
			minute: null,
			targetDateStr,
			isContradictory: false,
			isStillAmbiguous: false,
			errorReason: "INVALID_INPUT",
		};
	}

	let h24;
	if (parsedPeriod) {
		h24 = validateAndConvertPeriodHour(parsedH, parsedPeriod);

		// If the period cannot be applied to parsedH (e.g. "۱۲ صبح", "۱۷ صبح", "۵ ظهر", "۸ ظهر")
		if (h24 === null) {
			return {
				resolved: false,
				isoDueDate: null,
				hour: null,
				minute: null,
				targetDateStr,
				isContradictory: true,
				isStillAmbiguous: false,
				errorReason: "CONTRADICTORY_HOUR",
			};
		}

		// Consistency with ambiguous rawH
		const isConsistent = rawH === 12
			? (h24 === 12 || h24 === 0)
			: ((h24 % 12) === (rawH % 12));

		if (!isConsistent) {
			return {
				resolved: false,
				isoDueDate: null,
				hour: null,
				minute: null,
				targetDateStr,
				isContradictory: true,
				isStillAmbiguous: false,
				errorReason: "CONTRADICTORY_HOUR",
			};
		}
	} else {
		// No period in reply: check whether it's an explicit 24h format (13..23 or 0) vs still ambiguous (1..12)
		if (parsedH >= 13 && parsedH <= 23) {
			h24 = parsedH;
			if ((h24 % 12) !== (rawH % 12)) {
				return {
					resolved: false,
					isoDueDate: null,
					hour: null,
					minute: null,
					targetDateStr,
					isContradictory: true,
					isStillAmbiguous: false,
					errorReason: "CONTRADICTORY_HOUR",
				};
			}
		} else if (parsedH === 0) {
			h24 = 0;
			if (rawH !== 12) {
				return {
					resolved: false,
					isoDueDate: null,
					hour: null,
					minute: null,
					targetDateStr,
					isContradictory: true,
					isStillAmbiguous: false,
					errorReason: "CONTRADICTORY_HOUR",
				};
			}
		} else if (parsedH >= 1 && parsedH <= 12) {
			// Standalone 1..12 without period is still ambiguous (e.g. user answered "ساعت ۸" or "۸")
			return {
				resolved: false,
				isoDueDate: null,
				hour: null,
				minute: null,
				targetDateStr,
				isContradictory: false,
				isStillAmbiguous: true,
				errorReason: "STILL_AMBIGUOUS",
			};
		} else {
			return {
				resolved: false,
				isoDueDate: null,
				hour: null,
				minute: null,
				targetDateStr,
				isContradictory: false,
				isStillAmbiguous: false,
				errorReason: "INVALID_INPUT",
			};
		}
	}

	const hStr = String(h24).padStart(2, "0");
	const mStr = String(parsedM).padStart(2, "0");
	return {
		resolved: true,
		isoDueDate: `${targetDateStr}T${hStr}:${mStr}:00${TEHRAN_OFFSET}`,
		hour: h24,
		minute: parsedM,
		targetDateStr,
		isContradictory: false,
		isStillAmbiguous: false,
		errorReason: null,
	};
}

/**
 * Checks whether user input is an explicit cancellation phrase (e.g. لغو, کنسل, بیخیال, منصرف شدم).
 * Does NOT treat "نه" alone as cancel (caller context decides "نه"), and never treats replies
 * with time/numbers (e.g. "نه، ساعت ۵ عصر") as cancel.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isExplicitCancelText(text) {
	if (!text || typeof text !== "string") {
		return false;
	}

	let normalized = text
		.trim()
		.replace(/[\u200c\u200b]/g, " ")
		.replace(/ي/g, "ی")
		.replace(/ك/g, "ک")
		.replace(/\s+/g, " ");

	// Strip edge punctuation
	normalized = normalized.replace(/^[.,!?؛،\-_/\\*#@~()]+\s*/, "").replace(/\s*[.,!?؛،\-_/\\*#@~()]+$/, "");

	// If the reply mentions any time keyword, hours, or digits, it is NOT an explicit cancel
	if (/(?:صبح|عصر|شب|ظهر|بامداد|ساعت|[0-9۰-۹])/iu.test(normalized)) {
		return false;
	}

	const cancelPattern = /^(?:لطف[ااً]\s+)?(?:دیگه\s+)?(?:لغو(?:ش)?|کنسل(?:ش)?|بی\s*خیال(?:ش)?|منصرف\s*شدم|انصراف|نمی\s*خوام)(?:\s*(?:کن|کنید|شو|بشو|باشه|هستم))?$/iu;

	return cancelPattern.test(normalized);
}
