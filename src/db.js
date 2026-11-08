/**
 * Hermes Mini - Database Repository (Cloudflare D1)
 * All operations are strictly scoped to the authorized Telegram user.
 * All queries use prepared statements.
 */

import { isValidIsoDueDate } from "./dateUtils.js";

/**
 * Validates that DB binding is present
 */
export function ensureDb(db) {
	if (!db || typeof db.prepare !== "function") {
		throw new Error("D1 database binding (DB) is not configured or invalid.");
	}
}

/**
 * Checks database connection (used for health check)
 */
export async function checkDatabaseConnection(db) {
	if (!db || typeof db.prepare !== "function") {
		return { connected: false, error: "DB binding missing" };
	}
	try {
		await db.prepare("SELECT 1 AS alive").first();
		return { connected: true };
	} catch (err) {
		return { connected: false, error: err.message || "Query failed" };
	}
}

/**
 * Inserts a new task for the user
 * @param {D1Database} db
 * @param {string} userId - Telegram User ID
 * @param {{ title: string, dueDate?: string | null, updateId?: string | number | null, lockToken?: string | null }} data
 * @returns {Promise<object>} The created task
 */
export async function createTask(db, userId, { title, dueDate = null, updateId = null, lockToken = null }) {
	ensureDb(db);
	const cleanTitle = (title || "").trim();
	if (!cleanTitle) {
		throw new Error("Task title cannot be empty");
	}

	const uid = String(userId);
	const uIdStr = updateId ? String(updateId) : null;

	// Idempotency & Fencing Guard: If updateId is provided, check ownership & previous creation
	if (uIdStr) {
		try {
			if (lockToken) {
				const updateRow = await db.prepare(
					`SELECT lock_token FROM processed_updates WHERE update_id = ?`
				).bind(uIdStr).first();
				if (updateRow && updateRow.lock_token && updateRow.lock_token !== String(lockToken)) {
					throw new Error("FENCING_TOKEN_REVOKED: Worker lost ownership of update_id");
				}
			}

			const existingStmt = db.prepare(
				`SELECT id, telegram_user_id, title, is_completed, due_date, created_at, updated_at
				 FROM tasks
				 WHERE telegram_user_id = ? AND telegram_update_id = ?`
			).bind(uid, uIdStr);
			const existing = await existingStmt.first();
			if (existing) {
				return existing; // Return existing task idempotently
			}
		} catch (err) {
			if (err.message?.includes("FENCING_TOKEN_REVOKED")) {
				throw err;
			}
			// Ignore if column telegram_update_id doesn't exist yet
		}
	}

	let newId = null;
	try {
		const stmt = db.prepare(
			`INSERT INTO tasks (telegram_user_id, title, due_date, is_completed, telegram_update_id, created_at, updated_at)
			 VALUES (?, ?, ?, 0, ?, datetime('now'), datetime('now'))`
		).bind(uid, cleanTitle, dueDate, uIdStr);

		const info = await stmt.run();
		newId = info.meta?.last_row_id;
	} catch (err) {
		// Fallback if telegram_update_id column is not in schema
		if (err.message?.includes("no column named telegram_update_id")) {
			const stmt = db.prepare(
				`INSERT INTO tasks (telegram_user_id, title, due_date, is_completed, created_at, updated_at)
				 VALUES (?, ?, ?, 0, datetime('now'), datetime('now'))`
			).bind(uid, cleanTitle, dueDate);

			const info = await stmt.run();
			newId = info.meta?.last_row_id;
		} else {
			throw err;
		}
	}

	if (newId) {
		const created = await getTaskById(db, userId, newId);
		if (created) return created;
	}

	throw new Error("FAILED_TO_CREATE_TASK: Task could not be confirmed in D1");
}

/**
 * Retrieves a single task by ID scoped to user
 */
export async function getTaskById(db, userId, taskId) {
	ensureDb(db);
	const stmt = db.prepare(
		`SELECT id, telegram_user_id, title, is_completed, due_date, created_at, updated_at
		 FROM tasks
		 WHERE id = ? AND telegram_user_id = ?`
	).bind(Number(taskId), String(userId));

	return await stmt.first();
}

/**
 * Lists tasks for the user with optional filters
 * @param {D1Database} db
 * @param {string} userId
 * @param {"all"|"today"|"pending"|"completed"} [filter="all"]
 */
export async function listTasks(db, userId, filter = "all") {
	ensureDb(db);
	const uid = String(userId);

	if (filter === "pending") {
		const stmt = db.prepare(
			`SELECT id, telegram_user_id, title, is_completed, due_date, created_at, updated_at
			 FROM tasks
			 WHERE telegram_user_id = ? AND is_completed = 0
			 ORDER BY CASE WHEN due_date IS NULL THEN 1 ELSE 0 END, due_date ASC, id ASC`
		).bind(uid);
		const { results } = await stmt.all();
		return results || [];
	}

	if (filter === "completed") {
		const stmt = db.prepare(
			`SELECT id, telegram_user_id, title, is_completed, due_date, created_at, updated_at
			 FROM tasks
			 WHERE telegram_user_id = ? AND is_completed = 1
			 ORDER BY updated_at DESC, id DESC`
		).bind(uid);
		const { results } = await stmt.all();
		return results || [];
	}

	if (filter === "today") {
		// Filter tasks due today (or pending tasks without due date if needed)
		const stmt = db.prepare(
			`SELECT id, telegram_user_id, title, is_completed, due_date, created_at, updated_at
			 FROM tasks
			 WHERE telegram_user_id = ?
			 ORDER BY is_completed ASC, due_date ASC, id ASC`
		).bind(uid);
		const { results } = await stmt.all();
		return results || [];
	}

	// Default: "all"
	const stmt = db.prepare(
		`SELECT id, telegram_user_id, title, is_completed, due_date, created_at, updated_at
		 FROM tasks
		 WHERE telegram_user_id = ?
		 ORDER BY is_completed ASC, CASE WHEN due_date IS NULL THEN 1 ELSE 0 END, due_date ASC, id ASC`
	).bind(uid);
	const { results } = await stmt.all();
	return results || [];
}

/**
 * Searches for all tasks matching query (by numeric ID or title substring)
 * Returns all matching tasks so callers can handle ambiguity.
 */
export async function findTasksByQuery(db, userId, query, onlyIncomplete = false) {
	ensureDb(db);
	if (!query) return [];
	const uid = String(userId);
	const cleanQuery = String(query).trim();

	// 1. Check if query is a numeric ID
	const numericMatch = cleanQuery.match(/^\d+$/);
	if (numericMatch) {
		const byId = await getTaskById(db, uid, Number(numericMatch[0]));
		if (byId) return [byId];
	}

	// 2. Search by exact or partial title
	// Prevent SQLITE_MAX_LIKE_PATTERN_LENGTH error on D1 (capped at 50 bytes)
	const statusClause = onlyIncomplete ? "AND is_completed = 0" : "";
	const byteLength = typeof Buffer !== "undefined" ? Buffer.byteLength(cleanQuery, "utf8") : cleanQuery.length * 2;
	const useLike = byteLength <= 32;
	const searchPattern = useLike ? `%${cleanQuery}%` : "";

	const stmt = db.prepare(
		`SELECT id, telegram_user_id, title, is_completed, due_date, created_at, updated_at
		 FROM tasks
		 WHERE telegram_user_id = ? ${statusClause} AND (${useLike ? "title LIKE ? OR " : ""}instr(lower(title), lower(?)) > 0 OR instr(title, ?) > 0)
		 ORDER BY is_completed ASC, id DESC`
	).bind(...(useLike ? [uid, searchPattern, cleanQuery, cleanQuery] : [uid, cleanQuery, cleanQuery]));

	try {
		const { results } = await stmt.all();
		return results || [];
	} catch (err) {
		if (err.message?.includes("pattern too complex") || err.message?.includes("SQLITE_ERROR")) {
			const fallbackStmt = db.prepare(
				`SELECT id, telegram_user_id, title, is_completed, due_date, created_at, updated_at
				 FROM tasks
				 WHERE telegram_user_id = ? ${statusClause} AND instr(title, ?) > 0
				 ORDER BY is_completed ASC, id DESC`
			).bind(uid, cleanQuery);
			const { results } = await fallbackStmt.all();
			return results || [];
		}
		throw err;
	}
}

/**
 * Searches for a task matching query (by numeric ID or title substring)
 */
export async function findTaskByQuery(db, userId, query, onlyIncomplete = false) {
	const matches = await findTasksByQuery(db, userId, query, onlyIncomplete);
	return matches.length > 0 ? matches[0] : null;
}

/**
 * Updates task completion status
 */
export async function updateTaskStatus(db, userId, taskId, isCompleted) {
	ensureDb(db);
	try {
		if (isCompleted) {
			const stmt = db.prepare(
				`UPDATE tasks
				 SET is_completed = 1,
				     reminder_status = 'disabled',
				     reminder_token = NULL,
				     reminder_claimed_at = NULL,
				     updated_at = datetime('now')
				 WHERE id = ? AND telegram_user_id = ?`
			).bind(Number(taskId), String(userId));
			const info = await stmt.run();
			return (info.meta?.changes ?? 0) > 0;
		} else {
			const stmt = db.prepare(
				`UPDATE tasks
				 SET is_completed = 0,
				     reminder_token = NULL,
				     reminder_claimed_at = NULL,
				     reminder_retry_count = 0,
				     reminder_retry_after = 0,
				     reminder_sent = CASE
				       WHEN due_date IS NOT NULL AND due_date LIKE '%T%' AND unixepoch(due_date) >= (unixepoch('now') - 72 * 3600) THEN 0
				       ELSE reminder_sent
				     END,
				     reminder_status = CASE
				       WHEN due_date IS NULL OR due_date NOT LIKE '%T%' THEN 'disabled'
				       WHEN unixepoch(due_date) >= (unixepoch('now') - 72 * 3600) THEN 'pending'
				       ELSE 'missed'
				     END,
				     updated_at = datetime('now')
				 WHERE id = ? AND telegram_user_id = ?`
			).bind(Number(taskId), String(userId));
			const info = await stmt.run();
			return (info.meta?.changes ?? 0) > 0;
		}
	} catch (err) {
		// Fallback for mock environments without reminder columns
		if (err.message?.includes("no column named") || err.message?.includes("no such column")) {
			const stmt = db.prepare(
				`UPDATE tasks
				 SET is_completed = ?, updated_at = datetime('now')
				 WHERE id = ? AND telegram_user_id = ?`
			).bind(isCompleted ? 1 : 0, Number(taskId), String(userId));
			const info = await stmt.run();
			return (info.meta?.changes ?? 0) > 0;
		}
		throw err;
	}
}

/**
 * Deletes a task
 */
export async function deleteTask(db, userId, taskId) {
	ensureDb(db);
	const stmt = db.prepare(
		`DELETE FROM tasks
		 WHERE id = ? AND telegram_user_id = ?`
	).bind(Number(taskId), String(userId));

	const info = await stmt.run();
	return (info.meta?.changes ?? 0) > 0;
}

/**
 * Deletes all tasks for a user
 */
export async function deleteAllTasks(db, userId) {
	ensureDb(db);
	const stmt = db.prepare(
		`DELETE FROM tasks
		 WHERE telegram_user_id = ?`
	).bind(String(userId));

	const info = await stmt.run();
	return info.meta?.changes ?? 0;
}

/**
 * Deletes only completed tasks for a user, leaving incomplete and overdue tasks intact.
 * @param {D1Database} db
 * @param {string|number} userId
 * @returns {Promise<number>} Number of deleted completed tasks
 */
export async function deleteCompletedTasks(db, userId) {
	ensureDb(db);
	const stmt = db.prepare(
		`DELETE FROM tasks
		 WHERE telegram_user_id = ? AND is_completed = 1`
	).bind(String(userId));

	const info = await stmt.run();
	return info.meta?.changes ?? 0;
}

/**
 * Edits a task's title and/or due_date
 */
export async function editTask(db, userId, taskId, { title, dueDate }) {
	ensureDb(db);
	const updates = [];
	const params = [];

	if (typeof title === "string" && title.trim()) {
		updates.push("title = ?");
		params.push(title.trim());
	}
	if (dueDate !== undefined) {
		updates.push("due_date = ?");
		params.push(dueDate);

		// Reset reminder lifecycle whenever due_date is updated
		updates.push("reminder_sent = 0");
		updates.push(
			"reminder_status = CASE WHEN ? IS NULL OR ? NOT LIKE '%T%' THEN 'disabled' ELSE 'pending' END"
		);
		params.push(dueDate, dueDate);
		updates.push("reminder_token = NULL");
		updates.push("reminder_claimed_at = NULL");
		updates.push("reminder_retry_count = 0");
		updates.push("reminder_retry_after = 0");
		updates.push("reminded_at = NULL");
	}

	if (updates.length === 0) {
		return false;
	}

	updates.push("updated_at = datetime('now')");
	params.push(Number(taskId), String(userId));

	try {
		const stmt = db.prepare(
			`UPDATE tasks
			 SET ${updates.join(", ")}
			 WHERE id = ? AND telegram_user_id = ?`
		).bind(...params);

		const info = await stmt.run();
		return (info.meta?.changes ?? 0) > 0;
	} catch (err) {
		if (
			dueDate !== undefined &&
			(err.message?.includes("no column named") || err.message?.includes("no such column"))
		) {
			// Fallback for older mock DB without reminder columns
			const fallbackUpdates = [];
			const fallbackParams = [];
			if (typeof title === "string" && title.trim()) {
				fallbackUpdates.push("title = ?");
				fallbackParams.push(title.trim());
			}
			fallbackUpdates.push("due_date = ?");
			fallbackParams.push(dueDate);
			fallbackUpdates.push("updated_at = datetime('now')");
			fallbackParams.push(Number(taskId), String(userId));

			const stmt = db.prepare(
				`UPDATE tasks
				 SET ${fallbackUpdates.join(", ")}
				 WHERE id = ? AND telegram_user_id = ?`
			).bind(...fallbackParams);

			const info = await stmt.run();
			return (info.meta?.changes ?? 0) > 0;
		}
		throw err;
	}
}

/**
 * Saves a message to conversation history
 */
export async function saveConversationMessage(db, userId, role, content, intent = null) {
	if (!db || typeof db.prepare !== "function") return null;
	try {
		const cleanContent = (content || "").trim();
		if (!cleanContent) return null;

		const stmt = db.prepare(
			`INSERT INTO conversation_messages (telegram_user_id, role, content, intent, created_at)
			 VALUES (?, ?, ?, ?, datetime('now'))`
		).bind(String(userId), String(role), cleanContent, intent);

		await stmt.run();
	} catch (err) {
		console.warn("Failed to save conversation message:", err.message);
	}
}

/**
 * Retrieves the most recent N conversation messages in chronological order
 */
export async function getRecentConversation(db, userId, limit = 6) {
	if (!db || typeof db.prepare !== "function") return [];
	try {
		const stmt = db.prepare(
			`SELECT role, content, intent
			 FROM (
				SELECT id, role, content, intent
				FROM conversation_messages
				WHERE telegram_user_id = ?
				ORDER BY id DESC
				LIMIT ?
			 )
			 ORDER BY id ASC`
		).bind(String(userId), Number(limit));

		const { results } = await stmt.all();
		return results || [];
	} catch (err) {
		// Table might not exist yet if migration pending; fail gracefully
		return [];
	}
}

/**
 * Stages or activates a displayed task list for the user.
 * @param {D1Database} db
 * @param {string} userId
 * @param {number[]} taskIds
 * @param {"pending" | "active"} [status="active"]
 */
export async function saveDisplayedTaskList(db, userId, taskIds = [], status = "active") {
	if (!db || typeof db.prepare !== "function" || !userId) return;
	const uid = String(userId);
	const json = JSON.stringify(taskIds || []);

	// Retry up to 2 times to handle transient D1 write locks / glitches
	const maxRetries = 2;
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			if (status === "pending") {
				const stmt = db.prepare(
					`INSERT INTO user_displayed_lists (telegram_user_id, task_ids_json, pending_ids_json, status, list_version, updated_at)
					 VALUES (?, coalesce((SELECT task_ids_json FROM user_displayed_lists WHERE telegram_user_id = ?), '[]'), ?, 'pending', coalesce((SELECT list_version + 1 FROM user_displayed_lists WHERE telegram_user_id = ?), 1), datetime('now'))
					 ON CONFLICT(telegram_user_id) DO UPDATE SET
					   pending_ids_json = excluded.pending_ids_json,
					   status = 'pending',
					   list_version = user_displayed_lists.list_version + 1,
					   updated_at = datetime('now')`
				).bind(uid, uid, json, uid);
				await stmt.run();
				return;
			} else {
				// status === 'active'
				const stmt = db.prepare(
					`INSERT INTO user_displayed_lists (telegram_user_id, task_ids_json, pending_ids_json, status, list_version, updated_at)
					 VALUES (?, ?, NULL, 'active', coalesce((SELECT list_version + 1 FROM user_displayed_lists WHERE telegram_user_id = ?), 1), datetime('now'))
					 ON CONFLICT(telegram_user_id) DO UPDATE SET
					   task_ids_json = excluded.task_ids_json,
					   pending_ids_json = NULL,
					   status = 'active',
					   list_version = user_displayed_lists.list_version + 1,
					   updated_at = datetime('now')`
				).bind(uid, json, uid);
				await stmt.run();
				return;
			}
		} catch (err) {
			const msg = err.message || "";
			// Pre-migration schema fallback (if columns pending_ids_json/status/list_version missing)
			if (msg.includes("pending_ids_json") || msg.includes("status") || msg.includes("no column named") || msg.includes("no such column")) {
				if (status === "pending") {
					// In legacy schema without pending_ids_json, do NOT write to task_ids_json before delivery!
					return;
				}
				try {
					const fallbackStmt = db.prepare(
						`INSERT INTO user_displayed_lists (telegram_user_id, task_ids_json, updated_at)
						 VALUES (?, ?, datetime('now'))
						 ON CONFLICT(telegram_user_id) DO UPDATE SET
						   task_ids_json = excluded.task_ids_json,
						   updated_at = datetime('now')`
					).bind(uid, json);
					await fallbackStmt.run();
					return;
				} catch (fallbackErr) {
					if (attempt === maxRetries) {
						console.error("Could not save displayed task list (fallback):", fallbackErr.message);
					}
				}
			} else if (attempt === maxRetries) {
				console.error("Could not save displayed task list after retries:", msg);
			}
		}
	}
}

/**
 * Stages a newly prepared list as 'pending' prior to or during Telegram delivery.
 */
export async function stageDisplayedTaskList(db, userId, taskIds = []) {
	return await saveDisplayedTaskList(db, userId, taskIds, "pending");
}

/**
 * Clears any pending displayed list if Telegram message delivery failed.
 */
export async function clearPendingDisplayedList(db, userId) {
	if (!db || typeof db.prepare !== "function" || !userId) return;
	const uid = String(userId);
	try {
		// If there was no previous active list, remove the newly inserted pending row
		const deleteStmt = db.prepare(
			`DELETE FROM user_displayed_lists
			 WHERE telegram_user_id = ? AND (task_ids_json = '[]' OR task_ids_json IS NULL) AND status = 'pending'`
		).bind(uid);
		const delInfo = await deleteStmt.run();
		if ((delInfo.meta?.changes ?? 0) === 0) {
			const stmt = db.prepare(
				`UPDATE user_displayed_lists
				 SET pending_ids_json = NULL,
				     status = 'active',
				     updated_at = datetime('now')
				 WHERE telegram_user_id = ? AND status = 'pending'`
			).bind(uid);
			await stmt.run();
		}
	} catch (err) {
		// Schema fallback if status column is missing
	}
}

/**
 * Retrieves the exact task IDs previously displayed to the user within maxAgeMinutes
 */
export async function getDisplayedTaskList(db, userId, maxAgeMinutes = 30) {
	const createEmpty = (isExpired = false, found = false, status = "none") => {
		const arr = [];
		arr.found = found;
		arr.isExpired = isExpired;
		arr.status = status;
		arr.pendingIds = null;
		arr.activeIds = [];
		return arr;
	};

	if (!db || typeof db.prepare !== "function" || !userId) {
		return createEmpty(false, false);
	}

	try {
		let row;
		try {
			const stmt = db.prepare(
				`SELECT task_ids_json, pending_ids_json, status, list_version,
				 (strftime('%s', 'now') - strftime('%s', updated_at)) AS age_seconds
				 FROM user_displayed_lists
				 WHERE telegram_user_id = ?`
			).bind(String(userId));
			row = await stmt.first();
		} catch (schemaErr) {
			// Pre-migration schema fallback
			const legacyStmt = db.prepare(
				`SELECT task_ids_json,
				 (strftime('%s', 'now') - strftime('%s', updated_at)) AS age_seconds
				 FROM user_displayed_lists
				 WHERE telegram_user_id = ?`
			).bind(String(userId));
			row = await legacyStmt.first();
		}

		if (!row?.task_ids_json && !row?.pending_ids_json) {
			return createEmpty(false, false);
		}

		// Check TTL expiration (default 30 minutes)
		const age = Number(row.age_seconds) || 0;
		if (age > maxAgeMinutes * 60) {
			return createEmpty(true, true, "expired");
		}

		let activeIds = [];
		if (row.task_ids_json) {
			try {
				const parsed = JSON.parse(row.task_ids_json);
				if (Array.isArray(parsed)) activeIds = parsed;
			} catch {}
		}

		let pendingIds = null;
		if (row.pending_ids_json) {
			try {
				const parsed = JSON.parse(row.pending_ids_json);
				if (Array.isArray(parsed)) pendingIds = parsed;
			} catch {}
		}

		// If list status is pending (a new list is being sent or was just sent):
		// Use pendingIds as primary IDs because the user is referring to the newest list!
		const effectiveIds = (row.status === "pending" && pendingIds && pendingIds.length > 0)
			? [...pendingIds]
			: [...activeIds];

		effectiveIds.found = true;
		effectiveIds.isExpired = false;
		effectiveIds.status = row.status || "active";
		effectiveIds.listVersion = Number(row.list_version) || 1;
		effectiveIds.pendingIds = pendingIds;
		effectiveIds.activeIds = activeIds;

		return effectiveIds;
	} catch (err) {
		console.warn("Could not get displayed task list:", err.message);
		return createEmpty(false, false);
	}
}

/**
 * Atomically reserves a Telegram update_id to prevent concurrent duplicate processing.
 * Returns: { state: "reserved" | "completed" | "in_progress", lockToken: string | null, version: number, responseText?: string | null }
 */
export async function reserveTelegramUpdate(db, updateId, staleThresholdSeconds = 60) {
	if (!db || typeof db.prepare !== "function" || !updateId) {
		return { state: "reserved", lockToken: null, version: 1 };
	}

	const uid = String(updateId);
	const lockToken = typeof crypto !== "undefined" && crypto.randomUUID
		? crypto.randomUUID()
		: `tok_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

	try {
		// 1. Attempt atomic insert with lockToken and version 1
		const insertStmt = db.prepare(
			`INSERT INTO processed_updates (update_id, status, lock_token, version, created_at, updated_at)
			 VALUES (?, 'processing', ?, 1, datetime('now'), datetime('now'))`
		).bind(uid, lockToken);

		await insertStmt.run();
		return { state: "reserved", lockToken, version: 1 };
	} catch (err) {
		const msg = err.message || "";

		// If schema has no lock_token/version column (legacy schema fallback)
		if (msg.includes("lock_token") || msg.includes("no column named") || msg.includes("no such column")) {
			try {
				const legacyInsert = db.prepare(
					`INSERT INTO processed_updates (update_id, status, created_at, updated_at)
					 VALUES (?, 'processing', datetime('now'), datetime('now'))`
				).bind(uid);
				await legacyInsert.run();
				return { state: "reserved", lockToken: null, version: 1 };
			} catch (legacyErr) {
				const legacyMsg = legacyErr.message || "";
				if (legacyMsg.includes("no column named status") || legacyMsg.includes("has no column named status") || legacyMsg.includes("no such column: status")) {
					try {
						const minimalInsert = db.prepare(
							`INSERT INTO processed_updates (update_id, created_at)
							 VALUES (?, datetime('now'))`
						).bind(uid);
						await minimalInsert.run();
						return { state: "reserved", lockToken: null, version: 1 };
					} catch (minErr) {
						if ((minErr.message || "").includes("UNIQUE") || (minErr.message || "").includes("constraint")) {
							return { state: "completed", lockToken: null, version: 1 };
						}
						return { state: "reserved", lockToken: null, version: 1 };
					}
				}
				if (!legacyMsg.includes("UNIQUE") && !legacyMsg.includes("constraint")) {
					return { state: "reserved", lockToken: null, version: 1 };
				}
			}
		} else if (!msg.includes("UNIQUE") && !msg.includes("constraint")) {
			return { state: "reserved", lockToken, version: 1 };
		}

		// 2. Conflict occurred: Query current update state
		try {
			let existing;
			try {
				const selectStmt = db.prepare(
					`SELECT status, lock_token, version, response_text,
					 (strftime('%s', 'now') - strftime('%s', updated_at)) AS age_seconds
					 FROM processed_updates
					 WHERE update_id = ?`
				).bind(uid);
				existing = await selectStmt.first();
			} catch (selectErr) {
				const selMsg = (selectErr.message || "").toLowerCase();
				if (selMsg.includes("lock_token") || selMsg.includes("no such column")) {
					const legacySelect = db.prepare(
						`SELECT status,
						 (strftime('%s', 'now') - strftime('%s', updated_at)) AS age_seconds
						 FROM processed_updates
						 WHERE update_id = ?`
					).bind(uid);
					existing = await legacySelect.first();
				} else {
					throw selectErr;
				}
			}

			if (!existing) {
				return { state: "reserved", lockToken, version: 1 };
			}

			if (existing.status === "completed") {
				return {
					state: "completed",
					lockToken: existing.lock_token || null,
					version: Number(existing.version) || 1,
					responseText: existing.response_text || null,
				};
			}

			// If stuck in processing for longer than staleThresholdSeconds or marked failed, reclaim ownership
			const age = Number(existing.age_seconds) || 0;
			if (existing.status === "failed" || age >= staleThresholdSeconds) {
				const currentVersion = Number(existing.version) || 1;
				const newVersion = currentVersion + 1;

				try {
					const reclaimStmt = db.prepare(
						`UPDATE processed_updates
						 SET status = 'processing',
						     lock_token = ?,
						     version = coalesce(version, 1) + 1,
						     updated_at = datetime('now')
						 WHERE update_id = ? AND (status = 'failed' OR (strftime('%s', 'now') - strftime('%s', updated_at)) >= ?)`
					).bind(lockToken, uid, staleThresholdSeconds);

					const info = await reclaimStmt.run();
					if ((info.meta?.changes ?? 0) > 0) {
						return { state: "reserved", lockToken, version: newVersion };
					}
				} catch (reclaimErr) {
					const recMsg = (reclaimErr.message || "").toLowerCase();
					if (recMsg.includes("lock_token") || recMsg.includes("no such column")) {
						const fallbackReclaim = db.prepare(
							`UPDATE processed_updates
							 SET status = 'processing', updated_at = datetime('now')
							 WHERE update_id = ? AND (status = ? OR (strftime('%s', 'now') - strftime('%s', updated_at)) >= ?)`
						).bind(uid, existing.status, staleThresholdSeconds);
						const info = await fallbackReclaim.run();
						if ((info.meta?.changes ?? 0) > 0) {
							return { state: "reserved", lockToken: null, version: 1 };
						}
					} else {
						throw reclaimErr;
					}
				}
			}

			// Actively processing by another concurrent worker instance
			return {
				state: "in_progress",
				lockToken: existing.lock_token || null,
				version: Number(existing.version) || 1,
			};
		} catch {
			return { state: "completed", lockToken: null, version: 1 };
		}
	}
}

/**
 * Marks a Telegram update_id as completed, validating lockToken (fencing check)
 * and optionally caching responseText for retry recovery.
 * @returns {Promise<boolean>} true if successfully marked, false if lockToken mismatch or failure
 */
export async function markUpdateCompleted(db, updateId, lockToken = null, responseText = null) {
	if (!db || typeof db.prepare !== "function" || !updateId) return false;
	const uid = String(updateId);

	try {
		if (lockToken) {
			const stmt = db.prepare(
				`UPDATE processed_updates
				 SET status = 'completed',
				     response_text = coalesce(?, response_text),
				     updated_at = datetime('now')
				 WHERE update_id = ? AND lock_token = ?`
			).bind(responseText, uid, String(lockToken));

			const info = await stmt.run();
			return (info.meta?.changes ?? 0) > 0;
		} else {
			// Backward compatibility: no lockToken specified
			const stmt = db.prepare(
				`UPDATE processed_updates
				 SET status = 'completed',
				     response_text = coalesce(?, response_text),
				     updated_at = datetime('now')
				 WHERE update_id = ?`
			).bind(responseText, uid);

			const info = await stmt.run();
			return (info.meta?.changes ?? 0) > 0;
		}
	} catch (err) {
		// Fallback for schema missing response_text or lock_token
		try {
			const fallbackStmt = db.prepare(
				`UPDATE processed_updates
				 SET status = 'completed', updated_at = datetime('now')
				 WHERE update_id = ?`
			).bind(uid);
			const info = await fallbackStmt.run();
			return (info.meta?.changes ?? 0) > 0;
		} catch (fallbackErr) {
			console.warn("Could not mark update completed:", fallbackErr.message);
			return false;
		}
	}
}

/**
 * Marks a Telegram update_id as failed (allowing safe retry), validating lockToken (fencing check)
 * @returns {Promise<boolean>} true if successfully marked, false if lockToken mismatch
 */
export async function markUpdateFailed(db, updateId, lockToken = null) {
	if (!db || typeof db.prepare !== "function" || !updateId) return false;
	const uid = String(updateId);

	try {
		if (lockToken) {
			const stmt = db.prepare(
				`UPDATE processed_updates
				 SET status = 'failed', updated_at = datetime('now')
				 WHERE update_id = ? AND lock_token = ?`
			).bind(uid, String(lockToken));

			const info = await stmt.run();
			return (info.meta?.changes ?? 0) > 0;
		} else {
			const stmt = db.prepare(
				`UPDATE processed_updates
				 SET status = 'failed', updated_at = datetime('now')
				 WHERE update_id = ?`
			).bind(uid);

			const info = await stmt.run();
			return (info.meta?.changes ?? 0) > 0;
		}
	} catch (err) {
		console.warn("Could not mark update failed:", err.message);
		return false;
	}
}

/**
 * Checks if a Telegram update_id was already processed
 */
export async function isUpdateProcessed(db, updateId) {
	if (!db || typeof db.prepare !== "function" || !updateId) return false;
	try {
		const stmt = db.prepare(
			`SELECT update_id FROM processed_updates WHERE update_id = ? AND status = 'completed'`
		).bind(String(updateId));
		const row = await stmt.first();
		return Boolean(row);
	} catch (err) {
		return false;
	}
}

/**
 * Records a Telegram update_id as successfully processed
 */
export async function recordProcessedUpdate(db, updateId) {
	await markUpdateCompleted(db, updateId);
}

/**
 * Ensures pending_confirmations table exists in D1
 */
async function ensurePendingConfirmationsTable(db) {
	try {
		await db.prepare(
			`CREATE TABLE IF NOT EXISTS pending_confirmations (
				telegram_user_id TEXT PRIMARY KEY,
				action_type TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				expires_at INTEGER NOT NULL
			)`
		).run();
	} catch (err) {
		console.warn("Could not ensure pending_confirmations table:", err.message);
	}
}

/**
 * Sets a pending confirmation with TTL for sensitive actions like bulk delete
 */
export async function setPendingConfirmation(db, userId, actionType = "bulk_delete", ttlSeconds = 120) {
	ensureDb(db);
	await ensurePendingConfirmationsTable(db);
	const now = Date.now();
	const expiresAt = now + ttlSeconds * 1000;

	await db.prepare(
		`INSERT INTO pending_confirmations (telegram_user_id, action_type, created_at, expires_at)
		 VALUES (?, ?, ?, ?)
		 ON CONFLICT(telegram_user_id) DO UPDATE SET
			action_type = excluded.action_type,
			created_at = excluded.created_at,
			expires_at = excluded.expires_at`
	).bind(String(userId), actionType, now, expiresAt).run();
}

/**
 * Retrieves an active pending confirmation, returning null if expired or missing
 */
export async function getPendingConfirmation(db, userId, actionType = "bulk_delete") {
	ensureDb(db);
	await ensurePendingConfirmationsTable(db);
	const row = await db.prepare(
		`SELECT action_type, created_at, expires_at
		 FROM pending_confirmations
		 WHERE telegram_user_id = ? AND action_type = ?`
	).bind(String(userId), actionType).first();

	if (!row) return null;

	if (Date.now() > Number(row.expires_at)) {
		await clearPendingConfirmation(db, userId, actionType);
		return null;
	}

	return row;
}

/**
 * Clears any pending confirmation for the user
 */
export async function clearPendingConfirmation(db, userId, actionType = "bulk_delete") {
	ensureDb(db);
	await ensurePendingConfirmationsTable(db);
	await db.prepare(
		`DELETE FROM pending_confirmations
		 WHERE telegram_user_id = ? AND action_type = ?`
	).bind(String(userId), actionType).run();
}

/**
 * ============================================================================
 * STAGE 5: Task Reminder System Repository Functions
 * ============================================================================
 */

/**
 * Ensures reminder columns and index exist on the tasks table.
 * Useful for test fixtures or incremental schema validation.
 */
export async function ensureReminderColumns(db) {
	ensureDb(db);
	try {
		await db.prepare("SELECT reminder_status FROM tasks LIMIT 1").first();
	} catch (err) {
		if (err.message && (err.message.includes("no such column") || err.message.includes("no column named"))) {
			try { await db.prepare("ALTER TABLE tasks ADD COLUMN reminder_sent INTEGER NOT NULL DEFAULT 0").run(); } catch {}
			try { await db.prepare("ALTER TABLE tasks ADD COLUMN reminder_status TEXT NOT NULL DEFAULT 'pending'").run(); } catch {}
			try { await db.prepare("ALTER TABLE tasks ADD COLUMN reminder_token TEXT").run(); } catch {}
			try { await db.prepare("ALTER TABLE tasks ADD COLUMN reminder_claimed_at INTEGER").run(); } catch {}
			try { await db.prepare("ALTER TABLE tasks ADD COLUMN reminder_retry_count INTEGER NOT NULL DEFAULT 0").run(); } catch {}
			try { await db.prepare("ALTER TABLE tasks ADD COLUMN reminder_retry_after INTEGER NOT NULL DEFAULT 0").run(); } catch {}
			try { await db.prepare("ALTER TABLE tasks ADD COLUMN reminded_at TEXT").run(); } catch {}
			try {
				await db.prepare(
					"CREATE INDEX IF NOT EXISTS idx_tasks_reminders_active ON tasks (reminder_sent, is_completed, reminder_status, due_date)"
				).run();
			} catch {}
		}
	}
}

/**
 * Sweeps overdue tasks that have passed the threshold (default 72 hours) and moves them to 'missed'.
 * Only transitions 'pending', 'failed', or stale 'processing' (lease expired > 120s).
 * Never touches active processing leases or final statuses ('sent', 'abandoned', 'missed', 'disabled').
 * @param {D1Database} db
 * @param {number} [thresholdHours=72]
 * @returns {Promise<number>} Number of tasks swept
 */
export async function sweepMissedReminders(db, thresholdHours = 72) {
	ensureDb(db);
	const hours = Number.isFinite(Number(thresholdHours)) ? Number(thresholdHours) : 72;
	const stmt = db.prepare(
		`UPDATE tasks
		 SET reminder_status = 'missed',
		     reminder_token = NULL,
		     reminder_claimed_at = NULL,
		     updated_at = datetime('now')
		 WHERE is_completed = 0
		   AND reminder_sent = 0
		   AND due_date IS NOT NULL
		   AND due_date LIKE '%T%'
		   AND unixepoch(due_date) < (unixepoch('now') - ? * 3600)
		   AND (
		     reminder_status IN ('pending', 'failed')
		     OR (reminder_status = 'processing' AND reminder_claimed_at < (unixepoch('now') - 120))
		   )`
	).bind(hours);

	const info = await stmt.run();
	return info.meta?.changes ?? 0;
}

/**
 * Retrieves due tasks ready for notification within the 72-hour window.
 * Excludes completed, sent, abandoned, missed, disabled, and date-only tasks.
 * Includes stale processing tasks (lease expired > 120s) for reclamation.
 * @param {D1Database} db
 * @param {number} [limit=5]
 * @returns {Promise<Array>} List of due tasks
 */
export async function getDueTasksForReminder(db, limit = 5) {
	ensureDb(db);
	const maxLimit = Math.max(1, Number(limit) || 5);
	const stmt = db.prepare(
		`SELECT id, telegram_user_id, title, is_completed, due_date,
		        reminder_sent, reminder_status, reminder_token, reminder_claimed_at,
		        reminder_retry_count, reminder_retry_after, reminded_at,
		        created_at, updated_at
		 FROM tasks
		 WHERE is_completed = 0
		   AND reminder_sent = 0
		   AND due_date IS NOT NULL
		   AND due_date LIKE '%T%'
		   AND unixepoch(due_date) <= unixepoch('now')
		   AND unixepoch(due_date) >= (unixepoch('now') - 72 * 3600)
		   AND (
		     (reminder_status IN ('pending', 'failed') AND unixepoch('now') >= reminder_retry_after)
		     OR (reminder_status = 'processing' AND reminder_claimed_at < (unixepoch('now') - 120))
		   )
		 ORDER BY due_date ASC, id ASC
		 LIMIT ?`
	).bind(maxLimit);

	const { results } = await stmt.all();
	return results || [];
}

/**
 * Atomically claims a task for reminder delivery using an atomic UPDATE lease.
 * Succeeds only if task is eligible and lease is available or stale (>120s).
 * @param {D1Database} db
 * @param {number|string} taskId
 * @param {string} dueDate
 * @param {string} token - Unique lease/claim token
 * @returns {Promise<boolean>} True if atomically claimed, false otherwise
 */
export async function claimTaskForReminder(db, taskId, dueDate, token) {
	ensureDb(db);
	if (!taskId || !dueDate || !token) return false;

	const stmt = db.prepare(
		`UPDATE tasks
		 SET reminder_status = 'processing',
		     reminder_token = ?,
		     reminder_claimed_at = unixepoch('now'),
		     updated_at = datetime('now')
		 WHERE id = ?
		   AND due_date = ?
		   AND is_completed = 0
		   AND reminder_sent = 0
		   AND (
		     (reminder_status IN ('pending', 'failed') AND unixepoch('now') >= reminder_retry_after)
		     OR (reminder_status = 'processing' AND reminder_claimed_at < (unixepoch('now') - 120))
		   )`
	).bind(String(token), Number(taskId), String(dueDate));

	const info = await stmt.run();
	return (info.meta?.changes ?? 0) === 1;
}

/**
 * Marks a claimed reminder as sent successfully.
 * Fails if token, dueDate, or processing state doesn't match (e.g. task was completed or rescheduled).
 * @param {D1Database} db
 * @param {number|string} taskId
 * @param {string} dueDate
 * @param {string} token
 * @returns {Promise<boolean>} True if marked sent, false if rejected
 */
export async function markReminderSuccess(db, taskId, dueDate, token) {
	ensureDb(db);
	if (!taskId || !dueDate || !token) return false;

	const stmt = db.prepare(
		`UPDATE tasks
		 SET reminder_sent = 1,
		     reminder_status = 'sent',
		     reminded_at = datetime('now'),
		     reminder_token = NULL,
		     reminder_claimed_at = NULL,
		     updated_at = datetime('now')
		 WHERE id = ?
		   AND due_date = ?
		   AND reminder_token = ?
		   AND reminder_status = 'processing'
		   AND is_completed = 0
		   AND reminder_sent = 0`
	).bind(Number(taskId), String(dueDate), String(token));

	const info = await stmt.run();
	return (info.meta?.changes ?? 0) === 1;
}

/**
 * Records a reminder delivery failure with retry backoff and attempt counting.
 * Automatically transitions to 'abandoned' if permanent (e.g. 400/403) or after 3 attempts.
 * @param {D1Database} db
 * @param {number|string} taskId
 * @param {string} dueDate
 * @param {string} token
 * @param {{ isPermanent?: boolean, retryAfterSeconds?: number }} [options]
 * @returns {Promise<boolean>} True if failure recorded, false if rejected
 */
export async function markReminderFailure(db, taskId, dueDate, token, { isPermanent = false, retryAfterSeconds = 0 } = {}) {
	ensureDb(db);
	if (!taskId || !dueDate || !token) return false;

	const isPerm = isPermanent ? 1 : 0;
	const customDelay = Math.max(0, Number(retryAfterSeconds) || 0);

	const stmt = db.prepare(
		`UPDATE tasks
		 SET reminder_retry_count = reminder_retry_count + 1,
		     reminder_status = CASE
		       WHEN ? = 1 OR (reminder_retry_count + 1) >= 3 THEN 'abandoned'
		       ELSE 'failed'
		     END,
		     reminder_retry_after = CASE
		       WHEN ? = 1 OR (reminder_retry_count + 1) >= 3 THEN 0
		       WHEN ? > 0 THEN unixepoch('now') + ?
		       WHEN (reminder_retry_count + 1) = 1 THEN unixepoch('now') + 60
		       ELSE unixepoch('now') + 180
		     END,
		     reminder_token = NULL,
		     reminder_claimed_at = NULL,
		     updated_at = datetime('now')
		 WHERE id = ?
		   AND due_date = ?
		   AND reminder_token = ?
		   AND reminder_status = 'processing'
		   AND is_completed = 0
		   AND reminder_sent = 0`
	).bind(isPerm, isPerm, customDelay, customDelay, Number(taskId), String(dueDate), String(token));

	const info = await stmt.run();
	return (info.meta?.changes ?? 0) === 1;
}

/**
 * ============================================================================
 * STAGE 6 / PHASE 4: Pending Clarifications Repository Functions
 * Manages ambiguous hour follow-ups with atomic Claim/Lease fencing.
 * ============================================================================
 */

/**
 * Generates a cryptographically secure random token (CSPRNG).
 * Uses crypto.randomUUID or crypto.getRandomValues. Fails if no secure source is available.
 * @returns {string}
 */
export function generateSecureToken() {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}
	if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
		const bytes = new Uint8Array(16);
		crypto.getRandomValues(bytes);
		return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
	}
	throw new Error("SECURE_CRYPTO_UNAVAILABLE: Cryptographically secure random number generator is required");
}

/**
 * Validates that dateStr is a valid Gregorian calendar date in YYYY-MM-DD format.
 * Accurately validates days per month, leap years, and calendar boundaries.
 * Matches project date conventions from dateUtils.js.
 * @param {string} dateStr
 * @returns {boolean}
 */
export function isValidCalendarDate(dateStr) {
	if (!dateStr || typeof dateStr !== "string") return false;
	const trimmed = dateStr.trim();
	if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return false;
	return isValidIsoDueDate(trimmed);
}

/**
 * Ensures pending_clarifications table and indices exist in D1.
 * Throws on failure without swallowing errors.
 * @param {D1Database} db
 */
export async function ensurePendingClarificationsTable(db) {
	ensureDb(db);
	try {
		await db.prepare(
			`CREATE TABLE IF NOT EXISTS pending_clarifications (
				telegram_user_id TEXT PRIMARY KEY,
				clarification_id TEXT NOT NULL,
				action_type TEXT NOT NULL,
				payload TEXT NOT NULL,
				claim_token TEXT DEFAULT NULL,
				claimed_at INTEGER DEFAULT NULL,
				created_at INTEGER NOT NULL,
				expires_at INTEGER NOT NULL
			)`
		).run();

		await db.prepare(
			`CREATE INDEX IF NOT EXISTS idx_pending_clarifications_exp ON pending_clarifications(expires_at)`
		).run();
	} catch (err) {
		throw new Error(`FAILED_TO_ENSURE_PENDING_CLARIFICATIONS_TABLE: ${err.message || String(err)}`);
	}
}

/**
 * Validates clarification payload structure and field types.
 * Strictly verifies calendrical date integrity, component matching, ambiguous hour integers,
 * and boolean completion status.
 * Throws Error if payload is invalid.
 * @param {string} actionType - 'add' or 'edit'
 * @param {any} payload
 * @returns {boolean}
 */
export function validateClarificationPayload(actionType, payload) {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		throw new Error("INVALID_CLARIFICATION_PAYLOAD: Payload must be a non-null object");
	}

	const act = String(actionType || "").toLowerCase();

	if (act === "add") {
		const {
			title,
			targetDateStr,
			targetYear,
			targetMonth,
			targetDay,
			ambiguousHour,
			rawHourStr,
			originalUserText,
		} = payload;

		if (typeof title !== "string" || !title.trim()) {
			throw new Error("INVALID_CLARIFICATION_PAYLOAD: 'title' is required and must be a non-empty string");
		}
		if (typeof targetDateStr !== "string" || !isValidCalendarDate(targetDateStr)) {
			throw new Error("INVALID_CLARIFICATION_PAYLOAD: 'targetDateStr' must be a valid calendar date string (YYYY-MM-DD)");
		}
		if (typeof targetYear !== "number" || !Number.isInteger(targetYear) || targetYear <= 0) {
			throw new Error("INVALID_CLARIFICATION_PAYLOAD: 'targetYear' must be a valid integer year");
		}
		if (typeof targetMonth !== "number" || !Number.isInteger(targetMonth) || targetMonth < 1 || targetMonth > 12) {
			throw new Error("INVALID_CLARIFICATION_PAYLOAD: 'targetMonth' must be an integer between 1 and 12");
		}
		if (typeof targetDay !== "number" || !Number.isInteger(targetDay) || targetDay < 1 || targetDay > 31) {
			throw new Error("INVALID_CLARIFICATION_PAYLOAD: 'targetDay' must be an integer between 1 and 31");
		}

		// Ensure targetDateStr exactly matches year, month, and day components
		const expectedDateStr = `${targetYear}-${String(targetMonth).padStart(2, "0")}-${String(targetDay).padStart(2, "0")}`;
		if (targetDateStr.trim() !== expectedDateStr) {
			throw new Error(`INVALID_CLARIFICATION_PAYLOAD: 'targetDateStr' (${targetDateStr}) does not match components (${expectedDateStr})`);
		}

		if (typeof ambiguousHour !== "number" || !Number.isInteger(ambiguousHour) || ambiguousHour < 0 || ambiguousHour > 23) {
			throw new Error("INVALID_CLARIFICATION_PAYLOAD: 'ambiguousHour' must be an integer between 0 and 23");
		}
		if (typeof rawHourStr !== "string" || !rawHourStr.trim()) {
			throw new Error("INVALID_CLARIFICATION_PAYLOAD: 'rawHourStr' is required and must be a non-empty string");
		}
		if (typeof originalUserText !== "string" || !originalUserText.trim()) {
			throw new Error("INVALID_CLARIFICATION_PAYLOAD: 'originalUserText' is required and must be a non-empty string");
		}
		return true;
	}

	if (act === "edit") {
		const {
			targetTaskId,
			targetTaskTitle,
			targetTaskDueDate,
			targetTaskIsCompleted,
			newTitle,
			targetDateStr,
			ambiguousHour,
			originalUserText,
		} = payload;

		if (targetTaskId === undefined || targetTaskId === null || String(targetTaskId).trim() === "") {
			throw new Error("INVALID_CLARIFICATION_PAYLOAD: 'targetTaskId' is required");
		}
		if (typeof targetTaskTitle !== "string" || !targetTaskTitle.trim()) {
			throw new Error("INVALID_CLARIFICATION_PAYLOAD: 'targetTaskTitle' is required and must be a non-empty string");
		}
		if (targetTaskDueDate !== null && (typeof targetTaskDueDate !== "string" || !isValidIsoDueDate(targetTaskDueDate))) {
			throw new Error("INVALID_CLARIFICATION_PAYLOAD: 'targetTaskDueDate' must be null or a valid calendar/ISO date string");
		}
		if (typeof targetTaskIsCompleted !== "boolean") {
			throw new Error("INVALID_CLARIFICATION_PAYLOAD: 'targetTaskIsCompleted' must be a boolean (true or false)");
		}
		if (newTitle !== null && newTitle !== undefined && typeof newTitle !== "string") {
			throw new Error("INVALID_CLARIFICATION_PAYLOAD: 'newTitle' must be a string or null");
		}
		if (typeof targetDateStr !== "string" || !isValidCalendarDate(targetDateStr)) {
			throw new Error("INVALID_CLARIFICATION_PAYLOAD: 'targetDateStr' must be a valid calendar date string (YYYY-MM-DD)");
		}
		if (typeof ambiguousHour !== "number" || !Number.isInteger(ambiguousHour) || ambiguousHour < 0 || ambiguousHour > 23) {
			throw new Error("INVALID_CLARIFICATION_PAYLOAD: 'ambiguousHour' must be an integer between 0 and 23");
		}
		if (typeof originalUserText !== "string" || !originalUserText.trim()) {
			throw new Error("INVALID_CLARIFICATION_PAYLOAD: 'originalUserText' is required and must be a non-empty string");
		}
		return true;
	}

	throw new Error(`INVALID_CLARIFICATION_PAYLOAD: Unsupported action_type '${actionType}'`);
}

/**
 * Sets or replaces a pending clarification for the user.
 * Exactly one active clarification is allowed per user (upsert via ON CONFLICT).
 * @param {D1Database} db
 * @param {string} userId - Telegram User ID
 * @param {"add"|"edit"} actionType
 * @param {object} payload
 * @param {number} [ttlSeconds=300] - Default 5 minutes
 * @returns {Promise<object>} Created/updated pending clarification metadata
 */
export async function setPendingClarification(db, userId, actionType, payload, ttlSeconds = 300) {
	ensureDb(db);
	await ensurePendingClarificationsTable(db);

	const uid = String(userId || "").trim();
	if (!uid) {
		throw new Error("USER_ID_REQUIRED: userId cannot be empty");
	}

	const actType = String(actionType || "").trim().toLowerCase();
	if (actType !== "add" && actType !== "edit") {
		throw new Error(`INVALID_ACTION_TYPE: actionType must be 'add' or 'edit', got '${actionType}'`);
	}

	validateClarificationPayload(actType, payload);

	const clarificationId = generateSecureToken();
	const now = Date.now();
	const ttlMs = Math.max(1, Number(ttlSeconds) || 300) * 1000;
	const expiresAt = now + ttlMs;
	const payloadJson = JSON.stringify(payload);

	const stmt = db.prepare(
		`INSERT INTO pending_clarifications (
			telegram_user_id, clarification_id, action_type, payload,
			claim_token, claimed_at, created_at, expires_at
		)
		VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)
		ON CONFLICT(telegram_user_id) DO UPDATE SET
			clarification_id = excluded.clarification_id,
			action_type = excluded.action_type,
			payload = excluded.payload,
			claim_token = NULL,
			claimed_at = NULL,
			created_at = excluded.created_at,
			expires_at = excluded.expires_at`
	).bind(uid, clarificationId, actType, payloadJson, now, expiresAt);

	await stmt.run();

	return {
		clarificationId,
		userId: uid,
		actionType: actType,
		payload,
		createdAt: now,
		expiresAt,
	};
}

/**
 * Retrieves the active pending clarification for the user.
 * Returns null if missing, expired, corrupted, or invalid.
 * Expired entries are conditionally cleaned up matching the exact clarification_id and expires_at,
 * ensuring newly replaced records are never deleted by race conditions.
 * @param {D1Database} db
 * @param {string} userId
 * @returns {Promise<object|null>}
 */
export async function getPendingClarification(db, userId) {
	ensureDb(db);
	await ensurePendingClarificationsTable(db);

	const uid = String(userId || "").trim();
	if (!uid) return null;

	const stmt = db.prepare(
		`SELECT telegram_user_id, clarification_id, action_type, payload,
		        claim_token, claimed_at, created_at, expires_at
		 FROM pending_clarifications
		 WHERE telegram_user_id = ?`
	).bind(uid);

	const row = await stmt.first();
	if (!row) return null;

	const now = Date.now();
	if (now > Number(row.expires_at)) {
		// Scoped atomic cleanup: delete only if clarification_id and expires_at still match the read record
		await db.prepare(
			`DELETE FROM pending_clarifications
			 WHERE telegram_user_id = ?
			   AND clarification_id = ?
			   AND expires_at = ?
			   AND expires_at < ?`
		).bind(uid, String(row.clarification_id), Number(row.expires_at), now).run();
		return null;
	}

	let parsedPayload = null;
	try {
		parsedPayload = JSON.parse(row.payload);
		validateClarificationPayload(row.action_type, parsedPayload);
	} catch (err) {
		console.warn(`[getPendingClarification] Corrupted payload for user ${uid}: ${err.message}`);
		return null;
	}

	return {
		clarificationId: row.clarification_id,
		userId: row.telegram_user_id,
		actionType: row.action_type,
		payload: parsedPayload,
		claimToken: row.claim_token,
		claimedAt: row.claimed_at ? Number(row.claimed_at) : null,
		createdAt: Number(row.created_at),
		expiresAt: Number(row.expires_at),
	};
}

/**
 * Atomically claims a pending clarification with a lease (default 15s).
 * Conditional UPDATE ensures only one worker can hold active ownership.
 * Fail-Closed: Future claimed_at values are protected and not treated as expired.
 * Post-UPDATE validation guarantees returned metadata belongs strictly to the claimed record.
 * @param {D1Database} db
 * @param {string} userId
 * @param {number} [leaseMs=15000]
 * @returns {Promise<{ success: boolean, claimToken: string|null, claimedAt?: number, clarification?: object, reason?: string }>}
 */
export async function claimPendingClarification(db, userId, leaseMs = 15000) {
	ensureDb(db);
	await ensurePendingClarificationsTable(db);

	const uid = String(userId || "").trim();
	if (!uid) {
		return { success: false, claimToken: null, reason: "INVALID_USER_ID" };
	}

	const now = Date.now();
	const leaseDuration = Math.max(1000, Number(leaseMs) || 15000);
	const leaseThreshold = now - leaseDuration;
	const claimToken = generateSecureToken();

	const stmt = db.prepare(
		`UPDATE pending_clarifications
		 SET claim_token = ?,
		     claimed_at = ?
		 WHERE telegram_user_id = ?
		   AND expires_at >= ?
		   AND (
		     claim_token IS NULL
		     OR claimed_at IS NULL
		     OR claimed_at < ?
		   )`
	).bind(claimToken, now, uid, now, leaseThreshold);

	const info = await stmt.run();
	const changes = info.meta?.changes ?? 0;

	if (changes !== 1) {
		return {
			success: false,
			claimToken: null,
			reason: "NOT_FOUND_OR_ALREADY_CLAIMED_OR_EXPIRED",
		};
	}

	// Strictly verify that the currently stored record matches both uid and our claimToken
	const row = await db.prepare(
		`SELECT telegram_user_id, clarification_id, action_type, payload,
		        claim_token, claimed_at, created_at, expires_at
		 FROM pending_clarifications
		 WHERE telegram_user_id = ? AND claim_token = ?`
	).bind(uid, claimToken).first();

	if (!row || row.claim_token !== claimToken) {
		return {
			success: false,
			claimToken: null,
			reason: "CLAIM_SUPERSEDED_OR_LOST",
		};
	}

	let parsedPayload = null;
	try {
		parsedPayload = JSON.parse(row.payload);
		validateClarificationPayload(row.action_type, parsedPayload);
	} catch (err) {
		return {
			success: false,
			claimToken: null,
			reason: "CORRUPTED_PAYLOAD",
		};
	}

	return {
		success: true,
		claimToken,
		claimedAt: Number(row.claimed_at),
		clarification: {
			clarificationId: row.clarification_id,
			userId: row.telegram_user_id,
			actionType: row.action_type,
			payload: parsedPayload,
			claimToken: row.claim_token,
			claimedAt: Number(row.claimed_at),
			createdAt: Number(row.created_at),
			expiresAt: Number(row.expires_at),
		},
	};
}

/**
 * Checks whether the specified worker currently owns a valid, active claim lease.
 * @param {D1Database} db
 * @param {string} userId
 * @param {string} claimToken
 * @param {number} [leaseMs=15000]
 * @returns {Promise<boolean>}
 */
export async function isClaimOwner(db, userId, claimToken, leaseMs = 15000) {
	ensureDb(db);
	await ensurePendingClarificationsTable(db);

	const uid = String(userId || "").trim();
	const token = String(claimToken || "").trim();
	if (!uid || !token) return false;

	const now = Date.now();
	const leaseDuration = Math.max(1000, Number(leaseMs) || 15000);
	const minClaimedAt = now - leaseDuration;

	const stmt = db.prepare(
		`SELECT telegram_user_id, clarification_id, claim_token, claimed_at, expires_at
		 FROM pending_clarifications
		 WHERE telegram_user_id = ?
		   AND claim_token = ?
		   AND claimed_at IS NOT NULL
		   AND claimed_at >= ?
		   AND claimed_at <= ?
		   AND expires_at >= ?`
	).bind(uid, token, minClaimedAt, now, now);

	const row = await stmt.first();
	return Boolean(row);
}

/**
 * Releases a held claim so another worker can claim it immediately without waiting for lease timeout.
 * Operates only if caller provides the matching active claim_token within active lease window.
 * @param {D1Database} db
 * @param {string} userId
 * @param {string} claimToken
 * @param {number} [leaseMs=15000]
 * @returns {Promise<boolean>} True if released, false if not owner, expired, or replaced
 */
export async function releasePendingClarification(db, userId, claimToken, leaseMs = 15000) {
	ensureDb(db);
	await ensurePendingClarificationsTable(db);

	const uid = String(userId || "").trim();
	const token = String(claimToken || "").trim();
	if (!uid || !token) return false;

	const now = Date.now();
	const leaseDuration = Math.max(1000, Number(leaseMs) || 15000);
	const minClaimedAt = now - leaseDuration;

	const stmt = db.prepare(
		`UPDATE pending_clarifications
		 SET claim_token = NULL,
		     claimed_at = NULL
		 WHERE telegram_user_id = ?
		   AND claim_token = ?
		   AND claimed_at IS NOT NULL
		   AND claimed_at >= ?
		   AND claimed_at <= ?
		   AND expires_at >= ?`
	).bind(uid, token, minClaimedAt, now, now);

	const info = await stmt.run();
	return (info.meta?.changes ?? 0) === 1;
}

/**
 * Deletes the pending clarification upon successful processing.
 * Strictly gated by telegram_user_id, claim_token, active lease window, and unexpired TTL.
 * Prevents stale, replaced, or revoked workers from consuming the record.
 * @param {D1Database} db
 * @param {string} userId
 * @param {string} claimToken
 * @param {number} [leaseMs=15000]
 * @returns {Promise<boolean>} True if consumed, false if unauthorized, stale, or not found
 */
export async function consumePendingClarification(db, userId, claimToken, leaseMs = 15000) {
	ensureDb(db);
	await ensurePendingClarificationsTable(db);

	const uid = String(userId || "").trim();
	const token = String(claimToken || "").trim();
	if (!uid || !token) return false;

	const now = Date.now();
	const leaseDuration = Math.max(1000, Number(leaseMs) || 15000);
	const minClaimedAt = now - leaseDuration;

	const stmt = db.prepare(
		`DELETE FROM pending_clarifications
		 WHERE telegram_user_id = ?
		   AND claim_token = ?
		   AND claimed_at IS NOT NULL
		   AND claimed_at >= ?
		   AND claimed_at <= ?
		   AND expires_at >= ?`
	).bind(uid, token, minClaimedAt, now, now);

	const info = await stmt.run();
	return (info.meta?.changes ?? 0) === 1;
}

/**
 * Clears/cancels the pending clarification for a user directly (e.g. user sent cancel).
 * @param {D1Database} db
 * @param {string} userId
 * @returns {Promise<boolean>}
 */
export async function clearPendingClarification(db, userId) {
	ensureDb(db);
	await ensurePendingClarificationsTable(db);

	const uid = String(userId || "").trim();
	if (!uid) return false;

	const stmt = db.prepare(
		`DELETE FROM pending_clarifications WHERE telegram_user_id = ?`
	).bind(uid);

	const info = await stmt.run();
	return (info.meta?.changes ?? 0) > 0;
}

/**
 * Removes all expired pending clarifications across all users.
 * @param {D1Database} db
 * @returns {Promise<number>} Number of deleted rows
 */
export async function clearExpiredClarifications(db) {
	ensureDb(db);
	await ensurePendingClarificationsTable(db);

	const now = Date.now();
	const stmt = db.prepare(
		`DELETE FROM pending_clarifications WHERE expires_at < ?`
	).bind(now);

	const info = await stmt.run();
	return info.meta?.changes ?? 0;
}
