// 実体ごとの表示設定。予測線・過去線を出す実体と、タンパク質の敵に共通の表示形態・着色を持つ。
import {
  DEFAULT_PROTEIN_DISPLAY, isProteinDisplaySettings, type ProteinDisplaySettings,
} from '../../render/protein/protein-display';
import type { SerializedDynamicEntity } from '../dynamic/dynamic-entity/entity-dictionary';
import type { SerializedProteinEnemy } from '../dynamic/dynamic-entity/protein-enemy';

// 実体ごとの表示設定を読む面。
export interface EntityDisplaySource {
  // id の実体の予測線・過去線を、操作対象でなくても出すか。
  showsTrajectoryLine(id: string): boolean;
  // タンパク質の敵の表示形態と着色。全個体で共通。
  readonly proteinDisplay: ProteinDisplaySettings;
}

export class EntityDisplaySelection implements EntityDisplaySource {
  public constructor(
    // 予測線・過去線を出す実体の id。アセット待ちで顔ぶれにまだいない個体の id も持つ。
    private readonly trajectoryLineIds: Set<string> = new Set(),
    private _proteinDisplay: ProteinDisplaySettings = DEFAULT_PROTEIN_DISPLAY,
  ) {}

  // 直列化した実体の記録 entities から、線を出す実体とタンパク質の表示設定を戻す。タンパク質の
  // 表示は最初のタンパク質の敵の記録から採り、その敵がいないか値が不正なら既定から始める。
  public static deserialize(entities: readonly SerializedDynamicEntity[]): EntityDisplaySelection {
    const protein = entities.find((data): data is SerializedProteinEnemy => data.kind === 'protein-enemy');
    return new EntityDisplaySelection(
      new Set(entities
        .filter((data) => 'showTrajectoryLine' in data && data.showTrajectoryLine === true)
        .map((data) => data.id)),
      isProteinDisplaySettings(protein?.display) ? protein.display : undefined,
    );
  }

  public showsTrajectoryLine(id: string): boolean { return this.trajectoryLineIds.has(id); }

  public get proteinDisplay(): ProteinDisplaySettings { return this._proteinDisplay; }

  // id の実体の予測線・過去線を、出していれば消し、消していれば出す。
  public toggleTrajectoryLine(id: string): void {
    if (this.trajectoryLineIds.has(id)) this.trajectoryLineIds.delete(id);
    else this.trajectoryLineIds.add(id);
  }

  // タンパク質の敵の表示形態と着色を display へ差し替える。
  public setProteinDisplay(display: ProteinDisplaySettings): void {
    this._proteinDisplay = display;
  }
}
