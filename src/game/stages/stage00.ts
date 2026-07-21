// Stage 00: 無限耐久サバイバル。弾薬確保後、波状攻撃が自機破壊まで無限に続く
// (撃破数では終わらないので checkWin/onWin は no-op に override する)。
import * as THREE from 'three/webgpu';
import * as C from '../const';
import { StageCtx, Stage } from './stage';
import { WaveManager } from './stage-utils/wave-manager';
import { Hud } from '../../hud/hud';
import { Sfx } from '../../audio/sfx';
import type { Simulator } from '../orbit-entity/simulator';
import type { Player } from '../player/player';
import type { Enemy } from '../orbit-entity/enemy';
import type { UnlockManager } from '../unlock-manager';
import type { EffectsSystem } from '../effects-system';

export class Stage00 extends Stage {
  readonly index = -1 as const;
  readonly selectLabel = '[0] 無限耐久サバイバル (Stage 00)';
  readonly selectSub = '常時選択可。弾薬を拾ってから始まる無限の波状攻撃。自機が破壊されるまで続く';
  readonly selectKeys = ['Digit0'];
  readonly initialAmmo = { magsLeft: C.INITIAL_MAGS - 1, roundsInMag: C.MAG_ROUNDS };

  private readonly waveManager = new WaveManager(
    C.STAGE00_SPAWN_DELAY,
    C.STAGE00_SPAWN_INTERVAL,
    C.STAGE00_MAX_RANGE,
    true,
  );

  setup(
    hud: Hud,
    sfx: Sfx,
    scene: THREE.Scene,
    simulator: Simulator,
    setPhase: (phase: 'playing' | 'won' | 'lost' | 'timeup') => void,
    unlockManager: UnlockManager,
    fx: EffectsSystem,
  ): void {
    super.setup(hud, sfx, scene, simulator, setPhase, unlockManager, fx);
    this.waveManager.setup(hud, sfx, scene, fx);
  }

  briefingHtml(): string {
    return (
      '<b>サバイバル任務: 弾薬を回収し、無限の敵から生き残れ！</b><br>' +
      '敵は次々と波状攻撃を仕掛けてくる。<br>' +
      '補給マガジンが近くに浮いている — 弾切れ時は回収せよ<br>' +
      '[H] キーで操作方法を表示'
    );
  }

  init(player: Player, addEnemy: (enemy: Enemy) => void): number {
    for (let i = 0; i < C.MAX_AMMO; i++) {
      this.logistics.spawnForPlayer(player, C.STAGE00_LOGISTICS_MIN_DIST, C.STAGE00_LOGISTICS_MAX_DIST);
    }
    this.waveManager.spawnWave(player, addEnemy, 'random'); // 初期状態でもランダムに敵を配置する
    return 0;
  }

  update(dt: number, ctx: StageCtx): void {
    this.waveManager.update(dt, ctx.phase, ctx.player, ctx.enemies, ctx.addEnemy, ctx.simTime, this.logistics);
  }

  checkWin(): boolean { return false; }
  onWin(): void { /* no-op: このステージは撃破数では終わらない */ }

  hudSubStatus(): string {
    return `サバイバル 第${this.waveManager.waveCount}波`;
  }
}
