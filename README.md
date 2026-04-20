# Clawd for VS Code

Clawd for VS Code is a workspace extension that brings the Clawd on Desk agent-status experience into the VS Code sidebar. It runs the Clawd state server inside the VS Code extension host, which lets local workspaces and Remote-SSH sessions report coding-agent activity without a separate desktop tunnel.

The extension renders an animated Clawd or Calico pet in the Activity Bar view, tracks supported agent sessions, shows permission and notification prompts in the sidebar, and can sync the same agent hook/plugin integrations used by Clawd on Desk.

## Features

- Sidebar Clawd view with live state, session, and server status.
- Built-in Clawd and Calico themes vendored from Clawd on Desk.
- Workspace-hosted runtime for local and Remote-SSH extension hosts.
- Codex CLI and Gemini CLI log monitoring.
- Hook/plugin sync for Claude Code, Gemini CLI, Cursor Agent, CodeBuddy, Kiro CLI, and opencode.
- Permission handling for supported agents, including opencode once/always replies and Claude Code-style permission responses.
- Do Not Disturb, theme switching, runtime restart, and terminal focus actions from the view or command palette.

## Installation

Install the packaged VSIX from this folder:

```bash
code --install-extension clawd-for-vscode-0.1.0.vsix
```

Or package a fresh VSIX locally:

```bash
npm install
npm run package
```

Open the **Clawd** view from the VS Code Activity Bar after installation. Use **Clawd: Install Agent Integrations** to sync supported agent hooks/plugins on the machine where the extension host is running.

## Development

```bash
npm install
npm run check
npm test
```

Open this folder in VS Code and press `F5` to launch an Extension Development Host. The extension activates on startup, when the Clawd view opens, or when one of its commands is invoked.

## Acknowledgments

This extension is based on and vendors runtime, hook, agent, theme, sound, and artwork assets from [Clawd on Desk](https://github.com/rullerzhou-afk/clawd-on-desk) by [@rullerzhou-afk](https://github.com/rullerzhou-afk).

Clawd on Desk credits the Clawd pixel art reference to [clawd-tank](https://github.com/marciogranzotto/clawd-tank) by [@marciogranzotto](https://github.com/marciogranzotto), and was shared with the [LINUX DO](https://linux.do/) community.

The Clawd character is an unofficial fan project inspired by Anthropic's Claude branding. This extension is not affiliated with or endorsed by Anthropic.

## License

Source code is licensed under the MIT License. See `LICENSE`.

Vendored artwork and media assets are not covered by the MIT license. They remain reserved by their respective copyright holders; see `ASSETS-LICENSE` for details.
