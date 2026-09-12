# External Link Confirmation Preference

Markdown external links show an "Open external link" dialog by default. After checking "Don't remind me again" at the bottom and clicking "Open link", the current link opens normally, and all subsequent Markdown external links are handed directly to the current platform's opener; the desktop uses the default browser, and WebUI uses a new tab.

The preference is saved only when opening is confirmed. Copying the link, closing the dialog, or pressing Esc does not save it, and the next time the dialog opens the checkbox is back to unchecked. File link navigation, read-only Markdown, and incomplete streaming links continue to follow the original rules.

The preference is read by the shared `agent-ui` component and saved under the local `localStorage` key `liveagent:skip-external-link-confirmation:v1`, so it persists across refreshes/restarts and immediately affects other links already rendered in the current interface. It belongs to the current app/browser site and does not sync across devices or to a remote Agent; clearing app/site data restores the default reminder. When storage is unavailable it degrades to being valid only for the current run, without preventing links from opening.

Regression test: `crates/agent-gui/test/chat/external-link-preference.test.mjs`, covering default confirmation, cancel/copy not saving, confirmation persistence, cross-link effect, module reload, storage unavailable, and opener fallback.