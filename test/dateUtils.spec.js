import { describe, it, expect } from "vitest";
import {
	getTehranDateParts,
	getTehranContextString,
	formatPersianDateTime,
	isTodayInTehran,
	isOverdueInTehran,
	toEnglishDigits,
	extractPersianDateTime,
	isValidIsoDueDate,
	resolveAmbiguousHourResponse,
	isExplicitCancelText,
	jalaliToGregorian,
	gregorianToJalali,
	isLeapJalaliYear,
	getJalaliMonthDays,
	isValidJalaliDate,
	isBeyondCalendarOneYear,
	getTehranPersianDateParts,
	SOLAR_MONTH_NAMES,
	PERSIAN_DAY_WORDS,
	PERSIAN_NUMBER_WORDS,
	TIMEZONE,
} from "../src/dateUtils.js";

describe("Date & Time Utilities (Asia/Tehran)", () => {
	it("uses Asia/Tehran timezone constant", () => {
		expect(TIMEZONE).toBe("Asia/Tehran");
	});

	it("extracts Tehran date parts correctly", () => {
		const fixedDate = new Date("2026-11-02T12:00:00Z"); // 15:30 in Tehran (+03:30)
		const parts = getTehranDateParts(fixedDate);
		expect(parts.year).toBe(2026);
		expect(parts.month).toBe(11);
		expect(parts.day).toBe(2);
		expect(parts.hour).toBe(15);
		expect(parts.minute).toBe(30);
	});

	it("generates Persian context string with weekday and time", () => {
		const fixedDate = new Date("2026-11-02T12:00:00Z");
		const context = getTehranContextString(fixedDate);
		expect(context.tehranDate).toBe("2026-11-02");
		expect(context.tehranTime).toBe("15:30");
		expect(context.persianFull).toBeDefined();
		expect(typeof context.persianFull).toBe("string");
		expect(context.weekday).toBeDefined();
	});

	it("formats Persian date time nicely", () => {
		const now = new Date();
		const formattedNow = formatPersianDateTime(now.toISOString());
		expect(formattedNow).toContain("امروز");

		const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
		const formattedTomorrow = formatPersianDateTime(tomorrow.toISOString());
		expect(formattedTomorrow).toContain("فردا");
	});

	it("accurately detects if date is today in Tehran", () => {
		const now = new Date();
		expect(isTodayInTehran(now.toISOString())).toBe(true);

		const yesterday = new Date(now.getTime() - 48 * 60 * 60 * 1000);
		expect(isTodayInTehran(yesterday.toISOString())).toBe(false);
	});

	it("detects overdue dates in Tehran", () => {
		const past = new Date(Date.now() - 48 * 60 * 60 * 1000);
		expect(isOverdueInTehran(past.toISOString())).toBe(true);

		const future = new Date(Date.now() + 48 * 60 * 60 * 1000);
		expect(isOverdueInTehran(future.toISOString())).toBe(false);

		// Fixed base time: 2026-11-04 at 13:30 Tehran time (10:00 UTC)
		const fixedOverdueBase = new Date("2026-11-04T10:00:00Z");

		// Date-only for today: not overdue (the day is still active)
		expect(isOverdueInTehran("2026-11-04", fixedOverdueBase)).toBe(false);

		// Date-only for yesterday: overdue
		expect(isOverdueInTehran("2026-11-03", fixedOverdueBase)).toBe(true);

		// Today with hour that has already passed: overdue
		expect(isOverdueInTehran("2026-11-04T10:00:00+03:30", fixedOverdueBase)).toBe(true);

		// Today with hour in the future: not overdue
		expect(isOverdueInTehran("2026-11-04T16:00:00+03:30", fixedOverdueBase)).toBe(false);
	});

	it("converts Persian and Arabic digits to English digits", () => {
		expect(toEnglishDigits("۱۲۳۴۵")).toBe("12345");
		expect(toEnglishDigits("٠١٢٣٤")).toBe("01234");
		expect(toEnglishDigits("ساعت ۱۷:۳۰")).toBe("ساعت 17:30");
	});

	describe("extractPersianDateTime", () => {
		const fixedBase = new Date("2026-11-03T10:00:00Z"); // Tuesday, Nov 3 2026, 13:30 Tehran

		it("extracts 'فردا ساعت ۱۷:۳۰' correctly", () => {
			const res = extractPersianDateTime("باید فردا ساعت ۱۷:۳۰ به مادرم زنگ بزنم", fixedBase);
			expect(res.hasDate).toBe(true);
			expect(res.isoDueDate).toContain("2026-11-04T17:30:00+03:30");
			expect(res.cleanedText).toContain("به مادرم زنگ بزنم");
		});

		it("extracts 'فردا ساعت ۵ عصر'", () => {
			const res = extractPersianDateTime("فردا ساعت ۵ عصر برم دکتر", fixedBase);
			expect(res.hasDate).toBe(true);
			expect(res.isoDueDate).toContain("2026-11-04T17:00:00+03:30");
			expect(res.cleanedText).toContain("برم دکتر");
		});

		it("extracts 'ساعت ۸ صبح'", () => {
			const res = extractPersianDateTime("ساعت ۸ صبح ورزش کنم", fixedBase);
			expect(res.hasDate).toBe(true);
			expect(res.isoDueDate).toContain("08:00:00+03:30");
			expect(res.cleanedText).toContain("ورزش کنم");
		});

		it("extracts 'پس‌فردا'", () => {
			const res = extractPersianDateTime("پس‌فردا خرید کتاب", fixedBase);
			expect(res.hasDate).toBe(true);
			expect(res.isoDueDate).toContain("2026-11-05");
			expect(res.cleanedText).toContain("خرید کتاب");
		});

		it("treats all hours 1-12 without period qualifier as ambiguous (preserving targetDateStr and nullifying isoDueDate)", () => {
			// 1. «موعد تسک خرید نان رو ببر برای فردا ساعت ۵» -> ambiguous hour 5, tomorrow's date preserved in targetDateStr, isoDueDate null
			const resHour5 = extractPersianDateTime("موعد تسک خرید نان رو ببر برای فردا ساعت ۵", fixedBase);
			expect(resHour5.hasDate).toBe(true);
			expect(resHour5.isAmbiguousTime).toBe(true);
			expect(resHour5.ambiguousHour).toBe(5);
			expect(resHour5.hasTime).toBe(false);
			expect(resHour5.needsClarification).toBe(true);
			expect(resHour5.clarificationType).toBe("ambiguous_time");
			expect(resHour5.targetDateStr).toBe("2026-11-04");
			expect(resHour5.isoDueDate).toBeNull();

			// 2. «فردا ساعت ۸ یادم بنداز برم دکتر» -> ambiguous hour 8
			const resHour8 = extractPersianDateTime("فردا ساعت ۸ یادم بنداز برم دکتر", fixedBase);
			expect(resHour8.hasDate).toBe(true);
			expect(resHour8.isAmbiguousTime).toBe(true);
			expect(resHour8.ambiguousHour).toBe(8);
			expect(resHour8.hasTime).toBe(false);
			expect(resHour8.needsClarification).toBe(true);
			expect(resHour8.clarificationType).toBe("ambiguous_time");
			expect(resHour8.targetDateStr).toBe("2026-11-04");
			expect(resHour8.isoDueDate).toBeNull();

			// 3. «ساعت ۱۲» without period -> ambiguous hour 12
			const resHour12 = extractPersianDateTime("ساعت ۱۲ جلسه دارم", fixedBase);
			expect(resHour12.hasDate).toBe(true);
			expect(resHour12.isAmbiguousTime).toBe(true);
			expect(resHour12.ambiguousHour).toBe(12);
			expect(resHour12.hasTime).toBe(false);
			expect(resHour12.needsClarification).toBe(true);
			expect(resHour12.clarificationType).toBe("ambiguous_time");
			expect(resHour12.isoDueDate).toBeNull();

			// 4. «ساعت ۳ یادم بنداز برم دکتر» -> ambiguous hour 3 without explicit date
			const resNoDate = extractPersianDateTime("ساعت ۳ یادم بنداز برم دکتر", fixedBase);
			expect(resNoDate.hasDate).toBe(true);
			expect(resNoDate.isAmbiguousTime).toBe(true);
			expect(resNoDate.ambiguousHour).toBe(3);
			expect(resNoDate.hasTime).toBe(false);
			expect(resNoDate.needsClarification).toBe(true);
			expect(resNoDate.clarificationType).toBe("ambiguous_time");
			expect(resNoDate.isoDueDate).toBeNull();

			// 5. «فردا یادم بنداز برم دکتر» -> explicit date without time remains valid date-only
			const resDateOnly = extractPersianDateTime("فردا یادم بنداز برم دکتر", fixedBase);
			expect(resDateOnly.hasDate).toBe(true);
			expect(resDateOnly.hasTime).toBe(false);
			expect(resDateOnly.isAmbiguousTime).toBe(false);
			expect(resDateOnly.isoDueDate).toBe("2026-11-04");
			expect(resDateOnly.targetDateStr).toBe("2026-11-04");

			// 6. Invalid hour (25) -> rejected
			const resInvalid = extractPersianDateTime("فردا ساعت ۲۵ یادم بنداز برم دکتر", fixedBase);
			expect(resInvalid.isInvalidTime).toBe(true);
			expect(resInvalid.hasDate).toBe(false);
			expect(resInvalid.isoDueDate).toBeNull();
		});

		it("correctly parses qualified hours and 24-hour format hours (00 and 13-23)", () => {
			// 5 صبح -> 05:00
			const res5Morning = extractPersianDateTime("فردا ساعت ۵ صبح بیدار شم", fixedBase);
			expect(res5Morning.hasDate).toBe(true);
			expect(res5Morning.isAmbiguousTime).toBe(false);
			expect(res5Morning.isoDueDate).toBe("2026-11-04T05:00:00+03:30");

			// 5 عصر -> 17:00
			const res5Afternoon = extractPersianDateTime("فردا ساعت ۵ عصر جلسه", fixedBase);
			expect(res5Afternoon.hasDate).toBe(true);
			expect(res5Afternoon.isAmbiguousTime).toBe(false);
			expect(res5Afternoon.isoDueDate).toBe("2026-11-04T17:00:00+03:30");

			// 8 شب -> 20:00
			const res8Night = extractPersianDateTime("فردا ۸ شب شام", fixedBase);
			expect(res8Night.hasDate).toBe(true);
			expect(res8Night.isAmbiguousTime).toBe(false);
			expect(res8Night.isoDueDate).toBe("2026-11-04T20:00:00+03:30");

			// 12 ظهر -> 12:00
			const res12Noon = extractPersianDateTime("فردا ساعت ۱۲ ظهر ناهار", fixedBase);
			expect(res12Noon.hasDate).toBe(true);
			expect(res12Noon.isAmbiguousTime).toBe(false);
			expect(res12Noon.isoDueDate).toBe("2026-11-04T12:00:00+03:30");

			// 12 نیمه‌شب -> 00:00
			const res12Midnight = extractPersianDateTime("فردا ۱۲ نیمه‌شب بخوابم", fixedBase);
			expect(res12Midnight.hasDate).toBe(true);
			expect(res12Midnight.isAmbiguousTime).toBe(false);
			expect(res12Midnight.isoDueDate).toBe("2026-11-04T00:00:00+03:30");

			// 24-hr format: ساعت ۱۷
			const res17 = extractPersianDateTime("فردا ساعت ۱۷ ورزش", fixedBase);
			expect(res17.hasDate).toBe(true);
			expect(res17.isAmbiguousTime).toBe(false);
			expect(res17.isoDueDate).toBe("2026-11-04T17:00:00+03:30");

			// 24-hr format: ساعت ۰۰
			const res00 = extractPersianDateTime("فردا ساعت ۰۰ استراحت", fixedBase);
			expect(res00.hasDate).toBe(true);
			expect(res00.isAmbiguousTime).toBe(false);
			expect(res00.isoDueDate).toBe("2026-11-04T00:00:00+03:30");

			// 24-hr format: ساعت ۲۱
			const res21 = extractPersianDateTime("فردا ساعت ۲۱ مطالعه", fixedBase);
			expect(res21.hasDate).toBe(true);
			expect(res21.isAmbiguousTime).toBe(false);
			expect(res21.isoDueDate).toBe("2026-11-04T21:00:00+03:30");
		});

		it("supports weekday spelling variants (space, ZWNJ, compound words)", () => {
			// Sunday variants
			const rSun1 = extractPersianDateTime("یک شنبه ساعت ۱۰ صبح خرید", fixedBase);
			expect(rSun1.hasDate).toBe(true);
			expect(rSun1.isoDueDate).toContain("2026-11-08T10:00:00+03:30");

			const rSun2 = extractPersianDateTime("یک‌شنبه ساعت ۱۰ صبح خرید", fixedBase);
			expect(rSun2.hasDate).toBe(true);
			expect(rSun2.isoDueDate).toContain("2026-11-08T10:00:00+03:30");

			const rSun3 = extractPersianDateTime("یکشنبه ساعت ۱۰ صبح خرید", fixedBase);
			expect(rSun3.hasDate).toBe(true);
			expect(rSun3.isoDueDate).toContain("2026-11-08T10:00:00+03:30");

			// Monday variants
			const rMon1 = extractPersianDateTime("دو شنبه ساعت ۱۶ جلسه", fixedBase);
			expect(rMon1.hasDate).toBe(true);
			expect(rMon1.isoDueDate).toContain("2026-11-09T16:00:00+03:30");

			const rMon2 = extractPersianDateTime("دو‌شنبه ساعت ۱۶ جلسه", fixedBase);
			expect(rMon2.hasDate).toBe(true);
			expect(rMon2.isoDueDate).toContain("2026-11-09T16:00:00+03:30");

			// Thursday variants
			const rThu1 = extractPersianDateTime("پنج‌شنبه ساعت ۱۵ کارگاه", fixedBase);
			expect(rThu1.hasDate).toBe(true);
			expect(rThu1.isoDueDate).toContain("2026-11-05T15:00:00+03:30");

			const rThu2 = extractPersianDateTime("پنج شنبه ساعت ۱۵ کارگاه", fixedBase);
			expect(rThu2.hasDate).toBe(true);
			expect(rThu2.isoDueDate).toContain("2026-11-05T15:00:00+03:30");

			// Saturday
			const rSat = extractPersianDateTime("شنبه ساعت ۱۸ گزارش", fixedBase);
			expect(rSat.hasDate).toBe(true);
			expect(rSat.isoDueDate).toContain("2026-11-07T18:00:00+03:30");
		});

		it("does not falsely extract 'شنبه' from derived or attached words (word boundary check)", () => {
			const res = extractPersianDateTime("کتاب شنبه‌ای خریدم", fixedBase);
			expect(res.hasDate).toBe(false);
			expect(res.isoDueDate).toBeNull();
		});

		it("handles current day with future hour vs past hour (Rule 2)", () => {
			// Base: Saturday 2026-11-07 at 13:30 Tehran time (10:00 UTC)
			const saturdayBase = new Date("2026-11-07T10:00:00Z");

			// Future hour on Saturday: stays on today (2026-11-07)
			const futureRes = extractPersianDateTime("شنبه ساعت ۱۸ گزارش بدم", saturdayBase);
			expect(futureRes.hasDate).toBe(true);
			expect(futureRes.isoDueDate).toBe("2026-11-07T18:00:00+03:30");

			// Past hour on Saturday (10:00 AM passed): moves to next Saturday (+7 days -> 2026-11-14)
			const pastRes = extractPersianDateTime("شنبه ساعت ۱۰ صبح ورزش کنم", saturdayBase);
			expect(pastRes.hasDate).toBe(true);
			expect(pastRes.isoDueDate).toBe("2026-11-14T10:00:00+03:30");
		});

		it("extracts time without the word 'ساعت'", () => {
			const res1 = extractPersianDateTime("فردا ۹ صبح جلسه دارم", fixedBase);
			expect(res1.hasDate).toBe(true);
			expect(res1.isoDueDate).toBe("2026-11-04T09:00:00+03:30");
			expect(res1.cleanedText).toBe("جلسه دارم");

			const res2 = extractPersianDateTime("فردا ۶ عصر استخر برم", fixedBase);
			expect(res2.hasDate).toBe(true);
			expect(res2.isoDueDate).toBe("2026-11-04T18:00:00+03:30");
			expect(res2.cleanedText).toBe("استخر برم");
		});

		it("supports time periods before or after the hour", () => {
			// Period before hour
			const resBefore = extractPersianDateTime("فردا صبح ساعت ۹ پیاده‌روی", fixedBase);
			expect(resBefore.hasDate).toBe(true);
			expect(resBefore.isoDueDate).toBe("2026-11-04T09:00:00+03:30");
			expect(resBefore.cleanedText).toBe("پیاده‌روی");

			// Period after hour
			const resAfter = extractPersianDateTime("فردا عصر ساعت ۶ کلاس زبان", fixedBase);
			expect(resAfter.hasDate).toBe(true);
			expect(resAfter.isoDueDate).toBe("2026-11-04T18:00:00+03:30");
			expect(resAfter.cleanedText).toBe("کلاس زبان");
		});

		it("correctly handles 'امشب ساعت ۸' as 20:00", () => {
			const res = extractPersianDateTime("امشب ساعت ۸ با دوستان شام", fixedBase);
			expect(res.hasDate).toBe(true);
			expect(res.isoDueDate).toBe("2026-11-03T20:00:00+03:30");
			expect(res.cleanedText).toBe("با دوستان شام");
		});

		it("correctly converts 12 ظهر to 12:00 and 12 شب to 00:00", () => {
			const resNoon = extractPersianDateTime("فردا ۱۲ ظهر ناهار با تیم", fixedBase);
			expect(resNoon.hasDate).toBe(true);
			expect(resNoon.isoDueDate).toBe("2026-11-04T12:00:00+03:30");
			expect(resNoon.cleanedText).toBe("ناهار با تیم");

			const resMidnight = extractPersianDateTime("فردا ۱۲ شب خواب", fixedBase);
			expect(resMidnight.hasDate).toBe(true);
			expect(resMidnight.isoDueDate).toBe("2026-11-04T00:00:00+03:30");
			expect(resMidnight.cleanedText).toBe("خواب");
		});

		it("handles 24-hour format and minutes (e.g. ۱۸:۳۰)", () => {
			const res = extractPersianDateTime("فردا ساعت ۱۸:۳۰ مسابقه فوتبال", fixedBase);
			expect(res.hasDate).toBe(true);
			expect(res.isoDueDate).toBe("2026-11-04T18:30:00+03:30");
			expect(res.cleanedText).toBe("مسابقه فوتبال");
		});

		it("rejects invalid hours and minutes without producing valid dates", () => {
			const resHour = extractPersianDateTime("ساعت ۲۵:۰۰ خطا", fixedBase);
			expect(resHour.isInvalidTime).toBe(true);
			expect(resHour.hasDate).toBe(false);
			expect(resHour.isoDueDate).toBeNull();

			const resMin = extractPersianDateTime("ساعت ۱۲:۷۵ خطا", fixedBase);
			expect(resMin.isInvalidTime).toBe(true);
			expect(resMin.hasDate).toBe(false);
			expect(resMin.isoDueDate).toBeNull();
		});

		it("handles 'آخر هفته' by requesting clarification without guessing Thursday or Friday", () => {
			const res = extractPersianDateTime("آخر هفته بریم شمال", fixedBase);
			expect(res.hasDate).toBe(true);
			expect(res.needsClarification).toBe(true);
			expect(res.clarificationType).toBe("weekend");
			expect(res.isoDueDate).toBeNull();
			expect(res.cleanedText).toBe("بریم شمال");
		});

		it("handles 'هفته بعد' alone by requesting clarification, or schedules with weekday", () => {
			// Alone -> needs clarification
			const resAlone = extractPersianDateTime("هفته بعد گزارش پروژه", fixedBase);
			expect(resAlone.hasDate).toBe(true);
			expect(resAlone.needsClarification).toBe(true);
			expect(resAlone.clarificationType).toBe("next_week");
			expect(resAlone.isoDueDate).toBeNull();
			expect(resAlone.cleanedText).toBe("گزارش پروژه");

			// Combined with weekday -> advances to next week's occurrence
			const resWithDay = extractPersianDateTime("شنبه هفته بعد ساعت ۱۰ صبح کارگاه", fixedBase);
			expect(resWithDay.hasDate).toBe(true);
			expect(resWithDay.needsClarification).toBe(false);
			expect(resWithDay.isoDueDate).toBe("2026-11-14T10:00:00+03:30");
		});
	});

	describe("resolveAmbiguousHourResponse and isExplicitCancelText", () => {
		const targetDate = "2026-11-07";

		it("resolves 'صبح' for ambiguous hour", () => {
			const res5 = resolveAmbiguousHourResponse(5, "صبح", targetDate);
			expect(res5.resolved).toBe(true);
			expect(res5.isoDueDate).toBe("2026-11-07T05:00:00+03:30");
			expect(res5.hour).toBe(5);
			expect(res5.minute).toBe(0);
			expect(res5.targetDateStr).toBe(targetDate);
			expect(res5.isContradictory).toBe(false);
			expect(res5.isStillAmbiguous).toBe(false);

			const res8 = resolveAmbiguousHourResponse("۸", "صبح", targetDate);
			expect(res8.resolved).toBe(true);
			expect(res8.isoDueDate).toBe("2026-11-07T08:00:00+03:30");
			expect(res8.hour).toBe(8);
		});

		it("resolves 'عصر' for ambiguous hour", () => {
			const res5 = resolveAmbiguousHourResponse(5, "عصر", targetDate);
			expect(res5.resolved).toBe(true);
			expect(res5.isoDueDate).toBe("2026-11-07T17:00:00+03:30");
			expect(res5.hour).toBe(17);
			expect(res5.minute).toBe(0);
			expect(res5.targetDateStr).toBe(targetDate);

			const res3 = resolveAmbiguousHourResponse(3, "بعدازظهر", targetDate);
			expect(res3.resolved).toBe(true);
			expect(res3.isoDueDate).toBe("2026-11-07T15:00:00+03:30");
			expect(res3.hour).toBe(15);
		});

		it("resolves 'شب' for ambiguous hour", () => {
			const res8 = resolveAmbiguousHourResponse(8, "شب", targetDate);
			expect(res8.resolved).toBe(true);
			expect(res8.isoDueDate).toBe("2026-11-07T20:00:00+03:30");
			expect(res8.hour).toBe(20);
			expect(res8.minute).toBe(0);

			const res9 = resolveAmbiguousHourResponse(9, "شب", targetDate);
			expect(res9.resolved).toBe(true);
			expect(res9.isoDueDate).toBe("2026-11-07T21:00:00+03:30");
			expect(res9.hour).toBe(21);
		});

		it("resolves 'ظهر' for hour 12 as 12:00", () => {
			const res = resolveAmbiguousHourResponse(12, "ظهر", targetDate);
			expect(res.resolved).toBe(true);
			expect(res.isoDueDate).toBe("2026-11-07T12:00:00+03:30");
			expect(res.hour).toBe(12);
			expect(res.minute).toBe(0);
		});

		it("resolves 'نیمه‌شب' and 'شب' for hour 12 as 00:00", () => {
			const resMidnight = resolveAmbiguousHourResponse(12, "نیمه‌شب", targetDate);
			expect(resMidnight.resolved).toBe(true);
			expect(resMidnight.isoDueDate).toBe("2026-11-07T00:00:00+03:30");
			expect(resMidnight.hour).toBe(0);
			expect(resMidnight.minute).toBe(0);

			const resNight = resolveAmbiguousHourResponse(12, "شب", targetDate);
			expect(resNight.resolved).toBe(true);
			expect(resNight.isoDueDate).toBe("2026-11-07T00:00:00+03:30");
			expect(resNight.hour).toBe(0);
		});

		it("resolves compatible 24-hour numeric reply (e.g. ۱۷ or 17:00)", () => {
			const res17 = resolveAmbiguousHourResponse(5, "۱۷", targetDate);
			expect(res17.resolved).toBe(true);
			expect(res17.isoDueDate).toBe("2026-11-07T17:00:00+03:30");
			expect(res17.hour).toBe(17);

			const resColon = resolveAmbiguousHourResponse(5, "17:00", targetDate);
			expect(resColon.resolved).toBe(true);
			expect(resColon.isoDueDate).toBe("2026-11-07T17:00:00+03:30");

			const resMinutes = resolveAmbiguousHourResponse(5, "ساعت ۱۷:۳۰", targetDate);
			expect(resMinutes.resolved).toBe(true);
			expect(resMinutes.isoDueDate).toBe("2026-11-07T17:30:00+03:30");
			expect(resMinutes.hour).toBe(17);
			expect(resMinutes.minute).toBe(30);
		});

		it("resolves compatible reply containing period qualifier (e.g. ۵ عصر or ۵ صبح)", () => {
			const resAfternoon = resolveAmbiguousHourResponse(5, "ساعت ۵ عصر", targetDate);
			expect(resAfternoon.resolved).toBe(true);
			expect(resAfternoon.isoDueDate).toBe("2026-11-07T17:00:00+03:30");

			const resMorning = resolveAmbiguousHourResponse(5, "۵ صبح", targetDate);
			expect(resMorning.resolved).toBe(true);
			expect(resMorning.isoDueDate).toBe("2026-11-07T05:00:00+03:30");

			const resNight = resolveAmbiguousHourResponse(8, "۸ شب", targetDate);
			expect(resNight.resolved).toBe(true);
			expect(resNight.isoDueDate).toBe("2026-11-07T20:00:00+03:30");

			const resNoon = resolveAmbiguousHourResponse(12, "۱۲ ظهر", targetDate);
			expect(resNoon.resolved).toBe(true);
			expect(resNoon.isoDueDate).toBe("2026-11-07T12:00:00+03:30");
		});

		it("rejects ambiguous numeric reply without period (e.g. ساعت ۸ or ۸ or ساعت ۵)", () => {
			const res8 = resolveAmbiguousHourResponse(5, "ساعت ۸", targetDate);
			expect(res8.resolved).toBe(false);
			expect(res8.isStillAmbiguous).toBe(true);
			expect(res8.errorReason).toBe("STILL_AMBIGUOUS");
			expect(res8.isoDueDate).toBeNull();

			const res5Alone = resolveAmbiguousHourResponse(5, "ساعت ۵", targetDate);
			expect(res5Alone.resolved).toBe(false);
			expect(res5Alone.isStillAmbiguous).toBe(true);
			expect(res5Alone.errorReason).toBe("STILL_AMBIGUOUS");

			const resNumberOnly = resolveAmbiguousHourResponse(5, "۸", targetDate);
			expect(resNumberOnly.resolved).toBe(false);
			expect(resNumberOnly.isStillAmbiguous).toBe(true);
			expect(resNumberOnly.errorReason).toBe("STILL_AMBIGUOUS");
		});

		it("rejects contradictory reply (e.g. 5 vs 8 شب or 5 vs ۲۰ or 5 vs ظهر)", () => {
			const res8Night = resolveAmbiguousHourResponse(5, "۸ شب", targetDate);
			expect(res8Night.resolved).toBe(false);
			expect(res8Night.isContradictory).toBe(true);
			expect(res8Night.errorReason).toBe("CONTRADICTORY_HOUR");
			expect(res8Night.isoDueDate).toBeNull();

			const res20 = resolveAmbiguousHourResponse(5, "۲۰", targetDate);
			expect(res20.resolved).toBe(false);
			expect(res20.isContradictory).toBe(true);
			expect(res20.errorReason).toBe("CONTRADICTORY_HOUR");

			const resNoonOn5 = resolveAmbiguousHourResponse(5, "ظهر", targetDate);
			expect(resNoonOn5.resolved).toBe(false);
			expect(resNoonOn5.isContradictory).toBe(true);
			expect(resNoonOn5.errorReason).toBe("CONTRADICTORY_HOUR");

			const res12Conflict = resolveAmbiguousHourResponse(12, "۳ عصر", targetDate);
			expect(res12Conflict.resolved).toBe(false);
			expect(res12Conflict.isContradictory).toBe(true);
			expect(res12Conflict.errorReason).toBe("CONTRADICTORY_HOUR");
		});

		it("rejects invalid ambiguous hour input (e.g. 15, 0, -1, non-number)", () => {
			const res15 = resolveAmbiguousHourResponse(15, "صبح", targetDate);
			expect(res15.resolved).toBe(false);
			expect(res15.errorReason).toBe("INVALID_INPUT");

			const res0 = resolveAmbiguousHourResponse(0, "صبح", targetDate);
			expect(res0.resolved).toBe(false);
			expect(res0.errorReason).toBe("INVALID_INPUT");

			const resNegative = resolveAmbiguousHourResponse(-1, "عصر", targetDate);
			expect(resNegative.resolved).toBe(false);
			expect(resNegative.errorReason).toBe("INVALID_INPUT");

			const resNaN = resolveAmbiguousHourResponse("نامعتبر", "صبح", targetDate);
			expect(resNaN.resolved).toBe(false);
			expect(resNaN.errorReason).toBe("INVALID_INPUT");
		});

		it("rejects invalid targetDateStr (e.g. 2026-02-31, invalid format, null)", () => {
			const resLeap = resolveAmbiguousHourResponse(5, "صبح", "2026-02-31");
			expect(resLeap.resolved).toBe(false);
			expect(resLeap.errorReason).toBe("INVALID_TARGET_DATE");

			const resFormat = resolveAmbiguousHourResponse(5, "عصر", "not-a-date");
			expect(resFormat.resolved).toBe(false);
			expect(resFormat.errorReason).toBe("INVALID_TARGET_DATE");

			const resNull = resolveAmbiguousHourResponse(5, "عصر", null);
			expect(resNull.resolved).toBe(false);
			expect(resNull.errorReason).toBe("INVALID_TARGET_DATE");
		});

		it("strictly preserves initial target date without recalculating or guessing", () => {
			const customFutureDate = "2027-08-25";
			const res = resolveAmbiguousHourResponse(5, "عصر", customFutureDate);
			expect(res.resolved).toBe(true);
			expect(res.targetDateStr).toBe(customFutureDate);
			expect(res.isoDueDate).toBe("2027-08-25T17:00:00+03:30");
		});

		it("strictly verifies the mandatory 12-case specification table", () => {
			// Row 1: 12 + "۱۲ صبح" -> رد (REJECT)
			const r1 = resolveAmbiguousHourResponse(12, "۱۲ صبح", targetDate);
			expect(r1.resolved).toBe(false);
			expect(r1.isContradictory).toBe(true);

			// Row 2: 12 + "۱۲ ظهر" -> 12:00
			const r2 = resolveAmbiguousHourResponse(12, "۱۲ ظهر", targetDate);
			expect(r2.resolved).toBe(true);
			expect(r2.isoDueDate).toBe("2026-11-07T12:00:00+03:30");

			// Row 3: 12 + "۱۲ شب" -> 00:00
			const r3 = resolveAmbiguousHourResponse(12, "۱۲ شب", targetDate);
			expect(r3.resolved).toBe(true);
			expect(r3.isoDueDate).toBe("2026-11-07T00:00:00+03:30");

			// Row 4: 5 + "۵ صبح" -> 05:00
			const r4 = resolveAmbiguousHourResponse(5, "۵ صبح", targetDate);
			expect(r4.resolved).toBe(true);
			expect(r4.isoDueDate).toBe("2026-11-07T05:00:00+03:30");

			// Row 5: 5 + "۵ عصر" -> 17:00
			const r5 = resolveAmbiguousHourResponse(5, "۵ عصر", targetDate);
			expect(r5.resolved).toBe(true);
			expect(r5.isoDueDate).toBe("2026-11-07T17:00:00+03:30");

			// Row 6: 5 + "۵ ظهر" -> رد (REJECT)
			const r6 = resolveAmbiguousHourResponse(5, "۵ ظهر", targetDate);
			expect(r6.resolved).toBe(false);
			expect(r6.isContradictory).toBe(true);

			// Row 7: 5 + "۱۷" -> 17:00
			const r7 = resolveAmbiguousHourResponse(5, "۱۷", targetDate);
			expect(r7.resolved).toBe(true);
			expect(r7.isoDueDate).toBe("2026-11-07T17:00:00+03:30");

			// Row 8: 5 + "۱۷ صبح" -> رد (REJECT)
			const r8 = resolveAmbiguousHourResponse(5, "۱۷ صبح", targetDate);
			expect(r8.resolved).toBe(false);
			expect(r8.isContradictory).toBe(true);

			// Row 9: 8 + "۸ شب" -> 20:00
			const r9 = resolveAmbiguousHourResponse(8, "۸ شب", targetDate);
			expect(r9.resolved).toBe(true);
			expect(r9.isoDueDate).toBe("2026-11-07T20:00:00+03:30");

			// Row 10: 8 + "۸ عصر" -> 20:00
			const r10 = resolveAmbiguousHourResponse(8, "۸ عصر", targetDate);
			expect(r10.resolved).toBe(true);
			expect(r10.isoDueDate).toBe("2026-11-07T20:00:00+03:30");

			// Row 11: 8 + "۸ ظهر" -> رد (REJECT)
			const r11 = resolveAmbiguousHourResponse(8, "۸ ظهر", targetDate);
			expect(r11.resolved).toBe(false);
			expect(r11.isContradictory).toBe(true);

			// Row 12: 8 + "۲۰" -> 20:00
			const r12 = resolveAmbiguousHourResponse(8, "۲۰", targetDate);
			expect(r12.resolved).toBe(true);
			expect(r12.isoDueDate).toBe("2026-11-07T20:00:00+03:30");
		});

		it("validates minutes between 00 and 59 and rejects invalid minutes or hours >= 24", () => {
			// Valid minutes
			const res00 = resolveAmbiguousHourResponse(5, "ساعت ۱۷:۰۰", targetDate);
			expect(res00.resolved).toBe(true);
			expect(res00.minute).toBe(0);

			const res45 = resolveAmbiguousHourResponse(5, "ساعت ۵:۴۵ عصر", targetDate);
			expect(res45.resolved).toBe(true);
			expect(res45.minute).toBe(45);
			expect(res45.isoDueDate).toBe("2026-11-07T17:45:00+03:30");

			const res59 = resolveAmbiguousHourResponse(5, "ساعت ۱۷:۵۹", targetDate);
			expect(res59.resolved).toBe(true);
			expect(res59.minute).toBe(59);

			// Invalid minutes
			const resMin60 = resolveAmbiguousHourResponse(5, "ساعت ۱۷:۶۰", targetDate);
			expect(resMin60.resolved).toBe(false);
			expect(resMin60.errorReason).toBe("INVALID_INPUT");

			const resMin75 = resolveAmbiguousHourResponse(5, "ساعت ۵:۷۵ عصر", targetDate);
			expect(resMin75.resolved).toBe(false);
			expect(resMin75.errorReason).toBe("INVALID_INPUT");

			// Invalid hours >= 24
			const resH24 = resolveAmbiguousHourResponse(5, "ساعت ۲۴:۰۰", targetDate);
			expect(resH24.resolved).toBe(false);
			expect(resH24.errorReason).toBe("INVALID_INPUT");

			const resH25 = resolveAmbiguousHourResponse(5, "ساعت ۲۵", targetDate);
			expect(resH25.resolved).toBe(false);
			expect(resH25.errorReason).toBe("INVALID_INPUT");
		});

		it("detects valid explicit cancellation phrases", () => {
			expect(isExplicitCancelText("لغو")).toBe(true);
			expect(isExplicitCancelText("لغو کن")).toBe(true);
			expect(isExplicitCancelText("لطفا لغو کن")).toBe(true);
			expect(isExplicitCancelText("کنسل")).toBe(true);
			expect(isExplicitCancelText("کنسلش کن")).toBe(true);
			expect(isExplicitCancelText("لغوش کن")).toBe(true);
			expect(isExplicitCancelText("بیخیال")).toBe(true);
			expect(isExplicitCancelText("بی‌خیال")).toBe(true);
			expect(isExplicitCancelText("بیخیالش")).toBe(true);
			expect(isExplicitCancelText("منصرف شدم")).toBe(true);
			expect(isExplicitCancelText("انصراف")).toBe(true);
			expect(isExplicitCancelText("نمیخوام")).toBe(true);
			expect(isExplicitCancelText("نمی‌خوام")).toBe(true);
			expect(isExplicitCancelText("دیگه نمی‌خوام")).toBe(true);
		});

		it("rejects non-cancellation phrases, especially 'نه، ساعت ۵ عصر'", () => {
			expect(isExplicitCancelText("نه، ساعت ۵ عصر")).toBe(false);
			expect(isExplicitCancelText("نه")).toBe(false);
			expect(isExplicitCancelText("نه ساعت ۵")).toBe(false);
			expect(isExplicitCancelText("سلام")).toBe(false);
			expect(isExplicitCancelText("ساعت ۵")).toBe(false);
			expect(isExplicitCancelText("باشه")).toBe(false);
			expect(isExplicitCancelText("")).toBe(false);
			expect(isExplicitCancelText(null)).toBe(false);
			expect(isExplicitCancelText(undefined)).toBe(false);
		});
	});

	describe("Solar Hijri (Jalali) Calendar & Extended Relative Dates - Phase 1", () => {
		it("converts between Jalali and Gregorian accurately against Intl reference", () => {
			const intlFormatter = new Intl.DateTimeFormat("en-US-u-ca-persian", {
				timeZone: "Asia/Tehran",
				year: "numeric",
				month: "numeric",
				day: "numeric",
			});

			const testDates = [
				{ gy: 2024, gm: 3, gd: 20 }, // 1 Farvardin 1403 (Nowruz, leap year)
				{ gy: 2025, gm: 3, gd: 20 }, // 30 Esfand 1403 (Leap day in 1403)
				{ gy: 2025, gm: 3, gd: 21 }, // 1 Farvardin 1404
				{ gy: 2026, gm: 11, gd: 7 }, // 16 Aban 1405
				{ gy: 2027, gm: 11, gd: 6 }, // 15 Aban 1406
				{ gy: 2028, gm: 3, gd: 19 }, // 29 Esfand 1406
				{ gy: 2029, gm: 3, gd: 20 }, // 29 Esfand 1407
				{ gy: 2030, gm: 3, gd: 21 }, // 1 Farvardin 1409
			];

			for (const td of testDates) {
				const dt = new Date(Date.UTC(td.gy, td.gm - 1, td.gd, 12, 0, 0));
				const parts = intlFormatter.formatToParts(dt);
				const expectedJy = parseInt(parts.find((p) => p.type === "year").value, 10);
				const expectedJm = parseInt(parts.find((p) => p.type === "month").value, 10);
				const expectedJd = parseInt(parts.find((p) => p.type === "day").value, 10);

				const jCalc = gregorianToJalali(td.gy, td.gm, td.gd);
				expect(jCalc.jy).toBe(expectedJy);
				expect(jCalc.jm).toBe(expectedJm);
				expect(jCalc.jd).toBe(expectedJd);

				const gCalc = jalaliToGregorian(jCalc.jy, jCalc.jm, jCalc.jd);
				expect(gCalc.gy).toBe(td.gy);
				expect(gCalc.gm).toBe(td.gm);
				expect(gCalc.gd).toBe(td.gd);
			}
		});

		it("correctly identifies Jalali leap years including the 5-year break (1408)", () => {
			expect(isLeapJalaliYear(1395)).toBe(true);
			expect(isLeapJalaliYear(1399)).toBe(true);
			expect(isLeapJalaliYear(1403)).toBe(true);
			expect(isLeapJalaliYear(1404)).toBe(false);
			expect(isLeapJalaliYear(1405)).toBe(false);
			expect(isLeapJalaliYear(1406)).toBe(false);
			expect(isLeapJalaliYear(1407)).toBe(false);
			expect(isLeapJalaliYear(1408)).toBe(true); // 5-year leap jump
		});

		it("validates Jalali month days and leap limits accurately", () => {
			// Months 1-6 have 31 days
			for (let m = 1; m <= 6; m++) {
				expect(getJalaliMonthDays(1405, m)).toBe(31);
				expect(isValidJalaliDate(1405, m, 31)).toBe(true);
				expect(isValidJalaliDate(1405, m, 32)).toBe(false);
			}

			// Months 7-11 have 30 days
			for (let m = 7; m <= 11; m++) {
				expect(getJalaliMonthDays(1405, m)).toBe(30);
				expect(isValidJalaliDate(1405, m, 30)).toBe(true);
				expect(isValidJalaliDate(1405, m, 31)).toBe(false);
			}

			// Month 12: 30 days in 1403 (leap), 29 in 1404 (non-leap)
			expect(getJalaliMonthDays(1403, 12)).toBe(30);
			expect(isValidJalaliDate(1403, 12, 30)).toBe(true);

			expect(getJalaliMonthDays(1404, 12)).toBe(29);
			expect(isValidJalaliDate(1404, 12, 30)).toBe(false);
			expect(isValidJalaliDate(1404, 12, 29)).toBe(true);
		});

		it("extracts Tehran Persian date parts correctly", () => {
			const fixedBase = new Date("2026-11-07T08:00:00Z"); // 11:30 Tehran (+03:30), Saturday 16 Aban 1405
			const parts = getTehranPersianDateParts(fixedBase);
			expect(parts.jy).toBe(1405);
			expect(parts.jm).toBe(8);
			expect(parts.jd).toBe(16);
			expect(parts.persianDateString).toBe("1405-08-16");
			expect(parts.year).toBe(2026);
			expect(parts.month).toBe(11);
			expect(parts.day).toBe(7);
			expect(parts.hour).toBe(11);
			expect(parts.minute).toBe(30);
		});

		describe("extractPersianDateTime with Solar Hijri Dates", () => {
			const baseDate = new Date("2026-11-07T08:00:00Z"); // Saturday, 16 Aban 1405 (2026-11-07)

			it("extracts Solar date with explicit future year («۱۵ آبان ۱۴۰۶»)", () => {
				const res = extractPersianDateTime("تسک خرید کتاب برای ۱۵ آبان ۱۴۰۶", baseDate);
				expect(res.hasDate).toBe(true);
				expect(res.solarYear).toBe(1406);
				expect(res.solarMonth).toBe(8);
				expect(res.solarDay).toBe(15);
				expect(res.targetDateStr).toBe("2027-11-06");
				expect(res.isoDueDate).toBe("2027-11-06");
				expect(res.cleanedText).toBe("تسک خرید کتاب");
				expect(res.needsClarification).toBe(false);
			});

			it("extracts Solar date with explicit past year («۱۵ آبان ۱۴۰۴») and flags past date", () => {
				const res = extractPersianDateTime("تسک خرید کتاب برای ۱۵ آبان ۱۴۰۴", baseDate);
				expect(res.hasDate).toBe(true);
				expect(res.isPastDate).toBe(true);
				expect(res.needsClarification).toBe(true);
				expect(res.clarificationType).toBe("past_date");
				expect(res.solarYear).toBe(1404);
				expect(res.targetDateStr).toBe("2025-11-06");
				expect(res.isoDueDate).toBeNull();
			});

			it("flags dates beyond 1 year in the future («۱۵ آبان ۱۴۰۸»)", () => {
				const res = extractPersianDateTime("تسک خرید کتاب برای ۱۵ آبان ۱۴۰۸", baseDate);
				expect(res.hasDate).toBe(true);
				expect(res.isBeyondOneYear).toBe(true);
				expect(res.needsClarification).toBe(true);
				expect(res.clarificationType).toBe("beyond_one_year");
				expect(res.solarYear).toBe(1408);
				expect(res.isoDueDate).toBeNull();
			});

			it("strictly enforces 1-year calendar ceiling (today, exactly 1 year later, 1 day after ceiling)", () => {
				// Base: 16 Aban 1405 (Saturday, 2026-11-07)
				// 1. Today (16 Aban 1405): allowed
				const resToday = extractPersianDateTime("۱۶ آبان ۱۴۰۵ تسک امروز", baseDate);
				expect(resToday.hasDate).toBe(true);
				expect(resToday.isBeyondOneYear).toBe(false);
				expect(resToday.needsClarification).toBe(false);

				// 2. Exactly 1 year later (16 Aban 1406): allowed
				const resCeiling = extractPersianDateTime("۱۶ آبان ۱۴۰۶ تسک سقف یکساله", baseDate);
				expect(resCeiling.hasDate).toBe(true);
				expect(resCeiling.solarYear).toBe(1406);
				expect(resCeiling.solarMonth).toBe(8);
				expect(resCeiling.solarDay).toBe(16);
				expect(resCeiling.targetDateStr).toBe("2027-11-07");
				expect(resCeiling.isBeyondOneYear).toBe(false);
				expect(resCeiling.needsClarification).toBe(false);

				// 3. Exactly 1 day after 1-year ceiling (17 Aban 1406): rejected!
				const resAfterCeiling = extractPersianDateTime("۱۷ آبان ۱۴۰۶ تسک فراتر از سقف", baseDate);
				expect(resAfterCeiling.hasDate).toBe(true);
				expect(resAfterCeiling.solarYear).toBe(1406);
				expect(resAfterCeiling.solarMonth).toBe(8);
				expect(resAfterCeiling.solarDay).toBe(17);
				expect(resAfterCeiling.isBeyondOneYear).toBe(true);
				expect(resAfterCeiling.needsClarification).toBe(true);
				expect(resAfterCeiling.clarificationType).toBe("beyond_one_year");
				expect(resAfterCeiling.isoDueDate).toBeNull();
			});

			it("strictly enforces 1-year calendar ceiling across leap years (سال کبیسه)", () => {
				// Case A: Base is 1 Farvardin 1403 (leap year of 366 days)
				const baseLeapFarvardin = new Date("2024-03-20T08:00:00Z"); // 1 Farvardin 1403
				// Exactly 1 year later: 1 Farvardin 1404 -> allowed (366 days later)
				const res1404 = extractPersianDateTime("۱ فروردین ۱۴۰۴ تحویل پروژه", baseLeapFarvardin);
				expect(res1404.hasDate).toBe(true);
				expect(res1404.isBeyondOneYear).toBe(false);
				expect(res1404.needsClarification).toBe(false);

				// 1 day after ceiling: 2 Farvardin 1404 -> rejected
				const res1404Day2 = extractPersianDateTime("۲ فروردین ۱۴۰۴ تحویل پروژه", baseLeapFarvardin);
				expect(res1404Day2.hasDate).toBe(true);
				expect(res1404Day2.isBeyondOneYear).toBe(true);
				expect(res1404Day2.needsClarification).toBe(true);
				expect(res1404Day2.clarificationType).toBe("beyond_one_year");

				// Case B: Base is 30 Esfand 1403 (leap day). Next year 1404 is non-leap (29 days)
				const baseLeapDay = new Date("2025-03-20T08:00:00Z"); // 30 Esfand 1403
				// 29 Esfand 1404 is allowed (last day of next year)
				const res29Esfand = extractPersianDateTime("۲۹ اسفند ۱۴۰۴ پایان سال", baseLeapDay);
				expect(res29Esfand.hasDate).toBe(true);
				expect(res29Esfand.isBeyondOneYear).toBe(false);
				expect(res29Esfand.needsClarification).toBe(false);

				// 1 Farvardin 1405 (day after end of next year) -> rejected
				const res1Farv1405 = extractPersianDateTime("۱ فروردین ۱۴۰۵ سال نو", baseLeapDay);
				expect(res1Farv1405.hasDate).toBe(true);
				expect(res1Farv1405.isBeyondOneYear).toBe(true);
				expect(res1Farv1405.needsClarification).toBe(true);
				expect(res1Farv1405.clarificationType).toBe("beyond_one_year");

				// Case C: Base is 29 Esfand 1402 (non-leap, next year 1403 is leap)
				const basePreLeap = new Date("2024-03-19T08:00:00Z"); // 29 Esfand 1402
				// Exactly 1 year later: 29 Esfand 1403 -> allowed
				const res29Esfand1403 = extractPersianDateTime("۲۹ اسفند ۱۴۰۳ نوروز", basePreLeap);
				expect(res29Esfand1403.hasDate).toBe(true);
				expect(res29Esfand1403.isBeyondOneYear).toBe(false);

				// 1 day after ceiling: 30 Esfand 1403 -> rejected (beyond calendar anniversary)
				const res30Esfand1403 = extractPersianDateTime("۳۰ اسفند ۱۴۰۳ نوروز", basePreLeap);
				expect(res30Esfand1403.hasDate).toBe(true);
				expect(res30Esfand1403.isBeyondOneYear).toBe(true);
				expect(res30Esfand1403.needsClarification).toBe(true);
				expect(res30Esfand1403.clarificationType).toBe("beyond_one_year");
			});

			it("extracts Solar date without year when target is ahead in current year («۸ آذر»)", () => {
				const res = extractPersianDateTime("برای ۸ آذر خرید کتاب دارم", baseDate);
				expect(res.hasDate).toBe(true);
				expect(res.solarYear).toBe(1405);
				expect(res.solarMonth).toBe(9);
				expect(res.solarDay).toBe(8);
				expect(res.targetDateStr).toBe("2026-11-29");
				expect(res.isoDueDate).toBe("2026-11-29");
				expect(res.cleanedText).toBe("خرید کتاب دارم");
				expect(res.needsClarification).toBe(false);
			});

			it("rolls to next year when Solar date without year has already passed this year («۱۵ آبان»)", () => {
				// Today is 16 Aban 1405. User asks for "15 Aban". Should roll to 15 Aban 1406!
				const res = extractPersianDateTime("۱۵ آبان برم دکتر", baseDate);
				expect(res.hasDate).toBe(true);
				expect(res.solarYear).toBe(1406);
				expect(res.solarMonth).toBe(8);
				expect(res.solarDay).toBe(15);
				expect(res.targetDateStr).toBe("2027-11-06");
				expect(res.cleanedText).toBe("برم دکتر");
				expect(res.needsClarification).toBe(false);
			});

			it("extracts Solar date without year when target is today («۱۶ آبان»)", () => {
				const res = extractPersianDateTime("۱۶ آبان پرداخت قبض", baseDate);
				expect(res.hasDate).toBe(true);
				expect(res.solarYear).toBe(1405);
				expect(res.solarMonth).toBe(8);
				expect(res.solarDay).toBe(16);
				expect(res.targetDateStr).toBe("2026-11-07");
				expect(res.cleanedText).toBe("پرداخت قبض");
			});

			it("extracts Solar date with day word («هشتم آذر», «اول فروردین»)", () => {
				const res8 = extractPersianDateTime("هشتم آذر جلسه پروژه", baseDate);
				expect(res8.hasDate).toBe(true);
				expect(res8.solarYear).toBe(1405);
				expect(res8.solarMonth).toBe(9);
				expect(res8.solarDay).toBe(8);
				expect(res8.targetDateStr).toBe("2026-11-29");
				expect(res8.cleanedText).toBe("جلسه پروژه");

				const res1 = extractPersianDateTime("اول فروردین جشن نوروز", baseDate);
				expect(res1.hasDate).toBe(true);
				expect(res1.solarYear).toBe(1406); // Passed in 1405, rolls to 1406!
				expect(res1.solarMonth).toBe(1);
				expect(res1.solarDay).toBe(1);
				expect(res1.targetDateStr).toBe("2027-03-21");
				expect(res1.cleanedText).toBe("جشن نوروز");
			});

			it("validates leap years for 30 Esfand (1403 valid vs 1404 invalid)", () => {
				const res1403 = extractPersianDateTime("۳۰ اسفند ۱۴۰۳ تحویل سال", baseDate);
				expect(res1403.isInvalidDate).toBe(false);
				expect(res1403.solarYear).toBe(1403);
				expect(res1403.targetDateStr).toBe("2025-03-20");

				const res1404 = extractPersianDateTime("۳۰ اسفند ۱۴۰۴ پایان سال", baseDate);
				expect(res1404.isInvalidDate).toBe(true);
				expect(res1404.invalidDateReason).toBe("INVALID_LEAP_DAY");
				expect(res1404.needsClarification).toBe(true);
				expect(res1404.clarificationType).toBe("invalid_solar_date");
			});

			it("rejects invalid solar month days («۳۱ مهر», «۳۲ فروردین»)", () => {
				const resMehr = extractPersianDateTime("۳۱ مهر گزارش مالی", baseDate);
				expect(resMehr.isInvalidDate).toBe(true);
				expect(resMehr.invalidDateReason).toBe("INVALID_SOLAR_DAY");
				expect(resMehr.needsClarification).toBe(true);
				expect(resMehr.clarificationType).toBe("invalid_solar_date");

				const res32 = extractPersianDateTime("۳۲ فروردین جشن", baseDate);
				expect(res32.isInvalidDate).toBe(true);
				expect(res32.invalidDateReason).toBe("INVALID_SOLAR_DAY");
			});

			it("extracts relative offsets (days, weeks, month)", () => {
				// 3 days: 2026-11-07 + 3 = 2026-11-10
				const res3d = extractPersianDateTime("سه روز دیگر برم استخر", baseDate);
				expect(res3d.hasDate).toBe(true);
				expect(res3d.targetDateStr).toBe("2026-11-10");
				expect(res3d.cleanedText).toBe("برم استخر");

				// 5 days: 2026-11-07 + 5 = 2026-11-12
				const res5d = extractPersianDateTime("پنج روز بعد ارسال ایمیل", baseDate);
				expect(res5d.hasDate).toBe(true);
				expect(res5d.targetDateStr).toBe("2026-11-12");
				expect(res5d.cleanedText).toBe("ارسال ایمیل");

				// 15 days: 2026-11-07 + 15 = 2026-11-22
				const res15d = extractPersianDateTime("۱۵ روز دیگر ویزیت پزشک", baseDate);
				expect(res15d.hasDate).toBe(true);
				expect(res15d.targetDateStr).toBe("2026-11-22");
				expect(res15d.cleanedText).toBe("ویزیت پزشک");

				// 1 week: 2026-11-07 + 7 = 2026-11-14
				const res1w = extractPersianDateTime("یک هفته دیگر جلسه دفاع", baseDate);
				expect(res1w.hasDate).toBe(true);
				expect(res1w.targetDateStr).toBe("2026-11-14");
				expect(res1w.cleanedText).toBe("جلسه دفاع");

				// 2 weeks: 2026-11-07 + 14 = 2026-11-21
				const res2w = extractPersianDateTime("دو هفته دیگر تست نهایی", baseDate);
				expect(res2w.hasDate).toBe(true);
				expect(res2w.targetDateStr).toBe("2026-11-21");
				expect(res2w.cleanedText).toBe("تست نهایی");

				// 1 month: 16 Aban 1405 + 1 month = 16 Azar 1405 (2026-12-07)
				const res1m = extractPersianDateTime("یک ماه دیگر تمدید قرارداد", baseDate);
				expect(res1m.hasDate).toBe(true);
				expect(res1m.solarYear).toBe(1405);
				expect(res1m.solarMonth).toBe(9);
				expect(res1m.solarDay).toBe(16);
				expect(res1m.targetDateStr).toBe("2026-12-07");
				expect(res1m.cleanedText).toBe("تمدید قرارداد");
			});

			it("combines Solar date with time («۸ آذر ساعت ۵ عصر»)", () => {
				const res = extractPersianDateTime("۸ آذر ساعت ۵ عصر کلاس زبان", baseDate);
				expect(res.hasDate).toBe(true);
				expect(res.hasTime).toBe(true);
				expect(res.targetDateStr).toBe("2026-11-29");
				expect(res.isoDueDate).toBe("2026-11-29T17:00:00+03:30");
				expect(res.cleanedText).toBe("کلاس زبان");
				expect(res.needsClarification).toBe(false);
			});

			it("preserves date and requests clarification for ambiguous hour with Solar date («۸ آذر ساعت ۵»)", () => {
				const res = extractPersianDateTime("۸ آذر ساعت ۵ کلاس زبان", baseDate);
				expect(res.hasDate).toBe(true);
				expect(res.isAmbiguousTime).toBe(true);
				expect(res.ambiguousHour).toBe(5);
				expect(res.needsClarification).toBe(true);
				expect(res.clarificationType).toBe("ambiguous_time");
				expect(res.targetDateStr).toBe("2026-11-29");
				expect(res.isoDueDate).toBeNull();
				expect(res.cleanedText).toBe("کلاس زبان");
			});
		});
	});
});
