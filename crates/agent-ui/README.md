# `@liveagent/ui`

`agent-ui` is the application UI source shared by the GUI and WebUI, not a component library holding only base components.

## Directory responsibilities

- `src/application/`: shared application views and the page routing framework.
- `src/pages/`: complete shared pages such as settings, Skills, and MCP.
- `src/components/`: shared UI such as the chat sidebar, composer, project tools, and editor.
- `src/contracts/`: shared contracts such as the extension registry for the shared UI.
- `src/i18n/`: translation fragments and localization context used by both ends.

The GUI and WebUI applications are only responsible for:

- starting and mounting the React app;
- preparing business state, protocol data, and callbacks;
- implementing the capabilities the shared UI needs in their own `src/agent-ui-adapters/`;
- registering pages or features owned only by that application.

`ApplicationView` directly creates the Skills Hub, MCP Hub, and chat top bar. GUI/WebUI must not import and assemble these shared pages again; they only provide it with settings, model state, event callbacks, and protocol-related chat content controllers. This way changes to the shared application structure happen only in `agent-ui`, and JSX is not maintained separately at the two entry points.

## `@liveagent/app`

`@liveagent/app` is not an npm package, so it does not appear in `package.json`'s dependency list. It is a build-time alias:

- GUI maps it to `crates/agent-gui/src`;
- WebUI maps it to `crates/agent-gateway/web/src`.

The shared UI reads the current application's business types and general implementations through this alias. GUI builds point to GUI, WebUI builds point to WebUI.

## `@liveagent/adapters`

`@liveagent/adapters` points specifically to the current application's `src/agent-ui-adapters/`, for differentiated implementations such as directory selection, clipboard, title bar, and SSH client. The shared UI does not directly import concrete Tauri or Gateway implementations.

## Application-specific features

Application-specific features live in the corresponding application directory and are wired into shared pages through the extension registry or adapters. For example:

- GUI: global shortcuts, About page, desktop title bar, native clipboard;
- WebUI: device management, browser file capabilities, gateway connection status.

Shared UI such as provider settings, chat sidebar, chat top bar, empty-conversation page, tool arguments, todo list, assistant status, context checkpoints, retry details, context usage, web search group, and Diff view is likewise kept in a single copy in `agent-ui`; the GUI's CC Switch/Cherry Studio import is
injected by `src/agent-ui-adapters/providerSettings.tsx`, and the WebUI uses a same-named empty adapter. The chat sidebar's desktop title bar,
app update button, and system file manager entry are injected by the GUI's `src/agent-ui-adapters/sidebarChrome.tsx`.
Assistant avatar assets are provided by `src/agent-ui-adapters/assistantAvatar.ts` on both ends, and shared components are unaware of Tauri asset paths or the web public directory.

Do not copy a complete shared page into an application directory and then make small modifications; differences should be narrowed into `agent-ui-adapters/*` or application-specific feature components.
