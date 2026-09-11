// 地表配信物のデコード処理で共有するエラー型。
export class EarthSurfaceDecodeError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'EarthSurfaceDecodeError';
  }
}
