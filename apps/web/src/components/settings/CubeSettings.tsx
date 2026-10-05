import type { EnvironmentId, CubeBackend, CubeSize, ServerSettingsPatch } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useEffect, useState } from "react";

import { environmentCatalog } from "../../connection/catalog";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { createHome, cubeEnvironment } from "../../state/cube";
import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { EnvironmentVariablesEditor } from "./EnvironmentVariablesEditor";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSearchTarget,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";

/**
 * Cube hosting for one environment. Cubes run on the machine that
 * creates them and their variables usually hold login tokens, so these
 * settings save to the selected environment only instead of fanning out.
 */
/** Settings → Cubes. */
export function CubesSettingsPanel() {
  return (
    <SettingsPageContainer>
      <CubeSettings />
    </SettingsPageContainer>
  );
}

function CubeSettings() {
  const { scope, environment, connectedEnvironments } = useSettingsScope();
  const connect = useAtomCommand(environmentCatalog.connect, { reportFailure: false });
  // A cube home sleeps until needed, and opening its settings is a need.
  const sleepingEnvironmentId =
    environment?.entry.connectWhen === "needed" && environment.connection.phase !== "connected"
      ? environment.environmentId
      : null;
  useEffect(() => {
    if (sleepingEnvironmentId !== null) void connect(sleepingEnvironmentId);
  }, [sleepingEnvironmentId, connect]);
  if (scope.kind === "project" || scope.kind === "checkout") return null;
  const environmentId =
    environment?.connection.phase === "connected" ? environment.environmentId : null;
  const aggregate = scope.environmentIds.length !== 1 && connectedEnvironments.length > 1;
  return (
    <SettingsSection
      id={searchableSetting("cubes").id}
      title={aggregate && environment ? `Cubes · ${environment.label}` : "Cubes"}
    >
      {environmentId === null ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">
          {sleepingEnvironmentId === null
            ? "Connect an environment to host cubes on it."
            : `Waking ${environment?.label ?? "it"}…`}
        </p>
      ) : (
        // Drafts belong to one environment; switching must not carry them over.
        <CubeControls key={environmentId} environmentId={environmentId} />
      )}
    </SettingsSection>
  );
}

const BACKEND_LABELS: Record<CubeBackend, string> = {
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

const SIZE_LABELS: Record<CubeSize, string> = {
  small: "Small · 2 vCPU, 2 GB",
  medium: "Medium · 4 vCPU, 8 GB",
  large: "Large · 4 dedicated vCPU, 8 GB",
};

function CubeControls({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const settings = useEnvironmentSettings(environmentId);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "save cube settings",
  });
  const save = (patch: ServerSettingsPatch) => updateSettings({ environmentId, input: { patch } });
  const fly = settings.cubeBackend === "fly";
  const { environments } = useEnvironments();
  const self = environments.find((environment) => environment.environmentId === environmentId);
  const isHome = self?.serverConfig?.environment.capabilities.wakesOnRequest === true;
  // Where cubes are managed instead, such as the cube home they moved to.
  const otherHost = settings.enableCubes
    ? undefined
    : environments.find(
        (environment) =>
          environment.environmentId !== environmentId &&
          environment.entry.enabled &&
          environment.serverConfig?.settings.enableCubes === true,
      );

  return (
    <>
      <SettingsRow
        {...searchableSetting("cubes-enabled")}
        description={
          otherHost
            ? `${otherHost.label} manages your cubes.`
            : "Create cubes, each a separate environment for one task, with this machine's Docker or on Fly.io."
        }
        control={
          <Switch
            checked={settings.enableCubes}
            onCheckedChange={(checked) => void save({ enableCubes: Boolean(checked) })}
            aria-label="Host cubes"
          />
        }
      />
      {settings.enableCubes ? (
        <>
          <SettingsRow
            {...searchableSetting("cube-backend")}
            description={
              fly
                ? "New cubes run as Fly Machines on your own Fly account. Existing cubes stay where they are."
                : "New cubes run in Docker here. Docker access amounts to root on this machine."
            }
            control={
              <Select
                value={settings.cubeBackend}
                onValueChange={(value) => {
                  if (value === "docker" || value === "fly") void save({ cubeBackend: value });
                }}
              >
                <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Cubes run on">
                  <SelectValue>{BACKEND_LABELS[settings.cubeBackend]}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {(Object.keys(BACKEND_LABELS) as ReadonlyArray<CubeBackend>).map((backend) => (
                    <SelectItem hideIndicator key={backend} value={backend}>
                      {BACKEND_LABELS[backend]}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
          {fly ? <FlySettings environmentId={environmentId} save={save} /> : null}
          {fly && !isHome ? <CubeHomeSetting environmentId={environmentId} /> : null}
          <SettingsRow
            {...searchableSetting("cube-size")}
            description="How much machine each new cube gets. Builds and large test suites want medium or more."
            control={
              <Select
                value={settings.cubeSize}
                onValueChange={(value) => {
                  if (value === "small" || value === "medium" || value === "large") {
                    void save({ cubeSize: value });
                  }
                }}
              >
                <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Cube size">
                  <SelectValue>{SIZE_LABELS[settings.cubeSize]}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {(Object.keys(SIZE_LABELS) as ReadonlyArray<CubeSize>).map((size) => (
                    <SelectItem hideIndicator key={size} value={size}>
                      {SIZE_LABELS[size]}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
          <SettingsRow
            {...searchableSetting("cube-sleep")}
            description="Put a cube to sleep once its agent has finished and no message has been sent for this long, so it stops costing money. Opening its thread wakes it. Applies to cubes created afterwards."
            control={
              <Select
                value={String(settings.cubeSleepAfterMinutes)}
                onValueChange={(value) => {
                  const minutes = Number(value);
                  if (Number.isInteger(minutes)) void save({ cubeSleepAfterMinutes: minutes });
                }}
              >
                <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Sleep when idle">
                  <SelectValue>{sleepLabel(settings.cubeSleepAfterMinutes)}</SelectValue>
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
            {...searchableSetting("cube-keep-ready")}
            description={
              fly
                ? "Keep one cube booted and asleep, so a new one starts in seconds. A sleeping cube only costs its storage, a few cents a month."
                : "Keep one cube booted and paused, so a new one starts in seconds. A paused cube holds its memory on this machine."
            }
            control={
              <Switch
                checked={settings.cubeKeepReady}
                onCheckedChange={(checked) => void save({ cubeKeepReady: Boolean(checked) })}
                aria-label="Keep a cube ready"
              />
            }
          />
          <SettingsRow
            {...searchableSetting("cube-delete")}
            description="Delete a cube that has stayed stopped this long. Its files go with it, including changes that were not pushed."
            control={
              <Select
                value={String(settings.cubeDeleteAfterDays)}
                onValueChange={(value) => {
                  const days = Number(value);
                  if (Number.isInteger(days)) void save({ cubeDeleteAfterDays: days });
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="w-full sm:w-56"
                  aria-label="Delete stopped cubes"
                >
                  <SelectValue>{deleteLabel(settings.cubeDeleteAfterDays)}</SelectValue>
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
            {...searchableSetting("cube-image")}
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
                value={settings.cubeImage}
                onCommit={(value) => {
                  const image = value.trim();
                  if (image && image !== settings.cubeImage) void save({ cubeImage: image });
                }}
                spellCheck={false}
                aria-label="Cube image"
              />
            }
          />
          {fly ? null : (
            <SettingsRow
              {...searchableSetting("cube-address")}
              description="Where cubes accept connections. Loopback serves this machine only; use its LAN or Tailscale address to reach cubes from other devices."
              control={
                <DraftInput
                  size="sm"
                  font="mono"
                  className="w-full sm:w-56"
                  value={settings.cubePublishHost}
                  onCommit={(value) => {
                    const host = value.trim();
                    if (host && host !== settings.cubePublishHost) {
                      void save({ cubePublishHost: host });
                    }
                  }}
                  spellCheck={false}
                  aria-label="Cube address"
                />
              }
            />
          )}
          <SettingsSearchTarget id={searchableSetting("cube-variables").id}>
            <EnvironmentVariablesEditor
              description="Every new cube starts with these, such as CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`. Cubes keep the values they were created with."
              environment={settings.cubeEnvironment}
              onChange={(cubeEnvironment) => void save({ cubeEnvironment })}
            />
          </SettingsSearchTarget>
        </>
      ) : null}
    </>
  );
}

/**
 * Hands cube management to a cube home on Fly: a small machine that sleeps
 * while no one is using it, so cubes can be made and managed from any device
 * with this one off. This server then stops managing cubes and forgets its
 * Fly token, and this setting disappears with the rest.
 */
function CubeHomeSetting({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const hasToken = useEnvironmentSettings(
    environmentId,
    (settings) => settings.cubeFly.apiToken.length > 0,
  );
  const move = useAtomCommand(createHome, { reportFailure: false });
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!hasToken) return null;

  const start = async () => {
    setMoving(true);
    setError(null);
    const result = await move(environmentId);
    setMoving(false);
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "The cube home could not be set up.");
    }
  };

  return (
    <SettingsRow
      {...searchableSetting("cube-home")}
      description={
        error ??
        (moving
          ? "Setting up the cube home on Fly. This takes about a minute."
          : "Manage cubes from a small Fly machine that sleeps when no one is using it, so they keep working with this computer off. Costs cents a month. This server stops managing cubes and forgets its Fly token.")
      }
      control={
        <Button size="sm" variant="outline" disabled={moving} onClick={() => void start()}>
          {moving ? "Moving…" : "Move to Fly"}
        </Button>
      }
    />
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
  const saved = useEnvironmentSettings(environmentId, (settings) => settings.cubeFly);
  const hasToken = saved.apiToken.length > 0;
  const accountQuery = useEnvironmentQuery(
    hasToken ? cubeEnvironment.flyAccount({ environmentId, input: {} }) : null,
  );
  const account = accountQuery.data;
  const checkToken = useAtomCommand(cubeEnvironment.checkFlyToken, { reportFailure: false });
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
        cubeFly: {
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
        {...searchableSetting("cube-fly-token")}
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
                onClick={() => void save({ cubeFly: { apiToken: "" } })}
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
            {...searchableSetting("cube-fly-organization")}
            description="The Fly organization cubes are created and billed in."
            control={
              account && account.organizations.length > 0 ? (
                <Select
                  value={saved.organization}
                  onValueChange={(value) => {
                    if (typeof value === "string") void save({ cubeFly: { organization: value } });
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
                  onCommit={(value) => void save({ cubeFly: { organization: value.trim() } })}
                  spellCheck={false}
                  aria-label="Fly organization"
                />
              )
            }
          />
          <SettingsRow
            {...searchableSetting("cube-fly-region")}
            description="Where cubes run. The closest region keeps the desktop and terminal responsive."
            control={
              account ? (
                <Select
                  value={saved.region}
                  onValueChange={(value) => {
                    if (typeof value === "string") void save({ cubeFly: { region: value } });
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
                  onCommit={(value) => void save({ cubeFly: { region: value.trim() } })}
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
