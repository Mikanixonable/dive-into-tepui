// 推力を伴わず主燃料を冷却回路へ流す操作の状態。流し中は毎進行で流量ぶんの燃料の
// 消費を要求し、流せなくなった(燃料切れ)時点で自ら止まる。

// 流している間の主燃料流量 [unit/s]。最強段連続噴射の流量の 1/4。
const COOLING_DUMP_FLOW_RATE = 22.5;

export class CoolingDump {
  // runningFlag は流し中かどうか。復元時は保存されていた値を渡す。
  public constructor(private runningFlag = false) {}

  public static deserialize(serialized: boolean): CoolingDump {
    return new CoolingDump(serialized);
  }

  public get running(): boolean { return this.runningFlag; }

  // 流しと停止を反転する。
  public toggle(): void { this.runningFlag = !this.runningFlag; }

  // dt 秒ぶんの燃料消費を要求する。消費できた量が流量に満たなければ燃料切れなので
  // 流れを止める。consume は要求量を受け、実際に消費した量を返す。
  public update(dt: number, consume: (units: number) => number): void {
    if (!this.runningFlag) return;
    const requested = COOLING_DUMP_FLOW_RATE * dt;
    if (consume(requested) < requested) this.runningFlag = false;
  }

  public serialize(): boolean { return this.runningFlag; }
}
