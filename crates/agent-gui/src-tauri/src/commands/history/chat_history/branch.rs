// Branch session: take a prefix from the source session by anchor (user message)---including
// that turn's complete assistant reply---and copy it into a brand-new session. All writes happen
// within the same SQLite transaction.

/// Must match BRANCH_CONVERSATION_DEFAULT_TITLE in agent-gui src/lib/chat/page/chatPageHelpers.ts.
pub(crate) const BRANCH_DEFAULT_TITLE: &str = "New Branch";

fn parse_branch_segment_messages(segment: &ChatHistorySegmentRecord) -> Result<Vec<Value>, String> {
    let parsed = serde_json::from_str::<Value>(&segment.messages_json)
        .map_err(|e| format!("Failed to parse history segment {}: {e}", segment.segment_id))?;
    parsed
        .as_array()
        .cloned()
        .ok_or_else(|| format!("Messages of history segment {} are not an array", segment.segment_id))
}

fn branch_message_role_is_user(message: &Value) -> bool {
    message
        .as_object()
        .and_then(|object| object.get("role"))
        .and_then(Value::as_str)
        .map(str::trim)
        == Some("user")
}

/// Mirrors the frontend normalizeSegment (conversationState.ts): after trimming, recompute
/// message_count/start/end/updated_at while preserving segment_id, summary_json, created_at.
/// The stable ids of start/end are isomorphic to the frontend getMessageStableId (history_message_stable_id).
fn build_branch_sliced_segment(
    record: &ChatHistorySegmentRecord,
    kept_messages: &[Value],
    new_segment_index: i64,
) -> Result<ChatHistorySegmentInput, String> {
    let last_index = kept_messages.len().saturating_sub(1);
    let start_message_id = kept_messages
        .first()
        .map(|message| history_message_stable_id(message, new_segment_index, 0));
    let end_message_id = kept_messages
        .last()
        .map(|message| history_message_stable_id(message, new_segment_index, last_index));
    let updated_at = kept_messages
        .last()
        .map(read_message_timestamp)
        .unwrap_or(record.updated_at);
    let messages_json =
        serde_json::to_string(kept_messages).map_err(|e| format!("Failed to serialize branch segment messages: {e}"))?;

    Ok(ChatHistorySegmentInput {
        segment_index: new_segment_index,
        segment_id: record.segment_id.clone(),
        summary_json: record.summary_json.clone(),
        messages_json,
        message_count: i64::try_from(kept_messages.len()).unwrap_or(i64::MAX),
        start_message_id,
        end_message_id,
        created_at: record.created_at,
        updated_at,
    })
}

/// Starting from the anchor user message, scan forward for the next message with role=="user"
/// as the exclusive cut point, returning the list of segments copied to the new session
/// (renumbered as 0..n-1) and the total message count.
pub(crate) fn build_branch_segments(
    segments: &[ChatHistorySegmentRecord],
    anchor: &ChatHistoryMessageRef,
) -> Result<(Vec<ChatHistorySegmentInput>, i64), String> {
    let location = locate_history_message_ref(segments, anchor)
        .map_err(|error| format!("No matching branch anchor message found: {error}"))?;
    let anchor_segment_pos = location.segment_position;
    let anchor_messages = location.messages;
    let anchor_position = location.message_index;

    // Exclusive cut point: the first user message after the anchor (across segments); if none, the
    // whole session is copied. Also records whether a non-user message exists before the cut point:
    // desktop done precedes persistence (persist-lag), so branching is disallowed while the assistant
    // reply has not yet been written to history, otherwise it would silently copy a prefix missing that reply.
    let mut cut: Option<(usize, usize)> = None;
    let mut saw_reply_after_anchor = false;
    'scan: for (segment_pos, segment) in segments.iter().enumerate().skip(anchor_segment_pos) {
        let parsed;
        let messages: &[Value] = if segment_pos == anchor_segment_pos {
            &anchor_messages
        } else {
            parsed = parse_branch_segment_messages(segment)?;
            &parsed
        };
        let scan_from = if segment_pos == anchor_segment_pos {
            anchor_position + 1
        } else {
            0
        };
        for (message_index, message) in messages.iter().enumerate().skip(scan_from) {
            if branch_message_role_is_user(message) {
                cut = Some((segment_pos, message_index));
                break 'scan;
            }
            saw_reply_after_anchor = true;
        }
    }
    if !saw_reply_after_anchor {
        return Err("The branch target reply has not been written to history yet; please try again later".to_string());
    }

    let mut kept: Vec<ChatHistorySegmentInput> = Vec::new();
    match cut {
        Some((cut_segment_pos, cut_message_index)) if cut_segment_pos == anchor_segment_pos => {
            // The cut point is still within the anchor segment: trim the anchor segment and discard all subsequent segments.
            for segment in &segments[..anchor_segment_pos] {
                kept.push(record_to_segment_input(segment));
            }
            let new_index = kept.len() as i64;
            kept.push(build_branch_sliced_segment(
                &segments[anchor_segment_pos],
                &anchor_messages[..cut_message_index],
                new_index,
            )?);
        }
        Some((cut_segment_pos, cut_message_index)) => {
            // The cut point is in a later segment: copy earlier segments whole; trim the cut-point segment to [..j],
            // when j == 0 the whole segment (including summary) is discarded; segments after that are all discarded.
            for segment in &segments[..cut_segment_pos] {
                kept.push(record_to_segment_input(segment));
            }
            if cut_message_index > 0 {
                let cut_messages = parse_branch_segment_messages(&segments[cut_segment_pos])?;
                let new_index = kept.len() as i64;
                kept.push(build_branch_sliced_segment(
                    &segments[cut_segment_pos],
                    &cut_messages[..cut_message_index],
                    new_index,
                )?);
            }
        }
        None => {
            for segment in segments {
                kept.push(record_to_segment_input(segment));
            }
        }
    }

    for (index, segment) in kept.iter_mut().enumerate() {
        segment.segment_index = index as i64;
    }
    let total_message_count = kept.iter().fold(0_i64, |acc, segment| {
        acc.saturating_add(segment.message_count.max(0))
    });

    Ok((kept, total_message_count))
}

/// context_meta_json is the serialization of the frontend StoredChatContextMeta: overwrite only the
/// three count fields and leave other keys untouched; if it cannot be parsed, keep it as-is.
pub(crate) fn chat_history_branch_sync(
    conn: &mut Connection,
    source_id: &str,
    anchor: &ChatHistoryMessageRef,
) -> Result<ChatHistorySummary, String> {
    let source_id = source_id.trim();
    if source_id.is_empty() {
        return Err("History conversation id must not be empty".to_string());
    }
    validate_user_history_message_ref(anchor)?;

    let tx = conn
        .transaction()
        .map_err(|e| format!("Failed to begin branch session transaction: {e}"))?;

    let source = get_record_by_id(&tx, source_id)?;
    let source_segments = load_segments(&tx, &source.id)?;
    if source_segments.is_empty() {
        return Err("History conversation is missing segment data".to_string());
    }

    let (segments, total_message_count) = build_branch_segments(&source_segments, anchor)?;
    let retained_user_turns = count_user_messages_in_segment_inputs(&segments)?;
    let total_segment_count = segments.len() as i64;
    let active_segment_index = total_segment_count - 1;
    let context_meta_json = patch_history_context_meta(
        &source.context_meta_json,
        active_segment_index,
        total_segment_count,
        total_message_count,
    );

    let new_id = Uuid::new_v4().to_string();
    let now = now_ms();
    let conversation = ChatHistoryConversationInput {
        id: new_id.clone(),
        title: BRANCH_DEFAULT_TITLE.to_string(),
        provider_id: source.provider_id.clone(),
        model: source.model.clone(),
        session_id: None,
        cwd: source.cwd.clone(),
        selected_model_json: source.selected_model_json.clone(),
        context_meta_json,
        active_segment_index,
        total_segment_count,
        total_message_count,
        created_at: Some(now),
        updated_at: now,
    };
    validate_conversation_input(&conversation)?;

    upsert_chat_history_header(&tx, &conversation)?;
    for segment in &segments {
        insert_single_segment(&tx, &new_id, segment)?;
    }
    copy_branch_trajectory_prefix(
        &tx,
        source_id,
        &new_id,
        total_segment_count,
        total_message_count,
        retained_user_turns,
    )?;
    verify_chat_history_consistency(&tx, &new_id)?;

    tx.commit()
        .map_err(|e| format!("Failed to commit branch session transaction: {e}"))?;

    get_summary_by_id(conn, &new_id)
}

pub(crate) async fn chat_history_branch_inner(
    id: String,
    anchor: ChatHistoryMessageRef,
) -> Result<ChatHistorySummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = open_db()?;
        chat_history_branch_sync(&mut conn, &id, &anchor)
    })
    .await
    .map_err(|e| format!("chat_history_branch join failed: {e}"))?
}

#[tauri::command]
pub async fn chat_history_branch(
    id: String,
    base_message_ref: ChatHistoryMessageRef,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<ChatHistorySummary, String> {
    let summary = chat_history_branch_inner(id, base_message_ref).await?;
    gateway_controller
        .publish_history_sync(build_history_sync_upsert(&summary))
        .await;
    Ok(summary)
}
