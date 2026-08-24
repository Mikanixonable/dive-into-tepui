// 赤道面・黄道面の目安グリッド(緯線・経線)と両極マーカー。頂点は ECI に固定した
// 単位球面上の点(星殻と同じ半径)で、自機中心に追従する固定半径殻として描く。
import * as THREE from 'three/webgpu';
import { Q_ECL_TO_ECI } from '../physics/ecliptic';
import { STAR_SHELL_RADIUS } from './stars';
import { markOverlay } from './pipeline/lit-layer';

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

// 黄道・赤道それぞれのカテゴリトグルと、配下の面・極・グリッドの対応。表示パネルのボタン構成も
// この表を正本として組み立てる。子は1つでもONならカテゴリを自動でONにし、全てOFFになれば
// 自動でOFFにする(applyGridToggle/normalizeGridVisibility)。stars・縮尺グリッド系はどの
// カテゴリにも属さない独立トグルなのでここには含まれない。
interface GridCategory {
  readonly category: keyof CelestialGridVisibility;
  readonly children: readonly (keyof CelestialGridVisibility)[];
}

const GRID_CATEGORIES: readonly GridCategory[] = [
  { category: 'ecliptic', children: ['eclipticPlane', 'eclipticPole', 'eclipticGrid'] },
  { category: 'equator', children: ['equatorPlane', 'equatorPole', 'equatorGrid'] },
];

// クリックされたキー1つの反映。子キーならカテゴリを子の状態から再計算し、カテゴリキー
// そのものなら子を全て同じ値へ揃える(表示パネルの唯一の更新口)。
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

// 面を張る直交基底。e1/e2 が面内、pole が法線(北極方向)。
interface PlaneBasis {
  readonly e1: THREE.Vector3;
  readonly e2: THREE.Vector3;
  readonly pole: THREE.Vector3;
}

const eclToEciQuat = new THREE.Quaternion(Q_ECL_TO_ECI.x, Q_ECL_TO_ECI.y, Q_ECL_TO_ECI.z, Q_ECL_TO_ECI.w);

function rotatedAxis(x: number, y: number, z: number): THREE.Vector3 {
  return new THREE.Vector3(x, y, z).applyQuaternion(eclToEciQuat);
}

// 赤道面はゲーム ECI そのもの(Y軸 = 北極)。
const EQUATOR_BASIS: PlaneBasis = {
  e1: new THREE.Vector3(1, 0, 0),
  e2: new THREE.Vector3(0, 0, 1),
  pole: new THREE.Vector3(0, 1, 0),
};
// 黄道面は Q_ECL_TO_ECI で赤道基底から回転させて得る(傾斜角を直書きしない)。
const ECLIPTIC_BASIS: PlaneBasis = {
  e1: rotatedAxis(1, 0, 0),
  e2: rotatedAxis(0, 1, 0),
  pole: rotatedAxis(0, 0, 1),
};

const GRID_LAT_STEP_DEG = 15; // 交点の緯度間隔
const GRID_LON_STEP_DEG = 15; // 交点の経度間隔
const GRID_LABEL_STEP_DEG = 30; // 座標ラベルは間隔を空けて表示
const CIRCLE_SEGMENTS = 64; // 円1本あたりの分割数
const POLE_MARKER_HALF_LEN = STAR_SHELL_RADIUS * 0.04; // 極マーカーの殻面からの突き出し長さ

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

function makeLine(color: number, opacity: number): THREE.Line {
  const geo = new THREE.BufferGeometry();
  const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
  const line = new THREE.Line(geo, mat);
  markOverlay(line);
  // 常にカメラを中心とする殻として置く(sync が position をカメラ位置へ毎フレーム合わせる)ため、
  // 外接球によるフラスタム判定は常に「視界内」を返し意味を持たない。
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
  // makeLine と同じ理由(常にカメラ中心の殻)。
  line.frustumCulled = false;
  line.renderOrder = 0;
  return line;
}

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

// 緯度・経度の交点における東西・南北の短い十字を、LineSegments 用の
// 頂点対4つ([東西の2点, 南北の2点])として返す。全周の線を描かないことで、
// 天球上の座標密度を保ちつつ視界を塞がない。
function intersectionCrossPoints(basis: PlaneBasis, radius: number, latRad: number, lonRad: number): THREE.Vector3[] {
  const p = planePoint(basis, radius, latRad, lonRad);
  const eps = radius * 0.012;
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
// 3 種とも独立した可視トグルを持つため束ねずに別オブジェクトとして保持するが、
// grid/pole はそれぞれ内部の全セグメントを1つの LineSegments に詰め、
// トグル1つあたり描画1回で済むようにする。
class GridPlane {
  readonly planeLine: THREE.Line;
  readonly gridLine: THREE.LineSegments;
  readonly poleLine: THREE.LineSegments;
  private readonly labelLayer: HTMLDivElement;
  private readonly labels: HTMLDivElement[] = [];
  private readonly gridLabels: { el: HTMLDivElement; lat: number; lon: number }[] = [];
  private basis: PlaneBasis;
  private readonly initialBasis: PlaneBasis;
  private readonly basisRotation = new THREE.Quaternion();

  constructor(scene: THREE.Scene, basis: PlaneBasis, color: number, name: string) {
    this.basis = basis;
    this.initialBasis = basis;
    this.labelLayer = document.createElement('div');
    this.labelLayer.className = 'celestial-grid-labels';
    Object.assign(this.labelLayer.style, { position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: '8' });
    document.body.appendChild(this.labelLayer);
    this.planeLine = makeLine(color, 0.35);
    setLinePoints(this.planeLine, (() => {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= CIRCLE_SEGMENTS; i++) pts.push(planePoint(basis, STAR_SHELL_RADIUS, 0, (i / CIRCLE_SEGMENTS) * Math.PI * 2));
      return pts;
    })());
    scene.add(this.planeLine);

    // 交点ごとの東西・南北の線分(setLinePoints が組む頂点対)を1本の
    // LineSegments へ連結する。連続した1本の折れ線にすると線分間が斜めに
    // 接続され「4」のように見えるため、頂点対を独立したセグメントとして保つ。
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
    const addLabel = (text: string, cls = '') => {
      const el = document.createElement('div');
      el.textContent = text; el.className = `celestial-grid-label ${cls}`;
      Object.assign(el.style, { position: 'fixed', color: `#${color.toString(16).padStart(6, '0')}`, opacity: '0.72', font: '10px monospace', textShadow: '0 0 4px #000', whiteSpace: 'nowrap' });
      this.labelLayer.appendChild(el); this.labels.push(el); return el;
    };
    addLabel(`${name} PLANE`, 'plane');
    addLabel(`⇧ ${name} N`, 'pole-n'); addLabel(`⇩ ${name} S`, 'pole-s');
    // グリッドの全交点に座標ラベルを置く。画面端に固定した代表ラベルは使わない。
    for (let lat = -60; lat <= 60; lat += GRID_LABEL_STEP_DEG) {
      if (lat === 0) continue;
      for (let lon = 0; lon < 360; lon += GRID_LABEL_STEP_DEG) {
        const el = addLabel(`${lon}°/${lat > 0 ? '+' : ''}${lat}°`, 'grid-point');
        this.gridLabels.push({ el, lat, lon });
      }
    }
  }

  // 3本の線を親から外して解放し、ラベル層(配下のラベルごと)を document.body から外す。
  dispose(): void {
    for (const line of [this.planeLine, this.gridLine, this.poleLine]) {
      line.removeFromParent();
      line.geometry.dispose();
      (line.material as THREE.Material).dispose();
    }
    this.labelLayer.remove();
  }

  setBasis(basis: PlaneBasis): void {
    const poleDot = this.basis.pole.dot(basis.pole);
    if (poleDot > 1 - 1e-10 && this.basis.e1.dot(basis.e1) > 1 - 1e-10) return;
    this.basis = basis;
    const initialRotation = new THREE.Matrix4().makeBasis(
      this.initialBasis.e1, this.initialBasis.e2, this.initialBasis.pole,
    );
    const targetRotation = new THREE.Matrix4().makeBasis(basis.e1, basis.e2, basis.pole);
    const initialQ = new THREE.Quaternion().setFromRotationMatrix(initialRotation);
    const targetQ = new THREE.Quaternion().setFromRotationMatrix(targetRotation);
    this.basisRotation.copy(targetQ).multiply(initialQ.invert());
    for (const obj of [this.planeLine, this.gridLine, this.poleLine]) obj.quaternion.copy(this.basisRotation);
  }

  sync(planeVisible: boolean, poleVisible: boolean, gridVisible: boolean, scale: number, camera: THREE.Camera): void {
    this.planeLine.visible = planeVisible;
    this.gridLine.visible = gridVisible;
    this.poleLine.visible = poleVisible;
    for (const obj of [this.planeLine, this.gridLine, this.poleLine]) {
      obj.position.set(0, 0, 0);
      obj.scale.setScalar(scale);
      obj.quaternion.copy(this.basisRotation);
    }
    this.labels.forEach((el) => { el.style.display = 'none'; });
    const show = (el: HTMLDivElement, p: THREE.Vector3, below = false) => {
      const w = window.innerWidth, h = window.innerHeight;
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
      const w = window.innerWidth, h = window.innerHeight;
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
        // 画面端へ押し込む代表ラベルは作らず、交点そのものが画面内にある時だけ表示。
        if (sx < 8 || sx > w - 8 || sy < 8 || sy > h - 8) continue;
        // ラベルは画面の右下へ固定せず、交点におけるグリッド接線の合成方向へ
        // 一定距離だけオフセットする。これによりグリッドの向きに追従し、
        // カメラの回転や投影変化でも交点との対応が崩れない。
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

  constructor(scene: THREE.Scene) {
    this.equator = new GridPlane(scene, EQUATOR_BASIS, 0x8b93a0, 'EQUATOR');
    this.ecliptic = new GridPlane(scene, ECLIPTIC_BASIS, 0xc0a878, 'ECLIPTIC');
  }

  // 星殻と同じく描画原点(= カメラ)に固定した半径殻として、2 面ぶんの可視状態を反映する。
  // scale は星殻半径 STAR_SHELL_RADIUS に対する拡大率(広範囲視点では呼び出し側が
  // CELESTIAL_SHELL_RADIUS / STAR_SHELL_RADIUS を渡す)。
  sync(visibility: CelestialGridVisibility, cam: THREE.Camera, scale: number): void {
    this.equator.sync(visibility.equator && visibility.equatorPlane, visibility.equator && visibility.equatorPole, visibility.equator && visibility.equatorGrid, scale, cam);
    this.ecliptic.sync(visibility.ecliptic && visibility.eclipticPlane, visibility.ecliptic && visibility.eclipticPole, visibility.ecliptic && visibility.eclipticGrid, scale, cam);
  }

  // 2面ぶんの GridPlane を解放する。
  dispose(): void {
    this.equator.dispose();
    this.ecliptic.dispose();
  }
}
