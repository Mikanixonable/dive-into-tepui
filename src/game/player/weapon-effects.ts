import type { FlashEffects } from '../vfx/flash-effects';
import type { RunEventSink } from '../run-events';
import type { KinematicState } from '../../physics/kinematic-state';

// 射撃で起きたことの記録と閃光だけを担当する出力ポート。弾薬状態や発射判定は持たない。
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
    private readonly events: RunEventSink,
    private readonly fx: FlashEffects,
  ) {}

  public emptyClick(): void { this.events.record({ kind: 'gunDryFired' }); }
  public spinUp(): void { this.events.record({ kind: 'gunSpunUp' }); }
  public magFeed(): void { this.events.record({ kind: 'gunMagazineFed' }); }
  public reload(): void { this.events.record({ kind: 'gunBarrelSwapped' }); }
  public fire(): void { this.events.record({ kind: 'gunFired' }); }
  public muzzleFlash(state: KinematicState): void { this.fx.spawnMuzzleFlash(state); }
}
