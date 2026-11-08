/**
 * Hermes Mini - Natural Language Processing & Conversational AI (Gemini)
 * Converts natural Persian messages and multi-turn conversations to structured JSON actions
 * or natural conversational replies without forcing casual chat into tasks.
 */

import { getTehranContextString, normalizeWeekday } from "./dateUtils.js";

export const ALLOWED_INTENTS = [
	"chat",
	"general_qa",
	"add",
	"list",
	"done",
	"undone",
	"delete",
	"edit",
	"clarify",
];

/**
 * Extracts and parses JSON from text even if surrounded by markdown codeblocks or conversational filler.
 */
export function extractJsonFromText(text) {
	if (!text || typeof text !== "string") {
		throw new Error("Text must be a non-empty string");
	}

	let cleaned = text.trim();
	// Remove outer code fence if entire string is wrapped
	if (cleaned.startsWith("```")) {
		cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
	}

	try {
		return JSON.parse(cleaned);
	} catch {
		// Fallback: extract the JSON object substring between the first '{' and last '}'
		const firstBrace = cleaned.indexOf("{");
		const lastBrace = cleaned.lastIndexOf("}");
		if (firstBrace !== -1 && lastBrace > firstBrace) {
			const sub = cleaned.slice(firstBrace, lastBrace + 1);
			return JSON.parse(sub);
		}
		throw new Error("No valid JSON structure found in LLM response");
	}
}

/**
 * Validates and sanitizes structured LLM output against the expected schema.
 * Never executes raw LLM output without validation.
 */
export function validateLlmOutput(raw) {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return { valid: false, error: "Output must be a JSON object" };
	}

	const intent = typeof raw.intent === "string" ? raw.intent.toLowerCase().trim() : "";
	if (!ALLOWED_INTENTS.includes(intent)) {
		return { valid: false, error: `Invalid intent: ${intent}` };
	}

	const task = (raw.task && typeof raw.task === "object" && !Array.isArray(raw.task)) ? raw.task : {};
	const reply = typeof raw.reply === "string" && raw.reply.trim() ? raw.reply.trim() : null;

	const targetIndex = Number.isInteger(task.target_index) && task.target_index > 0 ? task.target_index : null;

	const sanitized = {
		intent,
		task: {
			title: typeof task.title === "string" && task.title.trim() ? task.title.trim() : null,
			target_query: typeof task.target_query === "string" && task.target_query.trim() ? task.target_query.trim() : null,
			target_index: targetIndex,
			due_date: typeof task.due_date === "string" && task.due_date.trim() ? task.due_date.trim() : null,
			filter: (() => {
				const f = task.filter;
				if (!f) return "all";
				const validStandard = ["all", "today", "tomorrow", "day_after_tomorrow", "overdue", "pending", "completed", "specific_date"];
				if (validStandard.includes(f)) return f;
				const nw = normalizeWeekday(f);
				if (nw) return nw;
				return "all";
			})(),
		},
		reply: reply || "متوجه شدم.",
	};

	// Intent-specific validation
	if (intent === "add") {
		if (!sanitized.task.title) {
			return { valid: false, error: "Task title is required for 'add' intent" };
		}
		if (sanitized.task.due_date) {
			const parsed = new Date(sanitized.task.due_date);
			if (isNaN(parsed.getTime())) {
				sanitized.task.due_date = null; // discard invalid date
			}
		}
	}

	if (["done", "undone", "delete"].includes(intent)) {
		if (!sanitized.task.target_query && !sanitized.task.target_index && !sanitized.task.title) {
			return { valid: false, error: `Target task query or index is required for '${intent}' intent` };
		}
		if (!sanitized.task.target_query && sanitized.task.title) {
			sanitized.task.target_query = sanitized.task.title;
		}
	}

	if (intent === "edit") {
		if (!sanitized.task.target_query && !sanitized.task.target_index && !sanitized.task.title) {
			return { valid: false, error: "Target task query or index is required for 'edit' intent" };
		}
		if (!sanitized.task.target_query && sanitized.task.title) {
			sanitized.task.target_query = sanitized.task.title;
		}
	}

	return { valid: true, data: sanitized };
}

/**
 * Builds the comprehensive system prompt for Persian Conversational Assistant & Task Manager
 */
export function buildSystemPrompt(referenceDate = new Date()) {
	const context = getTehranContextString(referenceDate);

	return `شما «هرمس مینی» (Hermes Mini) هستید؛ یک دستیار هوشمند، بسیار صمیمی، دانا و خوش‌صحبت به زبان فارسی، و در عین حال مدیر دقیق تسک‌ها و کارهای روزانه کاربر.

اطلاعات زمانی مبنا (Asia/Tehran):
- زمان استاندارد ISO فعلی: ${context.isoNow}
- تاریخ خورشیدی امروز: ${context.persianFull}
- تاریخ میلادی امروز: ${context.tehranDate} (${context.weekday})
- ساعت به وقت تهران: ${context.tehranTime}
- منطقه زمانی: Asia/Tehran (UTC+03:30)

قوانین رفتار و مکالمه:
۱. مکالمه آزاد و عمومی:
کاربر حق دارد با شما مثل یک دوست و دستیار دانا صحبت کند. پیام‌هایی مانند:
- احوال‌پرسی («سلام»، «خوبی؟»، «چه خبر؟»)
- درخواست جوک، طنز یا شعر («یه جوک بگو»، «یه لطیفه بگو»)
- درخواست داستان کوتاه («یه داستان بگو»)
- ابراز احساسات («امروز حوصله ندارم»، «خیلی خسته‌ام»، «خوشحالم»)
- پرسش درباره خودت («چیکار می‌کنی؟»، «تو کی هستی؟»)
- تشکر و خداحافظی («ممنون»، «مرسی»، «خداحافظ»، «شب بخیر»)
- پرسش‌های عمومی علمی، فرهنگی یا اطلاعات عمومی («پایتون چیه؟»، «پایتخت فرانسه کجاست؟»)
باید همگی با نیت "chat" یا "general_qa" پاسخ داده شوند.
⚠️ خط قرمز بسیار مهم: هرگز و تحت هیچ شرایطی، پیام‌های گفت‌وگوی عادی، جوک، داستان، ابراز احساسات یا پرسش‌های عمومی را به عنوان تسک ثبت نکنید!

۲. مدیریت هوشمند تسک‌ها:
تنها زمانی که کاربر قصد دارد کاری را برای آینده یا امروز برنامه‌ریزی کند، تسکی را بررسی کند یا تسکی را تغییر دهد، از نیت‌های تسک استفاده کنید:
- "add": ثبت کار جدید.
  * مثال: «فردا ساعت ۱۰ درس بخونم» -> title: "درس خواندن", due_date: فردا ساعت ۱۰:۰۰
  * مثال: «دو ساعت بعدش هم برم ورزش» -> با توجه به پیام قبلی (ساعت ۱۰)، due_date را ساعت ۱۲:۰۰ فردا بگذارید.
- "list": نمایش کارها.
  * filter: "today" (کارهای امروز), "tomorrow" (کارهای فردا), "day_after_tomorrow" (کارهای پس‌فردا), "pending" (انجام‌نشده), "completed" (انجام‌شده), "all" (همه), یا نام روز هفته مانند "دوشنبه", "سه‌شنبه", "پنج‌شنبه"
- "done": انجام شدن کار.
  * مثال: «درس رو انجام دادم» -> target_query: "درس"
  * مثال: «دومی رو انجام دادم» -> target_index: 2
- "undone": بازگرداندن کار به انجام‌نشده.
  * مثال: «اون تسک رو دوباره انجام‌نشده کن» -> target_query یا target_index
- "delete": حذف کار.
  * مثال: «تسک دکتر رو حذف کن»، «اولی رو پاک کن»
- "edit": ویرایش زمان یا عنوان تسک.
  * مثال: «ساعت درس خوندن رو ببر ۱۲» -> target_query: "درس", due_date: زمان جدید ساعت ۱۲:۰۰
- "clarify": هنگامی که درخواست تسک مبهم است و نیاز به توضیح کاربر دارد.

۳. تاریخچه و پیوستگی مکالمه (Context):
شما تاریخچه پیام‌های قبلی کاربر را در دسترس دارید. حتماً از پیام‌های قبلی برای فهم ضمایر («اون»، «بعدش»، «دومی»، «همون تسک») استفاده کنید.

فرمت خروجی الزامی:
شما باید فقط و فقط یک شیء JSON با این ساختار تولید کنید، بدون متن اضافی:
{
  "intent": "chat" | "general_qa" | "add" | "list" | "done" | "undone" | "delete" | "edit" | "clarify",
  "task": {
    "title": "عنوان کار یا null",
    "target_query": "کلمه کلیدی برای جستجوی تسک یا null",
    "target_index": 1 یا null (در صورت اشاره به اولی، دومی و ...),
    "due_date": "فرمت ISO 8601 با +03:30 مانند 2026-11-03T10:00:00+03:30 یا null",
    "filter": "all" | "today" | "tomorrow" | "day_after_tomorrow" | "overdue" | "pending" | "completed" | "شنبه" | "یکشنبه" | "دوشنبه" | "سه‌شنبه" | "چهارشنبه" | "پنج‌شنبه" | "جمعه" | null
  },
  "reply": "پاسخ گرم، روان، صمیمی، کوتاه و طبیعی به زبان فارسی"
}`;
}

/**
 * Normalizes Persian text by unifying characters, removing punctuation, and collapsing whitespace.
 */
export function normalizeText(text) {
	if (!text || typeof text !== "string") {
		return "";
	}

	return text
		.replace(/ي/g, "ی")
		.replace(/ك/g, "ک")
		.replace(/[\u200c\u200b]/g, " ")
		.replace(/[؟!?.,،؛:()\[\]{}"'«»\-_\/\\*~`^#@$%=+]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Detects unambiguous local requests to list/view tasks without calling Gemini.
 * Only inspects messages up to 40 characters.
 * Rejects action commands (add, done, delete, edit) and casual statements.
 */
export function detectListIntent(text) {
	if (!text || typeof text !== "string") {
		return null;
	}

	const trimmed = text.trim();
	if (trimmed.length === 0 || trimmed.length > 40) {
		return null;
	}

	const norm = normalizeText(trimmed);

	// 1. Guard: reject action keywords and casual statements
	const actionKeywords = /(انجام|تموم|حل|حذف|پاک|دیلیت|لغو|ویرایش|عوض|تغییر|اضافه|ثبت|جدید|یادم|یادت|باید|بخونم|برم|بنویس|بزار|بگذار|زیاد|خسته|حوصله)/;
	if (actionKeywords.test(norm)) {
		return null;
	}

	// 2. Identify filter
	let filter = "all";
	if (/(امروز|امروزم|امروزو)/.test(norm)) {
		filter = "today";
	} else if (/(فردا|فردام|فردا رو)/.test(norm)) {
		filter = "tomorrow";
	}

	// 3. Match explicit list patterns
	// Common task noun variants: کارام, کارامو, کارهام, کارهامو, کارای, کارهای, کارها, تسک هام, تسکام, تسک ها, برنامه هام, etc.
	const taskNoun = "(?:کار(?:ه?ام|ه?ای|ها|م)?|تسک\\s*(?:ه?ام|ه?ای|ها|ام|ای)?|برنامه\\s*(?:ه?ام|ه?ای|ها|ام|ای)?)";
	const objSuffix = "(?:[و]|(?:\\s+رو))?";

	// a. Direct 'لیست' requests: "لیست", "لیست کارام", "لیست کارهام", "لیست تسک ها", "لیست امروز", "لیست فردا"
	const listRegex = new RegExp(`^لیست(?:\\s+(?:${taskNoun}|امروز|فردا)(?:\\s+(?:امروز|فردا))?)?$`);
	if (listRegex.test(norm)) {
		return { isList: true, intent: "list", filter };
	}

	// b. What tasks/work do I have: "کارام چیه", "کارامو بگو", "کارای امروز چیه", "تسک هام چیه", "برنامه هام چیه", "کارهام چیه"
	const workQueryRegex = new RegExp(
		`^(?:لیست\\s+)?(?:(?:امروز|فردا)\\s+)?${taskNoun}${objSuffix}(?:\\s+(?:امروز|فردا))?(?:\\s+(?:من|رو))?\\s*(?:چیه|چیست|چندتاست|بگو|نشون\\s*بده|نشونم\\s*بده)$`
	);
	if (workQueryRegex.test(norm)) {
		return { isList: true, intent: "list", filter };
	}

	// c. "What am I doing today/tomorrow": "امروز چیکار دارم", "فردا چیکار دارم", "چیکار دارم", "امروز چه کاری دارم"
	const doingQueryPattern = /^(?:امروز|فردا)?\s*(?:چه\s*(?:کاری|کارایی|کارهایی)|چی\s*کار|چیکار)\s*(?:امروز|فردا)?\s*دارم$/;
	if (doingQueryPattern.test(norm)) {
		return { isList: true, intent: "list", filter };
	}

	// d. "کارهای من رو بگو" or "کارهام رو نشون بده"
	const showWorkRegex = new RegExp(
		`^(?:(?:امروز|فردا)\\s+)?${taskNoun}${objSuffix}(?:\\s+(?:امروز|فردا))?(?:\\s+(?:من|رو))?\\s*(?:بگو|نشون\\s*بده|نشونم\\s*بده)$`
	);
	if (showWorkRegex.test(norm)) {
		return { isList: true, intent: "list", filter };
	}

	return null;
}

/**
 * Fallback parser when LLM API is unavailable, key is missing, or unexpected error occurs.
 * CRITICAL RULE: Never force general messages or errors into task additions!
 */
export function fallbackPersianParser(text = "") {
	const trimmed = (text || "").trim();
	if (!trimmed) {
		return {
			intent: "chat",
			task: { title: null, target_query: null, target_index: null, due_date: null, filter: "all" },
			reply: "سلام! چطور می‌تونم کمکتون کنم؟",
		};
	}

	// Check local list intent detection first
	const listMatch = detectListIntent(trimmed);
	if (listMatch) {
		return {
			intent: "list",
			task: {
				title: null,
				target_query: null,
				target_index: null,
				due_date: null,
				filter: listMatch.filter,
			},
			reply: listMatch.filter === "tomorrow" ? "لیست کارهای فردا:" : listMatch.filter === "today" ? "لیست کارهای امروز:" : "لیست تسک‌های شما:",
		};
	}

	// Greetings, /start & Chat
	if (/^(سلام|درود|صبح بخیر|عصر بخیر|شب بخیر|چطوری|خوبی|هرمس|راهنما|کمک|\/start|^start$|^شروع$)/i.test(trimmed)) {
		return {
			intent: "chat",
			task: { title: null, target_query: null, target_index: null, due_date: null, filter: "all" },
			reply: "سلام! به هرمس مینی خوش آمدید 🚀\nمن دستیار هوشمند شما هستم. می‌توانید آزادانه با من صحبت کنید یا کارهای روزانه‌تان را به زبان عادی برام بفرستید تا مدیریت کنم.",
		};
	}

	// Jokes, Stories & General Conversational messages
	if (/(جوک|لطیفه|داستان|حوصله ندارم|خسته‌ام|خسته ام|چیکار می‌کنی|چیکار میکنی|ممنون|مرسی|خداحافظ|شب بخیر)/i.test(trimmed)) {
		return {
			intent: "chat",
			task: { title: null, target_query: null, target_index: null, due_date: null, filter: "all" },
			reply: "خوشحالم که هم‌صحبتم شدی! در حال حاضر در حالت آفلاین هستم، ولی در حالت عادی می‌تونم جوک بگم، داستان تعریف کنم و درباره هر موضوعی گپ بزنیم 😊",
		};
	}

	// List queries (broader regex fallback)
	if (/(لیست|کارهام|کارام|تسک‌هام|تسکام|کارهایی|کارهای امروز|کارهای فردا|چیکار دارم)/i.test(trimmed)) {
		const isToday = /(امروز|امروزم)/i.test(trimmed);
		const isTomorrow = /(فردا)/i.test(trimmed);
		return {
			intent: "list",
			task: {
				title: null,
				target_query: null,
				target_index: null,
				due_date: null,
				filter: isTomorrow ? "tomorrow" : isToday ? "today" : "all",
			},
			reply: isTomorrow ? "لیست کارهای فردا:" : isToday ? "لیست کارهای امروز:" : "لیست تسک‌های شما:",
		};
	}

	// Done (by query or ordinal)
	const doneMatch = trimmed.match(/^(?:(.+?)\s*(?:رو|را)?\s*)?(انجام دادم|انجام شد|تموم شد|انجامش دادم|حل شد)$/i);
	if (doneMatch) {
		const rawTarget = (doneMatch[1] || "").replace(/^(تسک|کار)\s*/i, "").trim();
		let targetIndex = null;
		let targetQuery = rawTarget;

		if (/^(اول|اولی|۱)$/i.test(rawTarget)) targetIndex = 1;
		else if (/^(دوم|دومی|۲)$/i.test(rawTarget)) targetIndex = 2;
		else if (/^(سوم|سومی|۳)$/i.test(rawTarget)) targetIndex = 3;

		// Guard: If ambiguous or target missing/generic, ask for clarification
		if (!targetIndex && (!targetQuery || targetQuery.length < 2 || /^(اون|همون|کار|تسک|تسک‌ها|کارها|این)$/i.test(targetQuery))) {
			return {
				intent: "clarify",
				task: { title: null, target_query: null, target_index: null, due_date: null, filter: "all" },
				reply: "دقیقاً مشخص نکردید کدام تسک انجام شده است. لطفاً عنوان یا شماره تسک را بفرمایید.",
			};
		}

		return {
			intent: "done",
			task: { title: null, target_query: targetQuery, target_index: targetIndex, due_date: null, filter: "all" },
			reply: `تسک مورد نظر به عنوان انجام‌شده علامت‌گذاری شد.`,
		};
	}

	// Undone
	const undoneMatch = trimmed.match(/^(?:(.+?)\s*(?:رو|را)?\s*)?(انجام‌نشده کن|انجام نشده کن|برگردون|ناقص کن)$/i);
	if (undoneMatch) {
		const rawTarget = (undoneMatch[1] || "").replace(/^(تسک|کار|اون تسک)\s*/i, "").trim();
		let targetIndex = null;
		if (/^(اول|اولی|۱)$/i.test(rawTarget)) targetIndex = 1;
		else if (/^(دوم|دومی|۲)$/i.test(rawTarget)) targetIndex = 2;
		else if (/^(سوم|سومی|۳)$/i.test(rawTarget)) targetIndex = 3;

		// Guard: If ambiguous
		if (!targetIndex && (!rawTarget || rawTarget.length < 2 || /^(اون|همون|کار|تسک|تسک‌ها|کارها|این)$/i.test(rawTarget))) {
			return {
				intent: "clarify",
				task: { title: null, target_query: null, target_index: null, due_date: null, filter: "all" },
				reply: "مشخص نیست کدام تسک باید به حالت انجام‌نشده بازگردد. لطفاً نام تسک را بنویسید.",
			};
		}

		return {
			intent: "undone",
			task: { title: null, target_query: rawTarget, target_index: targetIndex, due_date: null, filter: "all" },
			reply: `تسک مورد نظر به حالت انجام‌نشده بازگشت.`,
		};
	}

	// Delete
	const deleteMatch = trimmed.match(/^(?:(.+?)\s*(?:رو|را)?\s*)?(حذف کن|پاک کن|دیلیت کن)$/i);
	if (deleteMatch) {
		const rawTarget = (deleteMatch[1] || "").replace(/^(تسک|کار)\s*/i, "").trim();
		let targetIndex = null;
		if (/^(اول|اولی|۱)$/i.test(rawTarget)) targetIndex = 1;
		else if (/^(دوم|دومی|۲)$/i.test(rawTarget)) targetIndex = 2;
		else if (/^(سوم|سومی|۳)$/i.test(rawTarget)) targetIndex = 3;

		// Guard: If ambiguous
		if (!targetIndex && (!rawTarget || rawTarget.length < 2 || /^(اون|همون|کار|تسک|تسک‌ها|کارها|این)$/i.test(rawTarget))) {
			return {
				intent: "clarify",
				task: { title: null, target_query: null, target_index: null, due_date: null, filter: "all" },
				reply: "دقیقاً مشخص نکردید کدام تسک باید حذف شود. لطفاً عنوان یا شماره تسک را بفرمایید.",
			};
		}

		return {
			intent: "delete",
			task: { title: null, target_query: rawTarget, target_index: targetIndex, due_date: null, filter: "all" },
			reply: `تسک با موفقیت حذف شد.`,
		};
	}

	// Edit (inherently ambiguous without LLM understanding, ask for clarification)
	if (/(ویرایش کن|تغییر بده|عوض کن|ساعتش رو ببر)/i.test(trimmed)) {
		return {
			intent: "clarify",
			task: { title: null, target_query: null, target_index: null, due_date: null, filter: "all" },
			reply: "برای ویرایش تسک، لطفاً مشخص کنید کدام تسک و چه تغییری (عنوان یا ساعت جدید) مد نظرتان است.",
		};
	}

	// Explicit task addition (when clearly indicated as a task or action)
	if (/^(تسک|وظیفه)(?:\s+|$)/i.test(trimmed) || /(اضافه کن|یادم بنداز|ثبت کن)/i.test(trimmed) || /^(فردا|امروز|امشب|پس‌فردا).*(باید|برم|بخونم|انجام بدم)/i.test(trimmed) || /^باید\s+/i.test(trimmed)) {
		const cleanTitle = trimmed
			.replace(/^(یه تسک اضافه کن که|تسک اضافه کن|لطفاً|لطفا|یادم بنداز که|یادت نره|تسک:|وظیفه:|تسک\s*[\d۰-۹]*\s*[:\s]*|تسک\s*)/iu, "")
			.replace(/\s*(رو|را)?\s*(اضافه کن|ثبت کن|یادم بنداز)$/iu, "")
			.trim();

		if (!cleanTitle || cleanTitle.length < 2 || /^(تسک|کار|وظیفه)$/i.test(cleanTitle)) {
			return {
				intent: "clarify",
				task: { title: null, target_query: null, target_index: null, due_date: null, filter: "all" },
				reply: "عنوان تسک مشخص نیست. لطفاً بفرمایید چه کاری را می‌خواهید ثبت کنم؟",
			};
		}

		return {
			intent: "add",
			task: { title: cleanTitle, target_query: null, target_index: null, due_date: null, filter: "all" },
			reply: `تسک «${cleanTitle}» با موفقیت ثبت شد.`,
		};
	}

	// Safe fallback: treat as general conversation or notify gracefully without creating unwanted tasks
	return {
		intent: "chat",
		task: { title: null, target_query: null, target_index: null, due_date: null, filter: "all" },
		reply: "پیام شما دریافت شد. من هرمس مینی هستم؛ برای کارهای روزمره می‌تونید بفرمایید چه تسکی دارید، یا آزادانه با من صحبت کنید.",
	};
}

/**
 * Parses user Persian message via LLM API (OpenAI-compatible / Gemini) with full multi-turn context
 * Includes per-request timeout (8s), retry with jitter for transient errors (429, 500, 503),
 * deadline awareness, and structured return ({ ok, data } or { ok: false, status, retryable, error }).
 */
export async function parsePersianWithLLM(text, config, conversationHistory = [], optionsOrFetch = {}, fetchImplArg = null) {
	let options = {};
	let fetchImpl = fetch;

	if (typeof conversationHistory === "function") {
		fetchImpl = conversationHistory;
		conversationHistory = [];
	} else if (typeof optionsOrFetch === "function") {
		fetchImpl = optionsOrFetch;
		options = {};
	} else {
		if (optionsOrFetch && typeof optionsOrFetch === "object") {
			options = optionsOrFetch;
			if (typeof options.fetch === "function") {
				fetchImpl = options.fetch;
			}
		}
		if (typeof fetchImplArg === "function") {
			fetchImpl = fetchImplArg;
		}
	}

	if (!text || typeof text !== "string" || !text.trim()) {
		return {
			ok: false,
			status: null,
			retryable: false,
			error: "EMPTY_TEXT",
		};
	}

	// If no LLM API key configured
	if (!config || !config.llmApiKey) {
		console.warn("LLM_API_KEY is not configured.");
		return {
			ok: false,
			status: null,
			retryable: false,
			error: "LLM_API_KEY_MISSING",
		};
	}

	const url = `${config.llmApiBase}/chat/completions`;
	const systemPrompt = buildSystemPrompt(new Date());

	// Build messages array with conversation history
	const messages = [
		{ role: "system", content: systemPrompt },
	];

	if (Array.isArray(conversationHistory) && conversationHistory.length > 0) {
		for (const msg of conversationHistory) {
			if (msg && msg.content && (msg.role === "user" || msg.role === "assistant")) {
				messages.push({
					role: msg.role,
					content: msg.content,
				});
			}
		}
	}

	messages.push({ role: "user", content: text.trim() });

	// Model Chain Configuration (Max 3 models)
	const primaryModel = config.llmModel;
	const rawFallbacks = Array.isArray(config.llmModelFallbacks)
		? config.llmModelFallbacks
		: (typeof config.llmModelFallbacks === "string" ? config.llmModelFallbacks.split(",") : []);

	// Build clean unique models list preserving order, up to 3 models
	const models = [primaryModel];
	for (const m of rawFallbacks) {
		const clean = typeof m === "string" ? m.trim() : "";
		if (clean && !models.includes(clean)) {
			models.push(clean);
			if (models.length >= 3) break;
		}
	}

	// Number of attempts equals number of models (up to 3) if fallbacks provided.
	// If no fallbacks are configured, keep existing behavior (2 attempts on single model).
	const totalAttempts = models.length > 1 ? models.length : (options.maxRetries ?? 1) + 1;

	// Overall chain deadline: maximum 18 seconds total for Gemini chain
	const maxChainDeadline = Date.now() + 18000;
	const overallDeadline = options.deadline
		? Math.min(options.deadline, maxChainDeadline)
		: (options.remainingDeadlineMs ? Math.min(Date.now() + options.remainingDeadlineMs, maxChainDeadline) : maxChainDeadline);

	const TRANSIENT_STATUS_CODES = [429, 500, 502, 503, 504];
	const perRequestTimeoutMs = options.timeoutMs || 8000; // max 8s per attempt

	let lastError = null;

	for (let attempt = 1; attempt <= totalAttempts; attempt++) {
		const currentModel = models.length > 1 ? models[attempt - 1] : models[0];
		const nextModel = attempt < totalAttempts ? (models.length > 1 ? models[attempt] : currentModel) : null;

		const now = Date.now();
		const remainingOverall = overallDeadline - now;

		// Do not attempt if overall deadline is practically exhausted
		if (remainingOverall <= 1000) {
			console.warn(`[LLM] Overall deadline (18s) reached before attempt ${attempt}/${totalAttempts} (${currentModel})`);
			return {
				ok: false,
				status: null,
				retryable: true,
				error: "OVERALL_DEADLINE_EXCEEDED",
			};
		}

		// Cap attempt timeout to either perRequestTimeoutMs or remaining time
		const thisAttemptTimeout = Math.min(perRequestTimeoutMs, Math.max(1000, remainingOverall - 1500));
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(new Error("LLM request timeout")), thisAttemptTimeout);
		const attemptStart = Date.now();

		try {
			const response = await fetchImpl(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${config.llmApiKey}`,
				},
				body: JSON.stringify({
					model: currentModel,
					messages,
					temperature: 0.3,
					response_format: { type: "json_object" },
				}),
				signal: controller.signal,
			});
			clearTimeout(timer);
			const durationMs = Date.now() - attemptStart;
			const remainingAfterFetch = overallDeadline - Date.now();

			if (!response.ok) {
				const status = response.status;
				const isTransient = TRANSIENT_STATUS_CODES.includes(status);
				const isModelNotFound = status === 404 && models.length > 1;
				const canSwitchToNextModel = (isTransient || isModelNotFound) && attempt < totalAttempts;
				const errText = await response.text().catch(() => "");

				lastError = {
					ok: false,
					status,
					retryable: isTransient || isModelNotFound,
					error: errText.slice(0, 200) || `HTTP ${status}`,
				};

				// Log attempt outcome with duration and remaining deadline (no secrets logged)
				if (canSwitchToNextModel) {
					const reason = isModelNotFound ? "model not found (404)" : `transient error (HTTP ${status})`;
					console.warn(
						`[LLM] Attempt ${attempt}/${totalAttempts} (${currentModel}): HTTP ${status} (${durationMs}ms, ${remainingAfterFetch}ms left) - ${reason}, switching to ${nextModel}`
					);
				} else {
					console.error(
						`[LLM] Attempt ${attempt}/${totalAttempts} (${currentModel}): HTTP ${status} (${durationMs}ms, ${remainingAfterFetch}ms left) - ${
							isTransient || isModelNotFound ? "final attempt failed" : "non-retryable error (e.g. 400/401/403)"
						}`
					);
				}

				// Retry with next model only if eligible, attempts remain, and enough time left in 18s deadline
				if (canSwitchToNextModel && remainingAfterFetch > 2000) {
					const jitter = isModelNotFound ? 50 : Math.floor(Math.random() * 200) + 200;
					const sleepMs = Math.min(jitter, remainingAfterFetch - 1000);
					const sleep = options.sleepFn || ((ms) => new Promise((r) => setTimeout(r, ms)));
					await sleep(sleepMs);
					continue;
				}

				return lastError;
			}

			console.log(`[LLM] Attempt ${attempt}/${totalAttempts} (${currentModel}): HTTP 200 OK (${durationMs}ms)`);
			const data = await response.json();
			const rawContent = data?.choices?.[0]?.message?.content;
			if (!rawContent) {
				console.error(`[LLM] Attempt ${attempt}/${totalAttempts} (${currentModel}): returned empty content`);
				return {
					ok: false,
					status: 200,
					retryable: false,
					error: "EMPTY_CONTENT",
				};
			}

			let parsedJson;
			try {
				parsedJson = extractJsonFromText(rawContent);
			} catch (parseErr) {
				console.error(`[LLM] Attempt ${attempt}/${totalAttempts} (${currentModel}): failed to parse JSON:`, parseErr.message);
				return {
					ok: false,
					status: 200,
					retryable: false,
					error: "INVALID_JSON_RESPONSE",
				};
			}

			// Validate with strict schema
			const validation = validateLlmOutput(parsedJson);
			if (!validation.valid) {
				console.warn(`[LLM] Attempt ${attempt}/${totalAttempts} (${currentModel}): schema validation failed:`, validation.error);
				return {
					ok: false,
					status: 200,
					retryable: false,
					error: `SCHEMA_VALIDATION_FAILED: ${validation.error}`,
				};
			}

			return {
				ok: true,
				data: validation.data,
				intent: validation.data.intent,
				task: validation.data.task,
				reply: validation.data.reply,
			};
		} catch (err) {
			clearTimeout(timer);
			const durationMs = Date.now() - attemptStart;
			const isTimeout = err.name === "AbortError" || /timeout/i.test(err.message);

			lastError = {
				ok: false,
				status: null,
				retryable: true,
				error: isTimeout ? "REQUEST_TIMEOUT" : err.message,
			};

			if (attempt < totalAttempts) {
				console.warn(`[LLM] Attempt ${attempt}/${totalAttempts} (${currentModel}): ${isTimeout ? "Timeout" : err.message} (${durationMs}ms) - switching to ${nextModel}`);
			} else {
				console.error(`[LLM] Attempt ${attempt}/${totalAttempts} (${currentModel}): ${isTimeout ? "Timeout" : err.message} (${durationMs}ms) - final attempt failed`);
			}

			const remainingAfter = overallDeadline - Date.now();
			if (attempt < totalAttempts && remainingAfter > 2000) {
				const jitter = Math.floor(Math.random() * 200) + 200;
				const sleepMs = Math.min(jitter, remainingAfter - 1000);
				const sleep = options.sleepFn || ((ms) => new Promise((r) => setTimeout(r, ms)));
				await sleep(sleepMs);
				continue;
			}

			return lastError;
		}
	}

	return lastError || {
		ok: false,
		status: null,
		retryable: false,
		error: "UNKNOWN_LLM_FAILURE",
	};
}
