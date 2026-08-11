// 赤道面・黄道面の目安グリッド(緯線・経線)と両極マーカー。頂点は ECI に固定した
// 単位球面上の点(星殻と同じ半径)で、自機中心に追従する固定半径殻として描く。
import * as THREE from 'three/webgpu';
import { Q_ECL_TO_ECI } from '../physics/ecliptic';
import { qRotate } from '../physics/attitude';
import { Vec3, v3 } from '../physics/vec3';
import { STAR_SHELL_RADIUS } from './stars';

export interface CelestialGridVisibility {
  readonly ecliptic: boolean;
  readonly eclipticPlane: boolean;
  readonly eclipticPole: boolean;
  readonly eclipticGrid: boolean;
  readonly equator: boolean;
  readonly equatorPlane: boolean;
  readonly equatorPole: boolean;
  readonly equatorGrid: boolean;
}

// 面を張る直交基底。e1/e2 が面内、pole が法線(北極方向)。
interface PlaneBasis {
  readonly e1: Vec3;
  readonly e2: Vec3;
  readonly pole: Vec3;
}

// 赤道面はゲーム ECI そのもの(Y軸 = 北極)。
const EQUATOR_BASIS: PlaneBasis = { e1: v3(1, 0, 0), e2: v3(0, 0, 1), pole: v3(0, 1, 0) };
// 黄道面は Q_ECL_TO_ECI で赤道基底から回転させて得る(傾斜角を直書きしない)。
const ECLIPTIC_BASIS: PlaneBasis = {
  e1: qRotate(Q_ECL_TO_ECI, v3(1, 0, 0)),
  e2: qRotate(Q_ECL_TO_ECI, v3(0, 1, 0)),
  pole: qRotate(Q_ECL_TO_ECI, v3(0, 0, 1)),
};

const GRID_LAT_STEP_DEG = 15; // 交点の緯度間隔
const GRID_LON_STEP_DEG = 15; // 交点の経度間隔
const GRID_LABEL_STEP_DEG = 30; // 座標ラベルは間隔を空けて表示
const CIRCLE_SEGMENTS = 64; // 円1本あたりの分割数
const POLE_MARKER_HALF_LEN = STAR_SHELL_RADIUS * 0.04; // 極マーカーの殻面からの突き出し長さ

function planePoint(basis: PlaneBasis, radius: number, latRad: number, lonRad: number): Vec3 {
  const c = radius * Math.cos(latRad);
  const s = radius * Math.sin(latRad);
  const cl = Math.cos(lonRad);
  const sl = Math.sin(lonRad);
  return v3(
    c * cl * basis.e1.x + c * sl * basis.e2.x + s * basis.pole.x,
    c * cl * basis.e1.y + c * sl * basis.e2.y + s * basis.pole.y,
    c * cl * basis.e1.z + c * sl * basis.e2.z + s * basis.pole.z,
  );
}

function makeLine(color: number, opacity: number): THREE.Line {
  const geo = new THREE.BufferGeometry();
  const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
  const line = new THREE.Line(geo, mat);
  line.frustumCulled = false;
  line.renderOrder = 0;
  return line;
}

function setLinePoints(line: THREE.Line, points: readonly Vec3[]): void {
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

// 緯度 latRad の円周を、始点を終端に複製して閉じた頂点列として返す
// (WebGPU レンダラーは THREE.LineLoop 非対応のため、THREE.Line で手動に閉じる)。
// 緯度・経度の交点だけを小さな十字で示す。全周の線を描かないことで、
// 天球上の座標密度を保ちつつ視界を塞がない。
function intersectionCrossPoints(basis: PlaneBasis, radius: number, latRad: number, lonRad: number): Vec3[] {
  const p = planePoint(basis, radius, latRad, lonRad);
  const eps = radius * 0.012;
  const dLon = v3(
    -Math.sin(lonRad) * basis.e1.x + Math.cos(lonRad) * basis.e2.x,
    -Math.sin(lonRad) * basis.e1.y + Math.cos(lonRad) * basis.e2.y,
    -Math.sin(lonRad) * basis.e1.z + Math.cos(lonRad) * basis.e2.z,
  );
  const dLat = v3(
    -Math.sin(latRad) * Math.cos(lonRad) * basis.e1.x - Math.sin(latRad) * Math.sin(lonRad) * basis.e2.x + Math.cos(latRad) * basis.pole.x,
    -Math.sin(latRad) * Math.cos(lonRad) * basis.e1.y - Math.sin(latRad) * Math.sin(lonRad) * basis.e2.y + Math.cos(latRad) * basis.pole.y,
    -Math.sin(latRad) * Math.cos(lonRad) * basis.e1.z - Math.sin(latRad) * Math.sin(lonRad) * basis.e2.z + Math.cos(latRad) * basis.pole.z,
  );
  return [
    v3(p.x - dLon.x * eps, p.y - dLon.y * eps, p.z - dLon.z * eps),
    v3(p.x + dLon.x * eps, p.y + dLon.y * eps, p.z + dLon.z * eps),
    v3(p.x - dLat.x * eps, p.y - dLat.y * eps, p.z - dLat.z * eps),
    v3(p.x + dLat.x * eps, p.y + dLat.y * eps, p.z + dLat.z * eps),
  ];
}

// 面 1 枚ぶんの表示物: 基準円(plane)・緯線経線の網(grid)・両極マーカー(pole)。
// 3 種とも独立した可視トグルを持つため、束ねずに別オブジェクトとして保持する。
class GridPlane {
  readonly planeLine: THREE.Line;
  readonly gridGroup = new THREE.Group();
  readonly poleGroup = new THREE.Group();
  private readonly labelLayer: HTMLDivElement;
  private readonly labels: HTMLDivElement[] = [];
  private readonly gridLabels: { el: HTMLDivElement; lat: number; lon: number }[] = [];
  private readonly basis: PlaneBasis;

  constructor(scene: THREE.Scene, basis: PlaneBasis, color: number, name: string) {
    this.basis = basis;
    this.labelLayer = document.createElement('div');
    this.labelLayer.className = 'celestial-grid-labels';
    Object.assign(this.labelLayer.style, { position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: '8' });
    document.body.appendChild(this.labelLayer);
    this.planeLine = makeLine(color, 0.35);
    setLinePoints(this.planeLine, (() => {
      const pts: Vec3[] = [];
      for (let i = 0; i <= CIRCLE_SEGMENTS; i++) pts.push(planePoint(basis, STAR_SHELL_RADIUS, 0, (i / CIRCLE_SEGMENTS) * Math.PI * 2));
      return pts;
    })());
    scene.add(this.planeLine);

    for (let lat = -75; lat <= 75; lat += GRID_LAT_STEP_DEG) {
      if (lat === 0) continue;
      for (let lon = 0; lon < 360; lon += GRID_LON_STEP_DEG) {
        const points = intersectionCrossPoints(basis, STAR_SHELL_RADIUS, (lat * Math.PI) / 180, (lon * Math.PI) / 180);
        // 交点の東西・南北の線分を別オブジェクトにする。1本の折れ線に
        // まとめると線分間が斜めに接続され「4」のように見えるため。
        const lonLine = makeLine(color, 0.3);
        setLinePoints(lonLine, points.slice(0, 2));
        this.gridGroup.add(lonLine);
        const latLine = makeLine(color, 0.3);
        setLinePoints(latLine, points.slice(2, 4));
        this.gridGroup.add(latLine);
      }
    }
    scene.add(this.gridGroup);

    for (const sign of [1, -1]) {
      const tip = v3(basis.pole.x * STAR_SHELL_RADIUS * sign, basis.pole.y * STAR_SHELL_RADIUS * sign, basis.pole.z * STAR_SHELL_RADIUS * sign);
      const base = v3(
        tip.x - basis.pole.x * POLE_MARKER_HALF_LEN * sign,
        tip.y - basis.pole.y * POLE_MARKER_HALF_LEN * sign,
        tip.z - basis.pole.z * POLE_MARKER_HALF_LEN * sign,
      );
      const line = makeLine(color, 0.7);
      setLinePoints(line, [base, tip]);
      this.poleGroup.add(line);
    }
    scene.add(this.poleGroup);
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

  sync(planeVisible: boolean, poleVisible: boolean, gridVisible: boolean, origin: THREE.Vector3, scale: number, camera: THREE.Camera): void {
    this.planeLine.visible = planeVisible;
    this.gridGroup.visible = gridVisible;
    this.poleGroup.visible = poleVisible;
    for (const obj of [this.planeLine, this.gridGroup, this.poleGroup]) {
      obj.position.copy(origin);
      obj.scale.setScalar(scale);
    }
    this.labels.forEach((el) => { el.style.display = 'none'; });
    const show = (el: HTMLDivElement, p: Vec3, below = false) => {
      const w = window.innerWidth, h = window.innerHeight;
      const v = new THREE.Vector3(origin.x + p.x * scale, origin.y + p.y * scale, origin.z + p.z * scale).project(camera);
      if (v.z < -1 || v.z > 1) return;
      const margin = 18;
      const x = Math.max(margin, Math.min(w - margin, (v.x * .5 + .5) * w));
      const y = Math.max(margin, Math.min(h - margin, (-v.y * .5 + .5) * h + (below ? 12 : 0)));
      el.style.left = `${x}px`; el.style.top = `${y}px`; el.style.display = '';
    };
    const [plane, pn, ps] = this.labels;
    if (planeVisible) show(plane!, planePoint(this.basis, STAR_SHELL_RADIUS, 0, 0), true);
    if (poleVisible) {
      show(pn!, v3(this.basis.pole.x * STAR_SHELL_RADIUS, this.basis.pole.y * STAR_SHELL_RADIUS, this.basis.pole.z * STAR_SHELL_RADIUS));
      show(ps!, v3(-this.basis.pole.x * STAR_SHELL_RADIUS, -this.basis.pole.y * STAR_SHELL_RADIUS, -this.basis.pole.z * STAR_SHELL_RADIUS));
    }
    if (gridVisible) {
      const w = window.innerWidth, h = window.innerHeight;
      const project = (p: Vec3) => new THREE.Vector3(origin.x + p.x * scale, origin.y + p.y * scale, origin.z + p.z * scale).project(camera);
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

  // 星殻と同じくカメラ追従の固定半径殻として、6 トグルぶんの可視状態を反映する。
  // scale は星殻半径 STAR_SHELL_RADIUS に対する拡大率(広範囲視点では呼び出し側が
  // CELESTIAL_SHELL_RADIUS / STAR_SHELL_RADIUS を渡す)。
  sync(visibility: CelestialGridVisibility, cam: THREE.Camera, scale: number): void {
    this.equator.sync(visibility.equator && visibility.equatorPlane, visibility.equator && visibility.equatorPole, visibility.equator && visibility.equatorGrid, cam.position, scale, cam);
    this.ecliptic.sync(visibility.ecliptic && visibility.eclipticPlane, visibility.ecliptic && visibility.eclipticPole, visibility.ecliptic && visibility.eclipticGrid, cam.position, scale, cam);
  }
}
