// 角度 [rad] の区間への畳み込み。

// 位相角 [rad] を 0..2π へ畳む。
export function wrapAngle(angle: number): number {
  const turns = angle / (2 * Math.PI);
  return (turns - Math.floor(turns)) * 2 * Math.PI;
}
