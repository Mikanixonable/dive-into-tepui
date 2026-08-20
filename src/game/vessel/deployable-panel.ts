// 上下2枚が蛇腹式に展開/収納する外装パネル(放熱板・太陽電池パドル)の共通の振る舞い。
// どちらの用途で使うかは知らない — 展開度の値と折り角の変換を提供するだけで、
// 面積・蓄電量・接触代理など用途固有のものは呼び出し側(RadiatorSystem/PowerSystem)が持つ。
import * as THREE from 'three/webgpu';

export type PanelSide = 'up' | 'down';

// 展開度と、その目標値。0=収納、1=全開。
export class DeployablePanel {
  deploy: number;
  constructor(public deployTarget: 0 | 1) {
    this.deploy = deployTarget;
  }
}

// 展開度を目標値へ deployTimeSec 秒かけて近づける。数値のみを動かす(THREE には触れない)。
export function stepDeploy(panel: DeployablePanel, dt: number, deployTimeSec: number): void {
  const step = dt / deployTimeSec;
  if (panel.deploy < panel.deployTarget) panel.deploy = Math.min(panel.deployTarget, panel.deploy + step);
  else if (panel.deploy > panel.deployTarget) panel.deploy = Math.max(panel.deployTarget, panel.deploy - step);
}

// 展開度から折り角を線形補間する。deploy=0 で stowTilt、deploy=1 で deployedTilt。
export function foldTilt(deploy: number, stowTilt: number, deployedTilt: number): number {
  return stowTilt + (deployedTilt - stowTilt) * deploy;
}

// 偶数折り目/奇数折り目それぞれの、ヒンジ基準での累積回転角。展開方向(モデル側の折り目
// オフセット)は side ごとに符号が付くので、回転角自体は side に依らず ±tilt で揃えられる。
export function foldThetas(side: PanelSide, tilt: number): { even: number; odd: number } {
  const sign = side === 'up' ? 1 : -1;
  return { even: sign * tilt, odd: -sign * tilt };
}

// renderObject から namePrefix + 'Fold' + index の折り目 Group を foldCount 個解決する。
// 1つでも見つからなければ side ごと欠損として undefined を返す。
export function findFoldMeshes(
  renderObject: THREE.Object3D, namePrefix: string, foldCount: number,
): THREE.Object3D[] | undefined {
  const found = Array.from({ length: foldCount }, (_, i) => renderObject.getObjectByName(`${namePrefix}Fold${i}`));
  if (found.some((f) => !f)) return undefined;
  return found as THREE.Object3D[];
}
