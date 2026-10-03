import type { EnvironmentId, ServerSettingsPatch } from "@t3tools/contracts";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { DraftInput } from "../ui/draft-input";
import { Switch } from "../ui/switch";
import { EnvironmentVariablesEditor } from "./EnvironmentVariablesEditor";
import { SettingsRow, SettingsSearchTarget, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";

/**
 * Sandbox hosting for one environment. Sandboxes run on the machine that
 * creates them and their variables usually hold login tokens, so these
 * settings save to the selected environment only instead of fanning out.
 */
export function SandboxSettings() {
  const { scope, environment, connectedEnvironments } = useSettingsScope();
  if (scope.kind === "project" || scope.kind === "checkout") return null;
  const environmentId =
    environment?.connection.phase === "connected" ? environment.environmentId : null;
  const aggregate = scope.environmentIds.length !== 1 && connectedEnvironments.length > 1;
  return (
    <SettingsSection
      id={searchableSetting("sandboxes").id}
      title={aggregate && environment ? `Sandboxes · ${environment.label}` : "Sandboxes"}
    >
      {environmentId === null ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">
          Connect an environment to host sandboxes on it.
        </p>
      ) : (
        // Drafts belong to one environment; switching must not carry them over.
        <SandboxControls key={environmentId} environmentId={environmentId} />
      )}
    </SettingsSection>
  );
}

function SandboxControls({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const settings = useEnvironmentSettings(environmentId);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "save sandbox settings",
  });
  const save = (patch: ServerSettingsPatch) => {
    void updateSettings({ environmentId, input: { patch } });
  };

  return (
    <>
      <SettingsRow
        {...searchableSetting("sandboxes-enabled")}
        description="Create sandboxes on this machine with Docker, each a separate environment for one task. Docker access amounts to root on this machine."
        control={
          <Switch
            checked={settings.enableSandboxes}
            onCheckedChange={(checked) => save({ enableSandboxes: Boolean(checked) })}
            aria-label="Host sandboxes"
          />
        }
      />
      {settings.enableSandboxes ? (
        <>
          <SettingsRow
            {...searchableSetting("sandbox-image")}
            description="Docker image each new sandbox runs."
            control={
              <DraftInput
                size="sm"
                font="mono"
                className="w-full sm:w-56"
                value={settings.sandboxImage}
                onCommit={(value) => {
                  const image = value.trim();
                  if (image && image !== settings.sandboxImage) save({ sandboxImage: image });
                }}
                spellCheck={false}
                aria-label="Sandbox image"
              />
            }
          />
          <SettingsRow
            {...searchableSetting("sandbox-address")}
            description="Where sandboxes accept connections. Loopback serves this machine only; use its LAN or Tailscale address to reach sandboxes from other devices."
            control={
              <DraftInput
                size="sm"
                font="mono"
                className="w-full sm:w-56"
                value={settings.sandboxPublishHost}
                onCommit={(value) => {
                  const host = value.trim();
                  if (host && host !== settings.sandboxPublishHost) {
                    save({ sandboxPublishHost: host });
                  }
                }}
                spellCheck={false}
                aria-label="Sandbox address"
              />
            }
          />
          <SettingsSearchTarget id={searchableSetting("sandbox-variables").id}>
            <EnvironmentVariablesEditor
              description="Every new sandbox starts with these, such as CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`. Sandboxes keep the values they were created with."
              environment={settings.sandboxEnvironment}
              onChange={(sandboxEnvironment) => save({ sandboxEnvironment })}
            />
          </SettingsSearchTarget>
        </>
      ) : null}
    </>
  );
}
