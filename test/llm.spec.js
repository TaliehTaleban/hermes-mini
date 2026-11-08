import { describe, it, expect } from "vitest";
import {
	normalizeText,
	detectListIntent,
	validateLlmOutput,
	extractJsonFromText,
	fallbackPersianParser,
	buildSystemPrompt,
	parsePersianWithLLM,
	ALLOWED_INTENTS,
} from "../src/llm.js";

describe("LLM & Persian NLP Parser", () => {
	describe("Schema Validation (validateLlmOutput)", () => {
		it("accepts valid 'add' schema", () => {
			const validAdd = {
				intent: "add",
				task: {
					title: "رفتن به دکتر",
					due_date: "2026-11-03T17:00:00+03:30",
				},
				reply: "تسک اضافه شد",
			};

			const result = validateLlmOutput(validAdd);
			expect(result.valid).toBe(true);
			expect(result.data.intent).toBe("add");
			expect(result.data.task.title).toBe("رفتن به دکتر");
			expect(result.data.task.due_date).toBe("2026-11-03T17:00:00+03:30");
		});

		it("accepts 'chat' and 'general_qa' with natural reply and empty task", () => {
			const chat = {
				intent: "chat",
				reply: "یه روز یه فیل میره بالای درخت...",
			};
			const res = validateLlmOutput(chat);
			expect(res.valid).toBe(true);
			expect(res.data.intent).toBe("chat");
			expect(res.data.reply).toContain("فیل");

			const qa = {
				intent: "general_qa",
				reply: "پایتون یک زبان برنامه‌نویسی سطح بالاست.",
			};
			const resQa = validateLlmOutput(qa);
			expect(resQa.valid).toBe(true);
			expect(resQa.data.intent).toBe("general_qa");
		});

		it("accepts valid 'edit' schema", () => {
			const edit = {
				intent: "edit",
				task: {
					target_query: "درس",
					due_date: "2026-11-03T12:00:00+03:30",
				},
				reply: "ساعت درس به ۱۲ تغییر کرد",
			};
			const res = validateLlmOutput(edit);
			expect(res.valid).toBe(true);
			expect(res.data.intent).toBe("edit");
			expect(res.data.task.target_query).toBe("درس");
			expect(res.data.task.due_date).toBe("2026-11-03T12:00:00+03:30");
		});

		it("rejects unknown intent", () => {
			const invalid = {
				intent: "hack_system",
				task: {},
				reply: "Hi",
			};
			const result = validateLlmOutput(invalid);
			expect(result.valid).toBe(false);
			expect(result.error).toContain("Invalid intent");
		});

		it("rejects 'add' without title", () => {
			const invalid = {
				intent: "add",
				task: { title: "   " },
				reply: "اضافه شد",
			};
			const result = validateLlmOutput(invalid);
			expect(result.valid).toBe(false);
			expect(result.error).toContain("Task title is required");
		});

		it("requires target query for 'done', 'undone', 'delete'", () => {
			for (const intent of ["done", "undone", "delete"]) {
				const invalid = {
					intent,
					task: { target_query: "" },
					reply: "انجام شد",
				};
				const result = validateLlmOutput(invalid);
				expect(result.valid).toBe(false);
			}
		});

		it("sanitizes invalid date to null rather than crashing", () => {
			const input = {
				intent: "add",
				task: { title: "خرید نان", due_date: "invalid-date-string" },
				reply: "ثبت شد",
			};
			const result = validateLlmOutput(input);
			expect(result.valid).toBe(true);
			expect(result.data.task.due_date).toBeNull();
		});
	});

	describe("JSON Extraction from LLM Text (extractJsonFromText)", () => {
		it("extracts direct JSON string", () => {
			const json = extractJsonFromText('{"intent": "chat", "reply": "سلام"}');
			expect(json.intent).toBe("chat");
		});

		it("extracts JSON enclosed in markdown code fences", () => {
			const raw = "```json\n{\n  \"intent\": \"add\",\n  \"reply\": \"ثبت شد\"\n}\n```";
			const json = extractJsonFromText(raw);
			expect(json.intent).toBe("add");
		});

		it("extracts JSON surrounded by conversational text", () => {
			const raw = "Here is your JSON response:\n{\n  \"intent\": \"list\",\n  \"reply\": \"کارهای شما\"\n}\nHope this helps!";
			const json = extractJsonFromText(raw);
			expect(json.intent).toBe("list");
		});
	});

	describe("Text Normalization (normalizeText)", () => {
		it("converts Arabic ي and ك to Persian ی and ک", () => {
			expect(normalizeText("يك كتاب زيبا")).toBe("یک کتاب زیبا");
		});

		it("converts half-space to standard space", () => {
			expect(normalizeText("کارهای\u200cامروز")).toBe("کارهای امروز");
			expect(normalizeText("تسک\u200bها")).toBe("تسک ها");
		});

		it("removes punctuation marks and symbols", () => {
			expect(normalizeText("کارام چیه؟!.")).toBe("کارام چیه");
			expect(normalizeText("«تسک‌ها»: (امروز)")).toBe("تسک ها امروز");
		});

		it("collapses consecutive whitespace and trims ends", () => {
			expect(normalizeText("   لیست    کارهای    من   ")).toBe("لیست کارهای من");
		});
	});

	describe("Local List Intent Detection (detectListIntent)", () => {
		it("detects «کارام چیه؟» as list with filter all", () => {
			const res = detectListIntent("کارام چیه؟");
			expect(res).not.toBeNull();
			expect(res.intent).toBe("list");
			expect(res.filter).toBe("all");
		});

		it("detects «کارامو بگو» as list with filter all", () => {
			const res = detectListIntent("کارامو بگو");
			expect(res).not.toBeNull();
			expect(res.intent).toBe("list");
			expect(res.filter).toBe("all");
		});

		it("detects «کارهام چیه؟» as list with filter all", () => {
			const res = detectListIntent("کارهام چیه؟");
			expect(res).not.toBeNull();
			expect(res.intent).toBe("list");
			expect(res.filter).toBe("all");
		});

		it("detects «لیست» as list with filter all", () => {
			const res = detectListIntent("لیست");
			expect(res).not.toBeNull();
			expect(res.intent).toBe("list");
			expect(res.filter).toBe("all");
		});

		it("detects «لیست کارهام» as list with filter all", () => {
			const res = detectListIntent("لیست کارهام");
			expect(res).not.toBeNull();
			expect(res.intent).toBe("list");
			expect(res.filter).toBe("all");
		});

		it("detects «کارای امروز چیه؟» with filter today", () => {
			const res = detectListIntent("کارای امروز چیه؟");
			expect(res).not.toBeNull();
			expect(res.intent).toBe("list");
			expect(res.filter).toBe("today");
		});

		it("detects «کارای فردا چیه؟» with filter tomorrow", () => {
			const res = detectListIntent("کارای فردا چیه؟");
			expect(res).not.toBeNull();
			expect(res.intent).toBe("list");
			expect(res.filter).toBe("tomorrow");
		});

		it("detects «تسک‌هام چیه؟» as list with filter all", () => {
			const res = detectListIntent("تسک‌هام چیه؟");
			expect(res).not.toBeNull();
			expect(res.intent).toBe("list");
			expect(res.filter).toBe("all");
		});

		it("detects «برنامه‌هام چیه؟» as list with filter all", () => {
			const res = detectListIntent("برنامه‌هام چیه؟");
			expect(res).not.toBeNull();
			expect(res.intent).toBe("list");
			expect(res.filter).toBe("all");
		});

		it("detects «امروز چیکار دارم؟» with filter today", () => {
			const res = detectListIntent("امروز چیکار دارم؟");
			expect(res).not.toBeNull();
			expect(res.intent).toBe("list");
			expect(res.filter).toBe("today");
		});

		// Negative tests
		it("rejects «کارامو انجام دادم» (done action)", () => {
			expect(detectListIntent("کارامو انجام دادم")).toBeNull();
		});

		it("rejects «کارامو حذف کن» (delete action)", () => {
			expect(detectListIntent("کارامو حذف کن")).toBeNull();
		});

		it("rejects «فردا باید کارامو انجام بدم» (future action)", () => {
			expect(detectListIntent("فردا باید کارامو انجام بدم")).toBeNull();
		});

		it("rejects «کارام زیاده» (casual remark)", () => {
			expect(detectListIntent("کارام زیاده")).toBeNull();
		});

		it("rejects «یه کار جدید اضافه کن» (add action)", () => {
			expect(detectListIntent("یه کار جدید اضافه کن")).toBeNull();
		});

		it("rejects «یادم بنداز فردا درس بخونم» (add action)", () => {
			expect(detectListIntent("یادم بنداز فردا درس بخونم")).toBeNull();
		});

		it("rejects messages longer than 40 characters", () => {
			const longMsg = "لطفا لیست کارهای امروز من را به صورت کامل و دقیق برای من نمایش بده";
			expect(longMsg.length).toBeGreaterThan(40);
			expect(detectListIntent(longMsg)).toBeNull();
		});
	});

	describe("Persian Fallback Parser (fallbackPersianParser)", () => {
		it("detects greetings and /start as 'chat'", () => {
			const res = fallbackPersianParser("سلام هرمس");
			expect(res.intent).toBe("chat");
			expect(res.reply).toContain("هرمس مینی");

			const startRes = fallbackPersianParser("/start");
			expect(startRes.intent).toBe("chat");
			expect(startRes.reply).toContain("هرمس مینی");
		});

		it("detects list intent", () => {
			const res1 = fallbackPersianParser("لیست تسک‌هام رو نشون بده");
			expect(res1.intent).toBe("list");
			expect(res1.task.filter).toBe("all");

			const res2 = fallbackPersianParser("کارهای امروز من چیه؟");
			expect(res2.intent).toBe("list");
			expect(res2.task.filter).toBe("today");
		});

		it("detects done intent and extracts task target", () => {
			const res = fallbackPersianParser("تسک ریاضی رو انجام دادم");
			expect(res.intent).toBe("done");
			expect(res.task.target_query).toBe("ریاضی");
		});

		it("detects undone intent", () => {
			const res = fallbackPersianParser("تسک ریاضی رو دوباره انجام نشده کن");
			expect(res.intent).toBe("undone");
			expect(res.task.target_query).toContain("ریاضی");
		});

		it("detects delete intent", () => {
			const res = fallbackPersianParser("تسک دکتر رو حذف کن");
			expect(res.intent).toBe("delete");
			expect(res.task.target_query).toBe("دکتر");
		});

		it("detects add intent from natural Persian statement", () => {
			const res = fallbackPersianParser("فردا ساعت ۵ باید برم دکتر");
			expect(res.intent).toBe("add");
			expect(res.task.title).toContain("دکتر");
		});

		it("guards against ambiguous done operations and asks for clarification", () => {
			const ambiguousDone1 = fallbackPersianParser("انجام دادم");
			expect(ambiguousDone1.intent).toBe("clarify");
			expect(ambiguousDone1.reply).toContain("مشخص نکردید");

			const ambiguousDone2 = fallbackPersianParser("تسک رو انجام دادم");
			expect(ambiguousDone2.intent).toBe("clarify");
			expect(ambiguousDone2.reply).toContain("مشخص نکردید");

			const ambiguousDone3 = fallbackPersianParser("اون رو انجام دادم");
			expect(ambiguousDone3.intent).toBe("clarify");
		});

		it("guards against ambiguous delete operations and asks for clarification", () => {
			const ambiguousDelete1 = fallbackPersianParser("حذف کن");
			expect(ambiguousDelete1.intent).toBe("clarify");
			expect(ambiguousDelete1.reply).toContain("مشخص نکردید");

			const ambiguousDelete2 = fallbackPersianParser("تسک رو پاک کن");
			expect(ambiguousDelete2.intent).toBe("clarify");
			expect(ambiguousDelete2.reply).toContain("مشخص نکردید");
		});

		it("guards against ambiguous edit operations and asks for clarification", () => {
			const ambiguousEdit = fallbackPersianParser("ساعتش رو تغییر بده");
			expect(ambiguousEdit.intent).toBe("clarify");
			expect(ambiguousEdit.reply).toContain("ویرایش تسک");
		});

		it("does NOT turn casual conversation or arbitrary questions into tasks", () => {
			const queries = [
				"قیمت دلار چنده؟",
				"هوا چطوره فردا؟",
				"پایتون بهتره یا جاوا اسکریپت؟",
			];
			for (const q of queries) {
				const res = fallbackPersianParser(q);
				expect(res.intent).toBe("chat");
				expect(res.task.title).toBeNull();
			}
		});
	});

	describe("Prompt & API Caller (parsePersianWithLLM)", () => {
		it("includes current date and time context in system prompt", () => {
			const prompt = buildSystemPrompt(new Date("2026-11-02T12:00:00Z"));
			expect(prompt).toContain("هرمس مینی");
			expect(prompt).toContain("2026-11-02");
			expect(prompt).toContain("Asia/Tehran");
		});

		it("returns structured error when LLM_API_KEY is missing", async () => {
			const config = { llmApiKey: null, llmApiBase: "https://api.test", llmModel: "test" };
			const result = await parsePersianWithLLM("تسک خرید نان رو اضافه کن", config);
			expect(result.ok).toBe(false);
			expect(result.error).toBe("LLM_API_KEY_MISSING");
			expect(result.retryable).toBe(false);
		});

		it("returns structured success response when Gemini API succeeds", async () => {
			const mockFetch = async () => {
				return new Response(
					JSON.stringify({
						choices: [
							{
								message: {
									content: JSON.stringify({
										intent: "add",
										task: {
											title: "خواندن کتاب",
											due_date: "2026-11-03T20:00:00+03:30",
										},
										reply: "تسک خواندن کتاب برای فردا ساعت ۲۰ ثبت شد.",
									}),
								},
							},
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } }
				);
			};

			const config = {
				llmApiKey: "test-key",
				llmApiBase: "https://mock.llm.api/v1",
				llmModel: "gemini-3.8-flash",
			};

			const result = await parsePersianWithLLM("فردا شب کتاب بخونم", config, mockFetch);
			expect(result.ok).toBe(true);
			expect(result.intent).toBe("add");
			expect(result.task.title).toBe("خواندن کتاب");
			expect(result.task.due_date).toBe("2026-11-03T20:00:00+03:30");
			expect(result.reply).toContain("خواندن کتاب");
		});

		it("retries once with jitter on 503 error and returns structured error if retry fails", async () => {
			let callCount = 0;
			const mockFetch = async () => {
				callCount++;
				return new Response(
					JSON.stringify({
						error: { code: 503, message: "Model is overloaded", status: "UNAVAILABLE" },
					}),
					{ status: 503, headers: { "Content-Type": "application/json" } }
				);
			};

			const config = {
				llmApiKey: "test-key",
				llmApiBase: "https://mock.llm.api/v1",
				llmModel: "gemini-3.8-flash",
			};

			const result = await parsePersianWithLLM("سلام", config, [], {
				fetch: mockFetch,
				sleepFn: async () => {}, // 0ms sleep in tests
			});

			expect(callCount).toBe(2); // exactly 1 initial + 1 retry
			expect(result.ok).toBe(false);
			expect(result.status).toBe(503);
			expect(result.retryable).toBe(true);
		});

		it("retries on 429 and succeeds if second attempt succeeds", async () => {
			let callCount = 0;
			const mockFetch = async () => {
				callCount++;
				if (callCount === 1) {
					return new Response(
						JSON.stringify({ error: { code: 429, message: "Rate limit" } }),
						{ status: 429, headers: { "Content-Type": "application/json" } }
					);
				}
				return new Response(
					JSON.stringify({
						choices: [{ message: { content: JSON.stringify({ intent: "chat", reply: "درود بر شما" }) } }],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } }
				);
			};

			const config = {
				llmApiKey: "test-key",
				llmApiBase: "https://mock.llm.api/v1",
				llmModel: "gemini-3.8-flash",
			};

			const result = await parsePersianWithLLM("سلام", config, [], {
				fetch: mockFetch,
				sleepFn: async () => {},
			});

			expect(callCount).toBe(2);
			expect(result.ok).toBe(true);
			expect(result.intent).toBe("chat");
			expect(result.reply).toBe("درود بر شما");
		});

		it("does NOT retry on 401 error and returns immediately", async () => {
			let callCount = 0;
			const mockFetch = async () => {
				callCount++;
				return new Response(
					JSON.stringify({ error: { code: 401, message: "API key invalid" } }),
					{ status: 401, headers: { "Content-Type": "application/json" } }
				);
			};

			const config = {
				llmApiKey: "bad-key",
				llmApiBase: "https://mock.llm.api/v1",
				llmModel: "gemini-3.8-flash",
			};

			const result = await parsePersianWithLLM("سلام", config, [], {
				fetch: mockFetch,
				sleepFn: async () => {},
			});

			expect(callCount).toBe(1); // NO retry
			expect(result.ok).toBe(false);
			expect(result.status).toBe(401);
			expect(result.retryable).toBe(false);
		});

		it("retries on timeout (AbortError) and returns structured timeout error", async () => {
			let callCount = 0;
			const mockFetch = async () => {
				callCount++;
				const abortErr = new Error("The operation was aborted");
				abortErr.name = "AbortError";
				throw abortErr;
			};

			const config = {
				llmApiKey: "test-key",
				llmApiBase: "https://mock.llm.api/v1",
				llmModel: "gemini-3.8-flash",
			};

			const result = await parsePersianWithLLM("سلام", config, [], {
				fetch: mockFetch,
				sleepFn: async () => {},
			});

			expect(callCount).toBe(2); // exactly 1 retry
			expect(result.ok).toBe(false);
			expect(result.retryable).toBe(true);
			expect(result.error).toBe("REQUEST_TIMEOUT");
		});

		it("returns structured error on invalid JSON response from LLM", async () => {
			const mockFetch = async () => {
				return new Response(
					JSON.stringify({
						choices: [{ message: { content: "This is not valid json at all!" } }],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } }
				);
			};

			const config = {
				llmApiKey: "test-key",
				llmApiBase: "https://mock.llm.api/v1",
				llmModel: "test-model",
			};

			const result = await parsePersianWithLLM("سلام", config, mockFetch);
			expect(result.ok).toBe(false);
			expect(result.error).toBe("INVALID_JSON_RESPONSE");
		});

		it("passes multi-turn conversation history to the LLM messages payload", async () => {
			let capturedBody = null;
			const mockFetch = async (url, options) => {
				capturedBody = JSON.parse(options.body);
				return new Response(
					JSON.stringify({
						choices: [
							{
								message: {
									content: JSON.stringify({
										intent: "add",
										task: {
											title: "ورزش کردن",
											due_date: "2026-11-03T12:00:00+03:30",
										},
										reply: "تسک ورزش هم برای ساعت ۱۲ فردا ثبت شد.",
									}),
								},
							},
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } }
				);
			};

			const config = {
				llmApiKey: "test-key",
				llmApiBase: "https://mock.llm.api/v1",
				llmModel: "test-model",
			};

			const history = [
				{ role: "user", content: "فردا ساعت ۱۰ درس بخونم" },
				{ role: "assistant", content: "تسک درس خواندن ثبت شد." },
			];

			const result = await parsePersianWithLLM("دو ساعت بعدش هم ورزش کنم", config, history, mockFetch);
			expect(result.intent).toBe("add");
			expect(result.task.title).toBe("ورزش کردن");
			expect(capturedBody).not.toBeNull();
			// system (1) + history (2) + current user message (1) = 4
			expect(capturedBody.messages.length).toBe(4);
			expect(capturedBody.messages[1].content).toBe("فردا ساعت ۱۰ درس بخونم");
			expect(capturedBody.messages[2].content).toBe("تسک درس خواندن ثبت شد.");
			expect(capturedBody.messages[3].content).toBe("دو ساعت بعدش هم ورزش کنم");
		});

		it("model chain: succeeds on model 1 without invoking fallbacks", async () => {
			const calledModels = [];
			const mockFetch = async (url, options) => {
				const body = JSON.parse(options.body);
				calledModels.push(body.model);
				return new Response(
					JSON.stringify({
						choices: [{ message: { content: JSON.stringify({ intent: "chat", reply: "سلام از مدل اول" }) } }],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } }
				);
			};

			const config = {
				llmApiKey: "secret-key-12345",
				llmApiBase: "https://mock.llm/v1",
				llmModel: "model-1",
				llmModelFallbacks: ["model-2", "model-3"],
			};

			const result = await parsePersianWithLLM("سلام", config, [], {
				fetch: mockFetch,
				sleepFn: async () => {},
			});

			expect(result.ok).toBe(true);
			expect(result.reply).toBe("سلام از مدل اول");
			expect(calledModels).toEqual(["model-1"]); // Only model 1 was invoked
		});

		it("model chain: switches to model 2 on 503 error from model 1", async () => {
			const calledModels = [];
			const mockFetch = async (url, options) => {
				const body = JSON.parse(options.body);
				calledModels.push(body.model);
				if (body.model === "model-1") {
					return new Response(
						JSON.stringify({ error: { code: 503, message: "Overloaded" } }),
						{ status: 503, headers: { "Content-Type": "application/json" } }
					);
				}
				return new Response(
					JSON.stringify({
						choices: [{ message: { content: JSON.stringify({ intent: "chat", reply: "سلام از مدل دوم" }) } }],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } }
				);
			};

			const config = {
				llmApiKey: "secret-key-12345",
				llmApiBase: "https://mock.llm/v1",
				llmModel: "model-1",
				llmModelFallbacks: ["model-2", "model-3"],
			};

			const result = await parsePersianWithLLM("سلام", config, [], {
				fetch: mockFetch,
				sleepFn: async () => {},
			});

			expect(result.ok).toBe(true);
			expect(result.reply).toBe("سلام از مدل دوم");
			expect(calledModels).toEqual(["model-1", "model-2"]); // model 1 failed, model 2 succeeded
		});

		it("model chain: switches to model 3 when both model 1 and model 2 fail with 503", async () => {
			const calledModels = [];
			const mockFetch = async (url, options) => {
				const body = JSON.parse(options.body);
				calledModels.push(body.model);
				if (body.model === "model-1" || body.model === "model-2") {
					return new Response(
						JSON.stringify({ error: { code: 503, message: "Service Unavailable" } }),
						{ status: 503, headers: { "Content-Type": "application/json" } }
					);
				}
				return new Response(
					JSON.stringify({
						choices: [{ message: { content: JSON.stringify({ intent: "chat", reply: "سلام از مدل سوم" }) } }],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } }
				);
			};

			const config = {
				llmApiKey: "secret-key-12345",
				llmApiBase: "https://mock.llm/v1",
				llmModel: "model-1",
				llmModelFallbacks: ["model-2", "model-3"],
			};

			const result = await parsePersianWithLLM("سلام", config, [], {
				fetch: mockFetch,
				sleepFn: async () => {},
			});

			expect(result.ok).toBe(true);
			expect(result.reply).toBe("سلام از مدل سوم");
			expect(calledModels).toEqual(["model-1", "model-2", "model-3"]);
		});

		it("model chain: does NOT call model 2 on 401 error from model 1", async () => {
			const calledModels = [];
			const mockFetch = async (url, options) => {
				const body = JSON.parse(options.body);
				calledModels.push(body.model);
				return new Response(
					JSON.stringify({ error: { code: 401, message: "Unauthorized" } }),
					{ status: 401, headers: { "Content-Type": "application/json" } }
				);
			};

			const config = {
				llmApiKey: "invalid-key",
				llmApiBase: "https://mock.llm/v1",
				llmModel: "model-1",
				llmModelFallbacks: ["model-2", "model-3"],
			};

			const result = await parsePersianWithLLM("سلام", config, [], {
				fetch: mockFetch,
				sleepFn: async () => {},
			});

			expect(result.ok).toBe(false);
			expect(result.status).toBe(401);
			expect(calledModels).toEqual(["model-1"]); // model-2 was NOT called
		});

		it("model chain: does not start new attempt when 18s deadline expires", async () => {
			let callCount = 0;
			const mockFetch = async () => {
				callCount++;
				return new Response(
					JSON.stringify({ error: { code: 503, message: "Overloaded" } }),
					{ status: 503, headers: { "Content-Type": "application/json" } }
				);
			};

			const config = {
				llmApiKey: "key",
				llmApiBase: "https://mock.llm/v1",
				llmModel: "model-1",
				llmModelFallbacks: ["model-2", "model-3"],
			};

			// Deadline already expired / 0ms remaining
			const result = await parsePersianWithLLM("سلام", config, [], {
				deadline: Date.now() + 500, // < 1000ms
				fetch: mockFetch,
			});

			expect(result.ok).toBe(false);
			expect(result.error).toBe("OVERALL_DEADLINE_EXCEEDED");
			expect(callCount).toBe(0);
		});

		it("model chain: preserves current 2-attempt behavior when no fallbacks configured", async () => {
			let callCount = 0;
			const mockFetch = async () => {
				callCount++;
				return new Response(
					JSON.stringify({ error: { code: 503, message: "Overloaded" } }),
					{ status: 503, headers: { "Content-Type": "application/json" } }
				);
			};

			const config = {
				llmApiKey: "key",
				llmApiBase: "https://mock.llm/v1",
				llmModel: "only-model",
				llmModelFallbacks: [],
			};

			const result = await parsePersianWithLLM("سلام", config, [], {
				fetch: mockFetch,
				sleepFn: async () => {},
			});

			expect(callCount).toBe(2); // 1 initial + 1 retry
			expect(result.ok).toBe(false);
			expect(result.status).toBe(503);
		});

		it("model chain: switches to model 3 when model 1 fails with 503 and model 2 returns 404", async () => {
			const calledModels = [];
			const mockFetch = async (url, options) => {
				const body = JSON.parse(options.body);
				calledModels.push(body.model);
				if (body.model === "model-1") {
					return new Response(
						JSON.stringify({ error: { code: 503, message: "Overloaded" } }),
						{ status: 503, headers: { "Content-Type": "application/json" } }
					);
				}
				if (body.model === "model-2") {
					return new Response(
						JSON.stringify({ error: { code: 404, message: "Model not found on endpoint" } }),
						{ status: 404, headers: { "Content-Type": "application/json" } }
					);
				}
				return new Response(
					JSON.stringify({
						choices: [{ message: { content: JSON.stringify({ intent: "chat", reply: "پاسخ از مدل سوم" }) } }],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } }
				);
			};

			const config = {
				llmApiKey: "valid-key",
				llmApiBase: "https://mock.llm/v1",
				llmModel: "model-1",
				llmModelFallbacks: ["model-2", "model-3"],
			};

			const result = await parsePersianWithLLM("سلام", config, [], {
				fetch: mockFetch,
				sleepFn: async () => {},
			});

			expect(result.ok).toBe(true);
			expect(result.reply).toBe("پاسخ از مدل سوم");
			expect(calledModels).toEqual(["model-1", "model-2", "model-3"]);
		});

		it("model chain: does NOT call model 2 on 403 Forbidden error from model 1", async () => {
			const calledModels = [];
			const mockFetch = async (url, options) => {
				const body = JSON.parse(options.body);
				calledModels.push(body.model);
				return new Response(
					JSON.stringify({ error: { code: 403, message: "Forbidden" } }),
					{ status: 403, headers: { "Content-Type": "application/json" } }
				);
			};

			const config = {
				llmApiKey: "restricted-key",
				llmApiBase: "https://mock.llm/v1",
				llmModel: "model-1",
				llmModelFallbacks: ["model-2", "model-3"],
			};

			const result = await parsePersianWithLLM("سلام", config, [], {
				fetch: mockFetch,
				sleepFn: async () => {},
			});

			expect(result.ok).toBe(false);
			expect(result.status).toBe(403);
			expect(calledModels).toEqual(["model-1"]); // model-2 was NOT called
		});

		it("model chain: cleans up messy, duplicated, and spaced fallback configuration", async () => {
			const calledModels = [];
			const mockFetch = async (url, options) => {
				const body = JSON.parse(options.body);
				calledModels.push(body.model);
				return new Response(
					JSON.stringify({ error: { code: 503, message: "Fail" } }),
					{ status: 503, headers: { "Content-Type": "application/json" } }
				);
			};

			const config = {
				llmApiKey: "key",
				llmApiBase: "https://mock.llm/v1",
				llmModel: "model-1",
				// Messy fallback string with duplicates, spaces, empty values, and repetition of primary model
				llmModelFallbacks: "  model-2  , , model-1 , model-2 , model-3 , model-4 ",
			};

			await parsePersianWithLLM("سلام", config, [], {
				fetch: mockFetch,
				sleepFn: async () => {},
			});

			// Should be capped at 3 unique models: ["model-1", "model-2", "model-3"]
			expect(calledModels).toEqual(["model-1", "model-2", "model-3"]);
		});

		it("model chain: switches to model 2 when model 1 request times out", async () => {
			const calledModels = [];
			const mockFetch = async (url, options) => {
				const body = JSON.parse(options.body);
				calledModels.push(body.model);
				if (body.model === "model-1") {
					const err = new Error("Network timeout");
					err.name = "AbortError";
					throw err;
				}
				return new Response(
					JSON.stringify({
						choices: [{ message: { content: JSON.stringify({ intent: "chat", reply: "پاسخ مدل دوم بعد از تایم اوت" }) } }],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } }
				);
			};

			const config = {
				llmApiKey: "valid-key",
				llmApiBase: "https://mock.llm/v1",
				llmModel: "model-1",
				llmModelFallbacks: ["model-2"],
			};

			const result = await parsePersianWithLLM("سلام", config, [], {
				fetch: mockFetch,
				sleepFn: async () => {},
			});

			expect(result.ok).toBe(true);
			expect(result.reply).toBe("پاسخ مدل دوم بعد از تایم اوت");
			expect(calledModels).toEqual(["model-1", "model-2"]);
		});

		it("model chain: logs never leak secrets or API keys", async () => {
			const originalWarn = console.warn;
			const originalError = console.error;
			const logLines = [];

			console.warn = (...args) => logLines.push(args.join(" "));
			console.error = (...args) => logLines.push(args.join(" "));

			const secretKey = "super-secret-api-key-xyz-987";
			const mockFetch = async () => {
				return new Response(
					JSON.stringify({ error: { code: 503, message: "Overloaded" } }),
					{ status: 503, headers: { "Content-Type": "application/json" } }
				);
			};

			try {
				const config = {
					llmApiKey: secretKey,
					llmApiBase: "https://mock.llm/v1",
					llmModel: "model-1",
					llmModelFallbacks: ["model-2"],
				};

				await parsePersianWithLLM("سلام", config, [], {
					fetch: mockFetch,
					sleepFn: async () => {},
				});

				// Verify secret was NEVER logged
				for (const line of logLines) {
					expect(line).not.toContain(secretKey);
					expect(line).not.toContain("super-secret");
				}
			} finally {
				console.warn = originalWarn;
				console.error = originalError;
			}
		});
	});
});
