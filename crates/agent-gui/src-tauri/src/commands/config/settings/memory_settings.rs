pub(crate) fn load_memory(conn: &Connection) -> Result<Option<Value>, String> {
    let payload_json = conn
        .query_row(
            &format!(
                "SELECT payload_json FROM {MEMORY_SETTINGS_TABLE} WHERE config_id = 'default'"
            ),
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| format!("Failed to read {MEMORY_SETTINGS_TABLE}: {e}"))?;

    match payload_json {
        Some(raw) => Ok(Some(parse_json(&raw, MEMORY_SETTINGS_TABLE)?)),
        None => Ok(None),
    }
}
fn save_memory(conn: &mut Connection, payload: Value) -> Result<(), String> {
    let memory = Value::Object(expect_object(payload, "settings_save_memory payload")?);
    let updated_at = now_ms();
    let tx = conn
        .transaction()
        .map_err(|e| format!("Failed to begin transaction for {MEMORY_SETTINGS_TABLE}: {e}"))?;
    tx.execute(
        &format!("DELETE FROM {MEMORY_SETTINGS_TABLE} WHERE config_id = 'default'"),
        [],
    )
    .map_err(|e| format!("Failed to clear {MEMORY_SETTINGS_TABLE}: {e}"))?;
    tx.execute(
        &format!(
            "INSERT INTO {MEMORY_SETTINGS_TABLE} (config_id, payload_json, updated_at) VALUES ('default', ?1, ?2)"
        ),
        params![serialize_json(&memory, MEMORY_SETTINGS_TABLE)?, updated_at],
    )
    .map_err(|e| format!("Failed to write {MEMORY_SETTINGS_TABLE}: {e}"))?;
    tx.commit()
        .map_err(|e| format!("Failed to commit transaction for {MEMORY_SETTINGS_TABLE}: {e}"))?;
    Ok(())
}
