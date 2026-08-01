// navball ウィンドウの DOM: 正射影した円(グリッド + 方位マーカー)、基準モードの
// 排他選択、天球グリッド(render/celestial-grid.ts)6トグル。描画データは Navball が計算し、
// ここは押し出すだけ(sync/build の分担)。
import { hudButton, HudToggle } from '../hud/buttons';
import { CelestialGridVisibility } from '../../render/celestial-grid';
import type { NavballMode } from './navball';

const SVG_NS = 'http://www.w3.org/2000/svg';

export interface NavballGridLine {
  readonly cls: string;
  readonly points: readonly (readonly [number, number])[];
}

export interface NavballMarkerPoint {
  readonly key: string;
  readonly cls: string;
  readonly symbol: string;
  readonly x: number;
  readonly y: number;
  readonly opacity: number;
}

// [number,number] 点列を SVG polyline の points 属性値へ整形する。
function pointsAttr(points: readonly (readonly [number, number])[]): string {
  return points.map(([x, y]) => `${x},${y}`).join(' ');
}

export class NavballPanel {
  onModeSelect: ((mode: NavballMode) => void) | null = null;
  onGridToggle: ((key: keyof CelestialGridVisibility, on: boolean) => void) | null = null;

  private readonly gridGroup: SVGGElement;
  private readonly markerGroup: SVGGElement;
  private readonly modeButtons = new Map<NavballMode, HTMLElement>();

  // modeItems/gridToggleItems の並び順どおりにボタン・トグルを組み、root へ追加する。
  constructor(
    root: HTMLElement,
    modeItems: readonly (readonly [NavballMode, string])[],
    gridToggleItems: readonly (readonly [keyof CelestialGridVisibility, string])[],
  ) {
    const panel = document.createElement('div');
    panel.id = 'navball';
    panel.className = 'panel';
    panel.addEventListener('pointerdown', (e) => e.stopPropagation());

    const title = document.createElement('h3');
    title.textContent = 'NAVBALL';
    panel.appendChild(title);

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('class', 'nb-ball');

    const rim = document.createElementNS(SVG_NS, 'circle');
    rim.setAttribute('cx', '50');
    rim.setAttribute('cy', '50');
    rim.setAttribute('r', '42');
    rim.setAttribute('class', 'nb-rim');
    svg.appendChild(rim);

    this.gridGroup = document.createElementNS(SVG_NS, 'g');
    svg.appendChild(this.gridGroup);

    this.markerGroup = document.createElementNS(SVG_NS, 'g');
    svg.appendChild(this.markerGroup);

    // 機首方向は常にボールの中心(機体座標系原点)に一致するので、固定の十字で描く。
    const bore = document.createElementNS(SVG_NS, 'g');
    bore.setAttribute('class', 'nb-bore');
    const boreH = document.createElementNS(SVG_NS, 'line');
    boreH.setAttribute('x1', '46'); boreH.setAttribute('y1', '50');
    boreH.setAttribute('x2', '54'); boreH.setAttribute('y2', '50');
    const boreV = document.createElementNS(SVG_NS, 'line');
    boreV.setAttribute('x1', '50'); boreV.setAttribute('y1', '46');
    boreV.setAttribute('x2', '50'); boreV.setAttribute('y2', '54');
    bore.appendChild(boreH);
    bore.appendChild(boreV);
    svg.appendChild(bore);

    panel.appendChild(svg);

    const modeRow = document.createElement('div');
    modeRow.className = 'hud-seg';
    const modeTitle = document.createElement('span');
    modeTitle.className = 'seg-title';
    modeTitle.textContent = '基準';
    modeRow.appendChild(modeTitle);
    for (const [mode, label] of modeItems) {
      const btn = hudButton(label, () => this.onModeSelect?.(mode));
      modeRow.appendChild(btn);
      this.modeButtons.set(mode, btn);
    }
    panel.appendChild(modeRow);

    for (const [key, label] of gridToggleItems) {
      const toggle = new HudToggle(label, (on) => this.onGridToggle?.(key, on));
      panel.appendChild(toggle.element);
    }

    root.appendChild(panel);
  }

  // 選択中モードのボタンを点灯させる。
  setMode(mode: NavballMode): void {
    for (const [m, btn] of this.modeButtons) btn.classList.toggle('on', m === mode);
  }

  // ターゲット不在のあいだ、ターゲット基準の2ボタンをクリック不能にする。
  setTargetModeEnabled(enabled: boolean): void {
    for (const key of ['targetPro', 'targetRetro'] as const) {
      this.modeButtons.get(key)?.classList.toggle('disabled', !enabled);
    }
  }

  // グリッド線と方位マーカーをボールへ描き直す。両グループを毎回総入れ替えする
  // (フレームごとに姿勢が変わり本数も一定でないため、差分更新はしない)。
  setBall(lines: readonly NavballGridLine[], markers: readonly NavballMarkerPoint[]): void {
    // グリッド線: 1本の緯線/子午線が手前半球の区間ごとに複数の polyline へ分かれて渡ってくる。
    this.gridGroup.innerHTML = '';
    for (const line of lines) {
      const el = document.createElementNS(SVG_NS, 'polyline');
      el.setAttribute('points', pointsAttr(line.points));
      el.setAttribute('class', line.cls);
      this.gridGroup.appendChild(el);
    }

    this.markerGroup.innerHTML = '';
    for (const m of markers) {
      const text = document.createElementNS(SVG_NS, 'text');
      text.setAttribute('x', String(m.x));
      text.setAttribute('y', String(m.y));
      text.setAttribute('class', m.cls);
      text.setAttribute('opacity', String(m.opacity));
      text.textContent = m.symbol;
      this.markerGroup.appendChild(text);
    }
  }
}
