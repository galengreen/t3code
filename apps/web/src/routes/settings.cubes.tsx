import { createFileRoute } from "@tanstack/react-router";

import { CubesSettingsPanel } from "../components/settings/SandboxSettings";

export const Route = createFileRoute("/settings/cubes")({
  component: CubesSettingsPanel,
});
