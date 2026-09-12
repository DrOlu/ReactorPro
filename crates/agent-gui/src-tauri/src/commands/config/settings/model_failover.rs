pub(crate) fn load_model_failover(conn: &Connection) -> Result<Option<Value>, String> {
    let payload_json = conn
        .query_row(
            &format!(
                "SELECT payload_json FROM {MODEL_FAILOVER_SETTINGS_TABLE} WHERE config_id = 'default'"
            ),
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| format!("failed to read {MODEL_FAILOVER_SETTINGS_TABLE}: {e}"))?;

    match payload_json {
        Some(raw) => Ok(Some(parse_json(&raw, MODEL_FAILOVER_SETTINGS_TABLE)?)),
        None => Ok(None),
    }
}
fn save_model_failover(conn: &mut Connection, payload: Value) -> Result<(), String> {
    let model_failover = Value::Object(expect_object(
        payload,
        "settings_save_model_failover payload",
    )?);
    let updated_at = now_ms();
    let tx = conn
        .transaction()
        .map_err(|e| format!("failed to begin {MODEL_FAILOVER_SETTINGS_TABLE} transaction: {e}"))?;
    tx.execute(
        &format!("DELETE FROM {MODEL_FAILOVER_SETTINGS_TABLE} WHERE config_id = 'default'"),
        [],
    )
    .map_err(|e| format!("failed to clear {MODEL_FAILOVER_SETTINGS_TABLE}: {e}"))?;
    tx.execute(
        &format!(
            "INSERT INTO {MODEL_FAILOVER_SETTINGS_TABLE} (config_id, payload_json, updated_at) VALUES ('default', ?1, ?2)"
        ),
        params![
            serialize_json(&model_failover, MODEL_FAILOVER_SETTINGS_TABLE)?,
            updated_at
        ],
    )
    .map_err(|e| format!("failed to write {MODEL_FAILOVER_SETTINGS_TABLE}: {e}"))?;
    tx.commit()
        .map_err(|e| format!("failed to commit {MODEL_FAILOVER_SETTINGS_TABLE} transaction: {e}"))?;
    // Mark dirty after commit: an auto-sync must not be triggered when the transaction rolls back.
    crate::services::webdav_auto_sync::mark_dirty();
    Ok(())
}
