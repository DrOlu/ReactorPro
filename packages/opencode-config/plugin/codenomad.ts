import type { PluginInput } from "@opencode-ai/plugin"
import { createReactorProClient, getReactorProConfig } from "./lib/client"
import { createBackgroundProcessTools } from "./lib/background-process"

export async function ReactorProPlugin(input: PluginInput) {
  const config = getReactorProConfig()
  const client = createReactorProClient(config)
  const backgroundProcessTools = createBackgroundProcessTools(config, { baseDir: input.directory })

  await client.startEvents((event) => {
    if (event.type === "reactorpro.ping") {
      void client.postEvent({
        type: "reactorpro.pong",
        properties: {
          ts: Date.now(),
          pingTs: (event.properties as any)?.ts,
        },
      }).catch(() => {})
    }
  })

  return {
    tool: {
      ...backgroundProcessTools,
    },
    async event(input: { event: any }) {
      const opencodeEvent = input?.event
      if (!opencodeEvent || typeof opencodeEvent !== "object") return

    },
  }
}
