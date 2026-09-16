import type { RunEventSink } from '../run-events';
import type { KinematicState } from '../../physics/kinematic-state';

// 射撃で起きたことの記録だけを担当する出力ポート。弾薬状態や発射判定は持たない。
export interface WeaponEffects {
  emptyClick(): void;
  spinUp(): void;
  magFeed(): void;
  reload(): void;
  // muzzleState は砲口の位置と、そのときの艦の速度・時刻。
  fire(muzzleState: KinematicState): void;
}

export class DefaultWeaponEffects implements WeaponEffects {
  public constructor(private readonly events: RunEventSink) {}

  public emptyClick(): void { this.events.record({ kind: 'gunDryFired' }); }
  public spinUp(): void { this.events.record({ kind: 'gunSpunUp' }); }
  public magFeed(): void { this.events.record({ kind: 'gunMagazineFed' }); }
  public reload(): void { this.events.record({ kind: 'gunBarrelSwapped' }); }
  // muzzleState は砲口の位置と、そのときの艦の速度・時刻。
  public fire(muzzleState: KinematicState): void {
    this.events.record({ kind: 'gunFired', muzzleState });
  }
}
