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

// saved のうち最初のタンパク質の敵が持つ表示設定。その敵がいないか、値が不正なら既定。
function savedProteinDisplay(saved: readonly SerializedDynamicEntity[]): ProteinDisplaySettings {
  const protein = saved.find((data): data is SerializedProteinEnemy => data.kind === 'protein-enemy');
  return isProteinDisplaySettings(protein?.display) ? protein.display : DEFAULT_PROTEIN_DISPLAY;
}

export class EntityDisplaySelection implements EntityDisplaySource {
  // 予測線・過去線を出す実体の id。アセット待ちで顔ぶれにまだいない個体の id も持つ。
  private readonly trajectoryLineIds: Set<string>;
  private _proteinDisplay: ProteinDisplaySettings;

  // 保存された実体の記録 saved から、線を出す実体とタンパク質の表示設定を戻して始める。
  // saved が無ければ既定から始める。
  public constructor(saved: readonly SerializedDynamicEntity[] | undefined) {
    const entities = saved ?? [];
    this.trajectoryLineIds = new Set(entities
      .filter((data) => 'showTrajectoryLine' in data && data.showTrajectoryLine === true)
      .map((data) => data.id));
    this._proteinDisplay = savedProteinDisplay(entities);
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
