/**
 * What a Fly machine costs while it runs. Fly has no API for what an
 * organization was actually billed, so cube cost is always an estimate:
 * recorded running time priced by the machine's guest and region.
 *
 * Fly bills per second: a price per vCPU that includes some memory, plus a
 * price per GB of memory beyond that, scaled by a regional markup. The
 * built-in rates and markups are from https://docs.fly.io/about/pricing.
 * Fly's GraphQL API also answers with per-second prices for its presets;
 * those replace the built-in vCPU prices when they look plausible, so a price
 * change reaches the estimate without a release. The API has no memory price
 * or regional markups, so those always come from the built-in table.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import type { CubeBilling } from "./CubeDriver.ts";
import { flyAuthorization } from "./FlyCubeDriver.ts";

export interface FlyRates {
  /** Per vCPU-second, including `includedGbPerCpu` of memory. */
  readonly sharedCpuSecond: number;
  readonly performanceCpuSecond: number;
}

export const BUILT_IN_RATES: FlyRates = {
  sharedCpuSecond: 0.0000008465,
  performanceCpuSecond: 0.000012732,
};

const INCLUDED_GB_PER_CPU = { shared: 0.25, performance: 2 } as const;
const EXTRA_GB_SECOND = 0.000002316;

/** Regions Fly prices above Ashburn; any other region is priced at 1. */
const REGION_MARKUP: Readonly<Record<string, number>> = {
  ams: 1.038461538,
  arn: 1.038461538,
  cdg: 1.134615385,
  dfw: 1.25,
  fra: 1.153846154,
  gru: 1.615384615,
  jnb: 1.302884615,
  lax: 1.199519231,
  lhr: 1.134615385,
  nrt: 1.307692308,
  ord: 1.25,
  sin: 1.269230769,
  sjc: 1.192307692,
  syd: 1.269230769,
  yyz: 1.115384615,
};

export const usdPerSecond = (billing: CubeBilling, rates: FlyRates): number => {
  const cpuSecond =
    billing.cpuKind === "performance" ? rates.performanceCpuSecond : rates.sharedCpuSecond;
  const extraGb = Math.max(
    0,
    billing.memoryMb / 1024 - billing.cpus * INCLUDED_GB_PER_CPU[billing.cpuKind],
  );
  const markup = (billing.region && REGION_MARKUP[billing.region]) || 1;
  return (billing.cpus * cpuSecond + extraGb * EXTRA_GB_SECOND) * markup;
};

const decodeVmSizes = Schema.decodeUnknownEffect(
  Schema.Struct({
    data: Schema.Struct({
      platform: Schema.Struct({
        vmSizes: Schema.Array(
          Schema.Struct({
            name: Schema.String,
            cpuCores: Schema.Number,
            priceSecond: Schema.Number,
          }),
        ),
      }),
    }),
  }),
);

/**
 * Keeps a price from the API only within a factor of two of the published
 * one. A wrong field or unit there would otherwise silently multiply every
 * estimate.
 */
const plausible = (price: number | undefined, published: number) =>
  price !== undefined && price >= published / 2 && price <= published * 2 ? price : null;

/**
 * Fly's current vCPU prices, from the 1x presets' per-second prices (their
 * memory is exactly what a vCPU includes). Null when Fly cannot be asked or
 * its answer is implausible.
 */
export const fetchFlyRates = (token: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.post("https://api.fly.io/graphql").pipe(
        HttpClientRequest.setHeader("Authorization", flyAuthorization(token)),
        HttpClientRequest.bodyJsonUnsafe({
          query: "{ platform { vmSizes { name cpuCores priceSecond } } }",
        }),
      ),
    );
    const { data } = yield* decodeVmSizes(yield* response.json);
    const perCpu = (name: string) => {
      const size = data.platform.vmSizes.find((entry) => entry.name === name);
      return size && size.cpuCores > 0 ? size.priceSecond / size.cpuCores : undefined;
    };
    const shared = plausible(perCpu("shared-cpu-1x"), BUILT_IN_RATES.sharedCpuSecond);
    const performance = plausible(perCpu("performance-1x"), BUILT_IN_RATES.performanceCpuSecond);
    return shared === null || performance === null
      ? null
      : { sharedCpuSecond: shared, performanceCpuSecond: performance };
  }).pipe(
    Effect.timeout("15 seconds"),
    Effect.orElseSucceed(() => null),
  );
