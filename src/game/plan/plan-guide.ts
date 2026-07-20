// 軌道計画(Plan)の実施: 直近ノードの噴射ガイド表示・達成判定・ノード消化。
// マップモードとは無関係 — game.ts がマップモードでない間だけ毎フレーム呼ぶ
// (マップ編集中は WASDQE が Δv 編集に使われており、同時に噴射ガイドを出す意味が
// ないため。呼び出しどころの判断は game.ts が持つ、このクラス自身は mapMode を知らない)。
import * as THREE from 'three/webgpu';
import { Elements, elementsFromState } from '../../physics/orbital';
import { dvToWorld } from '../../physics/predict';
import { Vec3, add, clone, dot, len, norm, scale, sub } from '../../physics/vec3';
import * as C from '../const';
import { Hud } from '../../hud/hud';
import { fmtSpeed } from '../../hud/utils';
import { Sfx } from '../../audio/sfx';
import { OrbitLine } from '../../render/orbitline';
import { ProjectFn } from '../camera/projection';
import { Plan, PlanCtx } from './plan';

// 直近の未達成ノードをちょうど含む程度の短い予測期間(28日ぶんを毎回計算するのは
// 無駄なコストになるため)。map-mode/map-mode-system.ts も同一フレーム内で
// plannedOrbitLine 用に同じ予測を必要とするので、export して再利用させる。
export function guideDurationSec(plan: Plan, ctx: PlanCtx): number {
  const first = plan.firstNode();
  if (!first) return 0;
  return Math.max(C.NODE_GUIDE_MIN_DURATION, first.time - ctx.simTime + C.NODE_GUIDE_DURATION_MARGIN);
}

// 戦闘ビューの計画軌道ライン(plannedOrbitLine)用: 直近ノードを実施した直後の
// 軌道要素。噴射ガイド(PlanGuide.update)と同じ期間ポリシー(guideDurationSec)で
// 予測を最新化する — マップの表示用予測期間(day/week/monthなど)とは意図的に別物。
export function plannedOrbitElements(plan: Plan, ctx: PlanCtx): Elements | null {
  const first = plan.firstNode();
  if (!first) return null;
  plan.maybeRefresh(ctx, guideDurationSec(plan, ctx));
  const sample = plan.sampleAt(first.time);
  return sample ? elementsFromState(sample.r, sample.v) : null;
}

export class PlanGuide {
  // 直近ノードの「実行目標」(実行後の目標位置・速度・軌道要素)。
  // 遠方(残り NODE_TARGET_FREEZE_S 超)では予測リフレッシュのたびに追従更新するが、
  // ノード接近後は凍結する。予測は毎回「現在状態にノードの全Δvを適用」して
  // 作られるため、噴射中に目標を再計算し続けると目標が噴射分だけ先へ逃げて
  // 収束しない(さらにノード時刻超過後は予測から除外されて目標が現在状態に
  // 一致し、噴射せずとも達成判定が誤成立する)——凍結はその両方を防ぐ。
  private activeTarget: { nodeTime: number; rNode: Vec3; vPlanned: Vec3; targetEl: Elements } | null = null;

  // 戦闘ビューの計画軌道ライン(白)。マップモード中は非表示(マップ側は trajLine が
  // 予測軌道ゴーストを別途表示する)。
  readonly plannedLine = new OrbitLine(0xffffff, 0.9);

  constructor(private readonly _hud: Hud, private readonly _sfx: Sfx, scene: THREE.Scene) {
    this.plannedLine.line.renderOrder = 3;
    scene.add(this.plannedLine.line);
  }

  // マップでノード構成・Δvが変わった可能性がある時に呼ぶ(同じノード時刻のまま
  // Δvだけ編集されたケースは、達成判定側の nodeTime 比較だけでは検出できないため)。
  clearActiveTarget(): void {
    this.activeTarget = null;
  }

  // 計画軌道ラインを最新の予測に合わせる。mapMode 中は隠す。update()(噴射ガイド)
  // とは異なり mapMode 中も含め毎フレーム呼んでよい(このクラス自身は mapMode を
  // 知らないため、呼び出し側の game.ts が判定して渡す)。
  updatePlannedLine(plan: Plan, ctx: PlanCtx, origin: Vec3, mapMode: boolean): void {
    this.plannedLine.update(mapMode ? null : plannedOrbitElements(plan, ctx), origin);
  }

  update(
    plan: Plan,
    ctx: PlanCtx,
    o: Vec3,
    pv: Vec3,
    playerEl: Elements | null,
    playerAlive: boolean,
    project: ProjectFn,
  ): { achieved: boolean } {
    const node = plan.firstNode();
    if (!node || !playerAlive) {
      this._hud.markers.hide('nd');
      this._hud.markers.hide('burn');
      this._hud.setPlanPanel(null);
      return { achieved: false };
    }

    plan.maybeRefresh(ctx, guideDurationSec(plan, ctx));

    // 実行目標の構築・追従・凍結(凍結の理由は activeTarget フィールドのコメント参照)。
    const tRem = node.time - ctx.simTime;
    if (this.activeTarget && this.activeTarget.nodeTime !== node.time) this.activeTarget = null;
    if (!this.activeTarget || tRem > C.NODE_TARGET_FREEZE_S) {
      if (tRem > 0) {
        // 予測(ノードΔv適用済み)からノード実行直後の状態を取る
        const s = plan.sampleAt(node.time);
        const el = s ? elementsFromState(s.r, s.v) : null;
        if (s && el) {
          this.activeTarget = { nodeTime: node.time, rNode: s.r, vPlanned: s.v, targetEl: el };
        }
      } else if (!this.activeTarget) {
        // ノード時刻を過ぎているのに目標が無い(過去時刻へのノード配置など)。
        // 「今すぐ全Δvを噴射する」目標として現在状態から一度だけ構築・凍結する。
        const vP = add(pv, dvToWorld(o, pv, node.dv));
        const el = elementsFromState(o, vP);
        if (el) {
          this.activeTarget = { nodeTime: node.time, rNode: clone(o), vPlanned: vP, targetEl: el };
        }
      }
    }
    const tgt = this.activeTarget;
    if (!tgt) {
      this._hud.markers.hide('nd');
      this._hud.markers.hide('burn');
      return { achieved: false };
    }

    // 達成判定: 現在軌道が(凍結済みの)ノード実行後の計画軌道に十分近い
    if (playerEl && this.orbitClose(playerEl, tgt.targetEl)) {
      plan.consumeFirstNode();
      this.activeTarget = null;
      this._hud.markers.hide('nd');
      this._hud.markers.hide('burn');
      if (plan.nodes.length === 0) {
        this._hud.setPlanPanel(null);
        this._hud.hint('✓ マニューバ達成 — 計画軌道に到達', 5000);
      } else {
        this._hud.hint(`✓ ノード達成 — 残り ${plan.nodes.length} 件`, 4000);
      }
      this._sfx.warp();
      return { achieved: true };
    }

    // ノード位置マーカー(カウントダウン付き)
    const p = project(sub(tgt.rNode, o));
    const tLabel =
      tRem >= 0
        ? `T-${Math.floor(tRem / 60)}:${String(Math.floor(tRem % 60)).padStart(2, '0')}`
        : `T+${Math.floor(-tRem / 60)}:${String(Math.floor(-tRem % 60)).padStart(2, '0')}`;
    const more = plan.nodes.length > 1 ? ` (+${plan.nodes.length - 1})` : '';
    this._hud.markers.set('nd', 'mk-mnode', '◆', p.x, p.y, p.front, `NODE ${tLabel}${more}`);

    // 噴射ガイド: (凍結済みの)目標速度ベクトルとの差分方向へ加速する
    const dvRem = sub(tgt.vPlanned, pv);
    const mag = len(dvRem);
    const g = project(scale(norm(dvRem), 5e4));
    this._hud.markers.set(
      'burn',
      'mk-burn',
      '⬢',
      g.x,
      g.y,
      g.front,
      `BURN ${mag.toFixed(1)} m/s → ${fmtSpeed(len(tgt.vPlanned))}`,
    );
    return { achieved: false };
  }

  // 2 軌道の近さ判定(長半径・離心率・軌道面)
  private orbitClose(a: Elements, b: Elements): boolean {
    if (!isFinite(a.a) || !isFinite(b.a) || a.a <= 0 || b.a <= 0) return false;
    const planeCos = Math.max(-1, Math.min(1, dot(a.hHat, b.hHat)));
    return (
      Math.abs(a.a - b.a) / b.a < C.NODE_TOL_SMA &&
      Math.abs(a.e - b.e) < C.NODE_TOL_ECC &&
      (Math.acos(planeCos) * 180) / Math.PI < C.NODE_TOL_PLANE_DEG
    );
  }
}
