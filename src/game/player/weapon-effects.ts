import type { WorldSfx } from '../../audio/sfx/world-sfx';
import type { FlashEffects } from '../vfx/flash-effects';
import type { KinematicState } from '../../physics/kinematic-state';

// 射撃の音・閃光だけを担当する出力ポート。弾薬状態や発射判定は持たない。
export interface WeaponEffects {
  emptyClick(): void;
  spinUp(): void;
  magFeed(): void;
  reload(): void;
  fire(): void;
  muzzleFlash(state: KinematicState): void;
}

export class DefaultWeaponEffects implements WeaponEffects {
  public constructor(
    private readonly worldSfx: WorldSfx,
    private readonly fx: FlashEffects,
  ) {}

  public emptyClick(): void { this.worldSfx.emptyClick(); }
  public spinUp(): void { this.worldSfx.spinUp(); }
  public magFeed(): void { this.worldSfx.magFeed(); }
  public reload(): void { this.worldSfx.playReload(); }
  public fire(): void { this.worldSfx.fire(); }
  public muzzleFlash(state: KinematicState): void { this.fx.spawnMuzzleFlash(state); }
}
