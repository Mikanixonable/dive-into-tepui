// Stage 00: 無限耐久サバイバル。弾薬確保後、波状攻撃が自機破壊まで無限に続く
// (撃破数では終わらないので checkWin/onWin は no-op に override する)。
import * as C from '../const';
import { StageCtx, StageDefinition } from './stage-definition';
import { WaveManager } from './wave-manager';

export class Stage00 extends StageDefinition {
  readonly index = -1 as const;
  readonly selectLabel = '[0] 無限耐久サバイバル (Stage 00)';
  readonly selectSub = '常時選択可。弾薬を拾ってから始まる無限の波状攻撃。自機が破壊されるまで続く';
  readonly selectKeys = ['Digit0'];
  readonly initialAmmo = { magsLeft: C.INITIAL_MAGS - 1, roundsInMag: C.MAG_ROUNDS };

  private readonly waveManager = new WaveManager();

  briefingHtml(): string {
    return (
      '<b>サバイバル任務: 弾薬を回収し、無限の敵から生き残れ！</b><br>' +
      '敵は次々と波状攻撃を仕掛けてくる。<br>' +
      '補給マガジンが近くに浮いている — 弾切れ時は回収せよ<br>' +
      '[H] キーで操作方法を表示'
    );
  }

  init(ctx: StageCtx): number {
    for (let i = 0; i < C.MAX_MAG_PICKUPS; i++) {
      ctx.ammoResupply.spawnForPlayer(ctx.player, C.STAGE00_AMMO_MIN_DIST, C.STAGE00_AMMO_MAX_DIST);
    }
    this.waveManager.spawnWave(ctx, 'random'); // 初期状態でもランダムに敵を配置する
    return 0;
  }

  update(dt: number, ctx: StageCtx): void {
    this.waveManager.update(dt, ctx, {
      spawnDelay: C.STAGE00_SPAWN_DELAY,
      spawnInterval: C.STAGE00_SPAWN_INTERVAL,
      maxRange: C.STAGE00_MAX_RANGE,
      respawnAmmoOnDespawn: true,
    });
  }

  checkWin(): boolean { return false; }
  onWin(): void { /* no-op: このステージは撃破数では終わらない */ }

  hudSubStatus(): string {
    return `サバイバル 第${this.waveManager.waveCount}波`;
  }
}
