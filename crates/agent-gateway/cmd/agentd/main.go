// reactorpro-agentd: the ReactorPro headless agent runtime.
//
// A single static binary that signs into a reactorpro-gateway as an attached
// agent — over the same /ws/v2/agent WebSocket the desktop uses — and serves
// remote chat turns with real tool use, several at a time. From the gateway's
// point of view it is indistinguishable from a desktop: a row in the local
// agent directory, addressed by name or capability, behind the same gates and
// the same audit trail. No gateway configuration changes to adopt it.
//
//	run:
//	  reactorpro-agentd -gateway ws://127.0.0.1:3000/ws/v2/agent \
//	    -agent-id agentd-server-1 -token <gateway-or-agent-token> \
//	    -provider-url https://api.openai.com/v1 -provider-key … \
//	    -provider-model gpt-5 -workdir /srv/agentd-work
//
// Every flag has an environment twin (LIVEAGENT_AGENTD_*). The agentd holds its
// own provider key by design: the gateway keeps its "no model keys, ever"
// property, and the executor is where execution belongs.
package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/liveagent/agent-gateway/internal/agentd"
)

func main() {
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	cfg := agentd.DefaultConfig()
	flags := flag.NewFlagSet("reactorpro-agentd", flag.ContinueOnError)
	cfg.RegisterFlags(flags)
	flags.Usage = func() {
		fmt.Fprintln(os.Stderr, "reactorpro-agentd — the ReactorPro headless agent runtime")
		fmt.Fprintln(os.Stderr)
		fmt.Fprintln(os.Stderr, "Signs into a reactorpro-gateway as an attached agent and serves")
		fmt.Fprintln(os.Stderr, "remote chat turns with real tool use, several in parallel.")
		fmt.Fprintln(os.Stderr)
		flags.PrintDefaults()
	}
	if err := flags.Parse(os.Args[1:]); err != nil {
		os.Exit(2)
	}

	// Shutdown: the OS signal ends the process context; live runs are
	// cancelled locally (their local work stops immediately) and the
	// gateway fails anything unreported at its own budget — the same honest
	// restart behaviour the gateway itself promises.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := agentd.Serve(ctx, &cfg, logger); err != nil {
		logger.Error("reactorpro-agentd stopped", "error", err)
		os.Exit(1)
	}
	logger.Info("reactorpro-agentd stopped")
}
