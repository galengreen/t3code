import type {
  EnvironmentId,
  SandboxBackend,
  SandboxSize,
  ServerSettingsPatch,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { sandboxEnvironment } from "../../state/sandbox";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
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
      title={aggregate && environment ? `Cubes · ${environment.label}` : "Cubes"}
    >
      {environmentId === null ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">
          Connect an environment to host cubes on it.
        </p>
      ) : (
        // Drafts belong to one environment; switching must not carry them over.
        <SandboxControls key={environmentId} environmentId={environmentId} />
      )}
    </SettingsSection>
  );
}

const BACKEND_LABELS: Record<SandboxBackend, string> = {
  docker: "This machine (Docker)",
  fly: "Fly.io",
};

const SLEEP_OPTIONS: ReadonlyArray<{ readonly minutes: number; readonly label: string }> = [
  { minutes: 10, label: "After 10 minutes" },
  { minutes: 20, label: "After 20 minutes" },
  { minutes: 60, label: "After 1 hour" },
  { minutes: 240, label: "After 4 hours" },
  { minutes: 0, label: "Never" },
];

const DELETE_OPTIONS: ReadonlyArray<{ readonly days: number; readonly label: string }> = [
  { days: 3, label: "After 3 days" },
  { days: 7, label: "After 7 days" },
  { days: 14, label: "After 14 days" },
  { days: 30, label: "After 30 days" },
  { days: 0, label: "Never" },
];

const sleepLabel = (minutes: number) =>
  SLEEP_OPTIONS.find((option) => option.minutes === minutes)?.label ?? `After ${minutes} minutes`;
const deleteLabel = (days: number) =>
  DELETE_OPTIONS.find((option) => option.days === days)?.label ?? `After ${days} days`;

const SIZE_LABELS: Record<SandboxSize, string> = {
  small: "Small · 2 vCPU, 2 GB",
  medium: "Medium · 4 vCPU, 8 GB",
  large: "Large · 4 dedicated vCPU, 8 GB",
};

function SandboxControls({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const settings = useEnvironmentSettings(environmentId);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "save sandbox settings",
  });
  const save = (patch: ServerSettingsPatch) => updateSettings({ environmentId, input: { patch } });
  const fly = settings.sandboxBackend === "fly";

  return (
    <>
      <SettingsRow
        {...searchableSetting("sandboxes-enabled")}
        description="Create cubes, each a separate environment for one task, with this machine's Docker or on Fly.io."
        control={
          <Switch
            checked={settings.enableSandboxes}
            onCheckedChange={(checked) => void save({ enableSandboxes: Boolean(checked) })}
            aria-label="Host cubes"
          />
        }
      />
      {settings.enableSandboxes ? (
        <>
          <SettingsRow
            {...searchableSetting("sandbox-backend")}
            description={
              fly
                ? "New cubes run as Fly Machines on your own Fly account. Existing cubes stay where they are."
                : "New cubes run in Docker here. Docker access amounts to root on this machine."
            }
            control={
              <Select
                value={settings.sandboxBackend}
                onValueChange={(value) => {
                  if (value === "docker" || value === "fly") void save({ sandboxBackend: value });
                }}
              >
                <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Cubes run on">
                  <SelectValue>{BACKEND_LABELS[settings.sandboxBackend]}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {(Object.keys(BACKEND_LABELS) as ReadonlyArray<SandboxBackend>).map((backend) => (
                    <SelectItem hideIndicator key={backend} value={backend}>
                      {BACKEND_LABELS[backend]}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
          {fly ? <FlySettings environmentId={environmentId} save={save} /> : null}
          <SettingsRow
            {...searchableSetting("sandbox-size")}
            description="How much machine each new cube gets. Builds and large test suites want medium or more."
            control={
              <Select
                value={settings.sandboxSize}
                onValueChange={(value) => {
                  if (value === "small" || value === "medium" || value === "large") {
                    void save({ sandboxSize: value });
                  }
                }}
              >
                <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Cube size">
                  <SelectValue>{SIZE_LABELS[settings.sandboxSize]}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {(Object.keys(SIZE_LABELS) as ReadonlyArray<SandboxSize>).map((size) => (
                    <SelectItem hideIndicator key={size} value={size}>
                      {SIZE_LABELS[size]}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
          <SettingsRow
            {...searchableSetting("sandbox-sleep")}
            description="Put a cube to sleep once its agent has finished and no message has been sent for this long, so it stops costing money. Opening its thread wakes it. Applies to cubes created afterwards."
            control={
              <Select
                value={String(settings.sandboxSleepAfterMinutes)}
                onValueChange={(value) => {
                  const minutes = Number(value);
                  if (Number.isInteger(minutes)) void save({ sandboxSleepAfterMinutes: minutes });
                }}
              >
                <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Sleep when idle">
                  <SelectValue>{sleepLabel(settings.sandboxSleepAfterMinutes)}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {SLEEP_OPTIONS.map((option) => (
                    <SelectItem hideIndicator key={option.minutes} value={String(option.minutes)}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
          <SettingsRow
            {...searchableSetting("sandbox-keep-ready")}
            description={
              fly
                ? "Keep one cube booted and asleep, so a new one starts in seconds. A sleeping cube only costs its storage, a few cents a month."
                : "Keep one cube booted and paused, so a new one starts in seconds. A paused cube holds its memory on this machine."
            }
            control={
              <Switch
                checked={settings.sandboxKeepReady}
                onCheckedChange={(checked) => void save({ sandboxKeepReady: Boolean(checked) })}
                aria-label="Keep a cube ready"
              />
            }
          />
          <SettingsRow
            {...searchableSetting("sandbox-delete")}
            description="Delete a cube that has stayed stopped this long. Its files go with it, including changes that were not pushed."
            control={
              <Select
                value={String(settings.sandboxDeleteAfterDays)}
                onValueChange={(value) => {
                  const days = Number(value);
                  if (Number.isInteger(days)) void save({ sandboxDeleteAfterDays: days });
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="w-full sm:w-56"
                  aria-label="Delete stopped cubes"
                >
                  <SelectValue>{deleteLabel(settings.sandboxDeleteAfterDays)}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {DELETE_OPTIONS.map((option) => (
                    <SelectItem hideIndicator key={option.days} value={String(option.days)}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
          <SettingsRow
            {...searchableSetting("sandbox-image")}
            description={
              fly
                ? "Image each new cube runs. Fly pulls it, so use a registry reference."
                : "Docker image each new cube runs."
            }
            control={
              <DraftInput
                size="sm"
                font="mono"
                className="w-full sm:w-56"
                value={settings.sandboxImage}
                onCommit={(value) => {
                  const image = value.trim();
                  if (image && image !== settings.sandboxImage) void save({ sandboxImage: image });
                }}
                spellCheck={false}
                aria-label="Cube image"
              />
            }
          />
          {fly ? null : (
            <SettingsRow
              {...searchableSetting("sandbox-address")}
              description="Where cubes accept connections. Loopback serves this machine only; use its LAN or Tailscale address to reach cubes from other devices."
              control={
                <DraftInput
                  size="sm"
                  font="mono"
                  className="w-full sm:w-56"
                  value={settings.sandboxPublishHost}
                  onCommit={(value) => {
                    const host = value.trim();
                    if (host && host !== settings.sandboxPublishHost) {
                      void save({ sandboxPublishHost: host });
                    }
                  }}
                  spellCheck={false}
                  aria-label="Cube address"
                />
              }
            />
          )}
          <SettingsSearchTarget id={searchableSetting("sandbox-variables").id}>
            <EnvironmentVariablesEditor
              description="Every new cube starts with these, such as CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`. Cubes keep the values they were created with."
              environment={settings.sandboxEnvironment}
              onChange={(sandboxEnvironment) => void save({ sandboxEnvironment })}
            />
          </SettingsSearchTarget>
        </>
      ) : null}
    </>
  );
}

/**
 * Connects the host to a Fly account. A pasted token is checked with Fly
 * before it is saved, and what it can reach fills the organization and region
 * choices, defaulting to its first organization and the nearest region.
 */
function FlySettings({
  environmentId,
  save,
}: {
  readonly environmentId: EnvironmentId;
  readonly save: (patch: ServerSettingsPatch) => Promise<unknown>;
}) {
  const saved = useEnvironmentSettings(environmentId, (settings) => settings.sandboxFly);
  const hasToken = saved.apiToken.length > 0;
  const accountQuery = useEnvironmentQuery(
    hasToken ? sandboxEnvironment.flyAccount({ environmentId, input: {} }) : null,
  );
  const account = accountQuery.data;
  const checkToken = useAtomCommand(sandboxEnvironment.checkFlyToken, { reportFailure: false });
  const [checkError, setCheckError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [checking, setChecking] = useState(false);
  const error = checkError ?? accountQuery.error;

  const connect = async () => {
    const apiToken = draft.trim();
    if (!apiToken) return;
    setChecking(true);
    try {
      const result = await checkToken({ environmentId, input: { apiToken } });
      if (result._tag === "Failure") {
        const failure = squashAtomCommandFailure(result);
        setCheckError(failure instanceof Error ? failure.message : "Fly could not be reached.");
        return;
      }
      const found = result.value;
      setCheckError(null);
      await save({
        sandboxFly: {
          apiToken,
          organization:
            found.organizations.find((org) => org.slug === saved.organization)?.slug ??
            found.organizations[0]?.slug ??
            saved.organization,
          region: saved.region || found.nearestRegion || "",
        },
      });
      setDraft("");
      accountQuery.refresh();
    } finally {
      setChecking(false);
    }
  };

  return (
    <>
      <SettingsRow
        {...searchableSetting("sandbox-fly-token")}
        description={
          error ??
          (hasToken
            ? accountQuery.isPending
              ? "Checking the saved token…"
              : "Connected. Paste a new token to replace it."
            : "Create one with `fly tokens create org` or under Tokens in the Fly dashboard. A separate organization for cubes keeps this token away from your other apps.")
        }
        control={
          <form
            className="flex w-full gap-2 sm:w-auto"
            onSubmit={(event) => {
              event.preventDefault();
              void connect();
            }}
          >
            <Input
              type="password"
              autoComplete="off"
              size="sm"
              className="min-w-0 flex-1 sm:w-56"
              placeholder={hasToken ? "Stored token" : "FlyV1 fm2_…"}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              aria-label="Fly API token"
            />
            <Button type="submit" size="sm" disabled={checking || draft.trim().length === 0}>
              {checking ? "Checking…" : "Connect"}
            </Button>
            {hasToken ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void save({ sandboxFly: { apiToken: "" } })}
              >
                Disconnect
              </Button>
            ) : null}
          </form>
        }
      />
      {hasToken ? (
        <>
          <SettingsRow
            {...searchableSetting("sandbox-fly-organization")}
            description="The Fly organization cubes are created and billed in."
            control={
              account && account.organizations.length > 0 ? (
                <Select
                  value={saved.organization}
                  onValueChange={(value) => {
                    if (typeof value === "string")
                      void save({ sandboxFly: { organization: value } });
                  }}
                >
                  <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Fly organization">
                    <SelectValue>
                      {account.organizations.find((org) => org.slug === saved.organization)?.name ??
                        saved.organization}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    {account.organizations.map((org) => (
                      <SelectItem hideIndicator key={org.slug} value={org.slug}>
                        {org.name}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              ) : (
                <DraftInput
                  size="sm"
                  font="mono"
                  className="w-full sm:w-56"
                  value={saved.organization}
                  placeholder="personal"
                  onCommit={(value) => void save({ sandboxFly: { organization: value.trim() } })}
                  spellCheck={false}
                  aria-label="Fly organization"
                />
              )
            }
          />
          <SettingsRow
            {...searchableSetting("sandbox-fly-region")}
            description="Where cubes run. The closest region keeps the desktop and terminal responsive."
            control={
              account ? (
                <Select
                  value={saved.region}
                  onValueChange={(value) => {
                    if (typeof value === "string") void save({ sandboxFly: { region: value } });
                  }}
                >
                  <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Fly region">
                    <SelectValue>
                      {account.regions.find((region) => region.code === saved.region)?.name ??
                        (saved.region || "Choose a region")}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    {account.regions.map((region) => (
                      <SelectItem hideIndicator key={region.code} value={region.code}>
                        {region.name}
                        {region.code === account.nearestRegion ? " (nearest)" : ""}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              ) : (
                <DraftInput
                  size="sm"
                  font="mono"
                  className="w-full sm:w-56"
                  value={saved.region}
                  placeholder="syd"
                  onCommit={(value) => void save({ sandboxFly: { region: value.trim() } })}
                  spellCheck={false}
                  aria-label="Fly region"
                />
              )
            }
          />
        </>
      ) : null}
    </>
  );
}
