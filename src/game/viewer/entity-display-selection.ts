// 実体ごとの表示設定。予測線・過去線を出す実体と、タンパク質の敵に共通の表示形態・着色を持つ。
import {
  DEFAULT_PROTEIN_DISPLAY, isProteinDisplaySettings, type ProteinDisplaySettings,
} from '../../render/protein/protein-display';

export interface SerializedEntityDisplaySelection {
  readonly trajectoryLineIds: readonly string[];
  readonly proteinDisplay: ProteinDisplaySettings;
}

// 実体ごとの表示設定を読む面。
export interface EntityDisplaySource {
  // id の実体の予測線・過去線を、操作対象でなくても出すか。
  showsTrajectoryLine(id: string): boolean;
  // タンパク質の敵の表示形態と着色。全個体で共通。
  readonly proteinDisplay: ProteinDisplaySettings;
}

export class EntityDisplaySelection implements EntityDisplaySource {
  public constructor(
    // 予測線・過去線を表示する実体の id。アセットロード待機中で一覧にまだ存在しない個体の id も保持する。
    private readonly trajectoryLineIds: Set<string> = new Set(),
    private _proteinDisplay: ProteinDisplaySettings = DEFAULT_PROTEIN_DISPLAY,
  ) {}

  // 直列化した表示設定から復元する。タンパク質の表示が不正なら既定から始める。
  public static deserialize(serialized: SerializedEntityDisplaySelection): EntityDisplaySelection {
    return new EntityDisplaySelection(
      new Set(serialized.trajectoryLineIds),
      isProteinDisplaySettings(serialized.proteinDisplay) ? serialized.proteinDisplay : undefined,
    );
  }

  // 直列化した形へ畳む。
  public serialize(): SerializedEntityDisplaySelection {
    return { trajectoryLineIds: [...this.trajectoryLineIds], proteinDisplay: this._proteinDisplay };
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
