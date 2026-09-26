// 全球雲場の供給導出をメインスレッド外で行う worker。init メッセージで気候画素と環境の
// 定数を一度だけ受け取り、derive 要求の帯 range(半開区間)を
// ConvectiveCloudGlobalFieldJob で全速導出する。各帯の部分場は全球格子へ書かれるので、
// 応答を client が帯順で加算 merge すれば全 range の導出と同じ場になる。
// THREE・DOM 非依存の部品(気候画素・大気風の数値版)だけで環境源と風場を組む。

import { v3 } from '../../math/vec3';
import { ConvectiveCloudGlobalFieldJob } from './cloud-global-field-supply';
import { earthGlobalEnvironmentAt } from './earth-global-environment';
import { atmosphericWindAt } from '../../render/cloud/atmospheric-wind-sample';
import { climateValuesAtCpu } from '../../render/cloud/climate-pixels';
import type { Vec3 } from '../../math/vec3';
import type { ClimatePixels } from '../../render/cloud/climate-pixels';
import type { EarthClimateSource } from './earth-cloud-environment';
import type { CloudEventWindAt } from './cloud-event-transport';
import type { CloudMassPhase } from './cloud-mass-deposition';

// init メッセージ。気候画素は client が画像から取り出して転送する — 画像がまだ読めない
// ときは null で、環境は緯度近似へ落ちる(valuesAtCpu を通さない本物の climate と同じ)。
export interface CloudGlobalFieldWorkerInit {
  readonly kind: 'init';
  readonly climatePixels: ClimatePixels | null;
  // 環境の天気(渦の配置・地形応答)が掛かる天体の半径 [m] と自転周期 [s]。
  readonly surfaceRadiusM: number;
  readonly rotationPeriodSeconds: number;
}

// derive 要求。帯 range は globalEventCellBands の添字の半開区間で、各帯のセル・
// イベント・堆積をその帯だけが担当する。seed・格子・間隔は供給の構築値と同じものを
// client が載せる。
export interface CloudGlobalFieldWorkerRequest {
  readonly kind: 'derive';
  readonly id: number;
  readonly displayTimeSeconds: number;
  readonly bandIndexStart: number;
  readonly bandIndexEnd: number;
  readonly seed: number;
  readonly sphereRadiusM: number;
  readonly gridWidth: number;
  readonly gridHeight: number;
  readonly eventCellSpacingM: number;
}

// derive の応答。質量配列は所有権ごと返送され、場の寸法は格子の取り決めを受け手が
// 再確認できるよう結果そのものから写す。
export interface CloudGlobalFieldWorkerResult {
  readonly kind: 'result';
  readonly id: number;
  readonly width: number;
  readonly height: number;
  readonly sphereRadiusM: number;
  readonly layerEdgesM: readonly number[];
  readonly liquidKgM2: Float64Array;
  readonly iceKgM2: Float64Array;
  readonly eventMassKgByPhase: Readonly<Record<CloudMassPhase, number>>;
  readonly unassignedMassKgByPhase: Readonly<Record<CloudMassPhase, number>>;
  readonly eventCount: number;
  readonly truncatedEventCount: number;
  readonly omittedMassUpperBoundKgM2: number;
}

export interface CloudGlobalFieldWorkerFailure {
  readonly kind: 'error';
  readonly id: number;
  readonly error: string;
}

export type CloudGlobalFieldWorkerMessage =
  | CloudGlobalFieldWorkerInit
  | CloudGlobalFieldWorkerRequest;

export type CloudGlobalFieldWorkerReply =
  | CloudGlobalFieldWorkerResult
  | CloudGlobalFieldWorkerFailure;

interface CloudGlobalFieldWorkerScope {
  onmessage: ((event: MessageEvent<CloudGlobalFieldWorkerMessage>) => void) | null;
  postMessage(message: CloudGlobalFieldWorkerReply, transfer: Transferable[]): void;
}

const scope = globalThis as unknown as CloudGlobalFieldWorkerScope;

// init で組む環境の入力。気候源が null のあいだは緯度近似の柱が返る。
let climateSource: EarthClimateSource | null = null;
let surfaceRadiusM = 0;
let rotationPeriodSeconds = 0;

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

// 単位方向の接平面の東・北の右手系。経度から直接基底を作るので中心が極でも退化しない。
// 輸送の風の接線成分への写しは makeWindAt(cloud-local-field-supply)と同じ合成 —
// あちらは TSL のある wind field を包むので、worker では大気風の数値版を直に使う。
function tangentBasis(centerDirection: Vec3): { readonly east: Vec3; readonly north: Vec3 } {
  const latitudeRad = Math.asin(clamp(centerDirection.y, -1, 1));
  const longitudeRad = Math.atan2(centerDirection.x, centerDirection.z);
  const cosLatitude = Math.cos(latitudeRad);
  const sinLatitude = Math.sin(latitudeRad);
  const cosLongitude = Math.cos(longitudeRad);
  const sinLongitude = Math.sin(longitudeRad);
  return {
    east: v3(cosLongitude, 0, -sinLongitude),
    north: v3(-sinLatitude * sinLongitude, cosLatitude, -sinLatitude * cosLongitude),
  };
}

// 輸送と面積導出に使う風。イベント位置の緯度と高さで大気風モデルを評価し、接平面基底で
// 東・北成分から接線速度へ戻す。鉛直流は surrogate では扱わない。
function windAt(directionUnitVector: Vec3, geometricHeightM: number): ReturnType<CloudEventWindAt> {
  const latitudeRad = Math.asin(clamp(directionUnitVector.y, -1, 1));
  const { east, north } = tangentBasis(directionUnitVector);
  const wind = atmosphericWindAt(latitudeRad, geometricHeightM);
  return {
    tangentVelocityMPerS: v3(
      east.x * wind.east + north.x * wind.north,
      east.y * wind.east + north.y * wind.north,
      east.z * wind.east + north.z * wind.north,
    ),
    verticalVelocityMPerS: 0,
  };
}

scope.onmessage = (event) => {
  const message = event.data;
  if (message.kind === 'init') {
    const pixels = message.climatePixels;
    climateSource = pixels === null ? null : {
      valuesAtCpu: (direction: Vec3) => climateValuesAtCpu(direction, pixels),
    };
    surfaceRadiusM = message.surfaceRadiusM;
    rotationPeriodSeconds = message.rotationPeriodSeconds;
    return;
  }
  const request = message;
  try {
    const job = new ConvectiveCloudGlobalFieldJob(
      request.displayTimeSeconds,
      (direction, timeSeconds) => earthGlobalEnvironmentAt(
        direction, climateSource, timeSeconds, surfaceRadiusM, rotationPeriodSeconds),
      request.seed, request.sphereRadiusM, request.gridWidth, request.gridHeight,
      windAt, request.eventCellSpacingM, request.bandIndexStart, request.bandIndexEnd);
    job.step(Number.POSITIVE_INFINITY);
    const result = job.result;
    if (result === null) throw new Error('cloud global field job finished without a result');
    const field = result.field;
    scope.postMessage({
      kind: 'result',
      id: request.id,
      width: field.width,
      height: field.height,
      sphereRadiusM: field.sphereRadiusM,
      layerEdgesM: [...field.layerEdgesM],
      liquidKgM2: field.liquidKgM2,
      iceKgM2: field.iceKgM2,
      eventMassKgByPhase: result.eventMassKgByPhase,
      unassignedMassKgByPhase: result.unassignedMassKgByPhase,
      eventCount: result.eventCount,
      truncatedEventCount: result.truncatedEventCount,
      omittedMassUpperBoundKgM2: result.omittedMassUpperBoundKgM2,
    }, [field.liquidKgM2.buffer, field.iceKgM2.buffer]);
  } catch (error: unknown) {
    const text = error instanceof Error ? error.message : String(error);
    scope.postMessage({ kind: 'error', id: request.id, error: text }, []);
  }
};
