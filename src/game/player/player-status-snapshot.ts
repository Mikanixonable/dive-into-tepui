import type { RadiatorSide } from './radiator';
import type { SolarSide } from './power';

export interface PlayerStatusSnapshot {
  readonly throttleIdx: number;
  readonly rcsDamp: boolean;
  readonly progradeHold: boolean;
  readonly fineAttitude: boolean;
  readonly totalFuel: number;
  readonly totalMaxFuel: number;
  readonly aero: { readonly qdyn: number } | null;
  readonly power: {
    readonly chargeJ: number;
    readonly deploy: Record<SolarSide, number>;
  } | null;
  readonly radiator: Record<RadiatorSide, { readonly deploy: number; readonly wear: number }> | null;
  readonly fire: { readonly rounds: number; readonly mags: number; readonly cooldown: number } | null;
}
