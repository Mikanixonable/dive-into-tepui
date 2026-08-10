import * as C from './const';
import {
  calendarDateToJulianDate, ephemerisSeconds, parseCalendarDate,
} from '../physics/time';

export const SIM_EPOCH_CALENDAR_TDB = parseCalendarDate(C.SIM_EPOCH_TDB, 'TDB');
export const SIM_EPOCH_JD_TDB = calendarDateToJulianDate(SIM_EPOCH_CALENDAR_TDB).value;
export const SIM_EPOCH_ET = ephemerisSeconds(SIM_EPOCH_CALENDAR_TDB);
