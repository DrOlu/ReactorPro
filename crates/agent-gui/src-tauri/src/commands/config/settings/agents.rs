fn load_agents(conn: &Connection) -> Result<Option<Value>, String> {
    let mut stmt = conn
        .prepare(AGENT_PROMPT_TEMPLATES_SELECT_SQL)
        .map_err(|e| format!("failed to prepare reading {AGENT_PROMPT_TEMPLATES_TABLE}: {e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
            ))
        })
        .map_err(|e| format!("failed to read {AGENT_PROMPT_TEMPLATES_TABLE}: {e}"))?;

    let mut templates = Vec::new();
    for row in rows {
        let (template_id, name, description, prompt, enabled) =
            row.map_err(|e| format!("failed to read {AGENT_PROMPT_TEMPLATES_TABLE} row: {e}"))?;
        templates.push(Value::Object(Map::from_iter([
            ("id".to_string(), Value::String(template_id)),
            ("name".to_string(), Value::String(name)),
            ("description".to_string(), Value::String(description)),
            ("prompt".to_string(), Value::String(prompt)),
            ("enabled".to_string(), Value::Bool(enabled != 0)),
        ])));
    }

    if templates.is_empty() {
        Ok(None)
    } else {
        Ok(Some(Value::Array(templates)))
    }
}
fn save_agents(conn: &mut Connection, payload: Value) -> Result<(), String> {
    let templates = expect_array(payload, "settings_save_agents payload")?;
    let updated_at = now_ms();
    let tx = conn
        .transaction()
        .map_err(|e| format!("failed to begin {AGENT_PROMPT_TEMPLATES_TABLE} transaction: {e}"))?;
    tx.execute(AGENT_PROMPT_TEMPLATES_DELETE_SQL, [])
        .map_err(|e| format!("failed to clear {AGENT_PROMPT_TEMPLATES_TABLE}: {e}"))?;

    let mut seen = HashSet::new();
    let mut enabled_template_id: Option<String> = None;
    for (sort_index, template) in templates.into_iter().enumerate() {
        let template = expect_object(template, "settings_save_agents payload[]")?;
        let template_id =
            extract_non_empty_string(&template, "id", "settings_save_agents payload[]")?;
        if !seen.insert(template_id.clone()) {
            return Err(format!(
                "{AGENT_PROMPT_TEMPLATES_TABLE}.template_id is duplicated: {template_id}"
            ));
        }

        let name = extract_non_empty_string(&template, "name", "settings_save_agents payload[]")?;
        let prompt =
            extract_non_empty_string(&template, "prompt", "settings_save_agents payload[]")?;
        let description = extract_optional_string(&template, "description");
        let enabled = match template.get("enabled") {
            Some(Value::Bool(value)) => *value,
            Some(Value::Null) | None => false,
            Some(_) => {
                return Err("settings_save_agents payload[].enabled must be a boolean".to_string());
            }
        };
        if enabled {
            if let Some(existing_id) = &enabled_template_id {
                return Err(format!(
                    "{AGENT_PROMPT_TEMPLATES_TABLE}.enabled may only have one active entry: {existing_id}, {template_id}"
                ));
            }
            enabled_template_id = Some(template_id.clone());
        }

        tx.execute(
            AGENT_PROMPT_TEMPLATES_INSERT_SQL,
            params![
                template_id,
                name,
                description,
                prompt,
                if enabled { 1_i64 } else { 0_i64 },
                sort_index as i64,
                updated_at
            ],
        )
        .map_err(|e| format!("failed to write {AGENT_PROMPT_TEMPLATES_TABLE}: {e}"))?;
    }

    tx.commit()
        .map_err(|e| format!("failed to commit {AGENT_PROMPT_TEMPLATES_TABLE} transaction: {e}"))?;
    // Mark dirty after commit: a rolled-back transaction must not trigger auto-sync.
    crate::services::webdav_auto_sync::mark_dirty();
    Ok(())
}
