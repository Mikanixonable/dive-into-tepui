// キーボード入力の追跡。押下中のキーセットと、1フレームぶんの押下エッジを持ち、
// update() で今フレームのスナップショットとして確定させる。エッジは先着順の消費
// モデルで、take* が消費したものはキューから取り除かれ、takeHeld で確保した
// code は他の窓口から見えなくなる。
import { type KeyBinding, SCROLL_GUARD_KEYS } from './key-mapping';

// どの操作にも割り当てていないが、押されるとフォーカスが移動してゲームが操作不能に
// なるため既定動作だけ止めるキー。
const FOCUS_GUARD_CODE = 'Tab';

// code がこのキー割り当てに一致するか(altCodes も含めて)判定する。
function matchesCode(key: KeyBinding, code: string): boolean {
  return key.code === code || (key.altCodes?.includes(code) ?? false);
}

export class KeyboardTracker {
  private keys = new Set<string>();
  // takeHeld で確保済みの code。down()/takeKey()/takeKeys() からは見えなくなる。
  private claimedCodes = new Set<string>();
  private pendingPresses: string[] = [];
  private framePresses: string[] = [];

  // keydown を受け、押下エッジ(pendingPresses)と押下中セット(keys)へ反映する。
  public keyDown(e: KeyboardEvent): void {
    // Space スクロール・矢印キーのページスクロールと、割り当ての無い Tab による
    // フォーカス移動(ゲームが操作不能になる)を抑止する
    if (e.code === FOCUS_GUARD_CODE || SCROLL_GUARD_KEYS.some((k) => matchesCode(k, e.code))) {
      e.preventDefault();
    }
    if (!e.repeat) this.pendingPresses.push(e.code);
    this.keys.add(e.code);
  }

  // keyup を受け、押下中セットから除外する。
  public keyUp(e: KeyboardEvent): void {
    this.keys.delete(e.code);
  }

  // 押下中・確保済みのキー状態をすべて解除する。
  public release(): void {
    this.keys.clear();
    this.claimedCodes.clear();
  }

  // フレームの先頭で1度だけ呼ぶ。蓄積した押下エッジを今フレームのスナップショット
  // として確定し、確保済み code と次フレーム分の蓄積をリセットする。
  public update(): void {
    this.claimedCodes.clear();
    this.framePresses = this.pendingPresses;
    this.pendingPresses = [];
  }

  // 仮想キーの押下・解放を、物理キーと同じ扱いで押下中セットとエッジトリガキューへ
  // 反映する。
  public setVirtualKey(key: KeyBinding, down: boolean): void {
    if (down) {
      if (!this.keys.has(key.code)) this.pendingPresses.push(key.code);
      this.keys.add(key.code);
    } else {
      this.keys.delete(key.code);
    }
  }

  // key を1フレームぶんだけ押されたことにする。
  public tapKey(key: KeyBinding): void {
    this.setVirtualKey(key, true);
    this.setVirtualKey(key, false);
  }

  // code が押下中かつ未確保か返す。
  private isDown(code: string): boolean {
    return this.keys.has(code) && !this.claimedCodes.has(code);
  }

  // key が現在押下中か返す。takeHeld で確保済みの code は押下と見なさない。
  public down(key: KeyBinding): boolean {
    return this.isDown(key.code) || (key.altCodes?.some((c) => this.isDown(c)) ?? false);
  }

  // key がホールドされていれば、その code (と altCodes) を先着で確保して true を返す。
  // 確保した code は以後 down() / takeKey() / takeKeys() から見えなくなる。
  public takeHeld(key: KeyBinding): boolean {
    if (!this.down(key)) return false;
    this.claimedCodes.add(key.code);
    for (const c of key.altCodes ?? []) this.claimedCodes.add(c);
    return true;
  }

  // 今フレームの押下エッジに key があれば消費して true を返す。takeHeld で確保済みの
  // code は渡さない。
  public takeKey(key: KeyBinding): boolean {
    const i = this.framePresses.findIndex((code) => matchesCode(key, code) && !this.claimedCodes.has(code));
    if (i === -1) return false;
    this.framePresses.splice(i, 1);
    return true;
  }

  // 今フレームの未消費の押下エッジを順に渡し、handler が true を返したものを消費する。
  // takeHeld で確保済みの code は渡さない。
  public takeKeys(handler: (code: string) => boolean): void {
    for (const code of [...this.framePresses]) {
      if (this.claimedCodes.has(code)) continue;
      if (!handler(code)) continue;
      const i = this.framePresses.indexOf(code);
      if (i !== -1) this.framePresses.splice(i, 1);
    }
  }
}
