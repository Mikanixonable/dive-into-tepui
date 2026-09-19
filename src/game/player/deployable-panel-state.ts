// 展開式パネルに共通する、展開目標への線形補間の状態。

export interface SerializedDeployablePanelState {
  readonly deployTarget: 0 | 1;
  readonly deploy: number;
}

export class DeployablePanelState {
  private _value: number;

  // target は展開目標(0 = 収納、1 = 展開)、value は展開度で 0..1 へ収める。
  public constructor(private _target: 0 | 1, value: number) {
    this._value = Math.max(0, Math.min(1, value));
  }

  // 展開度(0 = 収納、1 = 展開)。
  public get value(): number { return this._value; }
  // 展開目標(0 = 収納、1 = 展開)。
  public get target(): 0 | 1 { return this._target; }

  // 直列化した展開目標と展開度から復元する。壊れた記録なら null — 持ち主が自分の初期値で補う。
  public static deserialize(serialized: SerializedDeployablePanelState): DeployablePanelState | null {
    const { deployTarget, deploy } = serialized;
    if (deployTarget !== 0 && deployTarget !== 1) return null;
    if (typeof deploy !== 'number' || !Number.isFinite(deploy)) return null;
    return new DeployablePanelState(deployTarget, deploy);
  }

  // 展開目標と展開度の直列化。
  public serialize(): SerializedDeployablePanelState {
    return { deployTarget: this._target, deploy: this._value };
  }

  // 展開目標を反転する。
  public toggle(): void {
    this._target = this._target === 0 ? 1 : 0;
  }

  // open なら展開、そうでなければ収納を目標にする。
  public setTarget(open: boolean): void {
    this._target = open ? 1 : 0;
  }

  // 展開度を目標へ dt 秒ぶん近づける。duration は全行程にかかる時間 [s] で、0 以下なら即座に着く。
  public update(dt: number, duration: number): void {
    const step = duration > 0 ? Math.max(0, dt) / duration : 1;
    if (this._value < this._target) this._value = Math.min(this._target, this._value + step);
    else if (this._value > this._target) this._value = Math.max(this._target, this._value - step);
  }
}
