import { describe, it, expect } from "vitest";
import {
	dispatchLocalAction,
	detectLocalListIntent,
	detectLocalStatusIntent,
	detectLocalDeleteIntent,
	detectLocalAddIntent,
	detectLocalEditIntent,
	cleanTaskTitle,
	parseOrdinalIndex,
	isExplicitChatMessage,
} from "../src/localDispatcher.js";

describe("Hermes Mini - Local Deterministic Dispatcher", () => {
	const fixedBase = new Date("2026-11-03T10:00:00Z");

	describe("Task Creation (Add)", () => {
		it("detects «گوشیم رو میخوام بزنم به شارژ»", () => {
			// Bare statement without date/reminder is a momentary routine and should NOT be added
			const resBare = dispatchLocalAction("گوشیم رو میخوام بزنم به شارژ", fixedBase);
			expect(resBare).toBeNull();

			// With explicit reminder directive, it should be added
			const resRemind = dispatchLocalAction("یادم بنداز گوشیم رو بزنم به شارژ", fixedBase);
			expect(resRemind).not.toBeNull();
			expect(resRemind.intent).toBe("add");
			expect(resRemind.title).toContain("گوشیم");
			expect(resRemind.title).toContain("شارژ");
		});

		it("does not add spontaneous urge «میخوام آب بخورم»", () => {
			const res = dispatchLocalAction("میخوام آب بخورم", fixedBase);
			expect(res).toBeNull();
		});

		it("does not add spontaneous urge «میخوام گوشیم رو به شارژ بزنم»", () => {
			const res = dispatchLocalAction("میخوام گوشیم رو به شارژ بزنم", fixedBase);
			expect(res).toBeNull();
		});

		it("detects plannable task «فردا باید برای امتحان درس بخونم» with due_date", () => {
			const res = dispatchLocalAction("فردا باید برای امتحان درس بخونم", fixedBase);
			expect(res).not.toBeNull();
			expect(res.intent).toBe("add");
			expect(res.title).toBe("برای امتحان درس بخونم");
			expect(res.due_date).toContain("2026-11-04");
		});

		it("detects plannable task «فردا ساعت ۱۰ جلسه کاری دارم» as ambiguous hour and «فردا ساعت ۱۰ صبح» as explicit", () => {
			// Ambiguous: ساعت ۱۰ without period
			const resAmbiguous = dispatchLocalAction("فردا ساعت ۱۰ جلسه کاری دارم", fixedBase);
			expect(resAmbiguous).not.toBeNull();
			expect(resAmbiguous.intent).toBe("add");
			expect(resAmbiguous.title).toBe("جلسه کاری دارم");
			expect(resAmbiguous.due_date).toBeNull();
			expect(resAmbiguous.isAmbiguousTime).toBe(true);
			expect(resAmbiguous.ambiguousHour).toBe(10);
			expect(resAmbiguous.needsClarification).toBe(true);
			expect(resAmbiguous.targetDateStr).toBe("2026-11-04");

			// Explicit: ساعت ۱۰ صبح
			const resExplicit = dispatchLocalAction("فردا ساعت ۱۰ صبح جلسه کاری دارم", fixedBase);
			expect(resExplicit).not.toBeNull();
			expect(resExplicit.intent).toBe("add");
			expect(resExplicit.title).toBe("جلسه کاری دارم");
			expect(resExplicit.due_date).toBe("2026-11-04T10:00:00+03:30");
			expect(resExplicit.hasTime).toBe(true);
			expect(resExplicit.isAmbiguousTime).toBe(false);
		});

		it("detects explicit reminder «یادم بنداز فردا آب بخورم» with due_date", () => {
			const res = dispatchLocalAction("یادم بنداز فردا آب بخورم", fixedBase);
			expect(res).not.toBeNull();
			expect(res.intent).toBe("add");
			expect(res.title).toBe("آب بخورم");
			expect(res.due_date).toContain("2026-11-04");
		});

		it("detects «باید فردا به مادرم زنگ بزنم» with proper due_date", () => {
			const res = dispatchLocalAction("باید فردا به مادرم زنگ بزنم", fixedBase);
			expect(res).not.toBeNull();
			expect(res.intent).toBe("add");
			expect(res.title).toBe("به مادرم زنگ بزنم");
			expect(res.due_date).toContain("2026-11-04");
		});

		it("detects «یادم باشه کتابم رو ببرم»", () => {
			const res = dispatchLocalAction("یادم باشه کتابم رو ببرم", fixedBase);
			expect(res).not.toBeNull();
			expect(res.intent).toBe("add");
			expect(res.title).toBe("کتابم رو ببرم");
		});

		it("detects «میخوام فردا خرید کنم»", () => {
			const res = dispatchLocalAction("میخوام فردا خرید کنم", fixedBase);
			expect(res).not.toBeNull();
			expect(res.intent).toBe("add");
			expect(res.due_date).toContain("2026-11-04");
		});
	});

	describe("Task Listing (List)", () => {
		it("detects «کارام رو نمایش بده»", () => {
			const res = dispatchLocalAction("کارام رو نمایش بده");
			expect(res).not.toBeNull();
			expect(res.intent).toBe("list");
			expect(res.filter).toBe("all");
		});

		it("detects «کارام چیه؟»", () => {
			const res = dispatchLocalAction("کارام چیه؟");
			expect(res).not.toBeNull();
			expect(res.intent).toBe("list");
		});

		it("detects «لیست کارام رو بده»", () => {
			const res = dispatchLocalAction("لیست کارام رو بده");
			expect(res).not.toBeNull();
			expect(res.intent).toBe("list");
		});

		it("detects «امروز چه کارایی دارم؟»", () => {
			const res = dispatchLocalAction("امروز چه کارایی دارم؟");
			expect(res).not.toBeNull();
			expect(res.intent).toBe("list");
			expect(res.filter).toBe("today");
		});

		it("detects «فردا چه کارایی دارم؟»", () => {
			const res = dispatchLocalAction("فردا چه کارایی دارم؟");
			expect(res).not.toBeNull();
			expect(res.intent).toBe("list");
			expect(res.filter).toBe("tomorrow");
		});
	});

	describe("Status Changes (Done / Undone)", () => {
		it("detects «ریاضی رو انجام دادم»", () => {
			const res = dispatchLocalAction("ریاضی رو انجام دادم");
			expect(res).not.toBeNull();
			expect(res.intent).toBe("done");
			expect(res.target_query).toBe("ریاضی");
		});

		it("detects «تیک بزن ریاضی»", () => {
			const res = dispatchLocalAction("تیک بزن ریاضی");
			expect(res).not.toBeNull();
			expect(res.intent).toBe("done");
			expect(res.target_query).toBe("ریاضی");
		});

		it("detects «ریاضی تموم شد»", () => {
			const res = dispatchLocalAction("ریاضی تموم شد");
			expect(res).not.toBeNull();
			expect(res.intent).toBe("done");
			expect(res.target_query).toBe("ریاضی");
		});

		it("detects «اولی رو انجام دادم»", () => {
			const res = dispatchLocalAction("اولی رو انجام دادم");
			expect(res).not.toBeNull();
			expect(res.intent).toBe("done");
			expect(res.target_index).toBe(1);
		});

		it("detects «دومی رو تموم کردم»", () => {
			const res = dispatchLocalAction("دومی رو تموم کردم");
			expect(res).not.toBeNull();
			expect(res.intent).toBe("done");
			expect(res.target_index).toBe(2);
		});

		it("detects «ریاضی رو ناقص کن»", () => {
			const res = dispatchLocalAction("ریاضی رو ناقص کن");
			expect(res).not.toBeNull();
			expect(res.intent).toBe("undone");
			expect(res.target_query).toBe("ریاضی");
		});

		it("does NOT detect undone when command lacks a valid target (e.g. «دوباره فعال کن», «فعال کن»)", () => {
			expect(detectLocalStatusIntent("دوباره فعال کن")).toBeNull();
			expect(dispatchLocalAction("دوباره فعال کن")).toBeNull();

			expect(detectLocalStatusIntent("فعال کن")).toBeNull();
			expect(dispatchLocalAction("فعال کن")).toBeNull();

			expect(detectLocalStatusIntent("برگردون")).toBeNull();
			expect(dispatchLocalAction("برگردون")).toBeNull();

			expect(detectLocalStatusIntent("ناقص کن")).toBeNull();
			expect(dispatchLocalAction("ناقص کن")).toBeNull();
		});

		it("detects undone with target after verb: «دوباره فعال کن ریاضی»", () => {
			const res = dispatchLocalAction("دوباره فعال کن ریاضی");
			expect(res).not.toBeNull();
			expect(res.intent).toBe("undone");
			expect(res.target_query).toBe("ریاضی");
			expect(res.target_index).toBeNull();
		});

		it("detects undone with target before verb: «ریاضی رو دوباره فعال کن»", () => {
			const res = dispatchLocalAction("ریاضی رو دوباره فعال کن");
			expect(res).not.toBeNull();
			expect(res.intent).toBe("undone");
			expect(res.target_query).toBe("ریاضی");
			expect(res.target_index).toBeNull();
		});

		it("preserves undone for «ناقص کن ریاضی» and «اولی رو برگردون»", () => {
			const res1 = dispatchLocalAction("ناقص کن ریاضی");
			expect(res1).not.toBeNull();
			expect(res1.intent).toBe("undone");
			expect(res1.target_query).toBe("ریاضی");

			const res2 = dispatchLocalAction("اولی رو برگردون");
			expect(res2).not.toBeNull();
			expect(res2.intent).toBe("undone");
			expect(res2.target_index).toBe(1);
			expect(res2.target_query).toBeNull();
		});

		it("preserves undone for «ریاضی رو فعال کن» and «فعال کن ریاضی»", () => {
			const res1 = dispatchLocalAction("ریاضی رو فعال کن");
			expect(res1).not.toBeNull();
			expect(res1.intent).toBe("undone");
			expect(res1.target_query).toBe("ریاضی");

			const res2 = dispatchLocalAction("فعال کن ریاضی");
			expect(res2).not.toBeNull();
			expect(res2.intent).toBe("undone");
			expect(res2.target_query).toBe("ریاضی");
		});
	});

	describe("Deletion", () => {
		it("detects «دکتر رو حذف کن»", () => {
			const res = dispatchLocalAction("دکتر رو حذف کن");
			expect(res).not.toBeNull();
			expect(res.intent).toBe("delete");
			expect(res.target_query).toBe("دکتر");
		});

		it("detects «اولی رو حذف کن»", () => {
			const res = dispatchLocalAction("اولی رو حذف کن");
			expect(res).not.toBeNull();
			expect(res.intent).toBe("delete");
			expect(res.target_index).toBe(1);
		});
	});

	describe("Chat & Ambiguity Protection", () => {
		it("treats greetings and casual chat as chat and NOT tasks", () => {
			const chats = [
				"سلام هرمس جان چطوری؟",
				"یه جوک بگو",
				"امروز حوصله ندارم و خسته‌ام",
				"پایتون چیه؟",
				"ممنون از کمکت",
			];

			for (const msg of chats) {
				const res = dispatchLocalAction(msg);
				expect(res).not.toBeNull();
				expect(res.intent).toBe("chat");
			}
		});
	});

	describe("Title Cleaning for Compound Containers", () => {
		it("cleans compound leading container «به لیست تسک‌هام اضافه کن پیگیری فاکتور»", () => {
			expect(cleanTaskTitle("به لیست تسک‌هام اضافه کن پیگیری فاکتور")).toBe("پیگیری فاکتور");
		});

		it("cleans compound trailing container «پیگیری فاکتور رو به لیست کارهام اضافه کن»", () => {
			expect(cleanTaskTitle("پیگیری فاکتور رو به لیست کارهام اضافه کن")).toBe("پیگیری فاکتور");
		});

		it("cleans compound leading container «به لیست کارهام اضافه کن خرید نان»", () => {
			expect(cleanTaskTitle("به لیست کارهام اضافه کن خرید نان")).toBe("خرید نان");
		});

		it("cleans compound trailing container without رو: «خرید نان به لیست کارهام اضافه کن»", () => {
			expect(cleanTaskTitle("خرید نان به لیست کارهام اضافه کن")).toBe("خرید نان");
		});

		it("cleans container with personal clitic «به لیستم اضافه کن خرید نان»", () => {
			expect(cleanTaskTitle("به لیستم اضافه کن خرید نان")).toBe("خرید نان");
		});

		it("cleans container with trailing clitic «پیگیری فاکتور رو به کارهام اضافه کن»", () => {
			expect(cleanTaskTitle("پیگیری فاکتور رو به کارهام اضافه کن")).toBe("پیگیری فاکتور");
		});

		it("dispatches local add with clean title for compound containers", () => {
			const res1 = dispatchLocalAction("به لیست تسک‌هام اضافه کن پیگیری فاکتور", fixedBase);
			expect(res1).not.toBeNull();
			expect(res1.intent).toBe("add");
			expect(res1.title).toBe("پیگیری فاکتور");

			const res2 = dispatchLocalAction("پیگیری فاکتور رو به لیست کارهام اضافه کن", fixedBase);
			expect(res2).not.toBeNull();
			expect(res2.intent).toBe("add");
			expect(res2.title).toBe("پیگیری فاکتور");

			const res3 = dispatchLocalAction("به لیست کارهام اضافه کن خرید نان", fixedBase);
			expect(res3).not.toBeNull();
			expect(res3.intent).toBe("add");
			expect(res3.title).toBe("خرید نان");
		});
	});

	describe("Reschedule & Regex Lookahead with Suffixes", () => {
		it("handles reschedule with «ببر» verb followed by whitespace or end", () => {
			const res = dispatchLocalAction("موعد تسک خرید نان رو ببر برای فردا", fixedBase);
			expect(res).not.toBeNull();
			expect(res.intent).toBe("edit");
			expect(res.target_query).toBe("خرید نان");
			expect(res.due_date).toContain("2026-11-04");
		});

		it("handles reschedule with «ببر» at the end", () => {
			const res = dispatchLocalAction("موعد تسک خرید نان رو برای فردا ببر", fixedBase);
			expect(res).not.toBeNull();
			expect(res.intent).toBe("edit");
			expect(res.target_query).toBe("خرید نان");
			expect(res.due_date).toContain("2026-11-04");
		});

		it("does not false-trigger «ببر» inside words with Persian suffixes (e.g. ببرستان, ببرند)", () => {
			const res = dispatchLocalAction("تسک ببرستان رو به فردا موکول کن", fixedBase);
			expect(res).not.toBeNull();
			expect(res.intent).toBe("edit");
			expect(res.target_query).toBe("ببرستان");
			expect(res.due_date).toContain("2026-11-04");
		});

		it("does not false-trigger «بذار» inside words with Persian suffixes (e.g. بذارند)", () => {
			const res = dispatchLocalAction("موعد تسک بذارند رو برای فردا تغییر بده", fixedBase);
			expect(res).not.toBeNull();
			expect(res.intent).toBe("edit");
			expect(res.target_query).toBe("بذارند");
			expect(res.due_date).toContain("2026-11-04");
		});
	});

	describe("Bug Fix 1: Reminders preceded by date or time", () => {
		it("detects «فردا یادم بنداز برم دکتر» as add intent with cleaned title and due date", () => {
			const res = dispatchLocalAction("فردا یادم بنداز برم دکتر", fixedBase);
			expect(res).not.toBeNull();
			expect(res.intent).toBe("add");
			expect(res.title).toBe("برم دکتر");
			expect(res.due_date).toContain("2026-11-04");
		});

		it("detects «فردا ساعت ۳ یادم بنداز برم دستشویی» as add intent with ambiguous time flag and preserved date", () => {
			const res = dispatchLocalAction("فردا ساعت ۳ یادم بنداز برم دستشویی", fixedBase);
			expect(res).not.toBeNull();
			expect(res.intent).toBe("add");
			expect(res.title).toBe("برم دستشویی");
			expect(res.due_date).toBeNull();
			expect(res.isAmbiguousTime).toBe(true);
			expect(res.ambiguousHour).toBe(3);
			expect(res.needsClarification).toBe(true);
			expect(res.targetDateStr).toBe("2026-11-04");

			// Ambiguous time without explicit date should keep null due_date
			const resNoDate = dispatchLocalAction("ساعت ۳ یادم بنداز برم دستشویی", fixedBase);
			expect(resNoDate).not.toBeNull();
			expect(resNoDate.intent).toBe("add");
			expect(resNoDate.title).toBe("برم دستشویی");
			expect(resNoDate.due_date).toBeNull();
			expect(resNoDate.isAmbiguousTime).toBe(true);
			expect(resNoDate.ambiguousHour).toBe(3);
			expect(resNoDate.needsClarification).toBe(true);

			// Unambiguous 24h time should have exact due_date
			const resExact = dispatchLocalAction("فردا ساعت ۱۵ یادم بنداز برم دستشویی", fixedBase);
			expect(resExact).not.toBeNull();
			expect(resExact.intent).toBe("add");
			expect(resExact.title).toBe("برم دستشویی");
			expect(resExact.due_date).toContain("2026-11-04T15:00:00+03:30");
			expect(resExact.isAmbiguousTime).toBe(false);
		});

		it("detects «ساعت ۱۰ یادم بنداز با علی تماس بگیرم» as ambiguous and «ساعت ۱۰ صبح» as explicit", () => {
			// Ambiguous: ساعت ۱۰
			const resAmbiguous = dispatchLocalAction("ساعت ۱۰ یادم بنداز با علی تماس بگیرم", fixedBase);
			expect(resAmbiguous).not.toBeNull();
			expect(resAmbiguous.intent).toBe("add");
			expect(resAmbiguous.title).toBe("با علی تماس بگیرم");
			expect(resAmbiguous.isAmbiguousTime).toBe(true);
			expect(resAmbiguous.ambiguousHour).toBe(10);
			expect(resAmbiguous.needsClarification).toBe(true);
			expect(resAmbiguous.due_date).toBeNull();

			// Explicit: ساعت ۱۰ صبح
			const resExplicit = dispatchLocalAction("ساعت ۱۰ صبح یادم بنداز با علی تماس بگیرم", fixedBase);
			expect(resExplicit).not.toBeNull();
			expect(resExplicit.intent).toBe("add");
			expect(resExplicit.title).toBe("با علی تماس بگیرم");
			expect(resExplicit.hasTime).toBe(true);
			expect(resExplicit.isAmbiguousTime).toBe(false);
			expect(resExplicit.due_date).toContain("10:00:00+03:30");
		});

		it("detects «یادم بنداز فردا ساعت ۱۲ برم باشگاه» as ambiguous and «۱۲ ظهر» as explicit", () => {
			// Ambiguous: ۱۲ without period
			const resAmbiguous = dispatchLocalAction("یادم بنداز فردا ساعت ۱۲ برم باشگاه", fixedBase);
			expect(resAmbiguous).not.toBeNull();
			expect(resAmbiguous.intent).toBe("add");
			expect(resAmbiguous.title).toBe("برم باشگاه");
			expect(resAmbiguous.isAmbiguousTime).toBe(true);
			expect(resAmbiguous.ambiguousHour).toBe(12);
			expect(resAmbiguous.targetDateStr).toBe("2026-11-04");
			expect(resAmbiguous.due_date).toBeNull();

			// Explicit: ۱۲ ظهر
			const resExplicit = dispatchLocalAction("یادم بنداز فردا ۱۲ ظهر برم باشگاه", fixedBase);
			expect(resExplicit).not.toBeNull();
			expect(resExplicit.intent).toBe("add");
			expect(resExplicit.title).toBe("برم باشگاه");
			expect(resExplicit.due_date).toBe("2026-11-04T12:00:00+03:30");
			expect(resExplicit.isAmbiguousTime).toBe(false);
		});

		it("never interprets reminder with «بنداز» as an edit command", () => {
			const editRes1 = detectLocalEditIntent("فردا یادم بنداز برم دکتر", fixedBase);
			expect(editRes1).toBeNull();

			const editRes2 = detectLocalEditIntent("فردا ساعت ۳ یادم بنداز برم دستشویی", fixedBase);
			expect(editRes2).toBeNull();
		});

		it("cleans embedded reminder phrases in cleanTaskTitle", () => {
			expect(cleanTaskTitle("یادم بنداز برم دکتر")).toBe("برم دکتر");
			expect(cleanTaskTitle("یادآوری کن که برم دکتر")).toBe("برم دکتر");
			expect(cleanTaskTitle("برم دکتر یادم بنداز")).toBe("برم دکتر");
		});
	});

	describe("Bug Fix 2: parseOrdinalIndex alphanumeric strictness", () => {
		it("rejects invalid alphanumeric strings like «2abc» and «شماره 2abc»", () => {
			expect(parseOrdinalIndex("2abc")).toBeNull();
			expect(parseOrdinalIndex("شماره 2abc")).toBeNull();
			expect(parseOrdinalIndex("3xyz")).toBeNull();
			expect(parseOrdinalIndex("تسک 4test")).toBeNull();
			expect(parseOrdinalIndex("۲abc")).toBeNull();
		});

		it("correctly parses valid ordinal and numeric task indices", () => {
			expect(parseOrdinalIndex("اولی")).toBe(1);
			expect(parseOrdinalIndex("دوم")).toBe(2);
			expect(parseOrdinalIndex("۲")).toBe(2);
			expect(parseOrdinalIndex("شماره ۲")).toBe(2);
			expect(parseOrdinalIndex("شماره 15")).toBe(15);
			expect(parseOrdinalIndex("تسک ۴")).toBe(4);
			expect(parseOrdinalIndex("100")).toBe(100);
			expect(parseOrdinalIndex("0")).toBeNull();
			expect(parseOrdinalIndex("101")).toBeNull();
		});
	});

	describe("Bug Fix 3: List Overdue Tasks with «موعد گذشته»", () => {
		it("detects «کارهای موعد گذشته رو نشون بده» as overdue list", () => {
			const res = dispatchLocalAction("کارهای موعد گذشته رو نشون بده");
			expect(res).not.toBeNull();
			expect(res.intent).toBe("list");
			expect(res.filter).toBe("overdue");
		});

		it("detects «لیست کارهای موعد گذشته» as overdue list", () => {
			const res = dispatchLocalAction("لیست کارهای موعد گذشته");
			expect(res).not.toBeNull();
			expect(res.intent).toBe("list");
			expect(res.filter).toBe("overdue");
		});

		it("detects «تسک‌های موعد گذشته رو نمایش بده» as overdue list", () => {
			const res = dispatchLocalAction("تسک‌های موعد گذشته رو نمایش بده");
			expect(res).not.toBeNull();
			expect(res.intent).toBe("list");
			expect(res.filter).toBe("overdue");
		});

		it("detects other synonyms of overdue: «عقب افتاده» and «معوق»", () => {
			const res1 = dispatchLocalAction("کارهای عقب افتاده رو نشون بده");
			expect(res1).not.toBeNull();
			expect(res1.intent).toBe("list");
			expect(res1.filter).toBe("overdue");

			const res2 = dispatchLocalAction("کارهای معوق رو نشون بده");
			expect(res2).not.toBeNull();
			expect(res2.intent).toBe("list");
			expect(res2.filter).toBe("overdue");
		});
	});

	describe("Bug Fix 4: Move Time with Lookahead on «ببر»", () => {
		it("matches move time with standalone «ببر»", () => {
			const res = dispatchLocalAction("ساعت تسک درس خوندن رو ببر ۱۲", fixedBase);
			expect(res).not.toBeNull();
			expect(res.intent).toBe("edit");
			expect(res.target_query).toBe("درس خوندن");
			expect(res.due_date).toBeDefined();
		});

		it("matches move time with preposition «ببر برای فردا ۱۰»", () => {
			const res = dispatchLocalAction("ساعت تسک خرید نان رو ببر برای فردا ۱۰", fixedBase);
			expect(res).not.toBeNull();
			expect(res.intent).toBe("edit");
			expect(res.target_query).toBe("خرید نان");
			expect(res.due_date).toBeDefined();
		});

		it("does not false-trigger «ببر» in move time pattern when part of another word (e.g. ببرند)", () => {
			const editRes = detectLocalEditIntent("ساعت تسک خرید ببرند ۱۲", fixedBase);
			// Should NOT match moveTimeMatch where target_query would be incorrectly extracted as "خرید"
			expect(editRes?.target_query).not.toBe("خرید");
		});
	});

	describe("Bug Fix 5: List Filter: Pending and Completed vs Overdue & Undone", () => {
		it("detects «کارهای انجام نشده رو نشون بده» as list pending", () => {
			const res = dispatchLocalAction("کارهای انجام نشده رو نشون بده");
			expect(res).not.toBeNull();
			expect(res.intent).toBe("list");
			expect(res.filter).toBe("pending");
		});

		it("detects «لیست کارهای انجام نشده» as list pending", () => {
			const res = dispatchLocalAction("لیست کارهای انجام نشده");
			expect(res).not.toBeNull();
			expect(res.intent).toBe("list");
			expect(res.filter).toBe("pending");
		});

		it("detects «کارهای انجام شده رو نشون بده» as list completed", () => {
			const res = dispatchLocalAction("کارهای انجام شده رو نشون بده");
			expect(res).not.toBeNull();
			expect(res.intent).toBe("list");
			expect(res.filter).toBe("completed");
		});

		it("detects «کارهای موعد گذشته رو نشون بده» as list overdue", () => {
			const res = dispatchLocalAction("کارهای موعد گذشته رو نشون بده");
			expect(res).not.toBeNull();
			expect(res.intent).toBe("list");
			expect(res.filter).toBe("overdue");
		});

		it("strictly distinguishes «کارهای انجام نشده» (pending) from «کارهای موعد گذشته» (overdue)", () => {
			const resPending = dispatchLocalAction("لیست کارهای انجام نشده");
			const resOverdue = dispatchLocalAction("لیست کارهای موعد گذشته");

			expect(resPending.intent).toBe("list");
			expect(resPending.filter).toBe("pending");

			expect(resOverdue.intent).toBe("list");
			expect(resOverdue.filter).toBe("overdue");

			expect(resPending.filter).not.toBe(resOverdue.filter);
		});

		it("detects «ریاضی رو انجام نشده کن» as undone", () => {
			const res = dispatchLocalAction("ریاضی رو انجام نشده کن");
			expect(res).not.toBeNull();
			expect(res.intent).toBe("undone");
			expect(res.target_query).toBe("ریاضی");
		});

		it("detects «ریاضی رو انجام ندادم» as undone", () => {
			const res = dispatchLocalAction("ریاضی رو انجام ندادم");
			expect(res).not.toBeNull();
			expect(res.intent).toBe("undone");
			expect(res.target_query).toBe("ریاضی");
		});
	});

	describe("Ambiguous Time Information Transmission in Add and Edit", () => {
		it("transmits ambiguity info for Add with «ساعت ۵» without period", () => {
			const res = dispatchLocalAction("یادم بنداز فردا ساعت ۵ برم دکتر", fixedBase);
			expect(res).not.toBeNull();
			expect(res.intent).toBe("add");
			expect(res.title).toBe("برم دکتر");
			expect(res.isAmbiguousTime).toBe(true);
			expect(res.ambiguousHour).toBe(5);
			expect(res.needsClarification).toBe(true);
			expect(res.clarificationType).toBe("ambiguous_time");
			expect(res.targetDateStr).toBe("2026-11-04");
			expect(res.targetYear).toBe(2026);
			expect(res.targetMonth).toBe(11);
			expect(res.targetDay).toBe(4);
			expect(res.due_date).toBeNull();
		});

		it("transmits ambiguity info for Add with «ساعت ۸» without period", () => {
			const res = dispatchLocalAction("فردا ساعت ۸ ورزش کنم", fixedBase);
			expect(res).not.toBeNull();
			expect(res.intent).toBe("add");
			expect(res.title).toBe("ورزش کنم");
			expect(res.isAmbiguousTime).toBe(true);
			expect(res.ambiguousHour).toBe(8);
			expect(res.needsClarification).toBe(true);
			expect(res.clarificationType).toBe("ambiguous_time");
			expect(res.targetDateStr).toBe("2026-11-04");
			expect(res.due_date).toBeNull();
		});

		it("correctly sets due_date for Add with «ساعت ۵ عصر» without ambiguity", () => {
			const res = dispatchLocalAction("فردا ساعت ۵ عصر برم دکتر", fixedBase);
			expect(res).not.toBeNull();
			expect(res.intent).toBe("add");
			expect(res.title).toBe("برم دکتر");
			expect(res.isAmbiguousTime).toBe(false);
			expect(res.needsClarification).toBe(false);
			expect(res.due_date).toBe("2026-11-04T17:00:00+03:30");
			expect(res.hasTime).toBe(true);
		});

		it("correctly sets due_date for Add with «ساعت ۸ شب» without ambiguity", () => {
			const res = dispatchLocalAction("فردا ساعت ۸ شب شام با دوستان", fixedBase);
			expect(res).not.toBeNull();
			expect(res.intent).toBe("add");
			expect(res.title).toBe("شام با دوستان");
			expect(res.isAmbiguousTime).toBe(false);
			expect(res.needsClarification).toBe(false);
			expect(res.due_date).toBe("2026-11-04T20:00:00+03:30");
			expect(res.hasTime).toBe(true);
		});

		it("transmits ambiguity info for Edit with «ساعت ۵» without period (Pattern B)", () => {
			const res = dispatchLocalAction("موعد تسک خرید نان رو ببر برای فردا ساعت ۵", fixedBase);
			expect(res).not.toBeNull();
			expect(res.intent).toBe("edit");
			expect(res.target_query).toBe("خرید نان");
			expect(res.clearDueDate).toBe(false);
			expect(res.isAmbiguousTime).toBe(true);
			expect(res.ambiguousHour).toBe(5);
			expect(res.needsClarification).toBe(true);
			expect(res.clarificationType).toBe("ambiguous_time");
			expect(res.targetDateStr).toBe("2026-11-04");
			expect(res.targetYear).toBe(2026);
			expect(res.targetMonth).toBe(11);
			expect(res.targetDay).toBe(4);
			expect(res.due_date).toBeNull();
		});

		it("transmits ambiguity info for Edit with «ساعت ۸» without period (Pattern A)", () => {
			const res = dispatchLocalAction("تسک پروژه رو بنداز برای فردا ساعت ۸", fixedBase);
			expect(res).not.toBeNull();
			expect(res.intent).toBe("edit");
			expect(res.target_query).toBe("پروژه");
			expect(res.clearDueDate).toBe(false);
			expect(res.isAmbiguousTime).toBe(true);
			expect(res.ambiguousHour).toBe(8);
			expect(res.needsClarification).toBe(true);
			expect(res.clarificationType).toBe("ambiguous_time");
			expect(res.targetDateStr).toBe("2026-11-04");
			expect(res.due_date).toBeNull();
		});

		it("transmits ambiguity info for Move time with «ساعت ۵» without period", () => {
			const res = dispatchLocalAction("ساعت تسک درس رو ببر ۵", fixedBase);
			expect(res).not.toBeNull();
			expect(res.intent).toBe("edit");
			expect(res.target_query).toBe("درس");
			expect(res.isAmbiguousTime).toBe(true);
			expect(res.ambiguousHour).toBe(5);
			expect(res.needsClarification).toBe(true);
			expect(res.due_date).toBeNull();
		});

		it("correctly sets due_date for Edit with «ساعت ۵ عصر» without ambiguity", () => {
			const res = dispatchLocalAction("موعد تسک خرید نان رو ببر برای فردا ساعت ۵ عصر", fixedBase);
			expect(res).not.toBeNull();
			expect(res.intent).toBe("edit");
			expect(res.target_query).toBe("خرید نان");
			expect(res.clearDueDate).toBe(false);
			expect(res.isAmbiguousTime).toBe(false);
			expect(res.needsClarification).toBe(false);
			expect(res.due_date).toBe("2026-11-04T17:00:00+03:30");
			expect(res.hasTime).toBe(true);
		});

		it("correctly sets due_date for Edit with «ساعت ۸ شب» without ambiguity", () => {
			const res = dispatchLocalAction("ساعت تسک درس رو ببر فردا ۸ شب", fixedBase);
			expect(res).not.toBeNull();
			expect(res.intent).toBe("edit");
			expect(res.target_query).toBe("درس");
			expect(res.isAmbiguousTime).toBe(false);
			expect(res.needsClarification).toBe(false);
			expect(res.due_date).toBe("2026-11-04T20:00:00+03:30");
			expect(res.hasTime).toBe(true);
		});

		it("preserves relative date (پس‌فردا) in targetDateStr while keeping due_date null", () => {
			const res = dispatchLocalAction("تسک گزارش رو بنداز برای پس‌فردا ساعت ۳", fixedBase);
			expect(res).not.toBeNull();
			expect(res.intent).toBe("edit");
			expect(res.target_query).toBe("گزارش");
			expect(res.isAmbiguousTime).toBe(true);
			expect(res.ambiguousHour).toBe(3);
			expect(res.targetDateStr).toBe("2026-11-05");
			expect(res.targetDay).toBe(5);
			expect(res.due_date).toBeNull();
		});
	});

	describe("Phase 2: Comprehensive Solar & Relative Date Extraction in Local Dispatcher", () => {
		// Base date: Friday 16 Aban 1405 (2026-11-06T12:00:00Z)
		const baseDate = new Date("2026-11-06T12:00:00Z");

		describe("Extraction and title separation for all required samples", () => {
			it("extracts «سه روز دیگه برم استخر»", () => {
				const res = dispatchLocalAction("سه روز دیگه برم استخر", baseDate);
				expect(res).not.toBeNull();
				expect(res.intent).toBe("add");
				expect(res.title).toBe("برم استخر");
				expect(res.due_date).toBe("2026-11-09");
				expect(res.targetDateStr).toBe("2026-11-09");
				expect(res.solarYear).toBe(1405);
				expect(res.solarMonth).toBe(8);
				expect(res.solarDay).toBe(18);
				expect(res.hasDate).toBe(true);
				expect(res.needsClarification).toBe(false);
			});

			it("extracts «پنج روز بعد ارسال ایمیل»", () => {
				const res = dispatchLocalAction("پنج روز بعد ارسال ایمیل", baseDate);
				expect(res).not.toBeNull();
				expect(res.intent).toBe("add");
				expect(res.title).toBe("ارسال ایمیل");
				expect(res.due_date).toBe("2026-11-11");
				expect(res.targetDateStr).toBe("2026-11-11");
				expect(res.solarYear).toBe(1405);
				expect(res.solarMonth).toBe(8);
				expect(res.solarDay).toBe(20);
			});

			it("extracts «یک هفته دیگه جلسه دفاع»", () => {
				const res = dispatchLocalAction("یک هفته دیگه جلسه دفاع", baseDate);
				expect(res).not.toBeNull();
				expect(res.intent).toBe("add");
				expect(res.title).toBe("جلسه دفاع");
				expect(res.due_date).toBe("2026-11-13");
				expect(res.targetDateStr).toBe("2026-11-13");
				expect(res.solarYear).toBe(1405);
				expect(res.solarMonth).toBe(8);
				expect(res.solarDay).toBe(22);
			});

			it("extracts «یک ماه دیگه تمدید قرارداد»", () => {
				const res = dispatchLocalAction("یک ماه دیگه تمدید قرارداد", baseDate);
				expect(res).not.toBeNull();
				expect(res.intent).toBe("add");
				expect(res.title).toBe("تمدید قرارداد");
				expect(res.due_date).toBe("2026-12-06");
				expect(res.targetDateStr).toBe("2026-12-06");
				expect(res.solarYear).toBe(1405);
				expect(res.solarMonth).toBe(9);
				expect(res.solarDay).toBe(15);
			});

			it("extracts «فردا خرید نان»", () => {
				const res = dispatchLocalAction("فردا خرید نان", baseDate);
				expect(res).not.toBeNull();
				expect(res.intent).toBe("add");
				expect(res.title).toBe("خرید نان");
				expect(res.due_date).toBe("2026-11-07");
				expect(res.targetDateStr).toBe("2026-11-07");
				expect(res.solarYear).toBe(1405);
				expect(res.solarMonth).toBe(8);
				expect(res.solarDay).toBe(16);
			});

			it("extracts «پس‌فردا ویزیت دکتر»", () => {
				const res = dispatchLocalAction("پس‌فردا ویزیت دکتر", baseDate);
				expect(res).not.toBeNull();
				expect(res.intent).toBe("add");
				expect(res.title).toBe("ویزیت دکتر");
				expect(res.due_date).toBe("2026-11-08");
				expect(res.targetDateStr).toBe("2026-11-08");
				expect(res.solarYear).toBe(1405);
				expect(res.solarMonth).toBe(8);
				expect(res.solarDay).toBe(17);
			});

			it("extracts «۸ آذر خرید کتاب»", () => {
				const res = dispatchLocalAction("۸ آذر خرید کتاب", baseDate);
				expect(res).not.toBeNull();
				expect(res.intent).toBe("add");
				expect(res.title).toBe("خرید کتاب");
				expect(res.due_date).toBe("2026-11-29");
				expect(res.targetDateStr).toBe("2026-11-29");
				expect(res.solarYear).toBe(1405);
				expect(res.solarMonth).toBe(9);
				expect(res.solarDay).toBe(8);
			});

			it("extracts «برای ۸ آذر خرید کتاب دارم» with title completely separated", () => {
				const res = dispatchLocalAction("برای ۸ آذر خرید کتاب دارم", baseDate);
				expect(res).not.toBeNull();
				expect(res.intent).toBe("add");
				expect(res.title).toBe("خرید کتاب دارم");
				expect(res.due_date).toBe("2026-11-29");
				expect(res.targetDateStr).toBe("2026-11-29");
				expect(res.solarYear).toBe(1405);
				expect(res.solarMonth).toBe(9);
				expect(res.solarDay).toBe(8);
			});

			it("extracts «۱۵ آبان ۱۴۰۶ پرواز دارم»", () => {
				const res = dispatchLocalAction("۱۵ آبان ۱۴۰۶ پرواز دارم", baseDate);
				expect(res).not.toBeNull();
				expect(res.intent).toBe("add");
				expect(res.title).toBe("پرواز دارم");
				expect(res.due_date).toBe("2027-11-06");
				expect(res.targetDateStr).toBe("2027-11-06");
				expect(res.solarYear).toBe(1406);
				expect(res.solarMonth).toBe(8);
				expect(res.solarDay).toBe(15);
			});

			it("extracts «چهارشنبه هفته بعد کلاس زبان»", () => {
				const res = dispatchLocalAction("چهارشنبه هفته بعد کلاس زبان", baseDate);
				expect(res).not.toBeNull();
				expect(res.intent).toBe("add");
				expect(res.title).toBe("کلاس زبان");
				expect(res.due_date).toBe("2026-11-18");
				expect(res.targetDateStr).toBe("2026-11-18");
				expect(res.solarYear).toBe(1405);
				expect(res.solarMonth).toBe(8);
				expect(res.solarDay).toBe(27);
			});
		});

		describe("Rejection of inputs with only date/boilerplate and no task title", () => {
			it("rejects «برای ۸ آذر» without creating empty or title-less task", () => {
				const res = dispatchLocalAction("برای ۸ آذر", baseDate);
				expect(res).toBeNull();
			});

			it("rejects «تسک برای ۸ آذر» without creating task", () => {
				const res = dispatchLocalAction("تسک برای ۸ آذر", baseDate);
				expect(res).toBeNull();
			});

			it("rejects «برای فردا» without title", () => {
				const res = dispatchLocalAction("برای فردا", baseDate);
				expect(res).toBeNull();
			});

			it("rejects «تسک برای فردا» without title", () => {
				const res = dispatchLocalAction("تسک برای فردا", baseDate);
				expect(res).toBeNull();
			});
		});

		describe("Past, Invalid, and Beyond 1-Year dates retention and flag forwarding", () => {
			it("flags past dates with isPastDate and needsClarification in add intent", () => {
				const res = dispatchLocalAction("برای ۱۵ آبان ۱۴۰۴ خرید کتاب دارم", baseDate);
				expect(res).not.toBeNull();
				expect(res.intent).toBe("add");
				expect(res.title).toBe("خرید کتاب دارم");
				expect(res.due_date).toBeNull();
				expect(res.isPastDate).toBe(true);
				expect(res.needsClarification).toBe(true);
				expect(res.clarificationType).toBe("past_date");
				expect(res.targetDateStr).toBe("2025-11-06");
				expect(res.solarYear).toBe(1404);
				expect(res.solarMonth).toBe(8);
				expect(res.solarDay).toBe(15);
			});

			it("flags beyond 1-year dates with isBeyondOneYear and needsClarification in add intent", () => {
				const res = dispatchLocalAction("برای ۱۵ آبان ۱۴۰۸ خرید کتاب دارم", baseDate);
				expect(res).not.toBeNull();
				expect(res.intent).toBe("add");
				expect(res.title).toBe("خرید کتاب دارم");
				expect(res.due_date).toBeNull();
				expect(res.isBeyondOneYear).toBe(true);
				expect(res.needsClarification).toBe(true);
				expect(res.clarificationType).toBe("beyond_one_year");
				expect(res.targetDateStr).toBe("2029-11-05");
				expect(res.solarYear).toBe(1408);
			});

			it("flags invalid solar dates (e.g. 31 Mehr) with isInvalidDate and needsClarification in add intent", () => {
				const res = dispatchLocalAction("برای ۳۱ مهر خرید کتاب دارم", baseDate);
				expect(res).not.toBeNull();
				expect(res.intent).toBe("add");
				expect(res.title).toBe("خرید کتاب دارم");
				expect(res.due_date).toBeNull();
				expect(res.isInvalidDate).toBe(true);
				expect(res.invalidDateReason).toBe("INVALID_SOLAR_DAY");
				expect(res.needsClarification).toBe(true);
				expect(res.clarificationType).toBe("invalid_solar_date");
			});

			it("supports explicit named format with invalid date «یه تسک به اسم خرید کتاب برای ۳۱ مهر ثبت کن»", () => {
				const res = dispatchLocalAction("یه تسک به اسم خرید کتاب برای ۳۱ مهر ثبت کن", baseDate);
				expect(res).not.toBeNull();
				expect(res.intent).toBe("add");
				expect(res.title).toBe("خرید کتاب");
				expect(res.isInvalidDate).toBe(true);
				expect(res.needsClarification).toBe(true);
			});
		});

		describe("Ambiguous hour preservation with Solar dates", () => {
			it("preserves target date and flags ambiguous hour for «۸ آذر ساعت ۵ کلاس زبان»", () => {
				const res = dispatchLocalAction("۸ آذر ساعت ۵ کلاس زبان", baseDate);
				expect(res).not.toBeNull();
				expect(res.intent).toBe("add");
				expect(res.title).toBe("کلاس زبان");
				expect(res.due_date).toBeNull();
				expect(res.isAmbiguousTime).toBe(true);
				expect(res.ambiguousHour).toBe(5);
				expect(res.needsClarification).toBe(true);
				expect(res.clarificationType).toBe("ambiguous_time");
				expect(res.targetDateStr).toBe("2026-11-29");
				expect(res.solarYear).toBe(1405);
				expect(res.solarMonth).toBe(9);
				expect(res.solarDay).toBe(8);
			});

			it("sets exact due_date when period is specified «۸ آذر ساعت ۵ عصر کلاس زبان»", () => {
				const res = dispatchLocalAction("۸ آذر ساعت ۵ عصر کلاس زبان", baseDate);
				expect(res).not.toBeNull();
				expect(res.intent).toBe("add");
				expect(res.title).toBe("کلاس زبان");
				expect(res.due_date).toBe("2026-11-29T17:00:00+03:30");
				expect(res.hasTime).toBe(true);
				expect(res.isAmbiguousTime).toBe(false);
				expect(res.needsClarification).toBe(false);
			});
		});

		describe("Solar and Relative Date Handling in Edit Intents", () => {
			it("reschedules to a solar date «موعد تسک خرید کتاب رو به ۸ آذر تغییر بده»", () => {
				const res = dispatchLocalAction("موعد تسک خرید کتاب رو به ۸ آذر تغییر بده", baseDate);
				expect(res).not.toBeNull();
				expect(res.intent).toBe("edit");
				expect(res.target_query).toBe("خرید کتاب");
				expect(res.due_date).toBe("2026-11-29");
				expect(res.targetDateStr).toBe("2026-11-29");
				expect(res.solarYear).toBe(1405);
				expect(res.solarMonth).toBe(9);
				expect(res.solarDay).toBe(8);
				expect(res.hasDate).toBe(true);
				expect(res.needsClarification).toBe(false);
			});

			it("reschedules with drop pattern «تسک خرید کتاب رو بنداز برای ۸ آذر»", () => {
				const res = dispatchLocalAction("تسک خرید کتاب رو بنداز برای ۸ آذر", baseDate);
				expect(res).not.toBeNull();
				expect(res.intent).toBe("edit");
				expect(res.target_query).toBe("خرید کتاب");
				expect(res.due_date).toBe("2026-11-29");
				expect(res.targetDateStr).toBe("2026-11-29");
			});

			it("flags invalid solar date in edit intent «موعد تسک خرید کتاب رو به ۳۱ مهر تغییر بده»", () => {
				const res = dispatchLocalAction("موعد تسک خرید کتاب رو به ۳۱ مهر تغییر بده", baseDate);
				expect(res).not.toBeNull();
				expect(res.intent).toBe("edit");
				expect(res.target_query).toBe("خرید کتاب");
				expect(res.due_date).toBeNull();
				expect(res.isInvalidDate).toBe(true);
				expect(res.invalidDateReason).toBe("INVALID_SOLAR_DAY");
				expect(res.needsClarification).toBe(true);
				expect(res.clarificationType).toBe("invalid_solar_date");
			});

			it("flags past solar date in edit intent «موعد تسک خرید کتاب رو به ۱۵ آبان ۱۴۰۴ تغییر بده»", () => {
				const res = dispatchLocalAction("موعد تسک خرید کتاب رو به ۱۵ آبان ۱۴۰۴ تغییر بده", baseDate);
				expect(res).not.toBeNull();
				expect(res.intent).toBe("edit");
				expect(res.target_query).toBe("خرید کتاب");
				expect(res.due_date).toBeNull();
				expect(res.isPastDate).toBe(true);
				expect(res.needsClarification).toBe(true);
				expect(res.clarificationType).toBe("past_date");
			});

			it("flags beyond 1-year solar date in edit intent «موعد تسک خرید کتاب رو به ۱۵ آبان ۱۴۰۸ تغییر بده»", () => {
				const res = dispatchLocalAction("موعد تسک خرید کتاب رو به ۱۵ آبان ۱۴۰۸ تغییر بده", baseDate);
				expect(res).not.toBeNull();
				expect(res.intent).toBe("edit");
				expect(res.target_query).toBe("خرید کتاب");
				expect(res.due_date).toBeNull();
				expect(res.isBeyondOneYear).toBe(true);
				expect(res.needsClarification).toBe(true);
				expect(res.clarificationType).toBe("beyond_one_year");
			});
		});

		describe("Forwarding of all structured date fields contract", () => {
			it("contains all 17 structured date fields in add intent", () => {
				const res = dispatchLocalAction("۸ آذر خرید کتاب", baseDate);
				expect(res).toHaveProperty("due_date");
				expect(res).toHaveProperty("isoDueDate");
				expect(res).toHaveProperty("hasDate");
				expect(res).toHaveProperty("hasTime");
				expect(res).toHaveProperty("isAmbiguousTime");
				expect(res).toHaveProperty("ambiguousHour");
				expect(res).toHaveProperty("needsClarification");
				expect(res).toHaveProperty("clarificationType");
				expect(res).toHaveProperty("targetDateStr");
				expect(res).toHaveProperty("targetYear");
				expect(res).toHaveProperty("targetMonth");
				expect(res).toHaveProperty("targetDay");
				expect(res).toHaveProperty("solarYear");
				expect(res).toHaveProperty("solarMonth");
				expect(res).toHaveProperty("solarDay");
				expect(res).toHaveProperty("isPastDate");
				expect(res).toHaveProperty("isBeyondOneYear");
				expect(res).toHaveProperty("isInvalidDate");
				expect(res).toHaveProperty("invalidDateReason");
			});

			it("contains all 17 structured date fields in edit intent", () => {
				const res = dispatchLocalAction("موعد تسک خرید کتاب رو به ۸ آذر تغییر بده", baseDate);
				expect(res).toHaveProperty("due_date");
				expect(res).toHaveProperty("isoDueDate");
				expect(res).toHaveProperty("hasDate");
				expect(res).toHaveProperty("hasTime");
				expect(res).toHaveProperty("isAmbiguousTime");
				expect(res).toHaveProperty("ambiguousHour");
				expect(res).toHaveProperty("needsClarification");
				expect(res).toHaveProperty("clarificationType");
				expect(res).toHaveProperty("targetDateStr");
				expect(res).toHaveProperty("targetYear");
				expect(res).toHaveProperty("targetMonth");
				expect(res).toHaveProperty("targetDay");
				expect(res).toHaveProperty("solarYear");
				expect(res).toHaveProperty("solarMonth");
				expect(res).toHaveProperty("solarDay");
				expect(res).toHaveProperty("isPastDate");
				expect(res).toHaveProperty("isBeyondOneYear");
				expect(res).toHaveProperty("isInvalidDate");
				expect(res).toHaveProperty("invalidDateReason");
			});
		});
	});
});
