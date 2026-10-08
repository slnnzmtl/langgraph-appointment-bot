import type { InteractionChoice } from "./booking-session.js";
import type { ServicesContext } from "../tools/service-tools.js";

const MAX_FAQ_CATALOG_CHOICES = 8;

/**
 * Build FAQ catalog choices from checkpointed CRM rows.
 * Prefer short direction/family stems when many rows share a prefix; otherwise
 * one chip per service name. Remaining CRM ids stay on each choice for narrowing.
 */
export const buildFaqCatalogChoices = (
  services: ServicesContext["list"],
  remainingIds?: readonly string[],
): InteractionChoice[] => {
  const rows = remainingIds != null && remainingIds.length > 0
    ? services.filter((row) => remainingIds.includes(row.id))
    : services;
  if (rows.length === 0) {
    return [];
  }
  if (rows.length === 1) {
    const row = rows[0]!;
    return [{ id: row.id, label: row.name, serviceIds: [row.id] }];
  }

  const groups = new Map<string, string[]>();
  for (const row of rows) {
    const stem = row.name.split(/[\s,—–-]+/).filter((part) => part.length > 0)[0] ?? row.name;
    const key = stem.trim();
    const existing = groups.get(key) ?? [];
    existing.push(row.id);
    groups.set(key, existing);
  }

  const useGroups = groups.size > 1 && groups.size < rows.length;
  if (useGroups) {
    return [...groups.entries()].slice(0, MAX_FAQ_CATALOG_CHOICES).map(([label, serviceIds], index) => ({
      id: serviceIds.length === 1 ? serviceIds[0]! : `faq-g${index}`,
      label: serviceIds.length === 1
        ? (rows.find((row) => row.id === serviceIds[0])?.name ?? label)
        : label,
      serviceIds,
    }));
  }

  return rows.slice(0, MAX_FAQ_CATALOG_CHOICES).map((row) => ({
    id: row.id,
    label: row.name,
    serviceIds: [row.id],
  }));
};
