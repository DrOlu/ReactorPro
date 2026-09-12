package pbws

import (
	"errors"
	"strings"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/protocol/shared"
	"github.com/liveagent/agent-gateway/internal/session"
)

// Passthrough allowlist and limit validation: this file precisely delimits the operations the browser
// may initiate -- payload arms not on the allowlist (internal push arms, chat_command which must go
// through gateway orchestration, ping, etc.) are rejected outright; feature-flag gating and field
// limits are applied before forwarding; post-processing of list-type responses runs via the finalize hook.

const (
	maxHistoryListLimit        = 200
	defaultHistoryListPage     = 1
	defaultHistoryListPageSize = 80
	maxWorkspaceRootGrants     = 64
)

// vetAgentRequest validates a passthrough request and (when necessary) corrects it in place; returning
// an error rejects forwarding, and the error message is client-facing.
// Gating is decided against the target Agent's view (sm is a read-only view bound to agent_id).
func vetAgentRequest(sm session.AgentView, env *gatewayv2.GatewayEnvelope) error {
	switch payload := env.GetPayload().(type) {
	case nil:
		return errors.New("agent_request payload is required")

	// ---- Plain passthrough arms (no gating) ----
	case *gatewayv2.GatewayEnvelope_HistoryList:
		clampHistoryList(payload.HistoryList)
		return nil
	case *gatewayv2.GatewayEnvelope_HistoryGet,
		*gatewayv2.GatewayEnvelope_HistoryRename,
		*gatewayv2.GatewayEnvelope_HistoryDelete,
		*gatewayv2.GatewayEnvelope_HistoryPrefix,
		*gatewayv2.GatewayEnvelope_HistoryPin,
		*gatewayv2.GatewayEnvelope_HistorySetCwd,
		*gatewayv2.GatewayEnvelope_HistoryShareGet,
		*gatewayv2.GatewayEnvelope_HistoryShareSet,
		*gatewayv2.GatewayEnvelope_HistoryWorkdirs,
		*gatewayv2.GatewayEnvelope_HistoryBranch,
		*gatewayv2.GatewayEnvelope_ProviderList,
		*gatewayv2.GatewayEnvelope_ProviderUsage,
		*gatewayv2.GatewayEnvelope_ProviderModels,
		*gatewayv2.GatewayEnvelope_SettingsGet,
		*gatewayv2.GatewayEnvelope_SettingsUpdate,
		*gatewayv2.GatewayEnvelope_SettingsResetSshKnownHost,
		*gatewayv2.GatewayEnvelope_SkillFilesList,
		*gatewayv2.GatewayEnvelope_SkillMetadataRead,
		*gatewayv2.GatewayEnvelope_SkillTextRead,
		*gatewayv2.GatewayEnvelope_SkillManage,
		*gatewayv2.GatewayEnvelope_FileMentionList,
		// Installed-apps list (@ app mentions): read-only host capability; what the
		// desktop returns is decided by the desktop itself (enumeration implementation
		// lives in services/cua_driver/installed_apps.rs).
		*gatewayv2.GatewayEnvelope_InstalledAppsList,
		*gatewayv2.GatewayEnvelope_UploadedImagePreview,
		*gatewayv2.GatewayEnvelope_MemoryManage,
		*gatewayv2.GatewayEnvelope_CronManage,
		*gatewayv2.GatewayEnvelope_FsRoots,
		*gatewayv2.GatewayEnvelope_FsListDirs,
		*gatewayv2.GatewayEnvelope_FsCreateProjectFolder,
		*gatewayv2.GatewayEnvelope_FsList,
		*gatewayv2.GatewayEnvelope_FsWriteText,
		*gatewayv2.GatewayEnvelope_FsCreateDir,
		*gatewayv2.GatewayEnvelope_FsRename,
		*gatewayv2.GatewayEnvelope_FsDelete,
		*gatewayv2.GatewayEnvelope_FsReadEditableText,
		*gatewayv2.GatewayEnvelope_FsReadWorkspaceImage,
		// Trajectory is read-only: it carries no write capability and does not touch
		// the workspace, so it can pass straight through.
		*gatewayv2.GatewayEnvelope_TrajectoryFetch,
		*gatewayv2.GatewayEnvelope_ChatQueue,
		// Clarify turn: a plain-text completion, its payload is forwarded to the
		// desktop to execute, with no gateway-side gating.
		*gatewayv2.GatewayEnvelope_ClarifyTurn:
		return nil
	case *gatewayv2.GatewayEnvelope_ChatFileOpen:
		return vetChatFileOpen(payload.ChatFileOpen)
	case *gatewayv2.GatewayEnvelope_WorkspaceRootGrants:
		return vetWorkspaceRootGrants(payload.WorkspaceRootGrants)
	case *gatewayv2.GatewayEnvelope_Checkpoint:
		return vetCheckpoint(payload.Checkpoint)
	case *gatewayv2.GatewayEnvelope_CuaDriver:
		return vetCuaDriver(payload.CuaDriver)

	// ---- Passthrough arms with feature gating / limits ----
	case *gatewayv2.GatewayEnvelope_GitRequest:
		action := strings.TrimSpace(payload.GitRequest.GetAction())
		if gitActionIsWrite(action) && !sm.WebGitEnabled() {
			return errors.New("web git is disabled in desktop Remote settings")
		}
		return nil
	case *gatewayv2.GatewayEnvelope_TerminalRequest:
		req := payload.TerminalRequest
		action := strings.TrimSpace(req.GetAction())
		if !shared.TerminalRequestAllowed(sm, action, strings.TrimSpace(req.GetSessionId())) {
			return errors.New(shared.TerminalPermissionError(action))
		}
		return nil
	case *gatewayv2.GatewayEnvelope_SftpRequest:
		if !sm.WebSshTerminalEnabled() {
			return errors.New("web SSH SFTP is disabled in desktop Remote settings")
		}
		return nil
	case *gatewayv2.GatewayEnvelope_TunnelMutation:
		if !sm.WebTunnelsEnabled() {
			return errors.New("web tunnels are disabled in desktop Remote settings")
		}
		return nil
	case *gatewayv2.GatewayEnvelope_ManagedProcessRequest:
		req := payload.ManagedProcessRequest
		action := strings.TrimSpace(req.GetAction())
		if strings.TrimSpace(req.GetProcessId()) == "" && action != "clear" && action != "snapshot" {
			return errors.New("process_id is required")
		}
		return nil

	// ---- Explicitly rejected arms ----
	default:
		// Includes chat_command (must go through gateway orchestration), ping (liveness
		// probing is initiated by the gateway), upload_readable_files (goes through the HTTP
		// upload path), history_share_resolve (dedicated to the public share endpoint), and
		// the gateway's internal push arms.
		return errors.New("unsupported agent_request payload")
	}
}

// vetCuaDriver only allows the two read-only actions from the Computer Use settings page. Installation
// (running an install script with network access on the host) and authorization (raising a macOS TCC
// dialog on the host screen) are local desktop actions -- the browser side cannot confirm the full
// command nor click the dialog, so they are never sent through the gateway; the desktop-side
// handle_cua_driver keeps the same allowlist as a fallback.
func vetCuaDriver(req *gatewayv2.CuaDriverRequest) error {
	switch strings.TrimSpace(req.GetAction()) {
	case "probe", "permissions_status":
		return nil
	default:
		return errors.New("unsupported cua_driver action")
	}
}

func vetCheckpoint(req *gatewayv2.CheckpointRequest) error {
	if req == nil || strings.TrimSpace(req.GetConversationId()) == "" || len(req.GetConversationId()) > 256 {
		return errors.New("checkpoint conversation_id is invalid")
	}
	switch strings.TrimSpace(req.GetAction()) {
	case "list":
		if req.GetTurnSeq() != 0 || len(req.GetAuthorizedRoots()) != 0 || len(req.GetExpected()) != 0 {
			return errors.New("checkpoint list payload is invalid")
		}
	case "diff":
		if req.GetTurnSeq() == 0 || len(req.GetExpected()) != 0 {
			return errors.New("checkpoint diff payload is invalid")
		}
	case "rewind":
		if req.GetTurnSeq() == 0 {
			return errors.New("checkpoint rewind turn_seq is required")
		}
	default:
		return errors.New("checkpoint action is invalid")
	}
	if len(req.GetAuthorizedRoots()) > 64 {
		return errors.New("too many checkpoint authorized roots")
	}
	for _, root := range req.GetAuthorizedRoots() {
		if strings.TrimSpace(root) == "" || len(root) > 32768 {
			return errors.New("checkpoint authorized root is invalid")
		}
	}
	if len(req.GetExpected()) > 10_000 {
		return errors.New("too many checkpoint expected entries")
	}
	for _, entry := range req.GetExpected() {
		if entry == nil ||
			strings.TrimSpace(entry.GetKey()) == "" ||
			len(entry.GetKey()) > 65536 ||
			strings.TrimSpace(entry.GetCurrentHash()) == "" ||
			len(entry.GetCurrentHash()) > 256 {
			return errors.New("checkpoint expected entry is invalid")
		}
	}
	return nil
}

func vetWorkspaceRootGrants(req *gatewayv2.WorkspaceRootGrantsRequest) error {
	if req == nil {
		return errors.New("workspace root grants request is required")
	}
	if strings.TrimSpace(req.GetProjectId()) == "" || len(req.GetProjectId()) > 256 {
		return errors.New("workspace root grants project_id is invalid")
	}
	switch strings.TrimSpace(req.GetAction()) {
	case "list":
		if strings.TrimSpace(req.GetProjectPath()) == "" || len(req.GetProjectPath()) > 32768 {
			return errors.New("workspace root grants project_path is invalid")
		}
		if len(req.GetGrants()) != 0 {
			return errors.New("workspace root grants list cannot include drafts")
		}
		return nil
	case "apply":
		if strings.TrimSpace(req.GetProjectPath()) == "" || len(req.GetProjectPath()) > 32768 {
			return errors.New("workspace root grants project_path is invalid")
		}
		if len(req.GetGrants()) > maxWorkspaceRootGrants {
			return errors.New("too many workspace root grants")
		}
	case "revoke":
		if strings.TrimSpace(req.GetProjectPath()) != "" {
			return errors.New("workspace root grants revoke cannot include project_path")
		}
		if len(req.GetGrants()) != 0 {
			return errors.New("workspace root grants revoke cannot include drafts")
		}
		return nil
	default:
		return errors.New("workspace root grants action is invalid")
	}

	for _, grant := range req.GetGrants() {
		if grant == nil || strings.TrimSpace(grant.GetAlias()) == "" || len(grant.GetAlias()) > 32 {
			return errors.New("workspace root grant alias is invalid")
		}
		if strings.TrimSpace(grant.GetDisplayPath()) == "" || len(grant.GetDisplayPath()) > 32768 {
			return errors.New("workspace root grant display_path is invalid")
		}
		if grant.Id != nil && (strings.TrimSpace(grant.GetId()) == "" || len(grant.GetId()) > 256) {
			return errors.New("workspace root grant id is invalid")
		}
		switch strings.TrimSpace(grant.GetAccess()) {
		case "read", "write":
		default:
			return errors.New("workspace root grant access is invalid")
		}
	}
	return nil
}

func vetChatFileOpen(req *gatewayv2.ChatFileOpenRequest) error {
	if req == nil || strings.TrimSpace(req.GetConversationId()) == "" || len(req.GetConversationId()) > 256 {
		return errors.New("conversation is unavailable")
	}
	if strings.TrimSpace(req.GetWorkdir()) == "" || strings.TrimSpace(req.GetPath()) == "" {
		return errors.New("linked file request is incomplete")
	}
	if len(req.GetWorkdir()) > 32768 || len(req.GetPath()) > 32768 {
		return errors.New("linked file request is too large")
	}
	switch strings.TrimSpace(req.GetSource()) {
	case "absolute", "relative", "file-url":
	default:
		return errors.New("linked file source is invalid")
	}
	if (req.Line != nil && req.GetLine() == 0) ||
		(req.EndLine != nil && req.GetEndLine() == 0) ||
		(req.Column != nil && req.GetColumn() == 0) {
		return errors.New("linked file location is invalid")
	}
	if req.Line == nil && (req.EndLine != nil || req.Column != nil) {
		return errors.New("linked file location is invalid")
	}
	if req.Line != nil && req.EndLine != nil && req.GetEndLine() < req.GetLine() {
		return errors.New("linked file location is invalid")
	}
	return nil
}

// gitActionIsWrite determines whether a passthrough git request is a write operation: write
// operations are gated by the desktop Remote setting enable_web_git, while read operations
// (status/log/diff, etc.) are always allowed.
func gitActionIsWrite(action string) bool {
	switch action {
	case "clone", "clone_start", "clone_cancel", "clone_dismiss", "init", "switch_branch", "create_branch", "create_worktree", "stage", "stage_all", "unstage", "unstage_all", "discard", "discard_all", "add_to_gitignore", "commit", "fetch", "pull", "set_remote", "push", "delete_branch", "rename_branch", "remove_worktree", "stash_push", "stash_pop":
		return true
	default:
		return false
	}
}

// clampHistoryList applies the pagination defaults and upper bounds for history lists.
func clampHistoryList(req *gatewayv2.HistoryListRequest) {
	if req == nil {
		return
	}
	if req.GetPage() <= 0 {
		req.Page = defaultHistoryListPage
	}
	if req.GetPageSize() <= 0 {
		req.PageSize = defaultHistoryListPageSize
	} else if req.GetPageSize() > maxHistoryListLimit {
		req.PageSize = maxHistoryListLimit
	}
}
