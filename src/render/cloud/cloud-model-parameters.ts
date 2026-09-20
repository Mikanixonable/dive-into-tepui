// 雲モデルの runtime 採用値。調整範囲や観測 provenance は tools 側へ置き、描画 hot path が calibration
// metadata を読む構造にしない。

export interface CloudModelParameters {
  readonly cloudCellLifetimeSeconds: number;
  readonly mesoLifetimeSeconds: number;
  readonly anvilLifetimeSeconds: number;
  readonly basisDelaySeconds: readonly [number, number];
  readonly maximumCloudAltitudeMeters: number;
  readonly liquidTauScale: number;
  readonly iceTauScale: number;
}

export const CLOUD_MODEL_PARAMETERS: CloudModelParameters = Object.freeze({
  cloudCellLifetimeSeconds: 60 * 60,
  mesoLifetimeSeconds: 12 * 60 * 60,
  anvilLifetimeSeconds: 6 * 60 * 60,
  basisDelaySeconds: Object.freeze([10 * 60, 20 * 60]) as readonly [number, number],
  maximumCloudAltitudeMeters: 20_000,
  liquidTauScale: 15,
  iceTauScale: 1,
});
