// 地表配信物のデコード処理で共有するエラー型。
export class EarthSurfaceDecodeError extends Error {
  // 地表配信物を解釈できない理由をErrorとして公開する。
  public constructor(message: string) {
    super(message);
    this.name = 'EarthSurfaceDecodeError';
  }
}
