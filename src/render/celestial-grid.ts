// 赤道面・黄道面の目安グリッド(緯線・経線)と両極マーカー。頂点は ECI に固定した
// 単位球面上の点(星殻と同じ半径)で、自機中心に追従する固定半径殻として描く。
import * as THREE from 'three/webgpu';
import { ECLIPTIC_BASIS, EQUATOR_BASIS, type PlaneBasis } from './plane-basis';
import { STAR_SHELL_RADIUS } from './stars';
import { markOverlay } from './pipeline/lit-layer';
import { SCHEMATIC_LINE } from './schematic-style';
import { RenderStyleGate, type RenderStyle } from './render-style';
import type { Viewport } from './viewport';

export interface CelestialGridVisibility {
  readonly stars: boolean;
  readonly ecliptic: boolean;
  readonly eclipticPlane: boolean;
  readonly eclipticPole: boolean;
  readonly eclipticGrid: boolean;
  readonly equator: boolean;
  readonly equatorPlane: boolean;
  readonly equatorPole: boolean;
  readonly equatorGrid: boolean;
  readonly eclipticScaleGrid: boolean;
  readonly equatorScaleGrid: boolean;
  readonly moonOrbitScaleGrid: boolean;
  readonly moonEquatorScaleGrid: boolean;
}

// 何も選んでいない状態。星だけを出す。
export const DEFAULT_GRID_VISIBILITY: CelestialGridVisibility = {
  stars: true,
  ecliptic: false,
  eclipticPlane: false, eclipticPole: false, eclipticGrid: false,
  equator: false,
  equatorPlane: false, equatorPole: false, equatorGrid: false,
  eclipticScaleGrid: false,
  equatorScaleGrid: false,
  moonOrbitScaleGrid: false,
  moonEquatorScaleGrid: false,
};

// 黄道・赤道それぞれのカテゴリトグルと、配下の面・極・グリッドの対応。子が1つでも ON なら
// カテゴリは ON、全て OFF なら OFF になる。
interface GridCategory {
  readonly category: keyof CelestialGridVisibility;
  readonly children: readonly (keyof CelestialGridVisibility)[];
}

const GRID_CATEGORIES: readonly GridCategory[] = [
  { category: 'ecliptic', children: ['eclipticPlane', 'eclipticPole', 'eclipticGrid'] },
  { category: 'equator', children: ['equatorPlane', 'equatorPole', 'equatorGrid'] },
];

// キー1つの切り替えを反映する。子キーならカテゴリを子の状態から計算し直し、カテゴリキー
// そのものなら子を全て同じ値へ揃える。
export function applyGridToggle(
  current: CelestialGridVisibility, key: keyof CelestialGridVisibility, on: boolean,
): CelestialGridVisibility {
  const asCategory = GRID_CATEGORIES.find((c) => c.category === key);
  if (asCategory !== undefined) {
    const next = { ...current, [key]: on };
    for (const child of asCategory.children) next[child] = on;
    return next;
  }
  const owner = GRID_CATEGORIES.find((c) => c.children.includes(key));
  if (owner === undefined) return { ...current, [key]: on };
  const next = { ...current, [key]: on };
  next[owner.category] = owner.children.some((child) => next[child]);
  return next;
}

// 保存データ・既定値を読み込んだ直後に、カテゴリトグルを子の状態から一括で計算し直す。
export function normalizeGridVisibility(visibility: CelestialGridVisibility): CelestialGridVisibility {
  const next = { ...visibility };
  for (const { category, children } of GRID_CATEGORIES) {
    next[category] = children.some((child) => next[child]);
  }
  return next;
}

// 保存された文字列を可視状態へ読み直す。読めなければ既定値に戻る。
export function parseGridVisibility(text: string | null): CelestialGridVisibility {
  try {
    if (!text) return DEFAULT_GRID_VISIBILITY;
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_GRID_VISIBILITY;
    return normalizeGridVisibility({ ...DEFAULT_GRID_VISIBILITY, ...parsed });
  } catch {
    return DEFAULT_GRID_VISIBILITY;
  }
}

// 可視状態を保存へ載せる文字列にする。
export function formatGridVisibility(visibility: CelestialGridVisibility): string {
  return JSON.stringify(visibility);
}

const GRID_LAT_STEP_DEG = 15; // 交点の緯度間隔
const GRID_LON_STEP_DEG = 15; // 交点の経度間隔
const GRID_LABEL_STEP_DEG = 30; // 座標ラベルは間隔を空けて表示
const CIRCLE_SEGMENTS = 64; // 円1本あたりの分割数
const POLE_MARKER_HALF_LEN = STAR_SHELL_RADIUS * 0.04; // 極マーカーの殻面からの突き出し長さ

// basis の面での緯度 latRad・経度 lonRad・半径 radius の点。経度は e1 から e2 へ増える。
function planePoint(basis: PlaneBasis, radius: number, latRad: number, lonRad: number): THREE.Vector3 {
  const c = radius * Math.cos(latRad);
  const s = radius * Math.sin(latRad);
  const cl = Math.cos(lonRad);
  const sl = Math.sin(lonRad);
  return new THREE.Vector3(
    c * cl * basis.e1.x + c * sl * basis.e2.x + s * basis.pole.x,
    c * cl * basis.e1.y + c * sl * basis.e2.y + s * basis.pole.y,
    c * cl * basis.e1.z + c * sl * basis.e2.z + s * basis.pole.z,
  );
}

// 星殻に乗せる折れ線1本。頂点は setLinePoints で後から入れる。
function makeLine(color: number, opacity: number): THREE.Line {
  const geo = new THREE.BufferGeometry();
  const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
  const line = new THREE.Line(geo, mat);
  markOverlay(line);
  // 描画原点に固定した星殻と同じ大きさの殻なので、外接球によるフラスタム判定は
  // 常に「視界内」を返し意味を持たない。
  line.frustumCulled = false;
  line.renderOrder = 0;
  return line;
}

// 経緯線の交点マーカー・両極マーカーは、目盛りの数だけ THREE.LineSegments の
// 頂点対として1つのバッファへ詰め、1グループ=1描画にまとめる。
function makeLineSegments(color: number, opacity: number): THREE.LineSegments {
  const geo = new THREE.BufferGeometry();
  const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
  const line = new THREE.LineSegments(geo, mat);
  markOverlay(line);
  // 描画原点に固定した殻なので、外接球によるフラスタム判定は意味を持たない。
  line.frustumCulled = false;
  line.renderOrder = 0;
  return line;
}

// 頂点列を新しい BufferGeometry へ焼き直し、前の geometry を解放する。
function setLinePoints(line: THREE.Line, points: readonly THREE.Vector3[]): void {
  const arr = new Float32Array(points.length * 3);
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    arr[i * 3] = p.x;
    arr[i * 3 + 1] = p.y;
    arr[i * 3 + 2] = p.z;
  }
  line.geometry.dispose();
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  line.geometry = geo;
}

// 緯度・経度の交点における東西・南北の短い十字を、LineSegments 用の頂点対4つ
// ([東西の2点, 南北の2点])として返す。交点だけを示すので視界を塞がずに済む。
function intersectionCrossPoints(basis: PlaneBasis, radius: number, latRad: number, lonRad: number): THREE.Vector3[] {
  const p = planePoint(basis, radius, latRad, lonRad);
  const eps = radius * 0.012;
  // その点における経度方向・緯度方向の接ベクトル。十字の腕の向きになる。
  const dLon = new THREE.Vector3(
    -Math.sin(lonRad) * basis.e1.x + Math.cos(lonRad) * basis.e2.x,
    -Math.sin(lonRad) * basis.e1.y + Math.cos(lonRad) * basis.e2.y,
    -Math.sin(lonRad) * basis.e1.z + Math.cos(lonRad) * basis.e2.z,
  );
  const dLat = new THREE.Vector3(
    -Math.sin(latRad) * Math.cos(lonRad) * basis.e1.x - Math.sin(latRad) * Math.sin(lonRad) * basis.e2.x + Math.cos(latRad) * basis.pole.x,
    -Math.sin(latRad) * Math.cos(lonRad) * basis.e1.y - Math.sin(latRad) * Math.sin(lonRad) * basis.e2.y + Math.cos(latRad) * basis.pole.y,
    -Math.sin(latRad) * Math.cos(lonRad) * basis.e1.z - Math.sin(latRad) * Math.sin(lonRad) * basis.e2.z + Math.cos(latRad) * basis.pole.z,
  );
  return [
    new THREE.Vector3(p.x - dLon.x * eps, p.y - dLon.y * eps, p.z - dLon.z * eps),
    new THREE.Vector3(p.x + dLon.x * eps, p.y + dLon.y * eps, p.z + dLon.z * eps),
    new THREE.Vector3(p.x - dLat.x * eps, p.y - dLat.y * eps, p.z - dLat.z * eps),
    new THREE.Vector3(p.x + dLat.x * eps, p.y + dLat.y * eps, p.z + dLat.z * eps),
  ];
}

// 極点(緯度±90°)の交点十字。経度が縮退するため intersectionCrossPoints の東西腕
// (経度方向)は使えず、直交する2本の子午線方向(e1・e2)をそのまま腕にする。
function poleCrossPoints(basis: PlaneBasis, radius: number, sign: 1 | -1): THREE.Vector3[] {
  const p = new THREE.Vector3(basis.pole.x, basis.pole.y, basis.pole.z).multiplyScalar(radius * sign);
  const eps = radius * 0.012;
  return [
    new THREE.Vector3(p.x - basis.e1.x * eps, p.y - basis.e1.y * eps, p.z - basis.e1.z * eps),
    new THREE.Vector3(p.x + basis.e1.x * eps, p.y + basis.e1.y * eps, p.z + basis.e1.z * eps),
    new THREE.Vector3(p.x - basis.e2.x * eps, p.y - basis.e2.y * eps, p.z - basis.e2.z * eps),
    new THREE.Vector3(p.x + basis.e2.x * eps, p.y + basis.e2.y * eps, p.z + basis.e2.z * eps),
  ];
}

// 面 1 枚ぶんの表示物: 基準円(plane)・緯線経線の交点網(grid)・両極マーカー(pole)。
// 3 種は独立した可視トグルを持つので、別オブジェクトとして保つ。
class GridPlane {
  private readonly planeLine: THREE.Line;
  private readonly gridLine: THREE.LineSegments;
  private readonly poleLine: THREE.LineSegments;
  private readonly labelLayer: HTMLDivElement;
  private readonly labels: HTMLDivElement[] = [];
  private readonly gridLabels: { el: HTMLDivElement; lat: number; lon: number }[] = [];
  private readonly basis: PlaneBasis;
  private readonly realisticColor: string;
  private readonly styleGate = new RenderStyleGate();

  // 面 1 枚ぶんの線を scene へ、ラベル層を document.body へ組み立てる。
  public constructor(scene: THREE.Scene, basis: PlaneBasis, color: number, name: string) {
    this.basis = basis;
    this.realisticColor = `#${color.toString(16).padStart(6, '0')}`;
    this.labelLayer = document.createElement('div');
    this.labelLayer.className = 'celestial-grid-labels';
    Object.assign(this.labelLayer.style, { position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: '8' });
    document.body.appendChild(this.labelLayer);
    // 基準円: 緯度 0 の全周。
    this.planeLine = makeLine(color, 0.35);
    setLinePoints(this.planeLine, (() => {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= CIRCLE_SEGMENTS; i++) pts.push(planePoint(basis, STAR_SHELL_RADIUS, 0, (i / CIRCLE_SEGMENTS) * Math.PI * 2));
      return pts;
    })());
    scene.add(this.planeLine);

    // 交点ごとの東西・南北の線分を1本の LineSegments へ連結する。連続した1本の折れ線に
    // すると線分間が斜めに繋がり「4」のように見えるので、頂点対のまま独立させておく。
    const gridPoints: THREE.Vector3[] = [];
    for (let lat = -75; lat <= 75; lat += GRID_LAT_STEP_DEG) {
      for (let lon = 0; lon < 360; lon += GRID_LON_STEP_DEG) {
        gridPoints.push(...intersectionCrossPoints(basis, STAR_SHELL_RADIUS, (lat * Math.PI) / 180, (lon * Math.PI) / 180));
      }
    }
    for (const sign of [1, -1] as const) gridPoints.push(...poleCrossPoints(basis, STAR_SHELL_RADIUS, sign));
    this.gridLine = makeLineSegments(color, 0.3);
    setLinePoints(this.gridLine, gridPoints);
    scene.add(this.gridLine);

    // 両極マーカー: 殻面から内側へ突き出す短い線分。
    const polePoints: THREE.Vector3[] = [];
    for (const sign of [1, -1]) {
      const tip = new THREE.Vector3(basis.pole.x * STAR_SHELL_RADIUS * sign, basis.pole.y * STAR_SHELL_RADIUS * sign, basis.pole.z * STAR_SHELL_RADIUS * sign);
      const base = new THREE.Vector3(
        tip.x - basis.pole.x * POLE_MARKER_HALF_LEN * sign,
        tip.y - basis.pole.y * POLE_MARKER_HALF_LEN * sign,
        tip.z - basis.pole.z * POLE_MARKER_HALF_LEN * sign,
      );
      polePoints.push(base, tip);
    }
    this.poleLine = makeLineSegments(color, 0.7);
    setLinePoints(this.poleLine, polePoints);
    scene.add(this.poleLine);
    // ラベル1枚を作ってラベル層へ入れ、labels の末尾へ積む。並び順が sync 側の索引になる。
    const addLabel = (text: string, cls = '') => {
      const el = document.createElement('div');
      el.textContent = text; el.className = `celestial-grid-label ${cls}`;
      Object.assign(el.style, { position: 'fixed', color: this.realisticColor, opacity: '0.72', font: '10px monospace', textShadow: '0 0 4px #000', whiteSpace: 'nowrap' });
      this.labelLayer.appendChild(el); this.labels.push(el); return el;
    };
    addLabel(`${name} PLANE`, 'plane');
    addLabel(`⇧ ${name} N`, 'pole-n'); addLabel(`⇩ ${name} S`, 'pole-s');
    // グリッドの全交点に座標ラベルを置く。
    for (let lat = -60; lat <= 60; lat += GRID_LABEL_STEP_DEG) {
      if (lat === 0) continue;
      for (let lon = 0; lon < 360; lon += GRID_LABEL_STEP_DEG) {
        const el = addLabel(`${lon}°/${lat > 0 ? '+' : ''}${lat}°`, 'grid-point');
        this.gridLabels.push({ el, lat, lon });
      }
    }
  }

  // 3本の線を親から外して解放し、ラベル層(配下のラベルごと)を document.body から外す。
  public dispose(): void {
    for (const line of [this.planeLine, this.gridLine, this.poleLine]) {
      line.removeFromParent();
      line.geometry.dispose();
      (line.material as THREE.Material).dispose();
    }
    this.labelLayer.remove();
  }

  // 模式図では区別の意味を持たない黒へ固定し、写実では元の色へ戻す。
  private applyStyle(style: RenderStyle): void {
    if (!this.styleGate.changed(style)) return;
    const color = style === 'schematic' ? `#${SCHEMATIC_LINE.toString(16).padStart(6, '0')}` : this.realisticColor;
    for (const line of [this.planeLine, this.gridLine, this.poleLine]) {
      (line.material as THREE.LineBasicMaterial).color.set(color);
    }
    for (const el of this.labels) {
      el.style.color = color;
      el.style.textShadow = style === 'schematic' ? 'none' : '0 0 4px #000';
    }
  }

  // 3 種の線とラベルを、この面の可視トグルとカメラへ合わせる。scale は星殻半径への倍率。
  public sync(
    style: RenderStyle, planeVisible: boolean, poleVisible: boolean, gridVisible: boolean,
    scale: number, camera: THREE.Camera, viewport: Viewport,
  ): void {
    this.applyStyle(style);
    this.planeLine.visible = planeVisible;
    this.gridLine.visible = gridVisible;
    this.poleLine.visible = poleVisible;
    for (const obj of [this.planeLine, this.gridLine, this.poleLine]) {
      obj.position.set(0, 0, 0);
      obj.scale.setScalar(scale);
    }
    this.labels.forEach((el) => { el.style.display = 'none'; });
    // 殻座標の点 p へラベルを置く。視錐台の外なら出さない。
    const show = (el: HTMLDivElement, p: THREE.Vector3, below = false) => {
      const w = viewport.width, h = viewport.height;
      const v = new THREE.Vector3(p.x * scale, p.y * scale, p.z * scale).project(camera);
      if (v.z < -1 || v.z > 1) return;
      const margin = 18;
      const x = Math.max(margin, Math.min(w - margin, (v.x * .5 + .5) * w));
      const y = Math.max(margin, Math.min(h - margin, (-v.y * .5 + .5) * h + (below ? 12 : 0)));
      el.style.left = `${x}px`; el.style.top = `${y}px`; el.style.display = '';
    };
    const [plane, pn, ps] = this.labels;
    if (planeVisible) show(plane!, planePoint(this.basis, STAR_SHELL_RADIUS, 0, 0), true);
    if (poleVisible) {
      show(pn!, new THREE.Vector3(this.basis.pole.x * STAR_SHELL_RADIUS, this.basis.pole.y * STAR_SHELL_RADIUS, this.basis.pole.z * STAR_SHELL_RADIUS));
      show(ps!, new THREE.Vector3(-this.basis.pole.x * STAR_SHELL_RADIUS, -this.basis.pole.y * STAR_SHELL_RADIUS, -this.basis.pole.z * STAR_SHELL_RADIUS));
    }
    if (gridVisible) {
      const w = viewport.width, h = viewport.height;
      const project = (p: THREE.Vector3) => new THREE.Vector3(p.x * scale, p.y * scale, p.z * scale).project(camera);
      for (const item of this.gridLabels) {
        const latRad = item.lat * Math.PI / 180;
        const lonRad = item.lon * Math.PI / 180;
        const p = planePoint(this.basis, STAR_SHELL_RADIUS, latRad, lonRad);
        const base = project(p);
        if (base.z < -1 || base.z > 1) continue;
        const d = 0.01 * STAR_SHELL_RADIUS;
        const dl = planePoint(this.basis, STAR_SHELL_RADIUS, latRad, lonRad + d / STAR_SHELL_RADIUS);
        const dt = planePoint(this.basis, STAR_SHELL_RADIUS, latRad + d / STAR_SHELL_RADIUS, lonRad);
        const a = project(dl), b = project(dt);
        const sx = (base.x * .5 + .5) * w, sy = (-base.y * .5 + .5) * h;
        const dxLon = (a.x - base.x) * w * .5, dyLon = -(a.y - base.y) * h * .5;
        const dxLat = (b.x - base.x) * w * .5, dyLat = -(b.y - base.y) * h * .5;
        const hx = Math.abs(dxLon) >= Math.abs(dyLon) ? dxLon : dxLat;
        const hy = Math.abs(dxLon) >= Math.abs(dyLon) ? dyLon : dyLat;
        let angle = Math.atan2(hy, hx) * 180 / Math.PI;
        if (angle > 90) angle -= 180;
        if (angle < -90) angle += 180;
        if (sx < 8 || sx > w - 8 || sy < 8 || sy > h - 8) continue;
        // ラベルは交点におけるグリッド接線の合成方向へ逃がす。グリッドの向きに追従するので、
        // カメラの回転や投影が変わっても交点との対応が崩れない。
        const tangentX = dxLon + dxLat;
        const tangentY = dyLon + dyLat;
        const tangentLen = Math.hypot(tangentX, tangentY) || 1;
        const offset = 5;
        item.el.style.left = `${sx + offset * tangentX / tangentLen}px`;
        item.el.style.top = `${sy + offset * tangentY / tangentLen}px`;
        item.el.style.transform = `translate(0, 0) rotate(${angle.toFixed(1)}deg)`;
        item.el.style.display = '';
      }
    }
  }
}

export class CelestialGrid {
  private readonly equator: GridPlane;
  private readonly ecliptic: GridPlane;

  // 赤道面・黄道面の 2 枚を scene へ置く。
  public constructor(scene: THREE.Scene) {
    this.equator = new GridPlane(scene, EQUATOR_BASIS, 0x8b93a0, 'EQUATOR');
    this.ecliptic = new GridPlane(scene, ECLIPTIC_BASIS, 0xc0a878, 'ECLIPTIC');
  }

  // 星殻と同じく描画原点(= カメラ)に固定した半径殻として、2 面ぶんの可視状態を反映する。
  // scale は星殻半径 STAR_SHELL_RADIUS に対する拡大率(stars.ts の CELESTIAL_SHELL_SCALE)。
  public sync(
    style: RenderStyle, visibility: CelestialGridVisibility, cam: THREE.Camera, scale: number,
    viewport: Viewport,
  ): void {
    this.equator.sync(
      style, visibility.equator && visibility.equatorPlane, visibility.equator && visibility.equatorPole,
      visibility.equator && visibility.equatorGrid, scale, cam, viewport);
    this.ecliptic.sync(
      style, visibility.ecliptic && visibility.eclipticPlane, visibility.ecliptic && visibility.eclipticPole,
      visibility.ecliptic && visibility.eclipticGrid, scale, cam, viewport);
  }

  // 2面ぶんの GridPlane を解放する。
  public dispose(): void {
    this.equator.dispose();
    this.ecliptic.dispose();
  }
}
