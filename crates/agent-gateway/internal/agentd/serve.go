package agentd

// Wiring and small shared helpers.

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strconv"
	"strings"

	"google.golang.org/protobuf/proto"
)

// Serve is the whole agentd in one call: validate the config, build the
// pieces, connect to the gateway and run until ctx ends. It is the single
// entry point the command and the tests share.
func Serve(ctx context.Context, cfg *Config, logger *slog.Logger) error {
	if err := cfg.Validate(); err != nil {
		return err
	}
	provider := NewProvider(cfg.ProviderURL, cfg.ProviderKey, cfg.ProviderModel,
		cfg.MaxTokens, cfg.RequestTimeout)
	tools := NewToolset(cfg.Workdir, cfg.ShellEnabled, cfg.FetchEnabled)
	SetCommandTimeout(cfg.CommandTimeout)

	client := NewClient(cfg, logger, nil, nil, nil, nil)
	runner := NewRunner(cfg, provider, tools, client, logger)
	client.onCommand = runner.SubmitChatCommand
	client.onCancel = runner.CancelConversation
	client.onDisconnect = func() { runner.DropAll("gateway link lost") }
	client.activeRuns = runner.ActiveRuns

	runner.Start(ctx, cfg.Concurrency)
	logger.Info("reactorpro agentd starting",
		"agent_id", cfg.AgentID, "gateway", cfg.GatewayURL,
		"model", cfg.ProviderModel, "workdir", cfg.Workdir,
		"concurrency", cfg.Concurrency,
		"tools", toolNames(tools))
	return client.Run(ctx)
}

func toolNames(tools *Toolset) string {
	names := make([]string, 0, 4)
	for _, tool := range tools.Tools() {
		names = append(names, tool.Name)
	}
	return strings.Join(names, ",")
}

// encodeProto / decodeProto wrap the protobuf codec so callers stay tidy.
func encodeProto(message proto.Message) ([]byte, error) {
	return proto.Marshal(message)
}

func decodeProto(raw []byte, message proto.Message) error {
	if err := proto.Unmarshal(raw, message); err != nil {
		return err
	}
	return nil
}

// decodeJSON is the tolerant argument reader: tool arguments arrive as the
// model wrote them, which is "usually JSON".
func decodeJSON(raw string, into any) error {
	return json.Unmarshal([]byte(raw), into)
}

// oneLine flattens a transcript fragment to a single legible line, capped —
// transcript entries are context for humans reading the conversation, not
// the full payload (the model already has the tool result verbatim).
func oneLine(text string, limit int) string {
	flat := strings.Join(strings.Fields(text), " ")
	if len(flat) <= limit {
		return flat
	}
	cut := limit
	for cut > 0 && !isRuneStartByte(flat[cut]) {
		cut--
	}
	return flat[:cut] + "…"
}

func isRuneStartByte(b byte) bool { return b&0xC0 != 0x80 }

func errStringOf(err error) string {
	if err == nil {
		return "unknown"
	}
	return err.Error()
}

func parseInt(raw string) (int, error) {
	return strconv.Atoi(strings.TrimSpace(raw))
}

// fmt import guard — the format helpers above are used across files; keep the
// compiler honest if an edit removes the last use in this file.
var _ = fmt.Sprintf
