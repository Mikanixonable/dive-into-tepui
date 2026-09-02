// 戦闘ビュー専用のフレーム処理(WorldViewFrame の具象)。呼ぶ位置と順序は Game が持つ。
import type { Input } from './input/input';
import type { TouchControls } from './input/touch';
import type { CameraSystem } from './camera/camera-system';
import type { DynamicSystem } from './dynamic/dynamic-system';
import type { MapPickables } from './pickable/map-pickables';
import type { LinePickables } from './pickable/line-pickables';
import type { MapContextActions } from './pickable/map-context-actions';
import type { CelestialMarkers } from './marker/celestial-markers';
import type { Targeter } from './targeter';
import type { Player } from './player/player';
import type { WorldViewFrame } from './world-view';

export class CombatView implements WorldViewFrame {
  constructor(
    private readonly input: Input,
    private readonly cameraSystem: CameraSystem,
    private readonly targeter: Targeter,
    private readonly mapActions: MapContextActions,
    private readonly dynamicSystem: DynamicSystem,
    private readonly mapPickables: MapPickables,
    private readonly linePickables: LinePickables,
    private readonly celestialMarkers: CelestialMarkers,
    private readonly touchControls: TouchControls | null,
    private readonly player: () => Player | null,
  ) {}

  // 照準キーと右クリックの配分。操作艦がいなければ照準先が無いので配らない。
  handlePointer(simTime: number): void {
    const player = this.player();
    if (!player) return;
    const project = this.cameraSystem.activeCameraProjection;
    const combatTargets = this.dynamicSystem.getCombatTargets(player);
    this.targeter.handleTargetSelectKey(this.input, combatTargets, project);
    this.mapActions.handleCombatRightClick(this.input, simTime);
  }

  // マップの選択候補と可視性ポリシーを空にする(戦闘ビューの表示・選択は null 経路で判定する)。
  update(): void {
    this.mapPickables.clear();
  }

  // 天体ラベルはマップ専用の表示なので、戦闘ビューの間は畳んでおく。
  syncLabels(): void {
    this.celestialMarkers.hideLabels();
  }

  // 戦闘ビュー専用の常設表示(タッチのモードボタン)と、軌道線候補の後始末。
  syncPanels(): void {
    this.linePickables.clear();
    const player = this.player();
    if (player) {
      this.touchControls?.syncModeButtons(
        player.rcsDamp, player.fineAttitude, player.progradeHold,
        (key) => player.throttle.isThrustLatched(key),
      );
    }
  }
}
