// Persistence for trajectory events and prompt segments.
//
// Events hang off `chatHistorySegment.trajectory_json`; whole-segment deletion is handled by the
// foreign-key lifecycle, but branching and in-segment edit-resend still require explicit pruning,
// with the relevant logic in trajectory_lifecycle.rs.
//
// Appends do not deduplicate events: the read side's `buildTrajectoryLedger` converges
// idempotently by event identity. A single append runs inside a SQLite transaction to avoid
// concurrent read-modify-write silently overwriting.

use sha2::{Digest as TrajectoryDigest, Sha256 as TrajectorySha256};
use std::collections::HashSet as TrajectorySectionIdSet;

/// Per-segment event limit; once exceeded, further appends are rejected.
///
/// A normal long turn is around 150 entries / 18 KB, so this limit leaves two orders of
/// magnitude of headroom; it exists only to stop runaway instrumentation (for example, a loop
/// repeatedly emitting the same entry) from growing the database without bound.
const TRAJECTORY_MAX_EVENTS_BYTES: usize = 8 * 1024 * 1024;

/// Limit for a single prompt segment. The memory overview itself has a 16 KB cap, and a
/// serialized tool catalog is usually tens of KB; 1 MB is enough to hold an exceptionally large
/// system prompt without running away.
const TRAJECTORY_MAX_SECTION_BYTES: usize = 1024 * 1024;
/// SYSTEM details need current+previous request slots; 64 leaves ample room while
/// preventing an authenticated client from constructing an unbounded SQLite IN query.
const TRAJECTORY_MAX_SECTION_REQUESTS: usize = 64;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrajectorySectionInput {
    pub section_id: String,
    pub slot: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrajectorySectionRecord {
    pub section_id: String,
    pub slot: String,
    pub content: String,
    pub bytes: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrajectoryEventsResponse {
    pub conversation_id: String,
    /// Flat JSON array text of all conversation events; `[]` when there are no records.
    pub events_json: String,
    pub segment_count: i64,
    /// Whether any segment stopped recording because it hit the limit; the UI uses this to indicate an incomplete trajectory.
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrajectoryAppendResult {
    pub stored_bytes: i64,
    /// true means these events were rejected by the limit and nothing was written.
    pub truncated: bool,
}

fn parse_event_array(raw: &str, label: &str) -> Result<Vec<Value>, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let parsed: Value =
        serde_json::from_str(trimmed).map_err(|e| format!("Failed to parse {label}: {e}"))?;
    match parsed {
        Value::Array(items) => Ok(items),
        _ => Err(format!("{label} must be a JSON array")),
    }
}

/// Append events to the specified segment.
///
/// Returns an error when the segment does not exist rather than silently creating one: the
/// trajectory always follows an existing message segment, and creating one out of thin air would
/// produce an orphan trajectory with no message.
fn append_trajectory_events_sync(
    conn: &Connection,
    conversation_id: &str,
    segment_index: i64,
    events_json: &str,
) -> Result<TrajectoryAppendResult, String> {
    let incoming = parse_event_array(events_json, "trajectory events")?;
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("Failed to begin trajectory append transaction: {e}"))?;
    let existing: Option<(String, i64)> = tx
        .query_row(
            "SELECT trajectory_json, trajectory_truncated FROM chatHistorySegment
             WHERE conversation_id = ?1 AND segment_index = ?2",
            params![conversation_id, segment_index],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|e| format!("Failed to read segment trajectory: {e}"))?;
    let Some((existing_raw, existing_truncated)) = existing else {
        return Err(format!(
            "Segment does not exist: conversation={conversation_id} segment={segment_index}"
        ));
    };

    if incoming.is_empty() || existing_truncated != 0 {
        tx.commit()
            .map_err(|e| format!("Failed to commit empty trajectory append transaction: {e}"))?;
        return Ok(TrajectoryAppendResult {
            stored_bytes: existing_raw.len() as i64,
            truncated: existing_truncated != 0,
        });
    }

    let mut merged = match parse_event_array(&existing_raw, "stored trajectory events") {
        Ok(events) => events,
        Err(_) => {
            tx.execute(
                "UPDATE chatHistorySegment SET trajectory_truncated = 1
                 WHERE conversation_id = ?1 AND segment_index = ?2",
                params![conversation_id, segment_index],
            )
            .map_err(|e| format!("Failed to mark corrupted trajectory segment: {e}"))?;
            tx.commit()
                .map_err(|e| format!("Failed to commit corrupted trajectory segment mark: {e}"))?;
            return Ok(TrajectoryAppendResult {
                stored_bytes: existing_raw.len() as i64,
                truncated: true,
            });
        }
    };
    merged.extend(incoming);
    let serialized =
        serde_json::to_string(&merged).map_err(|e| format!("Failed to serialize trajectory events: {e}"))?;

    if serialized.len() > TRAJECTORY_MAX_EVENTS_BYTES {
        // The truncation flag must be persisted; otherwise, after a restart the read side would misreport an incomplete trajectory as complete.
        tx.execute(
            "UPDATE chatHistorySegment SET trajectory_truncated = 1
             WHERE conversation_id = ?1 AND segment_index = ?2",
            params![conversation_id, segment_index],
        )
        .map_err(|e| format!("Failed to mark segment trajectory truncation: {e}"))?;
        tx.commit()
            .map_err(|e| format!("Failed to commit trajectory truncation mark: {e}"))?;
        return Ok(TrajectoryAppendResult {
            stored_bytes: existing_raw.len() as i64,
            truncated: true,
        });
    }

    tx.execute(
        "UPDATE chatHistorySegment
         SET trajectory_json = ?3
         WHERE conversation_id = ?1 AND segment_index = ?2",
        params![conversation_id, segment_index, serialized],
    )
    .map_err(|e| format!("Failed to write segment trajectory: {e}"))?;
    tx.commit()
        .map_err(|e| format!("Failed to commit trajectory append transaction: {e}"))?;

    Ok(TrajectoryAppendResult {
        stored_bytes: serialized.len() as i64,
        truncated: false,
    })
}

fn load_trajectory_events_sync(
    conn: &Connection,
    conversation_id: &str,
) -> Result<TrajectoryEventsResponse, String> {
    let mut stmt = conn
        .prepare(
            "SELECT trajectory_json, trajectory_truncated FROM chatHistorySegment
             WHERE conversation_id = ?1
             ORDER BY segment_index ASC",
        )
        .map_err(|e| format!("Failed to prepare trajectory query: {e}"))?;
    let rows = stmt
        .query_map(params![conversation_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .map_err(|e| format!("Failed to query trajectory: {e}"))?;

    let mut events: Vec<Value> = Vec::new();
    let mut segment_count = 0_i64;
    let mut truncated = false;
    for row in rows {
        let (raw, segment_truncated) = row.map_err(|e| format!("Failed to read trajectory row: {e}"))?;
        segment_count += 1;
        truncated |= segment_truncated != 0;
        match parse_event_array(&raw, "trajectory events") {
            Ok(items) => events.extend(items),
            Err(_) => {
                // A single corrupted segment only degrades that segment; the others are returned as usual.
                truncated = true;
            }
        }
    }

    backfill_legacy_trajectory_user_ids(conn, conversation_id, &mut events)?;
    let events_json =
        serde_json::to_string(&events).map_err(|e| format!("Failed to serialize trajectory events: {e}"))?;
    Ok(TrajectoryEventsResponse {
        conversation_id: conversation_id.to_string(),
        events_json,
        segment_count,
        truncated,
    })
}

fn resolve_trajectory_turn_number_sync(
    conn: &Connection,
    conversation_id: &str,
    current_user_persisted: bool,
) -> Result<i64, String> {
    let total_message_count = conn
        .query_row(
            "SELECT total_message_count FROM chatHistory WHERE id = ?1",
            params![conversation_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|e| format!("Failed to read conservative trajectory turn count: {e}"))?
        .unwrap_or(0)
        .max(0);
    let mut stmt = conn
        .prepare(
            "SELECT messages_json, trajectory_json FROM chatHistorySegment
             WHERE conversation_id = ?1 ORDER BY segment_index ASC",
        )
        .map_err(|e| format!("Failed to prepare trajectory turn resolution: {e}"))?;
    let rows = stmt
        .query_map(params![conversation_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| format!("Failed to query trajectory turn resolution: {e}"))?;
    let mut user_turns = 0_i64;
    let mut max_event_turn = 0_i64;
    let mut messages_complete = true;
    for row in rows {
        let (messages_raw, trajectory_raw) =
            row.map_err(|e| format!("Failed to read trajectory turn segment: {e}"))?;
        match parse_event_array(&messages_raw, "history segment messages") {
            Ok(messages) => {
                for message in messages {
                    if message
                        .as_object()
                        .and_then(|object| object.get("role"))
                        .and_then(Value::as_str)
                        == Some("user")
                    {
                        user_turns = user_turns.saturating_add(1);
                    }
                }
            }
            Err(_) => messages_complete = false,
        }
        if let Ok(events) = parse_event_array(&trajectory_raw, "trajectory events") {
            for turn in events.iter().filter_map(|event| {
                event
                    .as_object()
                    .and_then(|object| object.get("t"))
                    .and_then(Value::as_i64)
                    .filter(|turn| *turn > 0)
            }) {
                max_event_turn = max_event_turn.max(turn);
            }
        }
    }
    if !messages_complete {
        user_turns = user_turns.max(total_message_count);
    }
    let user_count_candidate = user_turns.saturating_add(i64::from(!current_user_persisted));
    Ok(1_i64
        .max(user_count_candidate)
        .max(max_event_turn.saturating_add(1)))
}

const TRAJECTORY_SECTION_SLOT_NAMES: [&str; 7] = [
    "base",
    "agent",
    "skills",
    "memory",
    "toolsSuffix",
    "toolCatalog",
    "runtime",
];

fn expected_trajectory_section_id(content: &str) -> String {
    let digest = TrajectorySha256::digest(content.as_bytes());
    let prefix = digest[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("s_{prefix}")
}

fn validate_trajectory_section(section: &TrajectorySectionInput) -> Result<(), String> {
    let section_id = section.section_id.trim();
    if section_id.is_empty() {
        return Err("Segment id cannot be empty".to_string());
    }
    let expected = expected_trajectory_section_id(&section.content);
    if section_id != expected {
        return Err(format!("Trajectory section id does not match the content SHA-256: {section_id}"));
    }
    if !TRAJECTORY_SECTION_SLOT_NAMES.contains(&section.slot.as_str()) {
        return Err(format!("Unknown trajectory section slot: {}", section.slot));
    }
    Ok(())
}

fn put_trajectory_sections_sync(
    conn: &Connection,
    conversation_id: &str,
    sections: &[TrajectorySectionInput],
) -> Result<i64, String> {
    if sections.is_empty() {
        return Ok(0);
    }
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("Failed to begin trajectory section transaction: {e}"))?;
    let now = now_ms();
    let mut stored = 0_i64;
    for section in sections {
        validate_trajectory_section(section)?;
        if section.content.len() > TRAJECTORY_MAX_SECTION_BYTES {
            // Missing details are an acceptable diagnostic degradation; the event skeleton can still be written and viewed.
            continue;
        }
        let section_id = section.section_id.trim();
        let affected = tx
            .execute(
                "INSERT OR IGNORE INTO chatTrajectorySection
                 (conversation_id, section_id, slot, content, bytes, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    conversation_id,
                    section_id,
                    section.slot,
                    section.content,
                    section.content.len() as i64,
                    now
                ],
            )
            .map_err(|e| format!("Failed to write trajectory section: {e}"))?;
        if affected == 0 {
            let existing: Option<String> = tx
                .query_row(
                    "SELECT content FROM chatTrajectorySection
                     WHERE conversation_id = ?1 AND section_id = ?2",
                    params![conversation_id, section_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|e| format!("Failed to check trajectory section conflict: {e}"))?;
            // section_id addresses content only. The same exact text may
            // legally occupy multiple prompt slots; refs carry slot position.
            if existing.as_deref() != Some(section.content.as_str()) {
                return Err(format!("Trajectory section content-addressing conflict: {section_id}"));
            }
        }
        stored += affected as i64;
    }
    tx.commit()
        .map_err(|e| format!("Failed to commit trajectory section transaction: {e}"))?;
    Ok(stored)
}

fn get_trajectory_sections_sync(
    conn: &Connection,
    conversation_id: &str,
    section_ids: &[String],
) -> Result<Vec<TrajectorySectionRecord>, String> {
    if section_ids.is_empty() {
        return Ok(Vec::new());
    }
    let mut seen = TrajectorySectionIdSet::new();
    let mut unique_ids = Vec::new();
    for id in section_ids {
        let id = id.trim();
        if id.is_empty() || !seen.insert(id.to_string()) {
            continue;
        }
        unique_ids.push(id.to_string());
        if unique_ids.len() > TRAJECTORY_MAX_SECTION_REQUESTS {
            return Err(format!(
                "Too many trajectory section requests: at most {TRAJECTORY_MAX_SECTION_REQUESTS}"
            ));
        }
    }
    if unique_ids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = std::iter::repeat_n("?", unique_ids.len())
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT section_id, slot, content, bytes FROM chatTrajectorySection
         WHERE conversation_id = ?1 AND section_id IN ({placeholders})"
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("Failed to prepare trajectory section query: {e}"))?;
    let mut bindings: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(unique_ids.len() + 1);
    bindings.push(&conversation_id);
    for id in &unique_ids {
        bindings.push(id);
    }
    let rows = stmt
        .query_map(bindings.as_slice(), |row| {
            Ok(TrajectorySectionRecord {
                section_id: row.get("section_id")?,
                slot: row.get("slot")?,
                content: row.get("content")?,
                bytes: row.get("bytes")?,
            })
        })
        .map_err(|e| format!("Failed to query trajectory sections: {e}"))?;

    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| format!("Failed to read trajectory section row: {e}"))?);
    }
    Ok(out)
}

#[tauri::command]
pub async fn trajectory_append_events(
    conversation_id: String,
    segment_index: i64,
    events_json: String,
) -> Result<TrajectoryAppendResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db()?;
        append_trajectory_events_sync(&conn, &conversation_id, segment_index, &events_json)
    })
    .await
    .map_err(|e| format!("trajectory_append_events join failed: {e}"))?
}

#[tauri::command]
pub async fn trajectory_get_events(
    conversation_id: String,
) -> Result<TrajectoryEventsResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db()?;
        load_trajectory_events_sync(&conn, &conversation_id)
    })
    .await
    .map_err(|e| format!("trajectory_get_events join failed: {e}"))?
}

#[tauri::command]
pub async fn trajectory_resolve_turn_number(
    conversation_id: String,
    current_user_persisted: bool,
) -> Result<i64, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db()?;
        resolve_trajectory_turn_number_sync(&conn, &conversation_id, current_user_persisted)
    })
    .await
    .map_err(|e| format!("trajectory_resolve_turn_number join failed: {e}"))?
}

#[tauri::command]
pub async fn trajectory_put_sections(
    conversation_id: String,
    sections: Vec<TrajectorySectionInput>,
) -> Result<i64, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db()?;
        put_trajectory_sections_sync(&conn, &conversation_id, &sections)
    })
    .await
    .map_err(|e| format!("trajectory_put_sections join failed: {e}"))?
}

#[tauri::command]
pub async fn trajectory_get_sections(
    conversation_id: String,
    section_ids: Vec<String>,
) -> Result<Vec<TrajectorySectionRecord>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db()?;
        get_trajectory_sections_sync(&conn, &conversation_id, &section_ids)
    })
    .await
    .map_err(|e| format!("trajectory_get_sections join failed: {e}"))?
}

#[cfg(test)]
mod trajectory_tests {
    use super::*;

    fn open_trajectory_db() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory trajectory database");
        history_db::initialize_connection(&conn).expect("initialize trajectory schema");
        conn
    }

    fn seed_conversation(conn: &Connection, id: &str, segment_indexes: &[i64]) {
        conn.execute(
            "INSERT INTO chatHistory
             (id, title, provider_id, model, context_meta_json, active_segment_index,
              total_segment_count, total_message_count, created_at, updated_at)
             VALUES (?1, 'T', 'codex', 'gpt-5', '{}', 0, ?2, 0, 1, 1)",
            params![id, segment_indexes.len() as i64],
        )
        .expect("seed conversation");
        for index in segment_indexes {
            conn.execute(
                "INSERT INTO chatHistorySegment
                 (conversation_id, segment_index, segment_id, messages_json, message_count,
                  created_at, updated_at)
                 VALUES (?1, ?2, ?3, '[]', 0, 1, 1)",
                params![id, index, format!("seg-{index}")],
            )
            .expect("seed segment");
        }
    }

    fn trajectory_raw(conn: &Connection, id: &str, segment_index: i64) -> String {
        conn.query_row(
            "SELECT trajectory_json FROM chatHistorySegment
             WHERE conversation_id = ?1 AND segment_index = ?2",
            params![id, segment_index],
            |row| row.get(0),
        )
        .expect("read trajectory column")
    }

    #[test]
    fn migration_adds_the_segment_column_and_section_table() {
        let conn = open_trajectory_db();
        let mut stmt = conn
            .prepare("PRAGMA table_info(chatHistorySegment)")
            .expect("prepare pragma");
        let columns: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .expect("query pragma")
            .map(|row| row.expect("read column"))
            .collect();
        assert!(columns.iter().any(|column| column == "trajectory_json"));
        assert!(columns
            .iter()
            .any(|column| column == "trajectory_truncated"));

        let table_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='chatTrajectorySection'",
                [],
                |row| row.get(0),
            )
            .expect("query sqlite_master");
        assert_eq!(table_count, 1);
    }

    #[test]
    fn a_fresh_segment_starts_with_an_empty_event_array() {
        let conn = open_trajectory_db();
        seed_conversation(&conn, "c1", &[0]);
        assert_eq!(trajectory_raw(&conn, "c1", 0), "[]");
        let loaded = load_trajectory_events_sync(&conn, "c1").expect("load events");
        assert_eq!(loaded.events_json, "[]");
        assert_eq!(loaded.segment_count, 1);
        assert!(!loaded.truncated);
    }

    #[test]
    fn appends_accumulate_in_order_across_calls() {
        let conn = open_trajectory_db();
        seed_conversation(&conn, "c1", &[0]);
        append_trajectory_events_sync(&conn, "c1", 0, r#"[{"k":"user","t":1,"at":10}]"#)
            .expect("first append");
        append_trajectory_events_sync(
            &conn,
            "c1",
            0,
            r#"[{"k":"step_start","t":1,"s":1,"at":20}]"#,
        )
        .expect("second append");

        let loaded = load_trajectory_events_sync(&conn, "c1").expect("load events");
        let events: Vec<Value> = serde_json::from_str(&loaded.events_json).expect("parse events");
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["k"], "user");
        assert_eq!(events[1]["k"], "step_start");
    }

    #[test]
    fn events_are_concatenated_in_segment_order() {
        let conn = open_trajectory_db();
        seed_conversation(&conn, "c1", &[0, 1]);
        append_trajectory_events_sync(&conn, "c1", 1, r#"[{"k":"turn_end","t":2,"at":90}]"#)
            .expect("append later segment");
        append_trajectory_events_sync(&conn, "c1", 0, r#"[{"k":"user","t":1,"at":10}]"#)
            .expect("append earlier segment");

        let loaded = load_trajectory_events_sync(&conn, "c1").expect("load events");
        let events: Vec<Value> = serde_json::from_str(&loaded.events_json).expect("parse events");
        assert_eq!(events[0]["k"], "user");
        assert_eq!(events[1]["k"], "turn_end");
        assert_eq!(loaded.segment_count, 2);
    }

    #[test]
    fn appending_to_a_missing_segment_is_an_error_not_a_silent_create() {
        let conn = open_trajectory_db();
        seed_conversation(&conn, "c1", &[0]);
        let error = append_trajectory_events_sync(&conn, "c1", 7, r#"[{"k":"user","t":1,"at":1}]"#)
            .expect_err("missing segment must fail");
        assert!(error.contains("Segment does not exist"));
    }

    #[test]
    fn a_non_array_payload_is_rejected() {
        let conn = open_trajectory_db();
        seed_conversation(&conn, "c1", &[0]);
        assert!(append_trajectory_events_sync(&conn, "c1", 0, r#"{"k":"user"}"#).is_err());
        assert!(append_trajectory_events_sync(&conn, "c1", 0, "not json").is_err());
    }

    #[test]
    fn an_empty_batch_leaves_storage_untouched() {
        let conn = open_trajectory_db();
        seed_conversation(&conn, "c1", &[0]);
        append_trajectory_events_sync(&conn, "c1", 0, r#"[{"k":"user","t":1,"at":10}]"#)
            .expect("seed one event");
        let before = trajectory_raw(&conn, "c1", 0);
        append_trajectory_events_sync(&conn, "c1", 0, "[]").expect("empty append");
        assert_eq!(trajectory_raw(&conn, "c1", 0), before);
    }

    #[test]
    fn a_corrupt_segment_degrades_alone_and_is_reported() {
        let conn = open_trajectory_db();
        seed_conversation(&conn, "c1", &[0, 1]);
        append_trajectory_events_sync(&conn, "c1", 0, r#"[{"k":"user","t":1,"at":10}]"#)
            .expect("append good segment");
        conn.execute(
            "UPDATE chatHistorySegment SET trajectory_json = '{oops'
             WHERE conversation_id = 'c1' AND segment_index = 1",
            [],
        )
        .expect("corrupt segment");

        let loaded = load_trajectory_events_sync(&conn, "c1").expect("load events");
        let events: Vec<Value> = serde_json::from_str(&loaded.events_json).expect("parse events");
        assert_eq!(events.len(), 1);
        assert!(loaded.truncated);
    }

    #[test]
    fn appending_to_a_corrupt_segment_marks_it_truncated_without_overwriting_it() {
        let conn = open_trajectory_db();
        seed_conversation(&conn, "c1", &[0]);
        conn.execute(
            "UPDATE chatHistorySegment SET trajectory_json = '{oops' WHERE conversation_id = 'c1'",
            [],
        )
        .expect("corrupt trajectory");
        let result =
            append_trajectory_events_sync(&conn, "c1", 0, r#"[{"k":"user","t":1,"at":10}]"#)
                .expect("diagnostic append degrades");
        assert!(result.truncated);
        assert_eq!(trajectory_raw(&conn, "c1", 0), "{oops");
        let flag: i64 = conn
            .query_row(
                "SELECT trajectory_truncated FROM chatHistorySegment WHERE conversation_id = 'c1'",
                [],
                |row| row.get(0),
            )
            .expect("read truncation flag");
        assert_eq!(flag, 1);
    }

    #[test]
    fn oversized_batches_are_refused_without_losing_existing_events() {
        let conn = open_trajectory_db();
        seed_conversation(&conn, "c1", &[0]);
        append_trajectory_events_sync(&conn, "c1", 0, r#"[{"k":"user","t":1,"at":10}]"#)
            .expect("seed one event");
        let huge = format!(
            r#"[{{"k":"context","t":1,"at":1,"tx":"{}"}}]"#,
            "x".repeat(TRAJECTORY_MAX_EVENTS_BYTES + 1)
        );
        let result =
            append_trajectory_events_sync(&conn, "c1", 0, &huge).expect("oversized append");
        assert!(result.truncated);

        let loaded = load_trajectory_events_sync(&conn, "c1").expect("load events");
        let events: Vec<Value> = serde_json::from_str(&loaded.events_json).expect("parse events");
        assert_eq!(
            events.len(),
            1,
            "existing events must survive a refused append"
        );
    }

    fn section(slot: &str, content: &str) -> TrajectorySectionInput {
        TrajectorySectionInput {
            section_id: expected_trajectory_section_id(content),
            slot: slot.to_string(),
            content: content.to_string(),
        }
    }

    #[test]
    fn sections_are_idempotent_by_content_address() {
        let conn = open_trajectory_db();
        seed_conversation(&conn, "c1", &[0]);
        let stored = put_trajectory_sections_sync(
            &conn,
            "c1",
            &[section("base", "BASE"), section("memory", "MEM")],
        )
        .expect("first put");
        assert_eq!(stored, 2);

        let again = put_trajectory_sections_sync(&conn, "c1", &[section("base", "BASE")])
            .expect("second put");
        assert_eq!(again, 0);

        let rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM chatTrajectorySection WHERE conversation_id = 'c1'",
                [],
                |row| row.get(0),
            )
            .expect("count sections");
        assert_eq!(rows, 2);
    }

    #[test]
    fn only_requested_sections_come_back_and_bytes_are_recorded() {
        let conn = open_trajectory_db();
        seed_conversation(&conn, "c1", &[0]);
        put_trajectory_sections_sync(
            &conn,
            "c1",
            &[section("base", "BASE"), section("memory", "MEM")],
        )
        .expect("put sections");

        let memory_id = expected_trajectory_section_id("MEM");
        let fetched = get_trajectory_sections_sync(
            &conn,
            "c1",
            &[memory_id.clone(), "s_0000000000000000".to_string()],
        )
        .expect("get sections");
        assert_eq!(fetched.len(), 1);
        assert_eq!(fetched[0].section_id, memory_id);
        assert_eq!(fetched[0].slot, "memory");
        assert_eq!(fetched[0].content, "MEM");
        assert_eq!(fetched[0].bytes, 3);

        assert!(get_trajectory_sections_sync(&conn, "c1", &[])
            .expect("empty request")
            .is_empty());
    }

    #[test]
    fn section_reads_deduplicate_ids_and_reject_unbounded_requests() {
        let conn = open_trajectory_db();
        seed_conversation(&conn, "c1", &[0]);
        put_trajectory_sections_sync(&conn, "c1", &[section("base", "BASE")]).expect("put section");
        let id = expected_trajectory_section_id("BASE");
        let fetched =
            get_trajectory_sections_sync(&conn, "c1", &[id.clone(), id.clone(), "  ".to_string()])
                .expect("deduplicated read");
        assert_eq!(fetched.len(), 1);

        let too_many = (0..=TRAJECTORY_MAX_SECTION_REQUESTS)
            .map(|index| format!("s_{index:016x}"))
            .collect::<Vec<_>>();
        assert!(get_trajectory_sections_sync(&conn, "c1", &too_many).is_err());
    }

    #[test]
    fn an_empty_section_id_is_rejected() {
        let conn = open_trajectory_db();
        seed_conversation(&conn, "c1", &[0]);
        assert!(put_trajectory_sections_sync(
            &conn,
            "c1",
            &[TrajectorySectionInput {
                section_id: "  ".to_string(),
                slot: "base".to_string(),
                content: "X".to_string(),
            }],
        )
        .is_err());
    }

    #[test]
    fn an_oversized_section_is_skipped_rather_than_stored() {
        let conn = open_trajectory_db();
        seed_conversation(&conn, "c1", &[0]);
        let huge = "x".repeat(TRAJECTORY_MAX_SECTION_BYTES + 1);
        let stored = put_trajectory_sections_sync(&conn, "c1", &[section("base", &huge)])
            .expect("put oversized section");
        assert_eq!(stored, 0);
        let huge_id = expected_trajectory_section_id(&huge);
        assert!(get_trajectory_sections_sync(&conn, "c1", &[huge_id])
            .expect("get sections")
            .is_empty());
    }

    #[test]
    fn sections_are_scoped_per_conversation() {
        let conn = open_trajectory_db();
        seed_conversation(&conn, "c1", &[0]);
        seed_conversation(&conn, "c2", &[0]);
        put_trajectory_sections_sync(&conn, "c1", &[section("base", "ONE")]).expect("put c1");
        put_trajectory_sections_sync(&conn, "c2", &[section("base", "TWO")]).expect("put c2");

        let one_id = expected_trajectory_section_id("ONE");
        let two_id = expected_trajectory_section_id("TWO");
        assert!(get_trajectory_sections_sync(&conn, "c2", &[one_id])
            .expect("c1 section must not leak")
            .is_empty());
        let from_c2 = get_trajectory_sections_sync(&conn, "c2", &[two_id]).expect("get from c2");
        assert_eq!(from_c2[0].content, "TWO");
    }

    #[test]
    fn identical_content_can_be_reused_across_prompt_slots() {
        let conn = open_trajectory_db();
        seed_conversation(&conn, "c1", &[0]);
        let stored = put_trajectory_sections_sync(
            &conn,
            "c1",
            &[section("base", "SHARED"), section("memory", "SHARED")],
        )
        .expect("reuse content across slots");
        assert_eq!(stored, 1);
        let id = expected_trajectory_section_id("SHARED");
        let fetched =
            get_trajectory_sections_sync(&conn, "c1", &[id]).expect("read shared section");
        assert_eq!(fetched.len(), 1);
        assert_eq!(fetched[0].content, "SHARED");
    }

    #[test]
    fn resolves_turn_from_user_count_across_all_segments() {
        let conn = open_trajectory_db();
        seed_conversation(&conn, "c1", &[0, 1]);
        conn.execute(
            "UPDATE chatHistorySegment SET messages_json = ?3, message_count = 3
             WHERE conversation_id = ?1 AND segment_index = ?2",
            params![
                "c1",
                0,
                r#"[{"role":"user"},{"role":"assistant"},{"role":"user"}]"#
            ],
        )
        .expect("seed first messages");
        conn.execute(
            "UPDATE chatHistorySegment SET messages_json = ?3, message_count = 2
             WHERE conversation_id = ?1 AND segment_index = ?2",
            params!["c1", 1, r#"[{"role":"assistant"},{"role":"user"}]"#],
        )
        .expect("seed second messages");
        assert_eq!(
            resolve_trajectory_turn_number_sync(&conn, "c1", false).unwrap(),
            4
        );
        assert_eq!(
            resolve_trajectory_turn_number_sync(&conn, "c1", true).unwrap(),
            3
        );
    }

    #[test]
    fn persisted_event_turn_keeps_future_turns_monotonic_after_a_fallback() {
        let conn = open_trajectory_db();
        seed_conversation(&conn, "c1", &[0]);
        conn.execute(
            "UPDATE chatHistorySegment SET messages_json = ?3, message_count = 3,
             trajectory_json = ?4 WHERE conversation_id = ?1 AND segment_index = ?2",
            params![
                "c1",
                0,
                r#"[{"role":"user"},{"role":"assistant"},{"role":"user"}]"#,
                r#"[{"k":"user","t":21,"at":10},{"k":"turn_end","t":21,"at":20}]"#
            ],
        )
        .expect("seed fallback trajectory turn");

        assert_eq!(
            resolve_trajectory_turn_number_sync(&conn, "c1", false).unwrap(),
            22
        );
    }

    #[test]
    fn malformed_messages_use_total_message_count_as_a_conservative_candidate() {
        let conn = open_trajectory_db();
        seed_conversation(&conn, "c1", &[0]);
        conn.execute(
            "UPDATE chatHistory SET total_message_count = 17 WHERE id = 'c1'",
            [],
        )
        .expect("seed total message count");
        conn.execute(
            "UPDATE chatHistorySegment SET messages_json = '{oops', message_count = 17
             WHERE conversation_id = 'c1' AND segment_index = 0",
            [],
        )
        .expect("seed malformed messages");

        assert_eq!(
            resolve_trajectory_turn_number_sync(&conn, "c1", false).unwrap(),
            18
        );
    }

    #[test]
    fn deleting_a_conversation_reclaims_its_sections_and_events() {
        let conn = open_trajectory_db();
        seed_conversation(&conn, "c1", &[0]);
        append_trajectory_events_sync(&conn, "c1", 0, r#"[{"k":"user","t":1,"at":10}]"#)
            .expect("append events");
        put_trajectory_sections_sync(&conn, "c1", &[section("base", "BASE")])
            .expect("put sections");

        conn.execute("DELETE FROM chatHistory WHERE id = 'c1'", [])
            .expect("delete conversation");

        let sections: i64 = conn
            .query_row("SELECT COUNT(*) FROM chatTrajectorySection", [], |row| {
                row.get(0)
            })
            .expect("count sections");
        assert_eq!(sections, 0);
        let segments: i64 = conn
            .query_row("SELECT COUNT(*) FROM chatHistorySegment", [], |row| {
                row.get(0)
            })
            .expect("count segments");
        assert_eq!(segments, 0);
    }
}
