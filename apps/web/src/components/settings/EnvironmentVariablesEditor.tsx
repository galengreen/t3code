import type { ProviderInstanceEnvironmentVariable } from "@t3tools/contracts";
import { PlusIcon, XIcon } from "lucide-react";
import { Lock as LockGlyph, LockOpen } from "lucide";
import { useEffect, useRef, useState } from "react";

import { Button } from "../ui/button";
import { MorphIcon } from "~/components/MorphIcon";
import { DraftInput } from "../ui/draft-input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsRow } from "./settingsLayout";

const ENVIRONMENT_VARIABLE_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

let environmentVariableDraftId = 0;
const nextEnvironmentVariableDraftId = () => `env-${environmentVariableDraftId++}`;

type EnvironmentDraftRow = {
  readonly id: string;
  readonly name: string;
  readonly value: string;
  readonly sensitive: boolean;
  readonly valueRedacted?: boolean;
};

function makeEnvironmentDraftRow(
  variable: ProviderInstanceEnvironmentVariable,
  index: number,
): EnvironmentDraftRow {
  return {
    id: `${index}:${variable.name}`,
    name: variable.name,
    value: variable.value,
    sensitive: variable.sensitive,
    ...(variable.valueRedacted !== undefined ? { valueRedacted: variable.valueRedacted } : {}),
  };
}

function environmentsEqual(
  left: ReadonlyArray<ProviderInstanceEnvironmentVariable>,
  right: ReadonlyArray<ProviderInstanceEnvironmentVariable>,
): boolean {
  return (
    left.length === right.length &&
    left.every((variable, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        variable.name === other.name &&
        variable.value === other.value &&
        variable.sensitive === other.sensitive &&
        variable.valueRedacted === other.valueRedacted
      );
    })
  );
}

/**
 * Edits a list of environment variables. Sensitive values are write-only: the
 * server keeps them in its secret store and sends back only that one is set,
 * so a stored value shows as empty until replaced.
 */
export function EnvironmentVariablesEditor(props: {
  readonly description: string;
  readonly environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>;
  readonly onChange: (environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>) => void;
}) {
  const [rows, setRows] = useState<ReadonlyArray<EnvironmentDraftRow>>(() =>
    props.environment.map(makeEnvironmentDraftRow),
  );
  const previousEnvironmentRef = useRef(props.environment);
  const lastPublishedEnvironmentRef = useRef<
    ReadonlyArray<ProviderInstanceEnvironmentVariable> | undefined
  >(undefined);

  useEffect(() => {
    const previousEnvironment = previousEnvironmentRef.current;
    const lastPublishedEnvironment = lastPublishedEnvironmentRef.current;
    previousEnvironmentRef.current = props.environment;
    lastPublishedEnvironmentRef.current = undefined;
    if (
      previousEnvironment === props.environment ||
      environmentsEqual(previousEnvironment, props.environment) ||
      (lastPublishedEnvironment !== undefined &&
        environmentsEqual(lastPublishedEnvironment, props.environment))
    ) {
      return;
    }
    setRows(props.environment.map(makeEnvironmentDraftRow));
  }, [props.environment]);

  const publishRows = (nextRows: ReadonlyArray<EnvironmentDraftRow>) => {
    const published: ProviderInstanceEnvironmentVariable[] = [];
    for (const row of nextRows) {
      const name = row.name.trim();
      if (!ENVIRONMENT_VARIABLE_NAME_PATTERN.test(name)) {
        if (
          name.length > 0 ||
          row.value.length > 0 ||
          row.sensitive !== true ||
          row.valueRedacted !== undefined
        ) {
          return;
        }
        continue;
      }
      const { id: _id, ...rest } = row;
      published.push({ ...rest, name });
    }
    lastPublishedEnvironmentRef.current = published;
    props.onChange(published);
  };

  const updateVariable = (id: string, patch: Partial<Omit<EnvironmentDraftRow, "id">>) => {
    const nextRows = rows.map((row) =>
      row.id === id
        ? {
            ...row,
            ...patch,
            ...(patch.value !== undefined ? { valueRedacted: false } : {}),
          }
        : row,
    );
    setRows(nextRows);
    publishRows(nextRows);
  };

  const removeVariable = (id: string) => {
    const nextRows = rows.filter((row) => row.id !== id);
    setRows(nextRows);
    publishRows(nextRows);
  };

  const addVariable = () =>
    setRows([
      ...rows,
      {
        id: nextEnvironmentVariableDraftId(),
        name: "",
        value: "",
        sensitive: true,
      },
    ]);

  return (
    <SettingsRow
      title="Variables"
      description={props.description}
      control={
        <Button type="button" size="sm" variant="outline" onClick={addVariable}>
          <PlusIcon className="size-3" />
          Add variable
        </Button>
      }
    >
      {rows.length > 0 ? (
        <div className="mt-3 min-w-0 space-y-2 pb-2">
          {rows.map((variable, index) => (
            <div key={variable.id} className="flex min-w-0 flex-wrap items-center gap-1.5">
              <DraftInput
                size="sm"
                font="mono"
                className="w-full min-w-0 sm:w-44 sm:shrink-0"
                value={variable.name}
                onCommit={(name) => updateVariable(variable.id, { name: name.trim() })}
                placeholder="VARIABLE_NAME"
                spellCheck={false}
                aria-label={`Environment variable name ${index + 1}`}
              />
              <span className="hidden text-xs text-muted-foreground sm:inline" aria-hidden>
                =
              </span>
              <DraftInput
                size="sm"
                font="mono"
                className="min-w-0 flex-1"
                value={variable.valueRedacted ? "" : variable.value}
                onCommit={(value) => updateVariable(variable.id, { value })}
                type={variable.sensitive ? "password" : undefined}
                autoComplete="off"
                placeholder={
                  variable.valueRedacted ? "Stored secret, enter a new value to replace" : "value"
                }
                spellCheck={false}
                aria-label={`Environment variable value ${index + 1}`}
              />
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      size="icon-micro"
                      variant="ghost-muted"
                      onClick={() => {
                        const sensitive = !variable.sensitive;
                        updateVariable(variable.id, {
                          sensitive,
                          ...(sensitive && variable.valueRedacted === undefined
                            ? {}
                            : { valueRedacted: sensitive ? variable.valueRedacted : false }),
                        });
                      }}
                      aria-pressed={variable.sensitive}
                      aria-label={`Mark environment variable ${variable.name || index + 1} as sensitive`}
                    >
                      <MorphIcon
                        className="size-3"
                        icon={variable.sensitive ? LockGlyph : LockOpen}
                      />
                    </Button>
                  }
                />
                <TooltipPopup side="top">
                  {variable.sensitive ? "Sensitive, stored separately" : "Plain text"}
                </TooltipPopup>
              </Tooltip>
              <Button
                type="button"
                size="icon-micro"
                variant="ghost-destructive"
                onClick={() => removeVariable(variable.id)}
                aria-label={`Remove environment variable ${variable.name || index + 1}`}
              >
                <XIcon className="size-3" />
              </Button>
            </div>
          ))}
          <p className="text-xs text-muted-foreground">
            Sensitive values are stored separately and never returned to the app.
          </p>
        </div>
      ) : null}
    </SettingsRow>
  );
}
