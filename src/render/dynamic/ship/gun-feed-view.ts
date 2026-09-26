import type * as THREE from 'three/webgpu';
import magazineData from '../../../assets/models/magazine.json';
import { MAG_THICKNESS } from '../../../physics/player-shape';
import { memoParseIndependent } from '../baked-model';
import { disposeOwnedRenderResources } from '../../dispose-owned-render-resources';

const parseMagazine = memoParseIndependent<THREE.Group>(magazineData);
const CARTRIDGE_ADVANCE_TIME = 0.22;
const MAGAZINE_FEED_TIME = 0.42;
const CARTRIDGE_STAGE_HEIGHT = MAG_THICKNESS * 0.25;
const MAGAZINE_FEED_DISTANCE = 0.85;

interface CartridgeView {
  readonly group: THREE.Group;
  readonly rounds: readonly THREE.Object3D[];
  readonly baseY: number;
}

// 給弾中のカートリッジ段をレールへ取り付け、残弾数と給弾時刻から表示を組み立てる。
export class GunFeedView {
  private readonly magazine = parseMagazine();
  private readonly cartridges: readonly CartridgeView[];
  private disposed = false;

  // magazine-rail の局所原点へ、給弾中の3段のカートリッジ表示を保持する。
  public constructor(anchor: THREE.Object3D) {
    const magazineFrame = this.magazine.getObjectByName('magazineFrame');
    if (magazineFrame !== undefined) magazineFrame.visible = false;
    // 残弾表示を段ごとに扱えるよう、各段の弾と基準位置をまとめる。
    const cartridges: CartridgeView[] = [];
    for (let stage = 0; stage < 3; stage++) {
      const found = this.magazine.getObjectByName(`cartridge:${stage}`);
      if (found === undefined) continue;
      const group = found as THREE.Group;
      const rounds = Array.from({ length: 8 }, (_, round) => (
        group.getObjectByName(`round:${round}`)
      )).filter((object): object is THREE.Object3D => object !== undefined);
      cartridges.push({ group, rounds, baseY: group.position.y });
    }
    this.cartridges = cartridges;
    this.attach(anchor);
  }

  // レールの anchor が再構築されたときに同じカートリッジ表示を移す。
  public attach(anchor: THREE.Object3D): void {
    if (this.disposed) return;
    if (this.magazine.parent !== anchor) anchor.add(this.magazine);
  }

  // 8発ごとの段送りと箱の装填位置を、シミュレーション時刻に対応する表示時刻へ同期する。
  public sync(
    roundsInMagazine: number,
    cartridgeAdvancedAt: number | null,
    magazineFedAt: number | null,
    displayTime: number,
  ): void {
    const rounds = Math.max(0, Math.min(24, Math.floor(roundsInMagazine)));
    this.magazine.visible = rounds > 0;
    if (rounds === 0) return;

    const advancedStages = Math.floor((24 - rounds) / 8);
    const cartridgeProgress = animationProgress(
      displayTime, cartridgeAdvancedAt, CARTRIDGE_ADVANCE_TIME,
    );
    const verticalOffset = advancedStages === 0
      ? 0
      : (advancedStages - 1 + cartridgeProgress) * CARTRIDGE_STAGE_HEIGHT;
    // 空段を隠し、残った段を上段の送り位置へ持ち上げる。
    for (let stage = 0; stage < this.cartridges.length; stage++) {
      const cartridge = this.cartridges[stage]!;
      const remaining = Math.max(0, Math.min(8, rounds - (2 - stage) * 8));
      cartridge.group.visible = remaining > 0;
      cartridge.group.position.y = cartridge.baseY + verticalOffset;
      for (let round = 0; round < cartridge.rounds.length; round++) {
        cartridge.rounds[round]!.visible = round < remaining;
      }
    }

    const feedProgress = animationProgress(displayTime, magazineFedAt, MAGAZINE_FEED_TIME);
    this.magazine.position.x = MAGAZINE_FEED_DISTANCE * (1 - feedProgress);
  }

  // 独立解析したカートリッジ表示の描画資源を解放する。
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.magazine.parent?.remove(this.magazine);
    disposeOwnedRenderResources(this.magazine);
    this.magazine.clear();
  }
}

// 未記録のイベントは完了状態とし、記録済みのイベントは表示時刻で補間する。
function animationProgress(displayTime: number, eventTime: number | null, duration: number): number {
  if (eventTime === null || !Number.isFinite(eventTime)) return 1;
  return Math.max(0, Math.min(1, (displayTime - eventTime) / duration));
}
