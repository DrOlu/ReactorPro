fn delete_chat_history_sync(
    conn: &mut Connection,
    id: &str,
) -> Result<subagent_store::SubagentPruneResult, String> {
    let chat_id = id.trim().to_string();
    if chat_id.is_empty() {
        return Err("History conversation id cannot be empty".to_string());
    }

    let existing = conn
        .query_row(
            "SELECT id FROM chatHistory WHERE id = ?1",
            params![chat_id.as_str()],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| format!("Failed to check whether the history conversation exists: {e}"))?;

    if existing.is_none() {
        return Err("No matching history conversation found".to_string());
    }

    let tx = conn
        .transaction()
        .map_err(|e| format!("Failed to begin delete-history transaction: {e}"))?;
    let subagent_prune_result =
        subagent_store::delete_subagent_history_for_parent_conversation(&tx, chat_id.as_str())?;
    delete_chat_history_conversation_fts(&tx, chat_id.as_str())?;
    tx.execute(
        "DELETE FROM chatHistorySegment WHERE conversation_id = ?1",
        params![chat_id.as_str()],
    )
    .map_err(|e| format!("Failed to delete history segments: {e}"))?;
    tx.execute(
        "DELETE FROM chatHistory WHERE id = ?1",
        params![chat_id.as_str()],
    )
    .map_err(|e| format!("Failed to delete history conversation: {e}"))?;
    tx.commit()
        .map_err(|e| format!("Failed to commit delete-history transaction: {e}"))?;
    Ok(subagent_prune_result)
}

pub(crate) async fn chat_history_delete_inner(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let chat_id = id.trim().to_string();
        let mut conn = open_db()?;
        let mut subagent_prune_result = delete_chat_history_sync(&mut conn, &chat_id)?;
        subagent_store::cleanup_pruned_worktrees(&mut subagent_prune_result);
        if !subagent_prune_result.worktree_cleanup_errors.is_empty() {
            eprintln!(
                "Failed to cleanup some deleted conversation subagent worktrees: {}",
                subagent_prune_result.worktree_cleanup_errors.join("; ")
            );
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("chat_history_delete join failed: {e}"))?
}

#[tauri::command]
pub async fn chat_history_delete(
    id: String,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<(), String> {
    let conversation_id = id.trim().to_string();
    chat_history_delete_inner(id).await?;
    gateway_controller
        .publish_history_sync(build_history_sync_delete(conversation_id))
        .await;
    Ok(())
}
