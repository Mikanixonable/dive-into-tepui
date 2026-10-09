// 盲検の刺激の並びを、乱数の種と撮影の名前から決まる乱数で混ぜる。同じ種と同じ入力からは同じ並びが出る。
import { createHash } from 'node:crypto';

// 種 seed と撮影 scene で決まる [0, 1) の乱数列。
function seededRandom(seed, scene) {
  let counter = 0;
  return () => {
    const digest = createHash('sha256').update(`${seed}:${scene}:${counter++}`).digest();
    return digest.readUInt32BE(0) / 0x1_0000_0000;
  };
}

// items を種 seed と撮影 scene で混ぜた並び。隣り合う 2 つ(前, 後)に alike が真を返す並びは引き直し、10000 回で見つから
// なければ投げる。
export function shuffled(items, seed, scene, alike) {
  const random = seededRandom(seed, scene);
  for (let attempt = 0; attempt < 10_000; attempt++) {
    const order = [...items];
    for (let index = order.length - 1; index > 0; index--) {
      const other = Math.floor(random() * (index + 1));
      [order[index], order[other]] = [order[other], order[index]];
    }
    if (order.every((item, index) => index === 0 || !alike(order[index - 1], item))) return order;
  }
  throw new Error(`could not find a mixed order for ${scene}`);
}
