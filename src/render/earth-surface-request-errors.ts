// tile-indexとHTTP要求の境界で共有するエラー型。
export class EarthSurfaceRequestError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'EarthSurfaceRequestError';
  }
}

export class EarthSurfaceHttpError extends EarthSurfaceRequestError {
  public constructor(public readonly status: number) {
    super(`Earth surface HTTP ${status}`);
    this.name = 'EarthSurfaceHttpError';
  }
}
