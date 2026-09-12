// Package chatcmd provides gateway-side chat command orchestration (request body
// normalization, runtime probing, command delivery, and startup watchdog, plus
// proto envelope construction) for reuse by the v2 protocol layer. The protocol
// layer only handles payload encoding/decoding; all orchestration logic is
// centralized here.
package chatcmd

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/liveagent/agent-gateway/internal/config"
	"github.com/liveagent/agent-gateway/internal/handler"
	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/session"
)

// MessageRef locates an existing message referenced by chat.edit_resend.
type MessageRef struct {
	SegmentIndex int    `json:"segment_index"`
	MessageIndex int    `json:"message_index"`
	SegmentID    string `json:"segment_id"`
	MessageID    string `json:"message_id"`
	Role         string `json:"role"`
	ContentHash  string `json:"content_hash"`
}

const (
	// runtimeWakeRequestPrefix is the agreed prefix for probe request ids; when the
	// desktop app recognizes it, it first wakes the Chat WebView runtime.
	runtimeWakeRequestPrefix = "chat-runtime-wake-"
	runtimeProbeReuseWindow  = 2 * time.Second
)

// NewTraceID generates a trace id for the chat command pipeline.
func NewTraceID() string {
	return strings.ReplaceAll(uuid.NewString(), "-", "")
}

// LogCommandSpan records one stage in the lifecycle of a chat command (structured logging).
func LogCommandSpan(
	traceID string,
	span string,
	runID string,
	conversationID string,
	clientRequestID string,
	commandType string,
) {
	slog.Info("chat_command_span",
		"span", strings.TrimSpace(span),
		"trace_id", strings.TrimSpace(traceID),
		"run_id", strings.TrimSpace(runID),
		"conversation_id", strings.TrimSpace(conversationID),
		"client_request_id", strings.TrimSpace(clientRequestID),
		"command_type", strings.TrimSpace(commandType),
	)
}

// NormalizeRequestBody normalizes and validates a chat request body (trim, defaults, required fields).
func NormalizeRequestBody(body *handler.ChatRequestBody) error {
	body.Message = strings.TrimSpace(body.Message)
	body.ConversationID = strings.TrimSpace(body.ConversationID)
	body.ClientRequestID = strings.TrimSpace(body.ClientRequestID)
	body.ExecutionMode = handler.NormalizeExecutionMode(body.ExecutionMode)
	body.Workdir = handler.NormalizeWorkdir(body.Workdir)
	body.CommandSafetyMode = handler.NormalizeCommandSafetyMode(body.CommandSafetyMode)
	body.QueuePolicy = normalizeQueuePolicy(body.QueuePolicy)
	body.UploadedFiles = handler.NormalizeChatUploadedFiles(body.UploadedFiles)
	body.ReferencedConversations = handler.NormalizeChatConversationReferences(
		body.ReferencedConversations,
		body.ConversationID,
	)
	body.RuntimeControls = handler.NormalizeChatRuntimeControls(body.RuntimeControls)
	selectedModel, err := handler.NormalizeChatSelectedModel(body.SelectedModel)
	if err != nil {
		return err
	}
	body.SelectedModel = selectedModel
	if body.ClientRequestID == "" {
		return errors.New("client_request_id is required")
	}
	if body.Message == "" && len(body.UploadedFiles) == 0 {
		return errors.New("message is required")
	}
	return nil
}

func normalizeQueuePolicy(value string) string {
	switch strings.TrimSpace(value) {
	case "append", "interrupt":
		return strings.TrimSpace(value)
	default:
		return "auto"
	}
}

// DispatchAcceptedCommand delivers an accepted command to the desktop app and arms
// the startup watchdog; cleanupWatch closes the caller's command-update watch stream
// once the command settles or is marked failed.
func DispatchAcceptedCommand(
	parent context.Context,
	cfg *config.Config,
	sm *session.Manager,
	agentID string,
	cleanupWatch func(),
	start session.ChatCommandStart,
	body handler.ChatRequestBody,
	baseMessageRef *MessageRef,
	traceID string,
) {
	if cleanupWatch != nil {
		defer cleanupWatch()
	}
	timeout := DeliveryTimeout(cfg)
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()

	commandType := "chat.submit"
	if baseMessageRef != nil {
		commandType = "chat.edit_resend"
	}
	if err := sm.SendToAgentContext(ctx, agentID, buildCommandEnvelope(start.RunID, commandType, body, baseMessageRef)); err != nil {
		message := "chat command failed"
		if err != nil && strings.TrimSpace(err.Error()) != "" {
			message = strings.TrimSpace(err.Error())
		}
		sm.FailChatCommand(agentID, start.RunID, "desktop_runtime_unavailable", message)
		return
	}
	LogCommandSpan(traceID, "command_delivered", start.RunID, start.ConversationID, body.ClientRequestID, commandType)
	WatchAcceptedCommandStartup(parent, cfg, sm, agentID, start.RunID)
}

// ProbeRuntime verifies that the desktop connection can complete a real round trip;
// the special prefix on the probe request id doubles as the signal that wakes the
// Chat WebView runtime.
func ProbeRuntime(
	ctx context.Context,
	sm *session.Manager,
	agentID string,
) error {
	if sm == nil {
		return session.ErrAgentOffline
	}
	if !sm.ChatIngressV1Ready(agentID) {
		if sm.IsOnline(agentID) {
			return session.ErrChatProtocolIncompatible
		}
		return session.ErrAgentOffline
	}
	sessionEpoch, online := sm.ChatRuntimeProbeEpoch(agentID)
	if !online {
		return session.ErrAgentOffline
	}
	requestID := runtimeWakeRequestPrefix + uuid.NewString()
	response, err := sm.AwaitUnaryResponse(ctx, agentID, requestID, &gatewayv2.GatewayEnvelope{
		RequestId: requestID,
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv2.GatewayEnvelope_Ping{
			Ping: &gatewayv2.PingRequest{Timestamp: time.Now().Unix()},
		},
	})
	if err != nil {
		return err
	}
	if response == nil || response.GetPong() == nil {
		return errors.New("desktop agent returned an invalid chat runtime probe response")
	}
	if !sm.RecordChatRuntimeProbe(agentID, sessionEpoch) {
		return session.ErrAgentOffline
	}
	return nil
}

// ProbeRuntimeForCommand reuses a recent successful probe result when available.
func ProbeRuntimeForCommand(ctx context.Context, sm *session.Manager, agentID string) error {
	if sm != nil && sm.ChatRuntimeProbeFresh(agentID, runtimeProbeReuseWindow) {
		return nil
	}
	return ProbeRuntime(ctx, sm, agentID)
}

// WatchAcceptedCommandStartup marks a command as failed if it does not settle
// (start, finish, or enter the desktop prompt queue) within the startup window.
func WatchAcceptedCommandStartup(
	parent context.Context,
	cfg *config.Config,
	sm *session.Manager,
	agentID string,
	runID string,
) {
	agentID = strings.TrimSpace(agentID)
	if sm == nil || agentID == "" || strings.TrimSpace(runID) == "" {
		return
	}
	if !waitCommandWatchdog(parent, StartTimeout(cfg)) {
		return
	}
	if sm.ChatCommandSettled(agentID, runID) {
		return
	}
	if !waitCommandWatchdog(parent, RenderStartTimeout(cfg)) {
		return
	}
	if sm.ChatCommandSettled(agentID, runID) {
		return
	}
	sm.FailChatCommand(agentID, runID, "startup_timeout",
		"The desktop app did not start the remote chat request. Please retry.")
}

func waitCommandWatchdog(ctx context.Context, timeout time.Duration) bool {
	if timeout <= 0 {
		return true
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

// StartTimeout / RenderStartTimeout / PrepareTimeout / DeliveryTimeout return the
// per-stage timeouts (falling back to conservative defaults when unconfigured).
func StartTimeout(cfg *config.Config) time.Duration {
	if cfg != nil && cfg.ChatStartTimeout > 0 {
		return cfg.ChatStartTimeout
	}
	return 5 * time.Second
}

func RenderStartTimeout(cfg *config.Config) time.Duration {
	if cfg != nil && cfg.ChatRenderStartTimeout > 0 {
		return cfg.ChatRenderStartTimeout
	}
	return 10 * time.Second
}

func PrepareTimeout(cfg *config.Config) time.Duration {
	if cfg != nil && cfg.ChatPrepareTimeout > 0 {
		return cfg.ChatPrepareTimeout
	}
	return 2 * time.Second
}

func DeliveryTimeout(cfg *config.Config) time.Duration {
	if cfg != nil && cfg.ChatDeliveryTimeout > 0 {
		return cfg.ChatDeliveryTimeout
	}
	return 5 * time.Second
}

// BuildAcceptedCommandPayloads builds the event payloads written to the session
// stream immediately when a command is accepted (edit_resend first prepends a
// rebase event).
func BuildAcceptedCommandPayloads(
	body handler.ChatRequestBody,
	baseMessageRef *MessageRef,
) []map[string]any {
	payloads := make([]map[string]any, 0, 2)
	if baseMessageRef != nil {
		payloads = append(payloads, map[string]any{
			"type":             session.StreamEventRebased,
			"base_message_ref": baseMessageRef,
			"reason":           "edit_resend",
		})
	}
	payloads = append(payloads, buildUserMessageAppendedPayload(body, baseMessageRef))
	return payloads
}

func buildUserMessageAppendedPayload(
	body handler.ChatRequestBody,
	baseMessageRef *MessageRef,
) map[string]any {
	payload := map[string]any{
		"type":                     "user_message",
		"message":                  body.Message,
		"uploaded_files":           body.UploadedFiles,
		"referenced_conversations": body.ReferencedConversations,
		"execution_mode":           body.ExecutionMode,
		"workdir":                  body.Workdir,
		"command_safety_mode":      body.CommandSafetyMode,
		"runtime_controls":         body.RuntimeControls,
		"selected_model":           body.SelectedModel,
	}
	if baseMessageRef != nil {
		payload["base_message_ref"] = baseMessageRef
		payload["reason"] = "edit_resend"
	}
	return payload
}

func buildCommandEnvelope(
	requestID string,
	commandType string,
	body handler.ChatRequestBody,
	baseMessageRef *MessageRef,
) *gatewayv2.GatewayEnvelope {
	return &gatewayv2.GatewayEnvelope{
		RequestId: strings.TrimSpace(requestID),
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv2.GatewayEnvelope_ChatCommand{
			ChatCommand: &gatewayv2.ChatCommandRequest{
				Type:           strings.TrimSpace(commandType),
				Request:        buildProtoRequest(body),
				BaseMessageRef: BuildProtoMessageRef(baseMessageRef),
			},
		},
	}
}

// BuildCancelCommandPayload builds the GatewayEnvelope payload arm for chat.cancel.
func BuildCancelCommandPayload(conversationID string) *gatewayv2.GatewayEnvelope_ChatCommand {
	return &gatewayv2.GatewayEnvelope_ChatCommand{
		ChatCommand: &gatewayv2.ChatCommandRequest{
			Type: "chat.cancel",
			Cancel: &gatewayv2.CancelChatRequest{
				ConversationId: strings.TrimSpace(conversationID),
			},
		},
	}
}

func buildProtoRequest(body handler.ChatRequestBody) *gatewayv2.ChatRequest {
	return &gatewayv2.ChatRequest{
		ConversationId:          body.ConversationID,
		ClientRequestId:         body.ClientRequestID,
		Message:                 body.Message,
		SelectedModel:           handler.ToProtoChatSelectedModel(body.SelectedModel),
		RuntimeControls:         handler.ToProtoChatRuntimeControls(body.RuntimeControls),
		ExecutionMode:           body.ExecutionMode,
		Workdir:                 body.Workdir,
		CommandSafetyMode:       body.CommandSafetyMode,
		UploadedFiles:           handler.ToProtoChatUploadedFiles(body.UploadedFiles),
		ReferencedConversations: handler.ToProtoChatConversationReferences(body.ReferencedConversations),
		QueuePolicy:             body.QueuePolicy,
	}
}

// BuildProtoMessageRef converts a MessageRef to its proto representation (nil-safe).
func BuildProtoMessageRef(ref *MessageRef) *gatewayv2.ChatMessageRef {
	if ref == nil {
		return nil
	}
	return &gatewayv2.ChatMessageRef{
		SegmentIndex: int32(ref.SegmentIndex),
		MessageIndex: int32(ref.MessageIndex),
		SegmentId:    strings.TrimSpace(ref.SegmentID),
		MessageId:    strings.TrimSpace(ref.MessageID),
		Role:         strings.TrimSpace(ref.Role),
		ContentHash:  strings.TrimSpace(ref.ContentHash),
	}
}

// RequestBodyFromProto reconstructs the orchestration-layer request body from the
// proto ChatRequest carried directly by v2 (the inverse of buildProtoRequest;
// callers then uniformly run NormalizeRequestBody).
func RequestBodyFromProto(req *gatewayv2.ChatRequest) handler.ChatRequestBody {
	if req == nil {
		return handler.ChatRequestBody{}
	}
	body := handler.ChatRequestBody{
		ConversationID:    req.GetConversationId(),
		ClientRequestID:   req.GetClientRequestId(),
		Message:           req.GetMessage(),
		ExecutionMode:     req.GetExecutionMode(),
		Workdir:           req.GetWorkdir(),
		CommandSafetyMode: req.GetCommandSafetyMode(),
		QueuePolicy:       req.GetQueuePolicy(),
	}
	for _, reference := range req.GetReferencedConversations() {
		body.ReferencedConversations = append(
			body.ReferencedConversations,
			handler.ChatConversationReferenceBody{
				ID:        reference.GetId(),
				Title:     reference.GetTitle(),
				Cwd:       reference.GetCwd(),
				UpdatedAt: reference.GetUpdatedAt(),
			},
		)
	}
	if selected := req.GetSelectedModel(); selected != nil {
		body.SelectedModel = &handler.ChatSelectedModelBody{
			CustomProviderID: selected.GetCustomProviderId(),
			Model:            selected.GetModel(),
			ProviderType:     selected.GetProviderType(),
		}
	}
	if controls := req.GetRuntimeControls(); controls != nil {
		thinking := controls.GetThinkingEnabled()
		webSearch := controls.GetNativeWebSearchEnabled()
		planMode := controls.GetPlanModeEnabled()
		body.RuntimeControls = &handler.ChatRuntimeControlsBody{
			ThinkingEnabled:        &thinking,
			NativeWebSearchEnabled: &webSearch,
			Reasoning:              controls.GetReasoning(),
			PlanModeEnabled:        &planMode,
		}
	}
	for _, file := range req.GetUploadedFiles() {
		body.UploadedFiles = append(body.UploadedFiles, handler.ChatUploadedFileBody{
			RelativePath: file.GetRelativePath(),
			AbsolutePath: file.GetAbsolutePath(),
			FileName:     file.GetFileName(),
			Kind:         file.GetKind(),
			SizeBytes:    file.GetSizeBytes(),
		})
	}
	return body
}

// MessageRefFromProto reconstructs the orchestration-layer representation from a
// proto message reference (nil-safe).
func MessageRefFromProto(ref *gatewayv2.ChatMessageRef) *MessageRef {
	if ref == nil {
		return nil
	}
	return &MessageRef{
		SegmentIndex: int(ref.GetSegmentIndex()),
		MessageIndex: int(ref.GetMessageIndex()),
		SegmentID:    ref.GetSegmentId(),
		MessageID:    ref.GetMessageId(),
		Role:         ref.GetRole(),
		ContentHash:  ref.GetContentHash(),
	}
}

// ValidateMessageRef validates and normalizes a message reference (in-place trim).
func ValidateMessageRef(ref *MessageRef) error {
	if ref == nil {
		return nil
	}
	if ref.SegmentIndex < 0 || ref.MessageIndex < 0 {
		return errors.New("base_message_ref indexes must be non-negative")
	}
	ref.SegmentID = strings.TrimSpace(ref.SegmentID)
	ref.MessageID = strings.TrimSpace(ref.MessageID)
	ref.Role = strings.TrimSpace(ref.Role)
	ref.ContentHash = strings.TrimSpace(ref.ContentHash)
	if ref.SegmentID == "" || ref.MessageID == "" || ref.Role == "" || ref.ContentHash == "" {
		return errors.New("base_message_ref requires segment_id, message_id, role, and content_hash")
	}
	if ref.Role != "user" {
		return errors.New("base_message_ref role must be user")
	}
	return nil
}
