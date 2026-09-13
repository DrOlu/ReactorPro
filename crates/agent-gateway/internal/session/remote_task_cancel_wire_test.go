package session_test

import (
	"testing"

	"github.com/liveagent/agent-gateway/internal/chatcmd"
	"github.com/liveagent/agent-gateway/internal/session"
)

// The session package builds the remote-task cancel command itself rather than
// calling chatcmd.BuildCancelCommandPayload, because chatcmd imports handler and
// handler imports session, so importing chatcmd from session is an import cycle.
// That leaves the wire string duplicated, and this is the assertion that keeps
// the two copies in step: if the browser's cancel command ever changes its type
// string, remote-task cancellation would silently stop cancelling anything, and
// a peer that gave up would leave a turn running on someone's machine.
//
// It lives in an external test package precisely so it can import both sides
// without recreating the cycle it exists to guard.
func TestRemoteTaskCancelMatchesBrowserCancelWireFormat(t *testing.T) {
	browser := chatcmd.BuildCancelCommandPayload("conv-42").ChatCommand
	if browser == nil {
		t.Fatal("chatcmd built no cancel command")
	}
	if got, want := browser.GetType(), session.RemoteTaskCancelCommandType; got != want {
		t.Fatalf("browser cancel type = %q but remote task sends %q: the duplicated wire string has drifted",
			got, want)
	}
	if got := browser.GetCancel().GetConversationId(); got != "conv-42" {
		t.Fatalf("browser cancel conversation = %q, want conv-42", got)
	}
}
