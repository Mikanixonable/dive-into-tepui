// 天気図の 2D canvas の器。同じ天気のモデルの面を時刻ごとに焼いて読み戻し、見る窓と層に合わせて描く。
// 焼きは 1 本ずつ走らせ、焼いている間に頼まれた時刻は最新の 1 つへ畳む。
import { SynopticField } from './synoptic-field';
import { drawLegend } from './synoptic-legend';
import {
  DEFAULT_LAYERS, GLOBE, MAP_HEIGHT, MAP_WIDTH, MSLP_HPA, drawSynoptic, mapViewAt, sampleField,
} from './synoptic-map';
import { drawCycloneSymbols } from './synoptic-symbols';
import type { SynopticFields } from './synoptic-field';
import { SECONDS_PER_HOUR } from './time-units';
import type { Framing, SynopticLayers } from './synoptic-map';
import type { LabProbe } from './lab';

interface SynopticPanel {
  readonly layers: SynopticLayers;
  readonly framing: Framing;
  setLayer(key: keyof SynopticLayers, on: boolean): void;
  setFraming(framing: Framing): void;
  // 時刻 hours の場を焼いて描く。焼いている間に頼まれた時刻は最新の 1 つへ畳む。
  refresh(hours: number): void;
  // 焼きが終わるまで待つ。
  settled(): Promise<void>;
  // canvas の画素 (xPx, yPx) の緯度・経度と、その点の場の実値(MSLP・地表風・上層風)を返す。
  // 読み戻した面がまだ無い(初回の焼きが終わっていない)ときは null。
  probeAt(xPx: number, yPx: number): LabProbe | null;
}

// canvas へ天気図を描く器を組む。status には焼きの進みと失敗を出す。
export function createSynopticPanel(canvas: HTMLCanvasElement, status: HTMLElement): SynopticPanel {
  canvas.width = MAP_WIDTH;
  canvas.height = MAP_HEIGHT;
  const context = canvas.getContext('2d')!;
  let layers: SynopticLayers = { ...DEFAULT_LAYERS };
  let framing: Framing = GLOBE;
  let fieldPromise: Promise<SynopticField> | null = null;
  let fields: SynopticFields | null = null;
  let fieldHours = 0;
  let requested: number | null = null;
  let running: Promise<void> | null = null;

  const draw = (): void => {
    if (fields === null) return;
    const view = mapViewAt(framing.longitude, framing.latitude, framing.radius);
    const seconds = fieldHours * SECONDS_PER_HOUR;
    drawSynoptic(context, fields, layers, seconds, view);
    drawLegend(context);
    if (layers.symbols) drawCycloneSymbols(context, fields, seconds, view);
  };

  const sampleLoop = async (): Promise<void> => {
    while (requested !== null) {
      const hours = requested;
      requested = null;
      status.textContent = '天気図の面を焼いて読み戻しています…';
      try {
        fieldPromise ??= SynopticField.create();
        fields = await (await fieldPromise).sample(hours * SECONDS_PER_HOUR);
        fieldHours = hours;
        status.textContent = '';
        draw();
      } catch (e) {
        status.textContent = `天気図の読み戻しに失敗: ${String(e)}`;
        fieldPromise = null;
      }
    }
    running = null;
  };

  return {
    get layers(): SynopticLayers { return layers; },
    get framing(): Framing { return framing; },
    setLayer: (key, on) => {
      layers = { ...layers, [key]: on };
      draw();
    },
    setFraming: (next) => {
      framing = next;
      draw();
    },
    refresh: (hours) => {
      if (running === null && fields !== null && fieldHours === hours) {
        draw();
        return;
      }
      requested = hours;
      running ??= sampleLoop();
    },
    settled: async () => {
      while (running !== null) await running;
    },
    probeAt: (xPx, yPx) => {
      const current = fields;
      if (current === null || xPx < 0 || xPx >= MAP_WIDTH || yPx < 0 || yPx >= MAP_HEIGHT) return null;
      // mapViewAt と同じ窓で画素→緯度経度へ戻す。緯度は窓の外(極の外)へ出た点は無効。
      const view = mapViewAt(framing.longitude, framing.latitude, framing.radius);
      const latitude = view.latMaxDeg - yPx * view.latSpanDeg / MAP_HEIGHT;
      const longitude = view.lonMinDeg + xPx * view.lonSpanDeg / MAP_WIDTH;
      if (latitude < -90 || latitude > 90) return null;
      const lonRad = longitude * Math.PI / 180;
      const latRad = latitude * Math.PI / 180;
      const pick = (channel: Float32Array): number =>
        sampleField(channel, current.width, current.height, lonRad, latRad);
      const deviation = pick(current.pressure);
      const surfaceEast = pick(current.surfaceWindEast);
      const surfaceNorth = pick(current.surfaceWindNorth);
      const upperEast = pick(current.upperWindEast);
      const upperNorth = pick(current.upperWindNorth);
      const signed = (v: number): string => `${v >= 0 ? '+' : ''}${v.toFixed(1)}`;
      const wrapped = ((longitude + 180) % 360 + 360) % 360 - 180;
      const text = `MSLP ${(MSLP_HPA + deviation).toFixed(1)} hPa(偏差 ${signed(deviation)})\n`
        + `地表風 東 ${signed(surfaceEast)} 北 ${signed(surfaceNorth)} m/s\n`
        + `上層風 東 ${signed(upperEast)} 北 ${signed(upperNorth)} m/s`;
      return { latitude, longitude: wrapped, text };
    },
  };
}
