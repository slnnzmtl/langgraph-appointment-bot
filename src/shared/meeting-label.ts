/** CRM titles are "[service-name] - [firstName lastName]"; last " - " is the patient, not the service. */
export const meetingServiceLabel = (name: string): string => {
  const separator = name.lastIndexOf(" - ");
  if (separator <= 0) {
    return name.trim();
  }
  const service = name.slice(0, separator).trim();
  return service.length > 0 ? service : name.trim();
};

export const VISIT_LABEL_SEPARATOR = " — ";

/** Patient-facing «service — when»; `whenLabel` is usually from formatKyivDateTimeLabel. */
export const visitLabel = (meetingTitle: string, whenLabel: string): string => {
  const serviceLabel = meetingServiceLabel(meetingTitle);
  const when = whenLabel.trim();
  if (serviceLabel.length === 0 || when.length === 0) {
    return "";
  }
  return `${serviceLabel}${VISIT_LABEL_SEPARATOR}${when}`;
};
