// GOES ABI の取得対象を時刻・プロダクトから一意に選ぶ。

import path from 'node:path';

export const PRODUCTS = [
  { prefix: 'ABI-L1b-RadF', filenameProducts: ['L1b-RadF-M6C02', 'L1b-RadF-M6C13'] },
  { prefix: 'ABI-L2-CODF', filenameProducts: ['L2-CODF-M6'] },
  { prefix: 'ABI-L2-ACHAF', filenameProducts: ['L2-ACHAF-M6'] },
  { prefix: 'ABI-L2-ACTPF', filenameProducts: ['L2-ACTPF-M6'] },
  { prefix: 'ABI-L2-ACMF', filenameProducts: ['L2-ACMF-M6'] },
];

function utcScanSlotParts(date) {
  const year = date.getUTCFullYear();
  const yearStart = Date.UTC(year, 0, 1);
  const dayOfYear = Math.floor((date.getTime() - yearStart) / 86_400_000) + 1;
  return {
    year: String(year),
    day: String(dayOfYear).padStart(3, '0'),
    hour: String(date.getUTCHours()).padStart(2, '0'),
    minute: String(date.getUTCMinutes()).padStart(2, '0'),
  };
}

export function seriesScanSlots(series) {
  const startMs = Date.parse(series.start);
  const endMs = Date.parse(series.end);
  const intervalMinutes = series.intervalMinutes;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs
    || !Number.isInteger(intervalMinutes) || intervalMinutes <= 0
    || startMs % 60_000 !== 0 || endMs % 60_000 !== 0) {
    throw new Error('manifest case has an invalid UTC series');
  }
  const intervalMs = intervalMinutes * 60_000;
  if ((endMs - startMs) % intervalMs !== 0) {
    throw new Error('manifest case series end must align with its scan interval');
  }
  const slots = [];
  for (let slotMs = startMs; slotMs <= endMs; slotMs += intervalMs) {
    slots.push(utcScanSlotParts(new Date(slotMs)));
  }
  return slots;
}

export function satelliteOf(referenceCase) {
  const satelliteMatch = /^GOES-(\d+) ABI /.exec(referenceCase.source.product);
  if (referenceCase.source.provider !== 'NOAA' || satelliteMatch === null) {
    throw new Error(`case ${referenceCase.id} is not a supported NOAA GOES ABI source`);
  }
  return `G${satelliteMatch[1]}`;
}

export function scanMinutePrefix(slot) {
  return `${slot.year}${slot.day}${slot.hour}${slot.minute}`;
}

/** NOAA ファイル名の開始・終了・作成時刻を検査する。 */
export function matchesSelectorKey(selector, key) {
  const basename = path.posix.basename(key);
  if (!key.startsWith(`${selector.productPrefix}/`)
    || !basename.startsWith(selector.filenamePrefix)) return false;
  const suffix = basename.slice(selector.filenamePrefix.length);
  const match = /^(\d{3})_e(\d{14})_c(\d{14})\.nc$/.exec(suffix);
  if (match === null) return false;
  const startMinute = selector.filenamePrefix.slice(selector.filenamePrefix.lastIndexOf('_s') + 2);
  const startTimestamp = parseNoaaTimestamp(`${startMinute}${match[1]}`);
  const endTimestamp = parseNoaaTimestamp(match[2]);
  const creationTimestamp = parseNoaaTimestamp(match[3]);
  return startTimestamp !== null && endTimestamp !== null && creationTimestamp !== null
    && endTimestamp > startTimestamp && creationTimestamp >= endTimestamp;
}

function parseNoaaTimestamp(value) {
  const match = /^(\d{4})(\d{3})(\d{2})(\d{2})(\d{3})$/.exec(value);
  if (match === null) return null;
  const [, yearText, dayText, hourText, minuteText, secondTenthsText] = match;
  const year = Number(yearText);
  const dayOfYear = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const secondTenths = Number(secondTenthsText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  if (year === 0 || dayOfYear < 1 || dayOfYear > (leapYear ? 366 : 365)
    || hour > 23 || minute > 59 || secondTenths > 599) return null;
  const date = new Date(0);
  date.setUTCFullYear(year, 0, 1);
  date.setTime(date.getTime() + (dayOfYear - 1) * 86_400_000);
  date.setUTCHours(hour, minute, Math.floor(secondTenths / 10), (secondTenths % 10) * 100);
  const yearStart = new Date(0);
  yearStart.setUTCFullYear(year, 0, 1);
  const actualDayOfYear = Math.floor((date.getTime() - yearStart.getTime()) / 86_400_000) + 1;
  return date.getUTCFullYear() === year && actualDayOfYear === dayOfYear ? date.getTime() : null;
}

export function plannedNetcdfSelectors(referenceCase) {
  const satellite = satelliteOf(referenceCase);
  return seriesScanSlots(referenceCase.series).flatMap((slot) => PRODUCTS.flatMap((product) => (
    product.filenameProducts.map((name) => ({
      productPrefix: product.prefix,
      filenamePrefix: `OR_ABI-${name}_${satellite}_s${scanMinutePrefix(slot)}`,
      scanMinute: scanMinutePrefix(slot),
    }))
  )));
}

export function acquisitionPlan(referenceCase, outputDirectory) {
  const satellite = satelliteOf(referenceCase);
  const bucket = `noaa-goes${satellite.slice(1)}`;
  const slotsByHour = new Map();
  for (const slot of seriesScanSlots(referenceCase.series)) {
    const hourKey = `${slot.year}/${slot.day}/${slot.hour}`;
    const slots = slotsByHour.get(hourKey) ?? [];
    slots.push(slot);
    slotsByHour.set(hourKey, slots);
  }
  const commands = [];
  for (const [hourKey, slots] of slotsByHour) {
    const [year, day, hour] = hourKey.split('/');
    for (const product of PRODUCTS) {
      commands.push({
        command: 'aws',
        args: [
          's3', 'cp',
          `s3://${bucket}/${product.prefix}/${year}/${day}/${hour}/`,
          path.join(outputDirectory, product.prefix),
          '--recursive', '--no-sign-request', '--exclude', '*',
          ...product.filenameProducts.flatMap((name) => slots.flatMap((slot) => [
            '--include', `OR_ABI-${name}_${satellite}_s${scanMinutePrefix(slot)}*.nc`,
          ])),
        ],
      });
    }
  }
  return commands;
}
