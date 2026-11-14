// 実体ごとの表示設定。予測線・過去線を出す実体を持つ。

export interface SerializedEntityDisplaySelection {
  readonly trajectoryLineIds: readonly string[];
}

// 実体ごとの表示設定を読む面。
export interface EntityDisplaySource {
  // id の実体の予測線・過去線を、操作対象でなくても出すか。
  showsTrajectoryLine(id: string): boolean;
}

export class EntityDisplaySelection implements EntityDisplaySource {
  public constructor(
    // 予測線・過去線を表示する実体の id。アセットロード待機中で一覧にまだ存在しない個体の id も保持する。
    private readonly trajectoryLineIds: Set<string> = new Set(),
  ) {}

  // 直列化した表示設定から復元する。
  public static deserialize(serialized: SerializedEntityDisplaySelection): EntityDisplaySelection {
    return new EntityDisplaySelection(
      new Set(serialized.trajectoryLineIds),
    );
  }

  // 直列化した形へ畳む。
  public serialize(): SerializedEntityDisplaySelection {
    return { trajectoryLineIds: [...this.trajectoryLineIds] };
  }

  public showsTrajectoryLine(id: string): boolean { return this.trajectoryLineIds.has(id); }

  // id の実体の予測線・過去線を、出していれば消し、消していれば出す。
  public toggleTrajectoryLine(id: string): void {
    if (this.trajectoryLineIds.has(id)) this.trajectoryLineIds.delete(id);
    else this.trajectoryLineIds.add(id);
  }
}
