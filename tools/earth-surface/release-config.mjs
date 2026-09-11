#!/usr/bin/env node
// 本番の地表配信先を、データ配備とは独立して検査する。

const DATASET_ID = /^[a-z0-9-]+$/;

export class EarthSurfaceReleaseConfigError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'EarthSurfaceReleaseConfigError';
  }
}

function localHostname(hostname) {
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  return normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '0.0.0.0'
    || normalized === '::1'
    || normalized === '[::1]'
    || normalized === '::';
}

function parseHttpsUrl(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new EarthSurfaceReleaseConfigError(`${name} is required`);
  }
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    throw new EarthSurfaceReleaseConfigError(`${name} must be an absolute URL`, { cause: error });
  }
  if (url.protocol !== 'https:') throw new EarthSurfaceReleaseConfigError(`${name} must use HTTPS`);
  if (localHostname(url.hostname)) throw new EarthSurfaceReleaseConfigError(`${name} must not target localhost`);
  if (url.username.length > 0 || url.password.length > 0) {
    throw new EarthSurfaceReleaseConfigError(`${name} must not contain credentials`);
  }
  return url;
}

function parseAllowedOrigin(value, index) {
  const url = parseHttpsUrl(value, `allowed origin[${index}]`);
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new EarthSurfaceReleaseConfigError(`allowed origin[${index}] must contain only an origin`);
  }
  return url.origin;
}

function normalizeAllowedOrigins(allowedOrigins) {
  if (allowedOrigins === undefined) return [];
  if (!Array.isArray(allowedOrigins)) {
    throw new EarthSurfaceReleaseConfigError('allowedOrigins must be an array');
  }
  const origins = allowedOrigins.map((value, index) => parseAllowedOrigin(value, index));
  return [...new Set(origins)];
}

export function validateEarthSurfaceReleaseConfig({ baseUrl, datasetId, allowedOrigins } = {}) {
  const url = parseHttpsUrl(baseUrl, 'Earth surface base URL');
  if (typeof datasetId !== 'string' || !DATASET_ID.test(datasetId)) {
    throw new EarthSurfaceReleaseConfigError('Earth surface datasetId must match /^[a-z0-9-]+$/');
  }
  const origins = normalizeAllowedOrigins(allowedOrigins);
  if (origins.length > 0 && !origins.includes(url.origin)) {
    throw new EarthSurfaceReleaseConfigError(`Earth surface base URL origin is not approved: ${url.origin}`);
  }
  return {
    baseUrl: url.toString(),
    datasetId,
    origin: url.origin,
    allowedOrigins: origins,
  };
}

function optionValue(args, option) {
  const index = args.indexOf(option);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) throw new EarthSurfaceReleaseConfigError(`${option} requires a value`);
  return value;
}

function optionValues(args, option) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== option) continue;
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) throw new EarthSurfaceReleaseConfigError(`${option} requires a value`);
    values.push(value);
    index += 1;
  }
  return values;
}

export function releaseConfigFromEnvironment(args = process.argv.slice(2), environment = process.env) {
  const cliAllowed = optionValues(args, '--allowed-origin');
  const listValue = optionValue(args, '--allowed-origins');
  const envAllowed = environment.EARTH_SURFACE_ALLOWED_ORIGINS
    ? environment.EARTH_SURFACE_ALLOWED_ORIGINS.split(',').map((value) => value.trim()).filter(Boolean)
    : [];
  const allowedOrigins = [...(listValue ? listValue.split(',').map((value) => value.trim()).filter(Boolean) : []), ...cliAllowed];
  return validateEarthSurfaceReleaseConfig({
    baseUrl: optionValue(args, '--base-url') ?? environment.EARTH_SURFACE_BASE_URL,
    datasetId: optionValue(args, '--dataset-id') ?? environment.EARTH_SURFACE_DATASET_ID,
    allowedOrigins: [...envAllowed, ...allowedOrigins],
  });
}

if (process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url) {
  try {
    console.log(JSON.stringify(releaseConfigFromEnvironment(), null, 2));
  } catch (error) {
    console.error(`earth-surface:release-check: ${error.message}`);
    process.exitCode = 1;
  }
}
