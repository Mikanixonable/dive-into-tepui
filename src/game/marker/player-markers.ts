// 操作中の艦の姿勢だけから決まる戦闘ビュー専用マーカー(軌道基準の方向マーカーと機首ボアサイト)。
import { LOCAL_FORWARD, qRotate } from '../../math/quat';
import type { ViewMode } from '../../render/view-mode';
import { KinematicState, kinematicState, orbitAxes } from '../../physics/kinematic-state';
import { scale, sub, type Vec3 } from '../../math/vec3';
import type { MarkerDeclaration } from '../../marker/marker-declaration';
import type { MarkerSink } from '../../marker/marker-sink';
import { MARKER_PRIORITY } from './marker-priority';
import { directionPlacement } from './marker-placement';
import { DIRECTION_GLYPH } from './marker-identity';
import type { Player } from '../player/player';
import type { ProjectFn } from '../../math/projection';

// 中央に切り欠きを残した、細い線の三尖星(120度間隔)。
const BORESIGHT_STAR = '<svg viewBox="0 0 24 24" width="48" height="48" aria-label="照準"><g fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="butt"><path d="M12 9.7V2"/><path d="M12 9.7V2" transform="rotate(120 12 12)"/><path d="M12 9.7V2" transform="rotate(240 12 12)"/></g></svg>';

export class PlayerMarkers {
  private readonly declarations: MarkerDeclaration[] = [];

  public constructor(private readonly group: MarkerSink) { }

  // 所有するマーカー群を取り除く。
  public dispose(): void { this.group.dispose(); }

  // 戦闘ビューで操作している艦の軌道軸・ボアサイトを置く。それ以外のフレームは全て片付ける。
  // orbitAxesReference は方向の基準にする運動状態で、null なら ECI(地球基準)。
  public sync(
    player: Player | null, view: ViewMode, project: ProjectFn,
    orbitAxesReference: KinematicState | null, nowMs: number,
  ): void {
    const declarations = this.declarations;
    declarations.length = 0;
    if (player !== null && view !== 'map') {
      this.pushOrbitAxes(declarations, player, project, orbitAxesReference);
      declarations.push(this.boresight(player, project));
    }
    this.group.sync(declarations, nowMs);
  }

  // prograde/retrograde/normal/antinormal/radial in-out の6方向マーカーを積む。
  // 方向は reference(null なら ECI)に対する相対 r/v から求める。
  private pushOrbitAxes(
    out: MarkerDeclaration[], player: Player, project: ProjectFn, reference: KinematicState | null,
  ): void {
    const state = player.motion.state;
    // 参照対象があれば相対状態へ移し、マーカーを置く原点だけは自機の絶対位置に保つ。
    const pr = state.r;
    const relState = reference !== null
      ? kinematicState<'eci'>(state.t, sub(state.r, reference.r), sub(state.v, reference.v))
      : state;
    const { pro: proDir, nrm: nrmDir, radOut: radDir } = orbitAxes(relState);
    const id = player.id;

    out.push(this.direction(`pro-${id}`, 'mk-pro', DIRECTION_GLYPH.prograde, pr, proDir, project, 'PROGRADE'));
    out.push(this.direction(`retro-${id}`, 'mk-retro', DIRECTION_GLYPH.retrograde, pr, scale(proDir, -1), project, 'RETROGRADE'));
    out.push(this.direction(`nrm-${id}`, 'mk-nrm', DIRECTION_GLYPH.normal, pr, nrmDir, project, 'NORMAL'));
    out.push(this.direction(`anm-${id}`, 'mk-nrm', DIRECTION_GLYPH.antinormal, pr, scale(nrmDir, -1), project, 'ANTINORMAL'));
    out.push(this.direction(`radout-${id}`, 'mk-rad', DIRECTION_GLYPH.radialOut, pr, radDir, project, 'RADIAL OUT'));
    out.push(this.direction(`radin-${id}`, 'mk-rad', DIRECTION_GLYPH.radialIn, pr, scale(radDir, -1), project, 'RADIAL IN'));
  }

  // 機首方向へ置くボアサイトマーカー。ラベルへ残弾とベルト・砲口初速を添える。
  private boresight(player: Player, project: ProjectFn): MarkerDeclaration {
    const state = player.motion.state;
    const fwd = qRotate(player.motion.att.q, LOCAL_FORWARD);
    const label = `AMMO ${Math.max(0, player.roundsInMag)}\nBELT ${Math.max(0, player.magsLeft)}\n${player.averageMuzzleVelocity.toFixed(0)} m/s`;
    return {
      ...this.direction(`bore-${player.id}`, 'mk-boresight', BORESIGHT_STAR, state.r, fwd, project, label),
      markup: true,
      fixedLabel: true,
    };
  }

  // 方向マーカー1件の宣言。
  private direction(
    id: string, cls: string, sym: string, origin: Vec3, dir: Vec3, project: ProjectFn, label: string,
  ): MarkerDeclaration {
    const { x, y, front } = directionPlacement(origin, dir, project);
    return { id, cls, sym, x, y, front, label, priority: MARKER_PRIORITY.NONE, iconHidable: false };
  }
}
