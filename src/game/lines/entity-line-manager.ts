// どのエンティティに、どんな見た目の軌道線・予測線・過去線を出すかを決める。
// update が出す/消す/スタイルを決め、sync は既に出ている線の形状と変換を合わせる。
import * as THREE from 'three/webgpu';
import type { FrameAnchorSource } from '../../physics/frame';
import { LINE_RENDER_ORDER, type LineStyle } from '../../render/line-style';
import * as C from '../const';
import { FloatingOrigin } from '../camera/floating-origin';
import type { DynamicEntity } from '../dynamic/dynamic-entity/dynamic-entity';
import { Player } from '../player/player';
import { currentThemePalette } from '../theme';
import type { CombatTarget } from '../targeter';
import type { DynamicSystem } from '../dynamic/dynamic-system';
import type { DisplayWindow } from '../display-window-manager';
import type { CelestialSystem } from '../celestial/celestial-system';
import type { MapVisibilityPolicy } from '../map/visibility-policy';
import { orbitLineBasisOf, type OrbitReference } from '../orbit-reference';

const COLOR_PLAYER_ORBIT_LINE_INACTIVE = '#ffffff'; // マップビューで操作対象でない自艦の軌道線

// 役割ごとの軌道線の見た目(色・不透明度・描画順)を一括して決める表。
const LINE_STYLE = {
  enemyLine: { color: C.COLOR_ENEMY_ORBIT_LINE, opacity: 0.35, renderOrder: LINE_RENDER_ORDER.shipOrbit },
  baseLine: { color: C.COLOR_BASE_ORBIT_LINE, opacity: 0.35, renderOrder: LINE_RENDER_ORDER.shipOrbit },
} as const satisfies Record<string, LineStyle>;

// ターゲットの軌道はほぼ自機の軌道と重なることが多く(近傍ランデブーを狙うため)、
// 埋もれて見えなくならないよう不透明度を上げる。
const TARGET_LINE_OPACITY = 0.9;

// 解析楕円・予測線・過去線それぞれの見た目。
interface TrajectoryStyles {
  readonly ellipse: LineStyle;
  readonly predicted: LineStyle;
  readonly actual: LineStyle;
}

// 3種の線を区別なく同じ見た目にする(自艦以外はアクティブ/非アクティブで色分けしないため)。
function sameTrajectoryStyle(style: LineStyle): TrajectoryStyles {
  return { ellipse: style, predicted: style, actual: style };
}

// 軌道線を出す/消す。style が null なら出さない。出す場合にどの基準で描くかは orbitRef が決める。
function applyOrbitLine(
  entity: DynamicEntity, style: LineStyle | null, orbitRef: OrbitReference | undefined,
): void {
  if (style === null) {
    entity.hideOrbitLine();
    return;
  }
  const basis = orbitLineBasisOf(orbitRef, entity);
  switch (basis.kind) {
    case 'ellipse': entity.showEllipseLine(style, basis.center); break;
    case 'relative': entity.showTargetRelativeLine(style, basis.target); break;
    case 'none': entity.hideOrbitLine(); break;
  }
}

export class EntityLineManager {
  constructor(private readonly entities: DynamicSystem) {}

  // 出す/消す/スタイルを決める。判断材料(表示可否・ターゲット・操作艦・ビュー)が
  // このフレームの確定値になった後に呼ぶ。
  update(
    activePlayer: Player | null, primaryTarget: CombatTarget | null,
    overviewMode: boolean, displayWindow: DisplayWindow, visibilityPolicy: MapVisibilityPolicy | null,
    orbitRef: OrbitReference | undefined,
  ): void {
    const { pastDuration } = displayWindow;
    // マップビューは軌道情報パネルの固定設定に従わず、常に自動選択(最も強く引く天体)で描く
    // (ORBIT.md「軌道線(3D描画)の基準天体」)。数値表示・軌道要素アイコンはこの絞り込みを受けない。
    const lineOrbitRef = overviewMode ? undefined : orbitRef;
    const palette = currentThemePalette();
    const primaryStyle: LineStyle = { color: palette.signal, opacity: TARGET_LINE_OPACITY, renderOrder: LINE_RENDER_ORDER.target };
    const targetStyleOf = (e: CombatTarget): LineStyle | null => e === primaryTarget ? primaryStyle : null;
    const playerOrbitStyleOf = (isActive: boolean): LineStyle => (
      { color: isActive ? palette.accent : COLOR_PLAYER_ORBIT_LINE_INACTIVE, opacity: 0.55, renderOrder: LINE_RENDER_ORDER.shipOrbit }
    );
    const playerPredictedStyleOf = (isActive: boolean): LineStyle => (
      { color: isActive ? palette.accent : COLOR_PLAYER_ORBIT_LINE_INACTIVE, opacity: 0.55, renderOrder: LINE_RENDER_ORDER.predicted }
    );
    const playerActualStyleOf = (isActive: boolean): LineStyle => (
      { color: isActive ? palette.accent : COLOR_PLAYER_ORBIT_LINE_INACTIVE, opacity: 0.3, renderOrder: LINE_RENDER_ORDER.predicted }
    );
    // 1体分の判定材料から、軌道線/予測線/過去線の出す/消す/スタイルを決める。ターゲットである間は
    // 常に asTarget のスタイルで軌道線を維持し、予測線・過去線には切り替えない。lineVisible は
    // ターゲット強調時にも及ぶ表示可否、visibleWhenUntargeted はそれに加えてターゲットでないときだけ
    // 課される表示可否(敵の生存判定など)を表す。
    const applyEntityLines = (
      entity: DynamicEntity, asTarget: LineStyle | null, lineVisible: boolean, visibleWhenUntargeted: boolean,
      trajectoryEligible: boolean, styles: TrajectoryStyles,
    ): void => {
      // 予測線・過去線を使う条件が揃っているか。
      const showLines = trajectoryEligible && visibleWhenUntargeted && asTarget === null;
      // 戦闘ビューの自艦・使用条件を満たさない機体は、積分線の代わりに解析楕円で描く。
      const ownEllipse = showLines && !overviewMode;
      const fallbackEllipse = !trajectoryEligible && overviewMode && visibleWhenUntargeted && asTarget === null;
      const orbitLineStyle = asTarget !== null && lineVisible
        ? asTarget
        : (ownEllipse || fallbackEllipse ? styles.ellipse : null);
      applyOrbitLine(entity, orbitLineStyle, lineOrbitRef);
      if (showLines && !ownEllipse) entity.showPredictedLine(styles.predicted);
      else entity.hidePredictedLine();
      if (showLines && pastDuration > 0) entity.showActualLine(styles.actual);
      else entity.hideActualLine();
    };

    for (const ship of this.entities.players) {
      const isActive = ship === activePlayer;
      const visibility = visibilityPolicy?.entity('player', isActive);
      const lineVisible = (visibility?.category ?? true) && (visibility?.orbit ?? true);
      // マップビューでは操作艦だけが既定で予測線・過去線を使う。それ以外の自艦は、
      // プロパティウィンドウのトグル(showTrajectoryLine)がONのときだけ同様に使う。
      const trajectoryEligible = isActive || (overviewMode && ship.showTrajectoryLine);
      applyEntityLines(
        ship, targetStyleOf(ship), lineVisible, lineVisible, trajectoryEligible,
        { ellipse: playerOrbitStyleOf(isActive), predicted: playerPredictedStyleOf(isActive), actual: playerActualStyleOf(isActive) },
      );
    }
    for (const enemy of this.entities.enemies) {
      const visibility = visibilityPolicy?.entity('ship');
      const lineVisible = (visibility?.category ?? true) && (visibility?.orbit ?? true);
      const enemyLineStyle: LineStyle = { ...LINE_STYLE.enemyLine, color: enemy.orbitLineColor };
      applyEntityLines(
        enemy, targetStyleOf(enemy), lineVisible, lineVisible && enemy.alive, overviewMode && enemy.showTrajectoryLine,
        sameTrajectoryStyle(enemyLineStyle),
      );
    }
    for (const base of this.entities.bases) {
      const lineVisible = visibilityPolicy?.entity('base').orbit ?? false;
      applyEntityLines(
        base, targetStyleOf(base), lineVisible, lineVisible, overviewMode && base.showTrajectoryLine,
        sameTrajectoryStyle(LINE_STYLE.baseLine),
      );
    }
  }

  // 既に出ている線の形状と変換を合わせる。どの線を持つかは update が決めきっているので、
  // ここでは全個体へ一律に呼ぶ。
  sync(
    displayWindow: DisplayWindow, fo: FloatingOrigin, camera: THREE.Camera,
    frameAnchors: FrameAnchorSource, celestialSystem: CelestialSystem,
  ): void {
    const { frame, simTime, displayTime, duration, pastDuration } = displayWindow;
    for (const group of this.lineOwners) {
      for (const entity of group) {
        const predictedTo = entity.predictionTruncated ? null : simTime + duration;
        entity.syncTrajectoryLines(
          frame, simTime, displayTime, pastDuration, predictedTo, celestialSystem, fo, camera, frameAnchors);
        entity.syncOrbitLine(displayTime, celestialSystem, fo, camera, frameAnchors);
      }
    }
  }

  // 線を持ちうるエンティティ。sync は種別を問わず同じ呼び出しで済むので、まとめて辿る。
  private get lineOwners(): readonly (readonly DynamicEntity[])[] {
    return [this.entities.players, this.entities.enemies, this.entities.bases];
  }
}
