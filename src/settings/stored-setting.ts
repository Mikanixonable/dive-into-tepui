// ラン跨ぎで残るユーザー設定1つぶんの器と、その保存先。設定の現在値を持ち、書き換えを保存先へ
// 流して購読者へ配る。値と保存文字列の変換は設定ごとの parse / format が受け持ち、保存先が
// 使えるかどうかの見極めは保存先の実装が受け持つ。

// 設定の保存先。読み書きの失敗はここで吸収する。
export interface SettingStorage {
  // key に保存された文字列。未保存なら null。
  read(key: string): string | null;
  // key へ文字列を保存する。
  write(key: string, text: string): void;
}

// ブラウザの localStorage を保存先にする。private browsing 等で localStorage が使えないときは、
// 読みが未保存として答え、書きは諦める。
export const browserSettingStorage: SettingStorage = {
  // localStorage が使えない環境では、未保存として答える。
  read(key: string): string | null {
    if (typeof window === 'undefined') return null;
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },

  // localStorage が使えない環境では、保存を諦める。
  write(key: string, text: string): void {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(key, text);
    } catch {
      // 保存できなくても、この実行の中では設定が生きている。
    }
  },
};

// この実行の中だけで生きる保存先。
export class MemorySettingStorage implements SettingStorage {
  private readonly entries = new Map<string, string>();

  // 仕込まれていない鍵は未保存として答える。
  public read(key: string): string | null {
    return this.entries.get(key) ?? null;
  }

  // この実行のあいだだけ覚える。
  public write(key: string, text: string): void {
    this.entries.set(key, text);
  }
}

// 現在値だけを読む面。
export interface SettingValue<T> {
  // いま選ばれている値。
  readonly current: T;
}

// 設定1つ。現在値を正本として持ち、書き換えを保存と購読者へ配る。
export class StoredSetting<T> implements SettingValue<T> {
  private value: T;
  private readonly listeners = new Set<(value: T) => void>();

  // key は storage の中でこの設定を指す鍵。parse は未保存(null)からも値を決める。
  public constructor(
    private readonly storage: SettingStorage,
    private readonly key: string,
    parse: (text: string | null) => T,
    private readonly format: (value: T) => string,
  ) {
    this.value = parse(storage.read(key));
  }

  public get current(): T { return this.value; }

  // 値を差し替え、保存と購読者への通知まで行う。保存に失敗しても、この実行の中では新しい値が生きる。
  public set(value: T): void {
    this.value = value;
    this.storage.write(this.key, this.format(value));
    for (const listener of this.listeners) listener(value);
  }

  // 変更を購読する。登録時に現在値で一度呼ぶので、購読側は初期反映を自前で書かなくてよい。
  // 返り値を呼ぶと購読を解除する。
  public subscribe(listener: (value: T) => void): () => void {
    this.listeners.add(listener);
    listener(this.value);
    return () => this.listeners.delete(listener);
  }
}
