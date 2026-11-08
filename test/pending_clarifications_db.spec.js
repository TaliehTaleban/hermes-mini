import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import {
	ensurePendingClarificationsTable,
	validateClarificationPayload,
	setPendingClarification,
	getPendingClarification,
	claimPendingClarification,
	isClaimOwner,
	releasePendingClarification,
	consumePendingClarification,
	clearPendingClarification,
	clearExpiredClarifications,
	generateSecureToken,
	isValidCalendarDate,
} from "../src/db.js";

describe("Hermes Mini - Step 2: Pending Clarifications DB & Concurrency Suite", () => {
	beforeEach(async () => {
		await ensurePendingClarificationsTable(env.DB);
		await env.DB.prepare("DELETE FROM pending_clarifications").run();
	});

	const sampleAddPayload = {
		title: "ورزش عصرگاهی",
		targetDateStr: "2026-11-07",
		targetYear: 2026,
		targetMonth: 11,
		targetDay: 7,
		ambiguousHour: 5,
		rawHourStr: "۵",
		originalUserText: "فردا ساعت ۵ ورزش عصرگاهی",
	};

	const sampleEditPayload = {
		targetTaskId: 42,
		targetTaskTitle: "کلاس زبان",
		targetTaskDueDate: "2026-11-06T10:00:00+03:30",
		targetTaskIsCompleted: false,
		newTitle: "کلاس زبان پیشرفته",
		targetDateStr: "2026-11-08",
		ambiguousHour: 6,
		originalUserText: "کلاس زبان رو تغییر بده به پس‌فردا ساعت ۶",
	};

	it("1. ایجاد وضعیت Add - creates valid Add clarification in D1", async () => {
		const res = await setPendingClarification(env.DB, "user_add_1", "add", sampleAddPayload, 300);

		expect(res.clarificationId).toBeDefined();
		expect(typeof res.clarificationId).toBe("string");
		expect(res.userId).toBe("user_add_1");
		expect(res.actionType).toBe("add");
		expect(res.payload.title).toBe("ورزش عصرگاهی");
		expect(res.expiresAt).toBeGreaterThan(Date.now());

		const row = await env.DB.prepare(
			"SELECT * FROM pending_clarifications WHERE telegram_user_id = ?"
		).bind("user_add_1").first();

		expect(row).not.toBeNull();
		expect(row.action_type).toBe("add");
		expect(row.claim_token).toBeNull();
		expect(row.claimed_at).toBeNull();
		expect(JSON.parse(row.payload).title).toBe("ورزش عصرگاهی");
	});

	it("2. ایجاد وضعیت Edit - creates valid Edit clarification in D1", async () => {
		const res = await setPendingClarification(env.DB, "user_edit_1", "edit", sampleEditPayload, 300);

		expect(res.clarificationId).toBeDefined();
		expect(res.userId).toBe("user_edit_1");
		expect(res.actionType).toBe("edit");
		expect(res.payload.targetTaskId).toBe(42);
		expect(res.payload.targetTaskTitle).toBe("کلاس زبان");
		expect(res.payload.targetTaskIsCompleted).toBe(false);

		const row = await env.DB.prepare(
			"SELECT * FROM pending_clarifications WHERE telegram_user_id = ?"
		).bind("user_edit_1").first();

		expect(row).not.toBeNull();
		expect(row.action_type).toBe("edit");
		expect(JSON.parse(row.payload).targetTaskId).toBe(42);
	});

	it("3. جایگزینی وضعیت قبلی همان کاربر - upsert preserves single row per user", async () => {
		const first = await setPendingClarification(env.DB, "user_replace", "add", sampleAddPayload, 300);
		const second = await setPendingClarification(env.DB, "user_replace", "edit", sampleEditPayload, 300);

		expect(first.clarificationId).not.toBe(second.clarificationId);

		const { results } = await env.DB.prepare(
			"SELECT * FROM pending_clarifications WHERE telegram_user_id = ?"
		).bind("user_replace").all();

		expect(results.length).toBe(1);
		expect(results[0].clarification_id).toBe(second.clarificationId);
		expect(results[0].action_type).toBe("edit");
		expect(JSON.parse(results[0].payload).targetTaskId).toBe(42);
	});

	it("4. عدم تداخل وضعیت دو کاربر - isolates data strictly by telegram_user_id", async () => {
		await setPendingClarification(env.DB, "user_A", "add", sampleAddPayload, 300);
		await setPendingClarification(env.DB, "user_B", "edit", sampleEditPayload, 300);

		const clarA = await getPendingClarification(env.DB, "user_A");
		const clarB = await getPendingClarification(env.DB, "user_B");

		expect(clarA.userId).toBe("user_A");
		expect(clarA.actionType).toBe("add");
		expect(clarB.userId).toBe("user_B");
		expect(clarB.actionType).toBe("edit");

		// Clearing A does not affect B
		await clearPendingClarification(env.DB, "user_A");
		expect(await getPendingClarification(env.DB, "user_A")).toBeNull();
		expect(await getPendingClarification(env.DB, "user_B")).not.toBeNull();
	});

	it("5. دریافت وضعیت معتبر - retrieves and parses active pending clarification", async () => {
		await setPendingClarification(env.DB, "user_valid", "add", sampleAddPayload, 300);

		const item = await getPendingClarification(env.DB, "user_valid");
		expect(item).not.toBeNull();
		expect(item.userId).toBe("user_valid");
		expect(item.actionType).toBe("add");
		expect(item.payload.ambiguousHour).toBe(5);
		expect(item.claimToken).toBeNull();
		expect(item.claimedAt).toBeNull();
		expect(item.createdAt).toBeLessThanOrEqual(Date.now());
		expect(item.expiresAt).toBeGreaterThan(Date.now());
	});

	it("6. عدم دریافت وضعیت منقضیشده - returns null and removes expired record", async () => {
		const past = Date.now() - 10000;
		await env.DB.prepare(
			`INSERT INTO pending_clarifications (
				telegram_user_id, clarification_id, action_type, payload,
				claim_token, claimed_at, created_at, expires_at
			) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)`
		).bind("user_expired", "cid-old", "add", JSON.stringify(sampleAddPayload), past - 300000, past).run();

		const retrieved = await getPendingClarification(env.DB, "user_expired");
		expect(retrieved).toBeNull();

		// Ensure it was cleaned up
		const row = await env.DB.prepare(
			"SELECT * FROM pending_clarifications WHERE telegram_user_id = ?"
		).bind("user_expired").first();
		expect(row).toBeNull();
	});

	it("7. Claim موفق - worker atomically claims clarification with active lease", async () => {
		await setPendingClarification(env.DB, "user_claim_ok", "add", sampleAddPayload, 300);

		const claimRes = await claimPendingClarification(env.DB, "user_claim_ok", 15000);
		expect(claimRes.success).toBe(true);
		expect(claimRes.claimToken).toBeDefined();
		expect(typeof claimRes.claimToken).toBe("string");
		expect(claimRes.claimedAt).toBeGreaterThan(0);

		const isOwner = await isClaimOwner(env.DB, "user_claim_ok", claimRes.claimToken, 15000);
		expect(isOwner).toBe(true);
	});

	it("8. جلوگیری از Claim همزمان توسط Worker دوم - rejects conflicting concurrent claim", async () => {
		await setPendingClarification(env.DB, "user_conflict", "add", sampleAddPayload, 300);

		const worker1 = await claimPendingClarification(env.DB, "user_conflict", 15000);
		expect(worker1.success).toBe(true);

		const worker2 = await claimPendingClarification(env.DB, "user_conflict", 15000);
		expect(worker2.success).toBe(false);
		expect(worker2.claimToken).toBeNull();
		expect(worker2.reason).toBe("NOT_FOUND_OR_ALREADY_CLAIMED_OR_EXPIRED");

		// Worker 1 remains the exclusive owner
		const isW1Owner = await isClaimOwner(env.DB, "user_conflict", worker1.claimToken, 15000);
		expect(isW1Owner).toBe(true);
	});

	it("9. جلوگیری از مصرف توسط Worker فاقد Claim - unauthorized consume fails and preserves row", async () => {
		await setPendingClarification(env.DB, "user_fake_consume", "add", sampleAddPayload, 300);
		const claim = await claimPendingClarification(env.DB, "user_fake_consume", 15000);
		expect(claim.success).toBe(true);

		// Worker with invalid token tries to consume
		const consumedFake = await consumePendingClarification(env.DB, "user_fake_consume", "unauthorized-token-123", 15000);
		expect(consumedFake).toBe(false);

		// Row must still exist in DB intact
		const row = await env.DB.prepare(
			"SELECT claim_token FROM pending_clarifications WHERE telegram_user_id = ?"
		).bind("user_fake_consume").first();
		expect(row).not.toBeNull();
		expect(row.claim_token).toBe(claim.claimToken);
	});

	it("10. جلوگیری از آزادسازی توسط Worker فاقد Claim - unauthorized release fails", async () => {
		await setPendingClarification(env.DB, "user_fake_release", "add", sampleAddPayload, 300);
		const claim = await claimPendingClarification(env.DB, "user_fake_release", 15000);
		expect(claim.success).toBe(true);

		const releasedFake = await releasePendingClarification(env.DB, "user_fake_release", "unauthorized-token-123");
		expect(releasedFake).toBe(false);

		// Worker 1 still holds claim
		const isW1Owner = await isClaimOwner(env.DB, "user_fake_release", claim.claimToken, 15000);
		expect(isW1Owner).toBe(true);
	});

	it("11. مصرف موفق توسط مالک - authorized owner consumes and deletes record", async () => {
		await setPendingClarification(env.DB, "user_consume_ok", "add", sampleAddPayload, 300);
		const claim = await claimPendingClarification(env.DB, "user_consume_ok", 15000);
		expect(claim.success).toBe(true);

		const consumed = await consumePendingClarification(env.DB, "user_consume_ok", claim.claimToken, 15000);
		expect(consumed).toBe(true);

		const check = await getPendingClarification(env.DB, "user_consume_ok");
		expect(check).toBeNull();
	});

	it("12. آزادسازی موفق توسط مالک - releases claim allowing another worker to claim immediately", async () => {
		await setPendingClarification(env.DB, "user_release_ok", "add", sampleAddPayload, 300);
		const worker1 = await claimPendingClarification(env.DB, "user_release_ok", 15000);
		expect(worker1.success).toBe(true);

		const released = await releasePendingClarification(env.DB, "user_release_ok", worker1.claimToken, 15000);
		expect(released).toBe(true);

		// Claim token and claimed_at reset to null
		const row = await env.DB.prepare(
			"SELECT claim_token, claimed_at FROM pending_clarifications WHERE telegram_user_id = ?"
		).bind("user_release_ok").first();
		expect(row.claim_token).toBeNull();
		expect(row.claimed_at).toBeNull();

		// Worker 2 can claim immediately
		const worker2 = await claimPendingClarification(env.DB, "user_release_ok", 15000);
		expect(worker2.success).toBe(true);
		expect(worker2.claimToken).not.toBe(worker1.claimToken);
	});

	it("13. عدم مصرف پس از انقضای Lease - stale worker cannot consume after 15s lease", async () => {
		await setPendingClarification(env.DB, "user_lease_timeout", "add", sampleAddPayload, 300);
		const worker1 = await claimPendingClarification(env.DB, "user_lease_timeout", 15000);
		expect(worker1.success).toBe(true);

		// Simulate lease expiry (e.g. 20s in the past)
		const expiredClaimTime = Date.now() - 20000;
		await env.DB.prepare(
			"UPDATE pending_clarifications SET claimed_at = ? WHERE telegram_user_id = ?"
		).bind(expiredClaimTime, "user_lease_timeout").run();

		// Worker 1 tries to consume after lease expiry -> must be rejected
		const consumedAfterExpiry = await consumePendingClarification(env.DB, "user_lease_timeout", worker1.claimToken, 15000);
		expect(consumedAfterExpiry).toBe(false);

		// Row must NOT be deleted
		const row = await env.DB.prepare(
			"SELECT * FROM pending_clarifications WHERE telegram_user_id = ?"
		).bind("user_lease_timeout").first();
		expect(row).not.toBeNull();

		// Worker 2 can now claim the clarification because worker 1's lease expired
		const worker2 = await claimPendingClarification(env.DB, "user_lease_timeout", 15000);
		expect(worker2.success).toBe(true);
	});

	it("14. عدم Claim پس از انقضای TTL - expired clarification cannot be claimed", async () => {
		const past = Date.now() - 5000;
		await env.DB.prepare(
			`INSERT INTO pending_clarifications (
				telegram_user_id, clarification_id, action_type, payload,
				claim_token, claimed_at, created_at, expires_at
			) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)`
		).bind("user_ttl_expired", "cid-ttl", "add", JSON.stringify(sampleAddPayload), past - 300000, past).run();

		const claimRes = await claimPendingClarification(env.DB, "user_ttl_expired", 15000);
		expect(claimRes.success).toBe(false);
		expect(claimRes.claimToken).toBeNull();
	});

	it("15. برخورد با JSON خراب - corrupted payload returns null safely without throwing", async () => {
		const future = Date.now() + 300000;
		await env.DB.prepare(
			`INSERT INTO pending_clarifications (
				telegram_user_id, clarification_id, action_type, payload,
				claim_token, claimed_at, created_at, expires_at
			) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)`
		).bind("user_bad_json", "cid-bad", "add", "{ this is NOT valid JSON :--", Date.now(), future).run();

		const res = await getPendingClarification(env.DB, "user_bad_json");
		expect(res).toBeNull();
	});

	it("16. برخورد با Payload نامعتبر - rejects incomplete or malformed payloads", async () => {
		// Missing fields for add
		await expect(
			setPendingClarification(env.DB, "user_invalid_1", "add", { title: "تسک ناقص" })
		).rejects.toThrow("INVALID_CLARIFICATION_PAYLOAD");

		// Missing ambiguousHour
		await expect(
			setPendingClarification(env.DB, "user_invalid_2", "add", {
				...sampleAddPayload,
				ambiguousHour: undefined,
			})
		).rejects.toThrow("INVALID_CLARIFICATION_PAYLOAD");

		// Missing targetTaskId for edit
		await expect(
			setPendingClarification(env.DB, "user_invalid_3", "edit", {
				...sampleEditPayload,
				targetTaskId: undefined,
			})
		).rejects.toThrow("INVALID_CLARIFICATION_PAYLOAD");

		// Invalid action type
		await expect(
			setPendingClarification(env.DB, "user_invalid_4", "delete", sampleAddPayload)
		).rejects.toThrow("INVALID_ACTION_TYPE");

		// Non-object payload
		expect(() => validateClarificationPayload("add", "string-payload")).toThrow("INVALID_CLARIFICATION_PAYLOAD");
		expect(() => validateClarificationPayload("add", null)).toThrow("INVALID_CLARIFICATION_PAYLOAD");
	});

	it("17. خطای Self-Healing و عدم پنهانکردن آن - throws and propagates schema errors", async () => {
		const brokenDb = {
			prepare: () => {
				throw new Error("D1_MOCK_FAILURE: Disk I/O error");
			},
		};

		await expect(ensurePendingClarificationsTable(brokenDb)).rejects.toThrow(
			"FAILED_TO_ENSURE_PENDING_CLARIFICATIONS_TABLE: D1_MOCK_FAILURE: Disk I/O error"
		);
	});

	it("18. پاککردن رکوردهای منقضیشده عمومی - clearExpiredClarifications removes only expired rows", async () => {
		const now = Date.now();
		// Expired row
		await env.DB.prepare(
			`INSERT INTO pending_clarifications (
				telegram_user_id, clarification_id, action_type, payload,
				claim_token, claimed_at, created_at, expires_at
			) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)`
		).bind("user_cleanup_exp", "cid-exp", "add", JSON.stringify(sampleAddPayload), now - 400000, now - 1000).run();

		// Active row
		await setPendingClarification(env.DB, "user_cleanup_act", "add", sampleAddPayload, 300);

		const deletedCount = await clearExpiredClarifications(env.DB);
		expect(deletedCount).toBe(1);

		expect(await getPendingClarification(env.DB, "user_cleanup_exp")).toBeNull();
		expect(await getPendingClarification(env.DB, "user_cleanup_act")).not.toBeNull();
	});

	/* =========================================================================
	 * NEW AUDIT TESTS: Concurrency, Fencing, Calendrical Validation, Race-Guards
	 * ========================================================================= */

	it("19. Claim با claimed_at در آینده نباید توسط Worker دوم تصاحب شود (Fail-Closed)", async () => {
		await setPendingClarification(env.DB, "user_future_claim", "add", sampleAddPayload, 300);

		// Worker 1 holds a claim whose claimed_at is in the future due to clock jitter
		const futureTime = Date.now() + 60000;
		await env.DB.prepare(
			`UPDATE pending_clarifications
			 SET claim_token = 'token_worker_1', claimed_at = ?
			 WHERE telegram_user_id = 'user_future_claim'`
		).bind(futureTime).run();

		// Worker 2 attempts to claim: must fail closed, NOT steal the claim
		const claimRes = await claimPendingClarification(env.DB, "user_future_claim", 15000);
		expect(claimRes.success).toBe(false);
		expect(claimRes.claimToken).toBeNull();

		// Worker 1's token is still intact in DB
		const row = await env.DB.prepare(
			"SELECT claim_token, claimed_at FROM pending_clarifications WHERE telegram_user_id = 'user_future_claim'"
		).first();
		expect(row.claim_token).toBe("token_worker_1");
		expect(Number(row.claimed_at)).toBe(futureTime);
	});

	it("20. پاکسازی وضعیت منقضی نباید وضعیت جدید جایگزینشده را حذف کند (Race Condition Guard)", async () => {
		const past = Date.now() - 5000;
		const oldCid = "cid-old-race";
		await env.DB.prepare(
			`INSERT INTO pending_clarifications (
				telegram_user_id, clarification_id, action_type, payload,
				claim_token, claimed_at, created_at, expires_at
			) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)`
		).bind("user_race_cleanup", oldCid, "add", JSON.stringify(sampleAddPayload), past - 300000, past).run();

		// Simulate race: Worker A read the expired row (oldCid, past),
		// but before cleanup executes, User B upserts a fresh new clarification:
		const fresh = await setPendingClarification(env.DB, "user_race_cleanup", "edit", sampleEditPayload, 300);

		// Now Worker A attempts conditional cleanup using the read oldCid and past expiration:
		const now = Date.now();
		const info = await env.DB.prepare(
			`DELETE FROM pending_clarifications
			 WHERE telegram_user_id = ?
			   AND clarification_id = ?
			   AND expires_at = ?
			   AND expires_at < ?`
		).bind("user_race_cleanup", oldCid, past, now).run();

		expect(info.meta?.changes ?? 0).toBe(0);

		// The fresh clarification must NOT have been deleted!
		const current = await getPendingClarification(env.DB, "user_race_cleanup");
		expect(current).not.toBeNull();
		expect(current.clarificationId).toBe(fresh.clarificationId);
		expect(current.actionType).toBe("edit");
	});

	it("21. Claim نباید اطلاعات متعلق به clarification دیگری برگرداند", async () => {
		await setPendingClarification(env.DB, "user_superseded", "add", sampleAddPayload, 300);

		// Worker 1 claims
		const worker1 = await claimPendingClarification(env.DB, "user_superseded", 15000);
		expect(worker1.success).toBe(true);
		expect(worker1.clarification.actionType).toBe("add");
		expect(worker1.clarification.payload.title).toBe("ورزش عصرگاهی");

		// User updates/replaces their clarification with an Edit clarification
		await setPendingClarification(env.DB, "user_superseded", "edit", sampleEditPayload, 300);

		// When querying with worker1's token, isClaimOwner returns false
		const isOwner = await isClaimOwner(env.DB, "user_superseded", worker1.claimToken, 15000);
		expect(isOwner).toBe(false);

		// Worker 1 cannot consume the new clarification
		const consumed = await consumePendingClarification(env.DB, "user_superseded", worker1.claimToken, 15000);
		expect(consumed).toBe(false);

		// Newly replaced clarification is intact
		const current = await getPendingClarification(env.DB, "user_superseded");
		expect(current).not.toBeNull();
		expect(current.actionType).toBe("edit");
		expect(current.payload.targetTaskId).toBe(42);
	});

	it("22. تاریخ نامعتبر و Payload ناسازگار رد شود (Calendrical & Component Validation)", async () => {
		// Calendrically invalid dates:
		// Non-leap February 29
		expect(isValidCalendarDate("2026-02-29")).toBe(false);
		await expect(
			setPendingClarification(env.DB, "user_cal_1", "add", {
				...sampleAddPayload,
				targetDateStr: "2026-02-29",
				targetYear: 2026,
				targetMonth: 2,
				targetDay: 29,
			})
		).rejects.toThrow("INVALID_CLARIFICATION_PAYLOAD: 'targetDateStr' must be a valid calendar date");

		// April 31 (April only has 30 days)
		expect(isValidCalendarDate("2026-04-31")).toBe(false);
		await expect(
			setPendingClarification(env.DB, "user_cal_2", "add", {
				...sampleAddPayload,
				targetDateStr: "2026-04-31",
				targetYear: 2026,
				targetMonth: 4,
				targetDay: 31,
			})
		).rejects.toThrow("INVALID_CLARIFICATION_PAYLOAD: 'targetDateStr' must be a valid calendar date");

		// Month 13
		expect(isValidCalendarDate("2026-13-01")).toBe(false);

		// Leap year 2024-02-29 is valid
		expect(isValidCalendarDate("2024-02-29")).toBe(true);

		// Component mismatch: targetDateStr does not match targetYear, targetMonth, targetDay
		await expect(
			setPendingClarification(env.DB, "user_mismatch_1", "add", {
				...sampleAddPayload,
				targetDateStr: "2026-11-07",
				targetYear: 2026,
				targetMonth: 11,
				targetDay: 8, // Mismatched day
			})
		).rejects.toThrow("does not match components");

		await expect(
			setPendingClarification(env.DB, "user_mismatch_2", "add", {
				...sampleAddPayload,
				targetDateStr: "2026-11-07",
				targetYear: 2025, // Mismatched year
				targetMonth: 11,
				targetDay: 7,
			})
		).rejects.toThrow("does not match components");

		// Non-integer year, month, or day
		await expect(
			setPendingClarification(env.DB, "user_mismatch_3", "add", {
				...sampleAddPayload,
				targetYear: 2026.5,
			})
		).rejects.toThrow("valid integer");

		// Edit with invalid targetDateStr
		await expect(
			setPendingClarification(env.DB, "user_edit_invalid_date", "edit", {
				...sampleEditPayload,
				targetDateStr: "2026-02-29",
			})
		).rejects.toThrow("valid calendar date string");
	});

	it("23. مقادیر غیرصحیح ambiguousHour و مقادیر غیر Boolean برای وضعیت انجامشدن رد شوند", async () => {
		// Float ambiguousHour
		await expect(
			setPendingClarification(env.DB, "user_hour_float", "add", {
				...sampleAddPayload,
				ambiguousHour: 5.5,
			})
		).rejects.toThrow("must be an integer between 0 and 23");

		// Negative or > 23 ambiguousHour
		await expect(
			setPendingClarification(env.DB, "user_hour_neg", "add", {
				...sampleAddPayload,
				ambiguousHour: -1,
			})
		).rejects.toThrow("must be an integer between 0 and 23");

		await expect(
			setPendingClarification(env.DB, "user_hour_24", "add", {
				...sampleAddPayload,
				ambiguousHour: 24,
			})
		).rejects.toThrow("must be an integer between 0 and 23");

		// String ambiguousHour
		await expect(
			setPendingClarification(env.DB, "user_hour_str", "add", {
				...sampleAddPayload,
				ambiguousHour: "5",
			})
		).rejects.toThrow("must be an integer between 0 and 23");

		// Edit with non-boolean targetTaskIsCompleted: number 0, 1, or string "false"
		await expect(
			setPendingClarification(env.DB, "user_comp_num0", "edit", {
				...sampleEditPayload,
				targetTaskIsCompleted: 0,
			})
		).rejects.toThrow("must be a boolean (true or false)");

		await expect(
			setPendingClarification(env.DB, "user_comp_num1", "edit", {
				...sampleEditPayload,
				targetTaskIsCompleted: 1,
			})
		).rejects.toThrow("must be a boolean (true or false)");

		await expect(
			setPendingClarification(env.DB, "user_comp_str", "edit", {
				...sampleEditPayload,
				targetTaskIsCompleted: "false",
			})
		).rejects.toThrow("must be a boolean (true or false)");

		await expect(
			setPendingClarification(env.DB, "user_comp_null", "edit", {
				...sampleEditPayload,
				targetTaskIsCompleted: null,
			})
		).rejects.toThrow("must be a boolean (true or false)");
	});

	it("24. Worker قدیمی پس از جایگزینی وضعیت نتواند وضعیت جدید را مصرف یا آزاد کند", async () => {
		await setPendingClarification(env.DB, "user_supersede_fence", "add", sampleAddPayload, 300);

		// Worker 1 claims old clarification
		const worker1 = await claimPendingClarification(env.DB, "user_supersede_fence", 15000);
		expect(worker1.success).toBe(true);

		// User sends new request, replacing the pending clarification
		await setPendingClarification(env.DB, "user_supersede_fence", "edit", sampleEditPayload, 300);

		// Worker 1 attempts to release with old claimToken: must be rejected
		const releaseOld = await releasePendingClarification(env.DB, "user_supersede_fence", worker1.claimToken, 15000);
		expect(releaseOld).toBe(false);

		// Worker 1 attempts to consume with old claimToken: must be rejected
		const consumeOld = await consumePendingClarification(env.DB, "user_supersede_fence", worker1.claimToken, 15000);
		expect(consumeOld).toBe(false);

		// New clarification remains in DB intact
		const current = await getPendingClarification(env.DB, "user_supersede_fence");
		expect(current).not.toBeNull();
		expect(current.actionType).toBe("edit");

		// Worker 2 can claim the new clarification
		const worker2 = await claimPendingClarification(env.DB, "user_supersede_fence", 15000);
		expect(worker2.success).toBe(true);
		expect(worker2.claimToken).not.toBe(worker1.claimToken);

		// Worker 1 still cannot consume or release with old token
		expect(await consumePendingClarification(env.DB, "user_supersede_fence", worker1.claimToken, 15000)).toBe(false);
		expect(await releasePendingClarification(env.DB, "user_supersede_fence", worker1.claimToken, 15000)).toBe(false);

		// Worker 2 successfully consumes the new clarification
		const consumeNew = await consumePendingClarification(env.DB, "user_supersede_fence", worker2.claimToken, 15000);
		expect(consumeNew).toBe(true);

		expect(await getPendingClarification(env.DB, "user_supersede_fence")).toBeNull();
	});

	it("25. خطاهای SQL همچنان به فراخواننده منتقل شوند", async () => {
		const brokenDb = {
			prepare: () => {
				throw new Error("SQL_SYNTAX_ERROR: Near unexpected token");
			},
		};

		await expect(setPendingClarification(brokenDb, "user_err", "add", sampleAddPayload)).rejects.toThrow(
			"SQL_SYNTAX_ERROR"
		);
		await expect(claimPendingClarification(brokenDb, "user_err")).rejects.toThrow(
			"SQL_SYNTAX_ERROR"
		);
		await expect(consumePendingClarification(brokenDb, "user_err", "token")).rejects.toThrow(
			"SQL_SYNTAX_ERROR"
		);
		await expect(releasePendingClarification(brokenDb, "user_err", "token")).rejects.toThrow(
			"SQL_SYNTAX_ERROR"
		);
	});

	it("26. تولید Claim Token باید از منبع تصادفی رمزنگارانه استفاده کند و Math.random نباشد", () => {
		const token = generateSecureToken();
		expect(typeof token).toBe("string");
		expect(token.length).toBeGreaterThanOrEqual(32);

		// Verify that tokens generated in sequence are cryptographically unique
		const tokens = new Set();
		for (let i = 0; i < 50; i++) {
			tokens.add(generateSecureToken());
		}
		expect(tokens.size).toBe(50);
	});

	it("27. اعتبارسنجی دقیق targetTaskDueDate در Edit (تقویمی و قالب‌های ISO)", async () => {
		// Valid non-leap February 28: accepted
		const resFeb28 = await setPendingClarification(env.DB, "user_due_feb28", "edit", {
			...sampleEditPayload,
			targetTaskDueDate: "2026-02-28",
		});
		expect(resFeb28.payload.targetTaskDueDate).toBe("2026-02-28");

		// Non-leap February 29: rejected
		await expect(
			setPendingClarification(env.DB, "user_due_feb29_bad", "edit", {
				...sampleEditPayload,
				targetTaskDueDate: "2026-02-29",
			})
		).rejects.toThrow("INVALID_CLARIFICATION_PAYLOAD: 'targetTaskDueDate' must be null or a valid calendar/ISO date string");

		// Leap year February 29: accepted
		const resLeap2024 = await setPendingClarification(env.DB, "user_due_leap", "edit", {
			...sampleEditPayload,
			targetTaskDueDate: "2024-02-29",
		});
		expect(resLeap2024.payload.targetTaskDueDate).toBe("2024-02-29");

		// February 31: rejected
		await expect(
			setPendingClarification(env.DB, "user_due_feb31_bad", "edit", {
				...sampleEditPayload,
				targetTaskDueDate: "2026-02-31",
			})
		).rejects.toThrow("INVALID_CLARIFICATION_PAYLOAD: 'targetTaskDueDate' must be null or a valid calendar/ISO date string");

		// Month 13: rejected
		await expect(
			setPendingClarification(env.DB, "user_due_m13_bad", "edit", {
				...sampleEditPayload,
				targetTaskDueDate: "2026-13-01",
			})
		).rejects.toThrow("INVALID_CLARIFICATION_PAYLOAD: 'targetTaskDueDate' must be null or a valid calendar/ISO date string");

		// null targetTaskDueDate: accepted
		const resNull = await setPendingClarification(env.DB, "user_due_null", "edit", {
			...sampleEditPayload,
			targetTaskDueDate: null,
		});
		expect(resNull.payload.targetTaskDueDate).toBeNull();

		// Supported datetime formats:
		// ISO with Tehran offset (+03:30)
		const resOffset = await setPendingClarification(env.DB, "user_due_offset", "edit", {
			...sampleEditPayload,
			targetTaskDueDate: "2026-11-06T10:00:00+03:30",
		});
		expect(resOffset.payload.targetTaskDueDate).toBe("2026-11-06T10:00:00+03:30");

		// ISO with Z (UTC)
		const resZ = await setPendingClarification(env.DB, "user_due_z", "edit", {
			...sampleEditPayload,
			targetTaskDueDate: "2026-11-06T10:00:00Z",
		});
		expect(resZ.payload.targetTaskDueDate).toBe("2026-11-06T10:00:00Z");

		// ISO with hours and minutes (YYYY-MM-DDTHH:mm)
		const resHm = await setPendingClarification(env.DB, "user_due_hm", "edit", {
			...sampleEditPayload,
			targetTaskDueDate: "2026-11-06T10:00",
		});
		expect(resHm.payload.targetTaskDueDate).toBe("2026-11-06T10:00");

		// Invalid datetime: invalid calendar day in datetime
		await expect(
			setPendingClarification(env.DB, "user_due_dt_bad_day", "edit", {
				...sampleEditPayload,
				targetTaskDueDate: "2026-02-31T10:00:00+03:30",
			})
		).rejects.toThrow("INVALID_CLARIFICATION_PAYLOAD: 'targetTaskDueDate' must be null or a valid calendar/ISO date string");

		// Invalid datetime: invalid hour 25
		await expect(
			setPendingClarification(env.DB, "user_due_dt_bad_hour", "edit", {
				...sampleEditPayload,
				targetTaskDueDate: "2026-11-06T25:00:00+03:30",
			})
		).rejects.toThrow("INVALID_CLARIFICATION_PAYLOAD: 'targetTaskDueDate' must be null or a valid calendar/ISO date string");

		// Invalid datetime: invalid minute 65
		await expect(
			setPendingClarification(env.DB, "user_due_dt_bad_min", "edit", {
				...sampleEditPayload,
				targetTaskDueDate: "2026-11-06T10:65:00+03:30",
			})
		).rejects.toThrow("INVALID_CLARIFICATION_PAYLOAD: 'targetTaskDueDate' must be null or a valid calendar/ISO date string");
	});
});
