// タイルURL解決とHTTP要求の境界で共有するエラー型。
export class EarthSurfaceRequestError extends Error {
  // 要求失敗のメッセージと任意の原因をErrorへ保存する。
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'EarthSurfaceRequestError';
  }
}

export class EarthSurfaceHttpError extends EarthSurfaceRequestError {
  // HTTPステータスを保持した要求エラーを作る。
  public constructor(public readonly status: number) {
    super(`Earth surface HTTP ${status}`);
    this.name = 'EarthSurfaceHttpError';
  }
}
