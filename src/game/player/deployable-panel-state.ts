// 展開式パネルに共通する、目標値への線形補間状態。
// 発電量・冷却量・接触形状などの性能計算は各所有者が持ち、ここは状態遷移だけを担う。

export class DeployablePanelState {
  public target: 0 | 1;
  public value: number;

  public constructor(target: 0 | 1, value: number) {
    this.target = target;
    this.value = Math.max(0, Math.min(1, value));
  }

  public toggle(): void {
    this.target = this.target === 0 ? 1 : 0;
  }

  public setTarget(open: boolean): void {
    this.target = open ? 1 : 0;
  }

  public update(dt: number, duration: number): void {
    const step = duration > 0 ? Math.max(0, dt) / duration : 1;
    if (this.value < this.target) this.value = Math.min(this.target, this.value + step);
    else if (this.value > this.target) this.value = Math.max(this.target, this.value - step);
  }
}
