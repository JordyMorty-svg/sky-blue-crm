/**
 * The name somebody would actually say.
 *
 * ITS OWN MODULE because two services need it and a second copy is how the
 * thread and the timeline end up disagreeing about what to call the same
 * person. textService.js uses it to label a bubble; contactService.js uses it
 * to label a timeline row; both are looking at the same customer.
 *
 * Trimmed and cut at the first space. A record with no name, or a name that
 * is all whitespace, gives null so the caller can fall back to "Them" — a
 * bubble or a row labelled with an empty string reads as a rendering fault.
 *
 * FIRST NAME ONLY. "Dana" is how somebody refers to a customer out loud;
 * "Dana Reyes" above every other line is a database field on a screen.
 */
export function firstName(full) {
  const name = String(full || "").trim();
  if (!name) return null;
  return name.split(/\s+/)[0];
}
