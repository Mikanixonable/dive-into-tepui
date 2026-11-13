// 雲の描画経路の多スケール撮影。render-lab と同じ LabView と地球ケースで、地域 cap × 高度と
// 全球を captureTarget へだけ描く。window.cloudRenderCapture が駆動口。
import { LabView } from '../render-lab/lab';
import type { LabViewAngles } from '../render-lab/view-angles';
import { MemorySettingStorage } from '../../src/settings/stored-setting';
import { UserSettings } from '../../src/settings/user-settings';
import { R_EARTH, R_EARTH_EQ } from '../../src/game/celestial/solar-system/earth-system';

declare global {
  interface Window {
    cloudRenderCapture?: CloudRenderCapture;
  }
}

// 1 枚の撮影の指定。緯度・経度は直下点、cameraDistanceKm は直下点からカメラまでの距離 [km]。
export interface RenderCaptureSpec {
  readonly latitudeDeg: number;
  readonly longitudeDeg: number;
  readonly cameraDistanceKm: number;
  readonly sunAzimuthDeg: number;
  readonly sunElevationDeg: number;
  readonly displayHours: number;
}

export interface CloudRenderCapture {
  readonly ready: () => boolean;
  readonly waitUntilReady: () => Promise<void>;
  readonly setCapture: (spec: RenderCaptureSpec) => void;
  readonly captureSettled: () => Promise<string>;
  readonly viewAngles: () => LabViewAngles;
}

// 落ち着き判定の上限。capture() を繰り返し、連続 2 回の絵が一致したら決定的とみなす。
const MAX_SETTLE_CAPTURES = 6;

async function init(): Promise<void> {
  const settings = new UserSettings(new MemorySettingStorage());
  const view = await LabView.create(
    document.getElementById('view') as HTMLCanvasElement, settings.graphics, { captureOnly: true });
  view.show('earth');
  // 注視点までの固定距離。show() が観察の向きを既定へ戻した直後なので cameraDistanceLog は 0 で、
  // ここで読む値はケースの既定距離そのものになる。setCapture のたびに view.cameraDistance を
  // 読み直すと、前回の撮影で変えた cameraDistanceLog が残った値を返し、高度が呼び出し順で
  // ずれる — 2000 km の梯子が 8〜12 Mm の全球像になり、400 km の cap の一部が 119 km の
  // 接写になった原因。直下点の配置とカメラ距離の両方がこの 1 つの値から決まる。
  const pivotM = view.cameraDistance;
  window.cloudRenderCapture = {
    ready: () => view.ready,
    waitUntilReady: () => view.waitUntilReady(),
    setCapture: (spec) => {
      // 直下点をケースの固定 pivot へ置く。地球の高度は、赤道面の地表が pivot に来る値
      // (earth-nadir の置き方と同じ式)。カメラはその天頂へ置く。
      view.setViewAngles({
        earthAzimuthDeg: 180,
        earthElevationDeg: 0,
        earthAltitudeLog: Math.log10(pivotM + R_EARTH_EQ - R_EARTH),
        earthLatitudeDeg: spec.latitudeDeg,
        earthLongitudeDeg: spec.longitudeDeg,
        cameraAzimuthDeg: 0,
        cameraElevationDeg: 0,
        cameraDistanceLog: Math.log10((spec.cameraDistanceKm * 1000) / pivotM),
        cameraZoomLog: 0,
        sunAzimuthDeg: spec.sunAzimuthDeg,
        sunElevationDeg: spec.sunElevationDeg,
        sunDistanceLogAu: 0,
      });
      // 要求した高度に置けたことをその場で確かめる。cameraDistance は既定距離 × 10^cameraDistanceLog
      // なので、pivotM が既定距離とずれるとここで落ちる。
      const actualM = view.cameraDistance;
      if (Math.abs(actualM - spec.cameraDistanceKm * 1000) > 1) {
        throw new Error(
          `render-capture: camera distance ${actualM} m, expected ${spec.cameraDistanceKm * 1000} m`);
      }
      view.setDisplayTime(spec.displayHours * 3600);
    },
    captureSettled: async () => {
      let previous = await view.capture();
      for (let count = 2; count <= MAX_SETTLE_CAPTURES; count++) {
        await new Promise<void>((resolve) => { requestAnimationFrame(() => resolve()); });
        const next = await view.capture();
        if (next === previous) return next;
        previous = next;
      }
      throw new Error('render-capture: shot did not settle within 6 captures');
    },
    viewAngles: () => view.viewAngles,
  };
}

init().catch((error: unknown) => {
  document.getElementById('error')!.textContent = String(error);
});
