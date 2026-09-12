use rusqlite::{Connection, OptionalExtension};
use std::{collections::HashSet, fs, path::PathBuf, sync::Mutex, time::Duration};

const DB_FILENAME: &str = "chat-history.sqlite3";
const HISTORY_DB_SCHEMA_VERSION: i64 = 4;

static HISTORY_DB_MIGRATION_LOCK: Mutex<()> = Mutex::new(());

fn history_db_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "Unable to locate the user directory".to_string())?;
    let dir = home.join(format!(".{}", env!("CARGO_PKG_NAME")));
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create history directory: {e}"))?;
    Ok(dir)
}

pub(crate) fn open_connection() -> Result<Connection, String> {
    let db_path = history_db_dir()?.join(DB_FILENAME);
    let conn = Connection::open(db_path).map_err(|e| format!("Failed to open history database: {e}"))?;
    configure_connection(&conn)?;
    Ok(conn)
}

fn configure_connection(conn: &Connection) -> Result<(), String> {
    conn.busy_timeout(Duration::from_secs(5))
        .map_err(|e| format!("Failed to set SQLite busy_timeout: {e}"))?;
    conn.execute_batch("PRAGMA foreign_keys = ON;")
        .map_err(|e| format!("Failed to enable history database foreign keys: {e}"))?;
    Ok(())
}

pub(crate) fn initialize_history_db() -> Result<(), String> {
    let conn = open_connection()?;
    initialize_connection(&conn)
}

pub(crate) fn initialize_connection(conn: &Connection) -> Result<(), String> {
    let _guard = HISTORY_DB_MIGRATION_LOCK
        .lock()
        .map_err(|_| "History database migration lock is corrupted".to_string())?;
    configure_connection(conn)?;
    migrate_history_db(conn)
}

fn read_user_version(conn: &Connection) -> Result<i64, String> {
    conn.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
        .map_err(|e| format!("Failed to read history database version: {e}"))
}

fn set_user_version(conn: &Connection, version: i64) -> Result<(), String> {
    conn.execute_batch(&format!("PRAGMA user_version = {version};"))
        .map_err(|e| format!("Failed to update history database version: {e}"))
}

fn migrate_history_db(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("BEGIN IMMEDIATE;")
        .map_err(|e| format!("Failed to lock history database migration: {e}"))?;

    let result = migrate_history_db_inner(conn);
    match result {
        Ok(()) => conn
            .execute_batch("COMMIT;")
            .map_err(|e| format!("Failed to commit history database migration: {e}")),
        Err(error) => {
            let rollback = conn.execute_batch("ROLLBACK;");
            if let Err(rollback_error) = rollback {
                return Err(format!("{error}; failed to roll back history database migration: {rollback_error}"));
            }
            Err(error)
        }
    }
}

fn migrate_history_db_inner(conn: &Connection) -> Result<(), String> {
    let current_version = read_user_version(conn)?;
    if current_version > HISTORY_DB_SCHEMA_VERSION {
        return Err(format!(
            "History database version {current_version} is higher than the currently supported version {HISTORY_DB_SCHEMA_VERSION}"
        ));
    }

    if current_version < 1 {
        migrate_to_v1(conn)?;
        set_user_version(conn, 1)?;
    }

    if current_version < 2 {
        migrate_to_v2(conn)?;
        set_user_version(conn, 2)?;
    }

    if current_version < 3 {
        migrate_to_v3(conn)?;
        set_user_version(conn, 3)?;
    }

    if current_version < 4 {
        migrate_to_v4(conn)?;
        set_user_version(conn, 4)?;
    }

    // The subagent schema is versioned independently via subagentMeta and is
    // safe to (re)ensure on every startup.
    ensure_subagent_schema(conn)?;

    Ok(())
}

fn migrate_to_v1(conn: &Connection) -> Result<(), String> {
    ensure_chat_history_schema(conn)?;
    Ok(())
}

// v2: chatHistory gains selected_model_json (per-session model selection). schema ensure is
// itself idempotent, so re-running it backfills any missing column.
fn migrate_to_v2(conn: &Connection) -> Result<(), String> {
    ensure_chat_history_schema(conn)?;
    Ok(())
}

// v3: trajectory diagnostics. Existing v2 installations must receive the
// per-segment event columns and the content-addressed prompt section table.
fn migrate_to_v3(conn: &Connection) -> Result<(), String> {
    ensure_chat_history_schema(conn)?;
    Ok(())
}

// v4: drop the chatHistory.context_json left over from 1.x (NOT NULL with no default). That column
// has had no readers or writers since segment persistence shipped, but CREATE TABLE IF NOT EXISTS
// does not rebuild existing tables and column ensure only adds, never drops---old databases still
// carrying the column have every INSERT rejected by the NOT NULL constraint, all chat history / task
// list persistence fails, and trajectory segments then spam errors due to the foreign key (missing
// main-table row).
fn migrate_to_v4(conn: &Connection) -> Result<(), String> {
    ensure_chat_history_schema(conn)?;
    let columns = read_table_columns(conn, "chatHistory", "chatHistory")?;
    if columns.contains("context_json") {
        conn.execute_batch("ALTER TABLE chatHistory DROP COLUMN context_json;")
            .map_err(|e| format!("Failed to drop legacy chatHistory.context_json column: {e}"))?;
    }
    Ok(())
}

fn read_table_columns(
    conn: &Connection,
    table_name: &str,
    table_label: &str,
) -> Result<HashSet<String>, String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table_name})"))
        .map_err(|e| format!("Failed to read {table_label} structure: {e}"))?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| format!("Failed to query {table_label} structure: {e}"))?;
    let mut columns = HashSet::new();
    for row in rows {
        let column = row.map_err(|e| format!("Failed to read {table_label} column: {e}"))?;
        columns.insert(column.to_ascii_lowercase());
    }
    Ok(columns)
}

fn ensure_table_columns(
    conn: &Connection,
    table_name: &str,
    table_label: &str,
    migrations: &[(&str, &str)],
) -> Result<(), String> {
    let mut columns = read_table_columns(conn, table_name, table_label)?;

    for (column, ddl) in migrations {
        let column_key = column.to_ascii_lowercase();
        if columns.contains(&column_key) {
            continue;
        }

        match conn.execute_batch(ddl) {
            Ok(()) => {
                columns.insert(column_key);
            }
            Err(error) => {
                let refreshed_columns = read_table_columns(conn, table_name, table_label)?;
                if refreshed_columns.contains(&column_key) {
                    columns = refreshed_columns;
                    continue;
                }
                return Err(format!("Failed to migrate {table_label} column {column}: {error}"));
            }
        }
    }

    Ok(())
}

fn ensure_chat_history_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS chatHistory (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            provider_id TEXT NOT NULL,
            model TEXT NOT NULL,
            session_id TEXT,
            cwd TEXT,
            context_meta_json TEXT,
            active_segment_index INTEGER,
            total_segment_count INTEGER,
            total_message_count INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            is_pinned INTEGER NOT NULL DEFAULT 0,
            pinned_at INTEGER,
            selected_model_json TEXT
        );

        CREATE TABLE IF NOT EXISTS chatHistorySegment (
            conversation_id TEXT NOT NULL,
            segment_index INTEGER NOT NULL,
            segment_id TEXT NOT NULL,
            summary_json TEXT,
            messages_json TEXT NOT NULL,
            message_count INTEGER NOT NULL,
            start_message_id TEXT,
            end_message_id TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            trajectory_json TEXT NOT NULL DEFAULT '[]',
            trajectory_truncated INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (conversation_id, segment_index),
            UNIQUE (conversation_id, segment_id),
            FOREIGN KEY (conversation_id) REFERENCES chatHistory(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS chatHistoryShare (
            conversation_id TEXT PRIMARY KEY,
            token TEXT UNIQUE,
            enabled INTEGER NOT NULL DEFAULT 0,
            redact_tool_content INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY (conversation_id) REFERENCES chatHistory(id) ON DELETE CASCADE
        );

        -- Trajectory system prompt segment pool: content-addressed, isolated per session.
        -- Not sharing across sessions is deliberate: sharing would require reference counting to reclaim
        -- safely, whereas with per-session isolation deleting a session reclaims the whole segment, at the
        -- cost of storing one duplicate copy of the base segment per session.
        CREATE TABLE IF NOT EXISTS chatTrajectorySection (
            conversation_id TEXT NOT NULL,
            section_id TEXT NOT NULL,
            slot TEXT NOT NULL,
            content TEXT NOT NULL,
            bytes INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            PRIMARY KEY (conversation_id, section_id),
            FOREIGN KEY (conversation_id) REFERENCES chatHistory(id) ON DELETE CASCADE
        );
        ",
    )
    .map_err(|e| format!("Failed to initialize chat history table: {e}"))?;

    ensure_chat_history_columns(conn)?;
    ensure_chat_history_segment_columns(conn)?;
    ensure_chat_history_share_columns(conn)?;
    conn.execute_batch(
        "
        CREATE INDEX IF NOT EXISTS idx_chatHistory_updated_at
            ON chatHistory(updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_chatHistorySegment_conversation_updated
            ON chatHistorySegment(conversation_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_chatHistory_pinned
            ON chatHistory(is_pinned DESC, pinned_at DESC, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_chatHistoryShare_token
            ON chatHistoryShare(token);
        CREATE INDEX IF NOT EXISTS idx_chatTrajectorySection_conversation
            ON chatTrajectorySection(conversation_id);
        ",
    )
    .map_err(|e| format!("Failed to initialize chat history indexes: {e}"))?;
    ensure_chat_history_fts(conn)?;

    Ok(())
}

fn ensure_chat_history_columns(conn: &Connection) -> Result<(), String> {
    ensure_table_columns(
        conn,
        "chatHistory",
        "chat history main table",
        &[
            (
                "title",
                "ALTER TABLE chatHistory ADD COLUMN title TEXT NOT NULL DEFAULT 'Untitled';",
            ),
            (
                "provider_id",
                "ALTER TABLE chatHistory ADD COLUMN provider_id TEXT NOT NULL DEFAULT '';",
            ),
            (
                "model",
                "ALTER TABLE chatHistory ADD COLUMN model TEXT NOT NULL DEFAULT '';",
            ),
            (
                "session_id",
                "ALTER TABLE chatHistory ADD COLUMN session_id TEXT;",
            ),
            ("cwd", "ALTER TABLE chatHistory ADD COLUMN cwd TEXT;"),
            (
                "context_meta_json",
                "ALTER TABLE chatHistory ADD COLUMN context_meta_json TEXT NOT NULL DEFAULT '{}';",
            ),
            (
                "active_segment_index",
                "ALTER TABLE chatHistory ADD COLUMN active_segment_index INTEGER NOT NULL DEFAULT 0;",
            ),
            (
                "total_segment_count",
                "ALTER TABLE chatHistory ADD COLUMN total_segment_count INTEGER NOT NULL DEFAULT 1;",
            ),
            (
                "total_message_count",
                "ALTER TABLE chatHistory ADD COLUMN total_message_count INTEGER NOT NULL DEFAULT 0;",
            ),
            (
                "created_at",
                "ALTER TABLE chatHistory ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;",
            ),
            (
                "updated_at",
                "ALTER TABLE chatHistory ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;",
            ),
            (
                "is_pinned",
                "ALTER TABLE chatHistory ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0;",
            ),
            (
                "pinned_at",
                "ALTER TABLE chatHistory ADD COLUMN pinned_at INTEGER;",
            ),
            (
                "selected_model_json",
                "ALTER TABLE chatHistory ADD COLUMN selected_model_json TEXT;",
            ),
        ],
    )?;

    conn.execute_batch(
        "
        UPDATE chatHistory
        SET title = 'Untitled'
        WHERE title IS NULL OR trim(title) = '';

        UPDATE chatHistory
        SET provider_id = ''
        WHERE provider_id IS NULL;

        UPDATE chatHistory
        SET model = ''
        WHERE model IS NULL;

        UPDATE chatHistory
        SET context_meta_json = '{}'
        WHERE context_meta_json IS NULL OR trim(context_meta_json) = '';

        UPDATE chatHistory
        SET active_segment_index = 0
        WHERE active_segment_index IS NULL OR active_segment_index < 0;

        UPDATE chatHistory
        SET total_segment_count = 1
        WHERE total_segment_count IS NULL OR total_segment_count < 1;

        UPDATE chatHistory
        SET total_message_count = 0
        WHERE total_message_count IS NULL OR total_message_count < 0;

        UPDATE chatHistory
        SET created_at = 0
        WHERE created_at IS NULL;

        UPDATE chatHistory
        SET updated_at = created_at
        WHERE updated_at IS NULL;

        UPDATE chatHistory
        SET is_pinned = 0
        WHERE is_pinned IS NULL;
        ",
    )
    .map_err(|e| format!("Failed to repair chat history main table default columns: {e}"))?;

    Ok(())
}

fn ensure_chat_history_segment_columns(conn: &Connection) -> Result<(), String> {
    ensure_table_columns(
        conn,
        "chatHistorySegment",
        "chat history segment table",
        &[
            (
                "segment_id",
                "ALTER TABLE chatHistorySegment ADD COLUMN segment_id TEXT NOT NULL DEFAULT '';",
            ),
            (
                "summary_json",
                "ALTER TABLE chatHistorySegment ADD COLUMN summary_json TEXT;",
            ),
            (
                "messages_json",
                "ALTER TABLE chatHistorySegment ADD COLUMN messages_json TEXT NOT NULL DEFAULT '[]';",
            ),
            (
                "message_count",
                "ALTER TABLE chatHistorySegment ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0;",
            ),
            (
                "start_message_id",
                "ALTER TABLE chatHistorySegment ADD COLUMN start_message_id TEXT;",
            ),
            (
                "end_message_id",
                "ALTER TABLE chatHistorySegment ADD COLUMN end_message_id TEXT;",
            ),
            (
                "created_at",
                "ALTER TABLE chatHistorySegment ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;",
            ),
            (
                "updated_at",
                "ALTER TABLE chatHistorySegment ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;",
            ),
            // Trajectory events follow their segment and automatically inherit the branch/truncate/replace lifecycle.
            (
                "trajectory_json",
                "ALTER TABLE chatHistorySegment ADD COLUMN trajectory_json TEXT NOT NULL DEFAULT '[]';",
            ),
            (
                "trajectory_truncated",
                "ALTER TABLE chatHistorySegment ADD COLUMN trajectory_truncated INTEGER NOT NULL DEFAULT 0;",
            ),
        ],
    )?;

    conn.execute_batch(
        "
        UPDATE chatHistorySegment
        SET segment_id = 'segment-' || segment_index
        WHERE segment_id IS NULL OR trim(segment_id) = '';

        UPDATE chatHistorySegment
        SET messages_json = '[]'
        WHERE messages_json IS NULL OR trim(messages_json) = '';

        UPDATE chatHistorySegment
        SET message_count = 0
        WHERE message_count IS NULL OR message_count < 0;

        UPDATE chatHistorySegment
        SET created_at = 0
        WHERE created_at IS NULL;

        UPDATE chatHistorySegment
        SET updated_at = created_at
        WHERE updated_at IS NULL;

        UPDATE chatHistorySegment
        SET trajectory_json = '[]'
        WHERE trajectory_json IS NULL OR trim(trajectory_json) = '';

        UPDATE chatHistorySegment
        SET trajectory_truncated = 0
        WHERE trajectory_truncated IS NULL;
        ",
    )
    .map_err(|e| format!("Failed to repair chat history segment table default columns: {e}"))?;

    Ok(())
}

fn ensure_chat_history_share_columns(conn: &Connection) -> Result<(), String> {
    ensure_table_columns(
        conn,
        "chatHistoryShare",
        "chat history share table",
        &[
            (
                "token",
                "ALTER TABLE chatHistoryShare ADD COLUMN token TEXT;",
            ),
            (
                "enabled",
                "ALTER TABLE chatHistoryShare ADD COLUMN enabled INTEGER NOT NULL DEFAULT 0;",
            ),
            (
                "redact_tool_content",
                "ALTER TABLE chatHistoryShare ADD COLUMN redact_tool_content INTEGER NOT NULL DEFAULT 0;",
            ),
            (
                "created_at",
                "ALTER TABLE chatHistoryShare ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;",
            ),
            (
                "updated_at",
                "ALTER TABLE chatHistoryShare ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;",
            ),
        ],
    )?;

    conn.execute_batch(
        "
        UPDATE chatHistoryShare
        SET enabled = 0
        WHERE enabled IS NULL;

        UPDATE chatHistoryShare
        SET redact_tool_content = 0
        WHERE redact_tool_content IS NULL;

        UPDATE chatHistoryShare
        SET created_at = 0
        WHERE created_at IS NULL;

        UPDATE chatHistoryShare
        SET updated_at = created_at
        WHERE updated_at IS NULL;
        ",
    )
    .map_err(|e| format!("Failed to repair chat history share table default columns: {e}"))?;

    Ok(())
}

fn ensure_chat_history_fts(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE VIRTUAL TABLE IF NOT EXISTS chatHistorySegmentFts USING fts5(
            conversation_id         UNINDEXED,
            segment_index           UNINDEXED,
            segment_id              UNINDEXED,
            title,
            cwd,
            body,
            segment_updated_at      UNINDEXED,
            conversation_updated_at UNINDEXED,
            tokenize = "trigram"
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS chatHistoryMessageFts USING fts5(
            conversation_id         UNINDEXED,
            segment_index           UNINDEXED,
            segment_id              UNINDEXED,
            message_index           UNINDEXED,
            message_id              UNINDEXED,
            role                    UNINDEXED,
            title,
            cwd,
            body,
            message_updated_at      UNINDEXED,
            segment_updated_at      UNINDEXED,
            conversation_updated_at UNINDEXED,
            tokenize = "trigram"
        );

        CREATE TABLE IF NOT EXISTS chatHistoryFtsSegmentIndex (
            conversation_id         TEXT NOT NULL,
            segment_index           INTEGER NOT NULL,
            segment_updated_at      INTEGER NOT NULL,
            conversation_updated_at INTEGER NOT NULL,
            PRIMARY KEY (conversation_id, segment_index)
        );
        "#,
    )
    .map_err(|e| format!("Failed to initialize chat history FTS table: {e}"))?;

    ensure_chat_history_fts_index_columns(conn)?;
    conn.execute_batch(
        "
        CREATE INDEX IF NOT EXISTS idx_chatHistoryFtsSegmentIndex_segment_updated
            ON chatHistoryFtsSegmentIndex(segment_updated_at DESC);

        CREATE INDEX IF NOT EXISTS idx_chatHistoryFtsSegmentIndex_conversation_updated
            ON chatHistoryFtsSegmentIndex(conversation_updated_at DESC);
        ",
    )
    .map_err(|e| format!("Failed to initialize chat history FTS indexes: {e}"))?;

    seed_existing_chat_history_fts_index(conn)?;

    Ok(())
}

fn ensure_chat_history_fts_index_columns(conn: &Connection) -> Result<(), String> {
    ensure_table_columns(
        conn,
        "chatHistoryFtsSegmentIndex",
        "chat history FTS metadata table",
        &[
            (
                "segment_updated_at",
                "ALTER TABLE chatHistoryFtsSegmentIndex ADD COLUMN segment_updated_at INTEGER NOT NULL DEFAULT 0;",
            ),
            (
                "conversation_updated_at",
                "ALTER TABLE chatHistoryFtsSegmentIndex ADD COLUMN conversation_updated_at INTEGER NOT NULL DEFAULT 0;",
            ),
        ],
    )
}

fn seed_existing_chat_history_fts_index(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "
        INSERT OR IGNORE INTO chatHistoryFtsSegmentIndex (
            conversation_id,
            segment_index,
            segment_updated_at,
            conversation_updated_at
        )
        SELECT
            f.conversation_id,
            CAST(f.segment_index AS INTEGER),
            s.updated_at,
            h.updated_at
        FROM chatHistorySegmentFts f
        JOIN chatHistorySegment s
          ON s.conversation_id = f.conversation_id
         AND s.segment_index = CAST(f.segment_index AS INTEGER)
        JOIN chatHistory h ON h.id = s.conversation_id
        WHERE CAST(f.segment_updated_at AS INTEGER) = s.updated_at
          AND CAST(f.conversation_updated_at AS INTEGER) = h.updated_at
        GROUP BY f.conversation_id, CAST(f.segment_index AS INTEGER)
        ",
        [],
    )
    .map_err(|e| format!("Failed to sync history FTS metadata: {e}"))?;

    Ok(())
}

const SUBAGENT_SCHEMA_VERSION: &str = "2";

/// Versioned bootstrap for the subagent store schema (v2).
///
/// The subagent tables are versioned independently of the chat-history
/// `user_version` via the `subagentMeta` table. When the recorded version is
/// missing or different from the current one, every subagent table (including
/// legacy v1 tables) is dropped and recreated — old persisted subagent data is
/// deliberately discarded.
pub(crate) fn ensure_subagent_schema(conn: &Connection) -> Result<(), String> {
    let meta_exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'subagentMeta'",
            [],
            |row| row.get(0),
        )
        .map_err(|e| format!("failed to check subagent meta table: {e}"))?;
    if meta_exists > 0 {
        let version: Option<String> = conn
            .query_row(
                "SELECT value FROM subagentMeta WHERE key = 'schemaVersion'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| format!("failed to read subagent schema version: {e}"))?;
        if version.as_deref() == Some(SUBAGENT_SCHEMA_VERSION) {
            return Ok(());
        }
    }

    conn.execute_batch(
        "
        DROP TABLE IF EXISTS subagentRunEvent;
        DROP TABLE IF EXISTS subagentMessageBusEntry;
        DROP TABLE IF EXISTS subagentRunSegment;
        DROP TABLE IF EXISTS subagentRun;
        DROP TABLE IF EXISTS subagentIdentity;
        DROP TABLE IF EXISTS subagentMessage;
        DROP TABLE IF EXISTS subagentMeta;
        ",
    )
    .map_err(|e| format!("failed to drop outdated subagent tables: {e}"))?;

    conn.execute_batch(
        "
        CREATE TABLE subagentMeta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE subagentIdentity (
            parent_conversation_id TEXT NOT NULL,
            agent_id TEXT NOT NULL,
            name TEXT NOT NULL,
            role TEXT NOT NULL,
            identity_prompt TEXT NOT NULL,
            template_id TEXT,
            last_mode TEXT NOT NULL,
            created_tool_call_id TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (parent_conversation_id, agent_id)
        );

        CREATE TABLE subagentRun (
            id TEXT PRIMARY KEY,
            parent_conversation_id TEXT NOT NULL,
            parent_tool_call_id TEXT NOT NULL,
            agent_id TEXT NOT NULL,
            agent_index INTEGER NOT NULL,
            agent_total INTEGER NOT NULL,
            prompt TEXT NOT NULL,
            mode TEXT NOT NULL,
            status TEXT NOT NULL,
            provider_id TEXT NOT NULL,
            model TEXT NOT NULL,
            session_id TEXT,
            workdir TEXT,
            worktree_root TEXT,
            branch_name TEXT,
            context_schema_version INTEGER NOT NULL,
            active_segment_index INTEGER NOT NULL,
            total_segment_count INTEGER NOT NULL,
            total_message_count INTEGER NOT NULL,
            round_count INTEGER NOT NULL,
            tool_call_count INTEGER NOT NULL,
            compaction_count INTEGER NOT NULL,
            summary TEXT,
            error TEXT,
            started_at INTEGER NOT NULL,
            ended_at INTEGER,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE subagentRunSegment (
            run_id TEXT NOT NULL,
            segment_index INTEGER NOT NULL,
            segment_id TEXT NOT NULL,
            summary_json TEXT,
            messages_json TEXT NOT NULL,
            message_count INTEGER NOT NULL,
            start_message_id TEXT,
            end_message_id TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (run_id, segment_index),
            UNIQUE (run_id, segment_id),
            FOREIGN KEY (run_id) REFERENCES subagentRun(id) ON DELETE CASCADE
        );

        CREATE TABLE subagentMessage (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            parent_conversation_id TEXT NOT NULL,
            seq INTEGER NOT NULL,
            sender_id TEXT NOT NULL,
            sender_name TEXT,
            recipient_id TEXT NOT NULL,
            recipient_name TEXT,
            channel TEXT NOT NULL,
            subject TEXT,
            body_markdown TEXT NOT NULL,
            source_run_id TEXT,
            source_tool_call_id TEXT,
            created_at INTEGER NOT NULL,
            UNIQUE (parent_conversation_id, seq)
        );

        CREATE INDEX idx_subagentIdentity_parent_updated
            ON subagentIdentity(parent_conversation_id, updated_at DESC);
        CREATE INDEX idx_subagentRun_parent_updated
            ON subagentRun(parent_conversation_id, updated_at DESC);
        CREATE INDEX idx_subagentRun_agent
            ON subagentRun(parent_conversation_id, agent_id, updated_at DESC);
        CREATE INDEX idx_subagentRun_tool_call
            ON subagentRun(parent_conversation_id, parent_tool_call_id);
        CREATE INDEX idx_subagentMessage_parent_seq
            ON subagentMessage(parent_conversation_id, seq);
        ",
    )
    .map_err(|e| format!("failed to create subagent schema: {e}"))?;

    conn.execute(
        "INSERT INTO subagentMeta (key, value) VALUES ('schemaVersion', ?1)",
        [SUBAGENT_SCHEMA_VERSION],
    )
    .map_err(|e| format!("failed to record subagent schema version: {e}"))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open_test_db() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory history db");
        initialize_connection(&conn).expect("initialize history db");
        conn
    }

    #[test]
    fn initialize_connection_sets_schema_version() {
        let conn = open_test_db();
        assert_eq!(
            read_user_version(&conn).expect("read version"),
            HISTORY_DB_SCHEMA_VERSION
        );
    }

    #[test]
    fn initialize_connection_creates_chat_and_subagent_tables() {
        let conn = open_test_db();
        for table_name in [
            "chatHistory",
            "chatHistorySegment",
            "chatHistoryShare",
            "chatTrajectorySection",
            "chatHistoryFtsSegmentIndex",
            "chatTrajectorySection",
            "subagentMeta",
            "subagentIdentity",
            "subagentRun",
            "subagentRunSegment",
            "subagentMessage",
        ] {
            let exists: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    [table_name],
                    |row| row.get(0),
                )
                .expect("query table existence");
            assert_eq!(exists, 1, "{table_name} should exist");
        }
    }

    #[test]
    fn migrate_v2_database_adds_trajectory_schema() {
        let conn = Connection::open_in_memory().expect("open v2 in-memory history db");
        conn.execute_batch(
            "
            CREATE TABLE chatHistory (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                provider_id TEXT NOT NULL,
                model TEXT NOT NULL,
                session_id TEXT,
                cwd TEXT,
                context_meta_json TEXT,
                active_segment_index INTEGER,
                total_segment_count INTEGER,
                total_message_count INTEGER,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                is_pinned INTEGER NOT NULL DEFAULT 0,
                pinned_at INTEGER,
                selected_model_json TEXT
            );
            CREATE TABLE chatHistorySegment (
                conversation_id TEXT NOT NULL,
                segment_index INTEGER NOT NULL,
                segment_id TEXT NOT NULL,
                summary_json TEXT,
                messages_json TEXT NOT NULL,
                message_count INTEGER NOT NULL,
                start_message_id TEXT,
                end_message_id TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (conversation_id, segment_index),
                UNIQUE (conversation_id, segment_id),
                FOREIGN KEY (conversation_id) REFERENCES chatHistory(id) ON DELETE CASCADE
            );
            CREATE TABLE chatHistoryShare (
                conversation_id TEXT PRIMARY KEY,
                token TEXT UNIQUE,
                enabled INTEGER NOT NULL DEFAULT 0,
                redact_tool_content INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                FOREIGN KEY (conversation_id) REFERENCES chatHistory(id) ON DELETE CASCADE
            );
            PRAGMA user_version = 2;
            ",
        )
        .expect("create v2 history schema");

        initialize_connection(&conn).expect("migrate v2 trajectory schema");

        assert_eq!(
            read_user_version(&conn).expect("read migrated version"),
            HISTORY_DB_SCHEMA_VERSION
        );
        let segment_columns = read_table_columns(&conn, "chatHistorySegment", "chatHistorySegment")
            .expect("read migrated segment columns");
        assert!(segment_columns.contains("trajectory_json"));
        assert!(segment_columns.contains("trajectory_truncated"));
        let section_table_exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'chatTrajectorySection'",
                [],
                |row| row.get(0),
            )
            .expect("query trajectory section table");
        assert_eq!(section_table_exists, 1);
    }

    #[test]
    fn migrate_v3_database_drops_legacy_context_json() {
        let conn = Connection::open_in_memory().expect("open v3 in-memory history db");
        // The shape of a real old database upgraded all the way from 1.x to v3: chatHistory still carries
        // the NOT NULL context_json column (the table predates segment persistence and column ensure only adds, never drops).
        conn.execute_batch(
            "
            CREATE TABLE chatHistory (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                provider_id TEXT NOT NULL,
                model TEXT NOT NULL,
                context_json TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                is_pinned INTEGER NOT NULL DEFAULT 0,
                pinned_at INTEGER,
                session_id TEXT,
                cwd TEXT,
                context_meta_json TEXT NOT NULL DEFAULT '{}',
                active_segment_index INTEGER NOT NULL DEFAULT 0,
                total_segment_count INTEGER NOT NULL DEFAULT 1,
                total_message_count INTEGER NOT NULL DEFAULT 0,
                selected_model_json TEXT
            );
            PRAGMA user_version = 3;
            ",
        )
        .expect("create legacy-with-context_json schema");

        initialize_connection(&conn).expect("migrate v3 -> v4");

        assert_eq!(
            read_user_version(&conn).expect("read migrated version"),
            HISTORY_DB_SCHEMA_VERSION
        );
        let columns = read_table_columns(&conn, "chatHistory", "chatHistory")
            .expect("read migrated chatHistory columns");
        assert!(
            !columns.contains("context_json"),
            "legacy context_json must be dropped"
        );
        // After migration, INSERT is no longer rejected by the legacy NOT NULL constraint.
        conn.execute(
            "INSERT INTO chatHistory (id, title, provider_id, model, context_meta_json, active_segment_index, total_segment_count, total_message_count, created_at, updated_at) VALUES ('c1', 't', 'claude_code', 'm', '{}', 0, 1, 0, 1, 1)",
            [],
        )
        .expect("insert into migrated chatHistory");
    }

    #[test]
    fn migrate_legacy_history_db_to_v1() {
        let conn = Connection::open_in_memory().expect("open legacy in-memory history db");
        conn.execute_batch(
            "
            CREATE TABLE chatHistory (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                provider_id TEXT NOT NULL,
                model TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE subagentRun (
                id TEXT PRIMARY KEY,
                parent_tool_call_id TEXT NOT NULL,
                parent_tool_name TEXT NOT NULL,
                agent_index INTEGER NOT NULL,
                agent_total INTEGER NOT NULL,
                description TEXT NOT NULL,
                mode TEXT NOT NULL,
                status TEXT NOT NULL,
                provider_id TEXT NOT NULL,
                model TEXT NOT NULL,
                context_meta_json TEXT NOT NULL,
                active_segment_index INTEGER NOT NULL,
                total_segment_count INTEGER NOT NULL,
                total_message_count INTEGER NOT NULL,
                started_at INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            ",
        )
        .expect("create legacy history schema");

        initialize_connection(&conn).expect("migrate legacy history schema");

        assert_eq!(
            read_user_version(&conn).expect("read version"),
            HISTORY_DB_SCHEMA_VERSION
        );
        for (table_name, column_name) in [
            ("chatHistory", "context_meta_json"),
            ("chatHistory", "is_pinned"),
            ("chatHistory", "selected_model_json"),
            ("subagentRun", "prompt"),
            ("subagentRun", "context_schema_version"),
        ] {
            let columns = read_table_columns(&conn, table_name, table_name)
                .expect("read migrated table columns");
            assert!(
                columns.contains(column_name),
                "{table_name}.{column_name} should exist"
            );
        }
        // Legacy v1 subagent columns must be gone after the drop-and-recreate.
        let subagent_run_columns = read_table_columns(&conn, "subagentRun", "subagentRun")
            .expect("read recreated subagentRun columns");
        assert!(!subagent_run_columns.contains("logical_agent_id"));
        assert!(!subagent_run_columns.contains("context_meta_json"));
    }
}
