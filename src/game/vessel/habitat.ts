export interface HabitatInput { readonly crew: number; readonly closedLoopRate: number; readonly cultivationArea: number; readonly wasteHeatW: number; readonly radiatorArea: number; readonly backgroundTemperatureK: number; }
export interface HabitatBalance { readonly consumableRateKgPerSecond: number; readonly requiredRadiatorArea: number; readonly radiatorMargin: number; }
export function habitatBalance(input: HabitatInput): HabitatBalance {
  if (input.crew < 0 || input.closedLoopRate < 0 || input.closedLoopRate > 1) throw new RangeError('invalid habitat input');
  const consumableRateKgPerSecond = input.crew * 1e-5 * (1 - input.closedLoopRate);
  const effectiveWPerM2 = input.backgroundTemperatureK <= 50 ? 400 : 150;
  const requiredRadiatorArea = input.wasteHeatW / effectiveWPerM2;
  return { consumableRateKgPerSecond, requiredRadiatorArea, radiatorMargin: input.radiatorArea - requiredRadiatorArea };
}
