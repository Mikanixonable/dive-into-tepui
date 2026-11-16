// 天気図へ低気圧と高気圧の記号を置く。中心は L / H と気圧値、眼を持つ渦は中心に眼の印を置く。
// 気象モデルが前線を持たない間は、記号は中心と眼だけになる。
import { eyeStrengthOf } from '../../src/render/cloud/cyclones';
import {
  LOW_COUNT, TROPICAL_COUNT, lowPlacementAt, tropicalPlacementAt,
} from '../../src/render/cloud/cyclone-tracks';
import { HIGH_COUNT, highPlacementAt } from '../../src/render/cloud/anticyclone-tracks';
import { R_EARTH, SIDEREAL_DAY } from '../../src/game/celestial/solar-system/earth-system';
import { sampleField, strokeWrapped } from './synoptic-map';
import type { MapView } from './synoptic-map';
import type { CyclonePlacement } from '../../src/render/cloud/cyclone-tracks';
import type { SynopticFields } from './synoptic-field';

// 中心の記号。mark(L / H)と気圧値、眼を持つなら眼の印。配置の経度は畳まずに持つので、
// 窓の西端を基準に一周(360°)で畳んでから画素へ写す — 時刻を大きく進めると配置の経度は
// 何周分も回り込み、畳まないままでは窓へ届かない。
function drawCenterLabel(
  context: CanvasRenderingContext2D, fields: SynopticFields,
  placement: CyclonePlacement, mark: 'L' | 'H', eyeStrength: number, view: MapView,
): void {
  const longitudeDeg = view.lonMinDeg
    + (((placement.longitude * 180 / Math.PI - view.lonMinDeg) % 360) + 360) % 360;
  const x = view.lonToX(longitudeDeg);
  const y = view.latToY(placement.latitude * 180 / Math.PI);
  // 中心の気圧は面から拾う。
  const pressure = Math.round(1013 + sampleField(
    fields.pressure, fields.width, fields.height,
    placement.longitude, placement.latitude));
  strokeWrapped(context, view, () => {
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.font = '700 26px "JetBrains Mono", ui-monospace, monospace';
    context.lineWidth = 4;
    context.strokeStyle = 'rgba(10, 13, 17, 0.85)';
    context.fillStyle = mark === 'L'
      ? 'rgba(255, 120, 100, 0.95)' : 'rgba(135, 175, 255, 0.95)';
    context.strokeText(mark, x, y);
    context.fillText(mark, x, y);
    context.font = '600 13px "JetBrains Mono", ui-monospace, monospace';
    context.strokeText(String(pressure), x, y + 20);
    context.fillText(String(pressure), x, y + 20);
    // 眼 — 開いているときだけ、中心に白い輪。
    if (eyeStrength > 0.4) {
      context.strokeStyle = `rgba(245, 250, 255, ${0.4 + 0.6 * eyeStrength})`;
      context.lineWidth = 2;
      context.beginPath();
      context.arc(x, y - 1, 7, 0, Math.PI * 2);
      context.stroke();
      context.fillStyle = 'rgba(12, 16, 22, 0.9)';
      context.beginPath();
      context.arc(x, y - 1, 3, 0, Math.PI * 2);
      context.fill();
    }
  });
}

// 低気圧と高気圧の記号をまとめて置く。seconds は現在時刻 [s]、view は地図の見せる窓。
export function drawCycloneSymbols(
  context: CanvasRenderingContext2D, fields: SynopticFields, seconds: number, view: MapView,
): void {
  // 温帯低気圧 — L。
  for (let index = 0; index < LOW_COUNT; index += 1) {
    const placement = lowPlacementAt(index, seconds, R_EARTH);
    if (placement === null || placement.depth < 2) continue;
    drawCenterLabel(context, fields, placement, 'L', 0, view);
  }
  // 熱帯低気圧 — L と眼。
  for (let index = 0; index < TROPICAL_COUNT; index += 1) {
    const tropical = tropicalPlacementAt(index, seconds);
    if (tropical === null || tropical.depth < 2) continue;
    const eye = eyeStrengthOf(
      tropical.depth, tropical.radius, tropical.latitude, R_EARTH, SIDEREAL_DAY);
    drawCenterLabel(context, fields, tropical, 'L', eye, view);
  }
  // 高気圧 — H。
  for (let index = 0; index < HIGH_COUNT; index += 1) {
    const high = highPlacementAt(index, seconds, R_EARTH);
    if (high === null || high.depth < 2) continue;
    drawCenterLabel(context, fields, high, 'H', 0, view);
  }
}
