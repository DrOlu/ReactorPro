package pbws

import (
	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/session"
)

// Mapping from session-layer Go seam types to v2 proto messages.

// statusEvent maps session.Status.
func statusEvent(status session.Status) *gatewayv2.StatusEvent {
	return &gatewayv2.StatusEvent{
		Online:                status.Online,
		AgentReady:            status.AgentReady,
		ChatRuntimeReady:      status.ChatRuntimeReady,
		AgentId:               status.AgentID,
		AgentVersion:          status.AgentVersion,
		SessionId:             status.SessionID,
		ConnectedSince:        status.ConnectedSince,
		LastHeartbeat:         status.LastHeartbeat,
		RuntimeState:          status.RuntimeState,
		RuntimeLastHeartbeat:  status.RuntimeLastHeartbeat,
		RuntimeWorkerId:       status.RuntimeWorkerID,
		RuntimeVisible:        status.RuntimeVisible,
		RuntimeActiveRunCount: status.RuntimeActiveRunCount,
	}
}

// chatActivityEvent maps session.ConversationActivityEvent.
func chatActivityEvent(event session.ConversationActivityEvent) *gatewayv2.ChatActivityEvent {
	return &gatewayv2.ChatActivityEvent{
		ConversationId:  event.ConversationID,
		RunId:           event.RunID,
		ClientRequestId: event.ClientRequestID,
		Running:         event.Running,
		State:           event.State,
		Workdir:         event.Workdir,
		UpdatedAtMs:     event.UpdatedAt.UnixMilli(),
	}
}

// chatRunActivity maps session.RunActivity and preserves the semantics of null fields.
func chatRunActivity(activity *session.RunActivity) *gatewayv2.ChatRunActivity {
	if activity == nil {
		return nil
	}
	return &gatewayv2.ChatRunActivity{
		RunId:                  activity.RunID,
		State:                  activity.State,
		StartedSeq:             activity.StartedSeq,
		UpdatedAtMs:            activity.UpdatedAt.UnixMilli(),
		ToolStatus:             activity.ToolStatus,
		ToolStatusIsCompaction: activity.ToolStatusIsCompaction,
		ClientRequestId:        activity.ClientRequestID,
	}
}

// chatRunActivityListItem maps a running-conversation list item (including the
// conversation and working directory).
func chatRunActivityListItem(activity session.RunActivity) *gatewayv2.ChatRunActivity {
	item := chatRunActivity(&activity)
	item.ConversationId = activity.ConversationID
	item.Workdir = activity.Workdir
	return item
}

// chatRunSnapshot maps session.RunSnapshot.
func chatRunSnapshot(snapshot *session.RunSnapshot) *gatewayv2.ChatRunSnapshot {
	if snapshot == nil {
		return nil
	}
	return &gatewayv2.ChatRunSnapshot{
		RunId:                  snapshot.RunID,
		Revision:               snapshot.Revision,
		EntriesJson:            snapshot.EntriesJSON,
		ToolStatus:             snapshot.ToolStatus,
		ToolStatusIsCompaction: snapshot.ToolStatusIsCompaction,
		AsOfSeq:                snapshot.AsOfSeq,
	}
}

// chatCommandUpdate maps session.ChatCommandUpdate.
func chatCommandUpdate(update session.ChatCommandUpdate) *gatewayv2.ChatCommandUpdate {
	return &gatewayv2.ChatCommandUpdate{
		RunId:           update.RunID,
		ClientRequestId: update.ClientRequestID,
		ConversationId:  update.ConversationID,
		Phase:           update.Phase,
		ErrorCode:       update.ErrorCode,
		Message:         update.Message,
	}
}
