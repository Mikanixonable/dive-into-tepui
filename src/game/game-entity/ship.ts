import * as THREE from 'three/webgpu';
import { Attitude } from '../../physics/attitude';
import { OrbitState } from '../../physics/orbital';
import * as C from '../const';
import { GameEntity } from './game-entity';
import type { Attractor } from '../../physics/attractor';
import type { FloatingOrigin } from '../floating-origin';

export abstract class Ship extends GameEntity {
  protected readonly bcInv = C.SHIP_BCINV;
  protected readonly historyDuration = C.SHIP_HISTORY_DURATION;
  readonly predictDuration = C.PREDICT_DURATION;

  name: string;
  radius: number; // 被弾判定半径 [m](剛体接触の collideRadius とは別)
  hp: number;
  maxHp: number;

  // 名前・当たり判定半径・HP を初期化し、基底の状態/メッシュ/姿勢を構築する。
  constructor(
    name: string,
    state: OrbitState,
    obj: THREE.Object3D,
    att: Attitude,
    radius: number,
    hp: number,
    scene?: THREE.Scene,
  ) {
    super(state, obj, scene, att);
    this.name = name;
    this.radius = radius;
    this.hp = hp;
    this.maxHp = hp;
  }

  // 接触速度に応じた装甲ダメージを hp へ適用し、ダメージが発生したかを返す。
  // COLLISION_DAMAGE_MIN_SPEED で 0、COLLISION_DAMAGE_FULL_SPEED で maxHp ぶんの線形。
  protected applyCollisionDamage(speed: number): boolean {
    const span = C.COLLISION_DAMAGE_FULL_SPEED - C.COLLISION_DAMAGE_MIN_SPEED;
    const t = Math.min(1, Math.max(0, (speed - C.COLLISION_DAMAGE_MIN_SPEED) / span));
    if (t <= 0) return false;
    this.hp -= this.maxHp * t;
    return true;
  }

  // 逆三角形を辺中央の切り欠きで分割し、残HPに応じて発光するSVGを生成する。
  // 分割数は3の倍数へ丸めるため、将来HPが12/18になっても多重リングへ拡張しやすい。
  protected hpMarkerSvg(): string {
    const segments = Math.max(3, Math.round(this.maxHp / 3) * 3);
    const lit = Math.max(0, Math.min(segments, Math.round((this.hp / this.maxHp) * segments)));
    // 正三角形のシルエット(辺長18、外接円中心は(12,12))。
    // 旧形状は高さが幅より大きく、画面上で縦長に見えていた。
    const points: [number, number][] = [[12, 3], [3, 18.588], [21, 18.588]];
    const lines: string[] = [];
    const emit = (i: number, j: number, k: number, a: number, b: number): void => {
      if (b <= a) return;
      const [x1, y1] = points[i]!;
      const [x2, y2] = points[(i + 1) % 3]!;
      const color = (i * k + j) < lit ? 'currentColor' : 'rgba(120,125,130,.2)';
      lines.push(`<line x1="${x1 + (x2 - x1) * a}" y1="${y1 + (y2 - y1) * a}" x2="${x1 + (x2 - x1) * b}" y2="${y1 + (y2 - y1) * b}" stroke="${color}" stroke-width="1.5" stroke-linecap="butt"/>`);
    };
    for (let i = 0; i < 3; i++) {
      const k = segments / 3;
      // 頂点は連続させ、各辺の中央だけを切り欠く。
      for (let j = 0; j < k; j++) {
        const a = j / k;
        const b = (j + 1) / k;
        const notch = 0.09;
        if (a < 0.5 && b > 0.5) {
          emit(i, j, k, a, 0.5 - notch / 2);
          emit(i, j, k, 0.5 + notch / 2, b);
        } else {
          emit(i, j, k, a, b);
        }
      }
    }
    return `<svg viewBox="0 0 24 24" width="24" height="24" aria-label="HP ${Math.max(0, this.hp)} / ${this.maxHp}">${lines.join('')}</svg>`;
  }

  // メッシュ配下のマテリアルを含めて破棄する。
  dispose(): void {
    super.dispose();
    this.obj.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (Array.isArray(mesh.material)) mesh.material.forEach((m) => m.dispose());
      else mesh.material.dispose();
    });
  }

  // オーバービュー時の非ターゲット背景描画用
  syncBackgroundOrbitLine(_show: boolean, _fo: FloatingOrigin, _bodies: readonly Attractor[]): void {}
}
