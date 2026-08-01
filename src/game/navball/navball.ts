// navball 計器: 自機姿勢を基準座標系(自機/ターゲット進行方向/その逆)で正射影した円として
// 表示するための投影計算。方位は physics/orbital.ts の既存 orbitalAxes をそのまま使い、
// 軌道基準方向を自前で組み立てない。天球グリッド(render/celestial-grid.ts)6トグルの可視状態も
// ここが保持し、EnvironmentScene.sync へ渡すのは Game の役目。
import { Attitude, Quat, qInvert, qRotate } from '../../physics/attitude';
import { OrbitState, OrbitalAxes, orbitalAxes } from '../../physics/orbital';
import { Vec3, v3 } from '../../physics/vec3';
import { CelestialGridVisibility } from '../../render/celestial-grid';
import { NavballGridLine, NavballMarkerPoint, NavballPanel } from './navball-panel';

export type NavballMode = 'self' | 'targetPro' | 'targetRetro';

const BALL_CENTER = 50;
const BALL_RADIUS = 42;
const GRID_LAT_STEP_DEG = 30;
const GRID_LON_STEP_DEG = 30;
const GRID_SEGMENTS = 24;

interface MarkerDef {
  readonly key: string;
  readonly cls: string;
  readonly symbol: string;
  readonly dir: (axes: OrbitalAxes) => Vec3;
}

// 自機マーカー(player-markers.ts)と同じ記号・色クラスを使い、意味の対応を崩さない。
const MARKER_DEFS: readonly MarkerDef[] = [
  { key: 'pro', cls: 'nb-pro', symbol: '⊙', dir: (a) => a.pro },
  { key: 'retro', cls: 'nb-pro', symbol: '⊗', dir: (a) => neg(a.pro) },
  { key: 'nrm', cls: 'nb-nrm', symbol: '▲', dir: (a) => a.nrm },
  { key: 'anm', cls: 'nb-nrm', symbol: '▽', dir: (a) => neg(a.nrm) },
  { key: 'radout', cls: 'nb-rad', symbol: '◎', dir: (a) => a.radOut },
  { key: 'radin', cls: 'nb-rad', symbol: '◉', dir: (a) => neg(a.radOut) },
];

const MODE_ITEMS: readonly (readonly [NavballMode, string])[] = [
  ['self', '自機'],
  ['targetPro', 'TGT+'],
  ['targetRetro', 'TGT-'],
];

const GRID_TOGGLE_ITEMS: readonly (readonly [keyof CelestialGridVisibility, string])[] = [
  ['eclipticPlane', '黄道面'],
  ['eclipticPole', '黄道極'],
  ['eclipticGrid', '黄道グリッド'],
  ['equatorPlane', '赤道面'],
  ['equatorPole', '赤道極'],
  ['equatorGrid', '赤道グリッド'],
];

function neg(v: Vec3): Vec3 { return v3(-v.x, -v.y, -v.z); }

// 円環グリッドを張る正規直交系。e1/e2 が面内、pole が極。
interface PlaneBasis { readonly e1: Vec3; readonly e2: Vec3; readonly pole: Vec3; }

// 表示モードに応じた基準軌道基底(nrm を極、pro/radOut を面内に取る)。
// targetPro/targetRetro でターゲットが無ければ null(呼び出し側は自機モードへ戻す)。
function referenceAxes(mode: NavballMode, playerState: OrbitState, targetState: OrbitState | null): OrbitalAxes | null {
  if (mode === 'self') return orbitalAxes(playerState);
  if (!targetState) return null;
  const axes = orbitalAxes(targetState);
  return mode === 'targetPro' ? axes : { pro: neg(axes.pro), nrm: axes.nrm, radOut: neg(axes.radOut) };
}

// nrm を極、pro/-radOut を面内に取った円環グリッド用の基底を返す。
function planeBasisOf(axes: OrbitalAxes): PlaneBasis {
  return { e1: axes.pro, e2: neg(axes.radOut), pole: axes.nrm };
}

// 基底 basis 上の緯度 latRad・経度 lonRad にあたる単位ベクトルを返す。
function planePoint(basis: PlaneBasis, latRad: number, lonRad: number): Vec3 {
  const c = Math.cos(latRad), s = Math.sin(latRad);
  const cl = Math.cos(lonRad), sl = Math.sin(lonRad);
  return v3(
    c * cl * basis.e1.x + c * sl * basis.e2.x + s * basis.pole.x,
    c * cl * basis.e1.y + c * sl * basis.e2.y + s * basis.pole.y,
    c * cl * basis.e1.z + c * sl * basis.e2.z + s * basis.pole.z,
  );
}

// ワールド方向を機体座標系(qInv = 姿勢の逆)へ変換し、正射影したボール上の画面座標を返す。
// z は手前(>=0)/裏側(<0)の判定に使う。
function project(qInv: Quat, worldDir: Vec3): { x: number; y: number; z: number; } {
  const b = qRotate(qInv, worldDir);
  return { x: BALL_CENTER + b.x * BALL_RADIUS, y: BALL_CENTER - b.y * BALL_RADIUS, z: b.z };
}

// 手前半球(z>=0)だけの連続区間へ分割する。裏側は表示しない。
function splitFrontSegments(pts: readonly { x: number; y: number; z: number; }[]): (readonly [number, number])[][] {
  const segs: (readonly [number, number])[][] = [];
  let cur: (readonly [number, number])[] = [];
  for (const p of pts) {
    if (p.z >= 0) cur.push([p.x, p.y]);
    else if (cur.length > 1) { segs.push(cur); cur = []; }
    else cur = [];
  }
  if (cur.length > 1) segs.push(cur);
  return segs;
}

// 緯度 latRad の緯線を経度方向にサンプルし、手前半球の区間へ分割して返す。
function circleSegments(qInv: Quat, basis: PlaneBasis, latRad: number): (readonly [number, number])[][] {
  const pts: { x: number; y: number; z: number; }[] = [];
  for (let i = 0; i <= GRID_SEGMENTS; i++) {
    pts.push(project(qInv, planePoint(basis, latRad, (i / GRID_SEGMENTS) * Math.PI * 2)));
  }
  return splitFrontSegments(pts);
}

// 経度 lonRad の子午線を緯度方向にサンプルし、手前半球の区間へ分割して返す。
function meridianSegments(qInv: Quat, basis: PlaneBasis, lonRad: number): (readonly [number, number])[][] {
  const pts: { x: number; y: number; z: number; }[] = [];
  for (let i = 0; i <= GRID_SEGMENTS; i++) {
    pts.push(project(qInv, planePoint(basis, -Math.PI / 2 + (i / GRID_SEGMENTS) * Math.PI, lonRad)));
  }
  return splitFrontSegments(pts);
}

export class Navball {
  mode: NavballMode = 'self';
  gridVisibility: CelestialGridVisibility = {
    eclipticPlane: false, eclipticPole: false, eclipticGrid: false,
    equatorPlane: false, equatorPole: false, equatorGrid: false,
  };

  private readonly panel: NavballPanel;

  // navball パネルの DOM を組み立て、モード選択・グリッドトグルの結果を自身の状態へ反映する。
  constructor(hudRoot: HTMLElement) {
    this.panel = new NavballPanel(hudRoot, MODE_ITEMS, GRID_TOGGLE_ITEMS);
    this.panel.setMode(this.mode);
    this.panel.onModeSelect = (mode) => {
      this.mode = mode;
      this.panel.setMode(mode);
    };
    this.panel.onGridToggle = (key, on) => {
      this.gridVisibility = { ...this.gridVisibility, [key]: on };
    };
  }

  // playerState/att は自機の現在状態(表示時刻ではなく実時刻の姿勢を示す計器のため)。
  // targetState は Targeter.aliveTarget の現在状態(第一ターゲットのみ、null なら未設定)。
  // ターゲット系モードのままターゲットを失ったら自機基準へ戻し、基底が組めなければボールを空にする。
  sync(playerState: OrbitState, att: Attitude, alive: boolean, targetState: OrbitState | null): void {
    this.panel.setTargetModeEnabled(targetState !== null);
    if (!targetState && this.mode !== 'self') {
      this.mode = 'self';
      this.panel.setMode('self');
    }

    const axes = alive ? referenceAxes(this.mode, playerState, targetState) : null;
    if (!axes) {
      this.panel.setBall([], []);
      return;
    }

    const qInv = qInvert(att.q);
    const basis = planeBasisOf(axes);

    // 緯線(赤道は別クラスで強調) + 子午線を、基準基底からボール座標へ投影する。
    const lines: NavballGridLine[] = [];
    for (let lat = -60; lat <= 60; lat += GRID_LAT_STEP_DEG) {
      const cls = lat === 0 ? 'nb-equator' : 'nb-grid';
      for (const points of circleSegments(qInv, basis, (lat * Math.PI) / 180)) lines.push({ cls, points });
    }
    for (let lon = 0; lon < 360; lon += GRID_LON_STEP_DEG) {
      for (const points of meridianSegments(qInv, basis, (lon * Math.PI) / 180)) lines.push({ cls: 'nb-grid', points });
    }

    const markers: NavballMarkerPoint[] = MARKER_DEFS.map((def) => {
      const p = project(qInv, def.dir(axes));
      return { key: def.key, cls: def.cls, symbol: def.symbol, x: p.x, y: p.y, opacity: p.z >= 0 ? 1 : 0.3 };
    });

    this.panel.setBall(lines, markers);
  }
}
