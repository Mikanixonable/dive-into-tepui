// fetch で取る焼き込みモデル(船モジュール・弾薬・マガジン)の読込をまとめる。読込を始めて
// から完了を待つまでの間に、ほかの初期化を進められる。
import { loadAmmoModels } from './ammo-models';
import { loadShipModuleModels } from './ship/ship-module-models';

// 焼き込みモデルをすべて読む。何度呼んでも fetch とパースは一度だけで、同じ完了を返す。
export function loadBakedModels(): Promise<void> {
  return Promise.all([loadShipModuleModels(), loadAmmoModels()]).then(() => undefined);
}
