"use strict";

const HOOK_GUIDE = "https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks";
const HOOK_EXPLANATION = "Clawd scripts update the character when Codex starts, uses a tool, or finishes, on the same computer or SSH host. They send session activity and working-folder details to Clawd on that host. For an approval request, they also send the requested tool and its inputs so you can review them. Allow or Deny applies to that request only.\n\n1. In Codex, choose Review hooks (CLI: /hooks).\n2. Find entries named Clawd. In Details, verify the command points to this extension's vendor/clawd/hooks/codex-hook.js.\n3. Select those entries and choose Allow selected. Other hooks belong to other tools.\n\nBasic activity tracking is available without hook approval. If the list still shows old entries, reload this VS Code window (or restart the CLI) first. Updated hook definitions may need another review.";

function connectionItems(status) {
  const items = [];
  if (!status.enabled) items.push({ label: "$(debug-start) Resume Clawd", detail: "Activity tracking and approval cards are paused.", action: "resume" });
  else if (status.running === false) items.push({ label: "$(debug-restart) Restart Clawd", detail: "The activity connection is not running. Restart it to try connecting again.", action: "restart" });
  if (status.selectedAgents.includes("claude-code")) items.push({
    label: "Claude Code",
    description: status.claudeObserved ? "Live events received" : status.installedAgents.includes("claude-code") ? "Set up · waiting for activity" : "Setup needed",
    detail: "Updates the character as Claude works. Start a new Claude session after setup.", action: "claude",
  });
  if (status.selectedAgents.includes("codex")) {
    const codex = status.codex;
    items.push({
      label: "Codex",
      description: codex.disabledInUserConfig ? "Hooks disabled in Codex settings"
        : codex.hookObserved ? "Live events received" : codex.logFallbackRunning ? "Basic activity tracking" : "Waiting for a connection",
      detail: codex.disabledInUserConfig ? "Enable lifecycle hooks in your Codex configuration on this host, restart Codex, then review the Clawd entries. Review alone does not enable disabled hooks."
        : codex.hookObserved ? "Native hooks have reached this window. Approval cards appear only for actual permission requests."
        : codex.installed ? "Hooks are installed. Start a Codex task to check live events. If Codex shows Review hooks, review the Clawd entries there."
          : "Logs can animate the character. Set up and review hooks for live events and approval cards.", action: codex.disabledInUserConfig ? "codex-disabled" : "codex",
    });
  }
  items.push(
    { label: "What does Review hooks allow?", detail: "Learn what runs, what data is used, and which entries belong to Clawd.", action: "explain" },
    { label: "Set Up Agent Connections…", detail: "Choose agents and install their Clawd connections on this host.", action: "setup" },
    { label: "Open Diagnostics", detail: "Connection details for troubleshooting.", action: "diagnostics" },
  );
  return items;
}

async function showConnectionHelp(vscode, runtime) {
  const picked = await vscode.window.showQuickPick(connectionItems(runtime.connectionStatus()), {
    title: "Clawd · Agent Connections", placeHolder: "Choose a connection to see its status and next step", matchOnDetail: true,
  });
  if (!picked) return;
  if (picked.action === "resume") return runtime.resume();
  if (picked.action === "restart") return runtime.restart();
  if (picked.action === "setup") return vscode.commands.executeCommand("clawd.installIntegrations");
  if (picked.action === "diagnostics") return runtime.diagnostics();
  if (picked.action === "codex-disabled") {
    const action = await vscode.window.showInformationMessage("Codex lifecycle hooks are disabled in your user settings", {
      modal: true,
      detail: "To enable live events and approval cards, open Codex's config.toml on this computer or SSH host. Set hooks = true in the [features] section (features.hooks), then restart Codex and review the Clawd entries in Review hooks (CLI: /hooks). Reviewing entries while hooks are disabled will not activate them. Basic log tracking can still be used when enabled in Clawd.",
    }, "Official Guide");
    if (action === "Official Guide") return vscode.env.openExternal(vscode.Uri.parse("https://learn.chatgpt.com/docs/hooks#turn-hooks-off"));
    return;
  }
  if (picked.action === "claude") {
    const action = await vscode.window.showInformationMessage("Claude Code uses Clawd's installed event scripts on this host. Start a new Claude session after setup. The character reacts to activity, and approval requests remain with Claude whenever Clawd is hidden or paused.", "Set Up Connections");
    if (action) return vscode.commands.executeCommand("clawd.installIntegrations");
    return;
  }
  const action = await vscode.window.showInformationMessage("Let Clawd follow your Codex work", { modal: true, detail: HOOK_EXPLANATION }, "Open Codex", "Official Guide");
  if (action === "Official Guide") return vscode.env.openExternal(vscode.Uri.parse(HOOK_GUIDE));
  if (action === "Open Codex") {
    const commands = await vscode.commands.getCommands(true);
    if (commands.includes("chatgpt.openSidebar")) {
      await vscode.commands.executeCommand("chatgpt.openSidebar");
      void vscode.window.showInformationMessage("In Codex, choose Review hooks and inspect Details. Select only the Clawd codex-hook.js entries, then Allow selected.");
    } else void vscode.window.showInformationMessage("Open your Codex CLI and type /hooks. Review the Clawd codex-hook.js entries there.");
  }
}

module.exports = { HOOK_GUIDE, HOOK_EXPLANATION, connectionItems, showConnectionHelp };
