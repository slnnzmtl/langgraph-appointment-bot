/** Clinic slot step and fallback open hours when CRM working time is unavailable. */
export const CLINIC_SLOT_TZ = "Europe/Kyiv";
export const CLINIC_ADDRESS = "вул. Миколаївська 33, м. Білгород-Дністровський";
export const CLINIC_MAPS_URL =
  "https://www.google.com/maps/place/Mukolayivska+St,+33,+Bilhorod-Dnistrovs'kyi,+Odes'ka+oblast,+Ukraine,+67701";
export const CLINIC_MAPS_MARKDOWN = `[Google maps](${CLINIC_MAPS_URL})`;
export const CLINIC_OPEN_HOUR = 9;
export const CLINIC_CLOSE_HOUR = 18;
export const CLINIC_SLOT_MINUTES = 30;
export const MAX_PRESENTED_SLOTS = 12;
/** Max calendar days to scan when looking for the next free appointment day. */
export const MAX_AVAILABILITY_SEARCH_DAYS = 30;
/** How many open days with free slots to return in one next-available search. */
export const MAX_PROPOSED_AVAILABILITY_DAYS = 5;
