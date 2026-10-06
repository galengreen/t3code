import { DEVICE_PLATFORM_NAMES, type DevicePlatformAvailability } from "@t3tools/contracts";
import { Check, Minus } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";

export function DeviceHostAvailability({
  platforms,
}: {
  platforms: ReadonlyArray<DevicePlatformAvailability>;
}) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {platforms.map((platform) => (
        <Tooltip key={platform.platform}>
          <TooltipTrigger render={<span tabIndex={0} className="inline-flex items-center gap-1" />}>
            {platform.available ? <Check className="size-3" /> : <Minus className="size-3" />}
            {DEVICE_PLATFORM_NAMES[platform.platform]}{" "}
            {platform.available ? "available" : "unavailable"}
          </TooltipTrigger>
          <TooltipPopup>
            {platform.reason ?? `${DEVICE_PLATFORM_NAMES[platform.platform]} available`}
          </TooltipPopup>
        </Tooltip>
      ))}
    </div>
  );
}
