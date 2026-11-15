// 天気図の 2D canvas の器。同じ天気のモデルの面を時刻ごとに焼いて読み戻し、見る窓と層に合わせて描く。
// 焼きは 1 本ずつ走らせ、焼いている間に頼まれた時刻は最新の 1 つへ畳む。
import { SynopticField } from './synoptic-field';
import { drawLegend } from './synoptic-legend';
import { DEFAULT_LAYERS, GLOBE, MAP_HEIGHT, MAP_WIDTH, drawSynoptic, mapViewAt } from './synoptic-map';
import { drawCycloneSymbols } from './synoptic-symbols';
import type { SynopticFields } from './synoptic-field';
import { SECONDS_PER_HOUR } from './time-units';
import type { Framing, SynopticLayers } from './synoptic-map';

interface SynopticPanel {
  readonly layers: SynopticLayers;
  readonly framing: Framing;
  setLayer(key: keyof SynopticLayers, on: boolean): void;
  setFraming(framing: Framing): void;
  // 時刻 hours の場を焼いて描く。焼いている間に頼まれた時刻は最新の 1 つへ畳む。
  refresh(hours: number): void;
  // 焼きが終わるまで待つ。
  settled(): Promise<void>;
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
  };
}
