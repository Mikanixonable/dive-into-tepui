// 天気図の凡例。地図の左下に、気圧の色帯・線の種類・前線と中心の記号の見本を描く。
import { MAP_HEIGHT, PRESSURE_HIGH_HPA, PRESSURE_LOW_HPA, pressureColor } from './synoptic-map';

const X0 = 14;
const Y0 = MAP_HEIGHT - 118;
const BOX_WIDTH = 616;
const BOX_HEIGHT = 108;
const TEXT_COLOR = 'rgba(215, 226, 238, 0.8)';
const SMALL_FONT = '11px "JetBrains Mono", ui-monospace, monospace';
const LABEL_FONT = '700 16px "JetBrains Mono", ui-monospace, monospace';
// 色帯の標本数。線の見本の長さと、見本の右にそろえる文字の位置。
const BAR_SAMPLES = 180;
const KEY_LENGTH = 44;
const KEY_TEXT_X = X0 + 52;
// 前線と中心の見本の列。
const SYMBOL_X = X0 + 320;

const rowY = (index: number): number => Y0 + 42 + index * 20;
const symbolY = (index: number): number => Y0 + 8 + index * 24;

// 気圧偏差の色帯と目盛り。
function drawPressureKey(context: CanvasRenderingContext2D): void {
  const barY = Y0 + 6;
  for (let i = 0; i < BAR_SAMPLES; i += 1) {
    const p = PRESSURE_LOW_HPA + (PRESSURE_HIGH_HPA - PRESSURE_LOW_HPA) * (i / (BAR_SAMPLES - 1));
    const [r, g, b] = pressureColor(p);
    context.fillStyle = `rgb(${r | 0}, ${g | 0}, ${b | 0})`;
    context.fillRect(X0 + i, barY, 2, 10);
  }
  context.fillStyle = TEXT_COLOR;
  context.fillText('気圧 [hPa]', X0 + 190, barY + 5);
  context.fillText(String(PRESSURE_LOW_HPA), X0, barY + 20);
  context.fillText(`+${PRESSURE_HIGH_HPA}`, X0 + 160, barY + 20);
}

// 線の種類の見本。流線・地表の風・蛇行・等圧線の四行。
function drawLineKeys(context: CanvasRenderingContext2D): void {
  context.fillStyle = TEXT_COLOR;
  context.strokeStyle = 'rgba(125, 195, 255, 0.75)';
  context.lineWidth = 1.4;
  context.beginPath();
  context.moveTo(X0, rowY(0));
  context.lineTo(X0 + KEY_LENGTH, rowY(0));
  context.stroke();
  context.fillText('上層の風の流線(明るいほど速い)', KEY_TEXT_X, rowY(0));

  context.strokeStyle = 'rgba(205, 218, 235, 0.6)';
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(X0, rowY(1));
  context.lineTo(X0 + KEY_LENGTH, rowY(1));
  context.moveTo(X0 + KEY_LENGTH, rowY(1));
  context.lineTo(X0 + KEY_LENGTH - 6, rowY(1) - 3);
  context.moveTo(X0 + KEY_LENGTH, rowY(1));
  context.lineTo(X0 + KEY_LENGTH - 6, rowY(1) + 3);
  context.stroke();
  context.fillText('地表の風(m/s)', KEY_TEXT_X, rowY(1));

  context.strokeStyle = 'rgba(255, 195, 95, 0.75)';
  context.lineWidth = 1.6;
  context.beginPath();
  for (let i = 0; i <= KEY_LENGTH; i += 1) {
    const x = X0 + i;
    const y = rowY(2) + Math.sin((i / KEY_LENGTH) * Math.PI * 2) * 4;
    if (i === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  }
  context.stroke();
  context.fillText('偏西風の蛇行(上層ジェットの軸)', KEY_TEXT_X, rowY(2));

  context.strokeStyle = 'rgba(215, 228, 242, 0.62)';
  context.lineWidth = 1.5;
  context.beginPath();
  context.moveTo(X0, rowY(3));
  context.lineTo(X0 + KEY_LENGTH, rowY(3));
  context.stroke();
  context.fillText('等圧線(4 hPa、20 hPa ごとに太線)', KEY_TEXT_X, rowY(3));
}

// 前線の見本(寒冷・温暖・オクルード)と、中心の見本(L・H・眼)。
function drawFrontKeys(context: CanvasRenderingContext2D): void {
  const x = SYMBOL_X;
  const cold = 'rgba(80, 140, 255, 0.9)';
  context.strokeStyle = cold;
  context.fillStyle = cold;
  context.lineWidth = 2.5;
  context.beginPath();
  context.moveTo(x, symbolY(0));
  context.lineTo(x + KEY_LENGTH, symbolY(0));
  context.stroke();
  context.beginPath();
  context.moveTo(x + 28, symbolY(0) - 6);
  context.lineTo(x + 34, symbolY(0) + 6);
  context.lineTo(x + 22, symbolY(0) + 6);
  context.closePath();
  context.fill();
  context.fillStyle = TEXT_COLOR;
  context.fillText('寒冷前線', x + 52, symbolY(0));

  const warm = 'rgba(255, 100, 82, 0.9)';
  context.strokeStyle = warm;
  context.beginPath();
  context.moveTo(x, symbolY(1));
  context.lineTo(x + KEY_LENGTH, symbolY(1));
  context.stroke();
  context.fillStyle = warm;
  context.beginPath();
  context.arc(x + 28, symbolY(1), 6, -Math.PI / 2, Math.PI / 2);
  context.fill();
  context.fillStyle = TEXT_COLOR;
  context.fillText('温暖前線', x + 52, symbolY(1));

  const occluded = 'rgba(190, 120, 255, 0.9)';
  context.strokeStyle = occluded;
  context.beginPath();
  context.moveTo(x, symbolY(2));
  context.lineTo(x + KEY_LENGTH, symbolY(2));
  context.stroke();
  context.fillStyle = occluded;
  context.beginPath();
  context.moveTo(x + 20, symbolY(2) - 6);
  context.lineTo(x + 26, symbolY(2) + 6);
  context.lineTo(x + 14, symbolY(2) + 6);
  context.closePath();
  context.fill();
  context.beginPath();
  context.arc(x + 34, symbolY(2), 6, -Math.PI / 2, Math.PI / 2);
  context.fill();
  context.fillStyle = TEXT_COLOR;
  context.fillText('オクルード前線', x + 52, symbolY(2));

  context.fillStyle = 'rgba(255, 120, 100, 0.95)';
  context.font = LABEL_FONT;
  context.fillText('L', x + 6, symbolY(3));
  context.fillStyle = 'rgba(110, 170, 255, 0.95)';
  context.fillText('H', x + 26, symbolY(3));
  context.strokeStyle = 'rgba(245, 250, 255, 0.8)';
  context.lineWidth = 1.5;
  context.beginPath();
  context.arc(x + 42, symbolY(3), 5, 0, Math.PI * 2);
  context.stroke();
  context.font = SMALL_FONT;
  context.fillStyle = TEXT_COLOR;
  context.fillText('低気圧 / 高気圧 / 眼', x + 52, symbolY(3));
}

export function drawLegend(context: CanvasRenderingContext2D): void {
  context.fillStyle = 'rgba(10, 13, 17, 0.8)';
  context.fillRect(X0 - 6, Y0 - 8, BOX_WIDTH, BOX_HEIGHT);
  context.strokeStyle = 'rgba(255, 255, 255, 0.12)';
  context.lineWidth = 1;
  context.strokeRect(X0 - 6, Y0 - 8, BOX_WIDTH, BOX_HEIGHT);
  context.font = SMALL_FONT;
  context.textBaseline = 'middle';
  context.textAlign = 'left';
  drawPressureKey(context);
  drawLineKeys(context);
  drawFrontKeys(context);
}
