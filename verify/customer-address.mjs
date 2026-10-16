// Filling in a blank customer address, and never touching a good one.
//
//   node verify/customer-address.mjs
//
// The rule is one sentence and the sentence is the risk: this runs on every
// booking against an existing customer, so a mistake in it quietly rewrites
// the address book. "Never overwrites" is therefore asserted far more ways
// than "fills", because the failure modes are not symmetrical — a hole left
// unfilled is the state we are already in, and a good address replaced by a
// worse one is a van at the wrong house.

import {
  addressFillForMatch,
  blankAddressGuard,
} from "../src/services/customerAddress.js";

let passed = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) passed += 1;
  else failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
}

const LEAD = {
  address: "900 Second Address Rd, Corvallis, OR",
  latitude: 44.5646,
  longitude: -123.262,
};

console.log("\n-- filling a hole --\n");

ok(
  "THE POINT: a blank address is filled from the booking",
  addressFillForMatch({ address: null }, LEAD)?.address === LEAD.address
);
ok(
  "...and the coordinates come with it",
  addressFillForMatch({ address: null }, LEAD)?.latitude === 44.5646 &&
    addressFillForMatch({ address: null }, LEAD)?.longitude === -123.262
);

for (const [label, blank] of [
  ["null", null],
  ["undefined", undefined],
  ["empty string", ""],
  ["whitespace", "   "],
  ["a tab", "\t"],
]) {
  ok(
    `${label} counts as blank`,
    addressFillForMatch({ address: blank }, LEAD) !== null
  );
}
ok(
  "a customer row that is missing entirely does not throw",
  addressFillForMatch(undefined, LEAD)?.address === LEAD.address
);

console.log("-- never overwriting a good one --\n");

const GOOD = { address: "123 Real St, Corvallis, OR", latitude: 44.6, longitude: -123.2 };

ok(
  "THE POINT: an address already on file is left alone",
  addressFillForMatch(GOOD, LEAD) === null
);
ok(
  "...even when the booking's address is different",
  addressFillForMatch(GOOD, { ...LEAD, address: "somewhere else" }) === null
);
ok(
  "...even when the customer has an address but no pin, and the lead has both",
  addressFillForMatch({ address: "123 Real St", latitude: null }, LEAD) === null,
  "tempting, and still not this function's business — the property sync owns coordinates"
);
ok(
  "...and a one-character address still counts as an address",
  addressFillForMatch({ address: "x" }, LEAD) === null
);

console.log("-- when there is nothing worth writing --\n");

for (const [label, source] of [
  ["no lead at all", undefined],
  ["a lead with no address", { address: null }],
  ["an empty address", { address: "" }],
  ["a whitespace address", { address: "  " }],
]) {
  ok(
    `${label} writes nothing rather than null over null`,
    addressFillForMatch({ address: null }, source) === null
  );
}

console.log("-- coordinates travel with their own address --\n");

// jobAddress.js: mixing them "sends the van to the wrong house with the
// right street name printed on the screen". A lead with an address and no
// pin must not leave stale coordinates sitting under a new address.
const noPin = addressFillForMatch(
  { address: null, latitude: 44.9, longitude: -123.9 },
  { address: "456 Pinless Ave" }
);
ok(
  "THE POINT: an address with no pin writes nulls, not the old pin",
  noPin.address === "456 Pinless Ave" &&
    noPin.latitude === null &&
    noPin.longitude === null,
  JSON.stringify(noPin)
);
// THE CASE THAT KEEPS GETTING MISSED, now on its seventh appearance in this
// codebase. `Number(null)` is 0 and 0 is finite, so a lead whose latitude is
// explicitly null — which is what Supabase returns, as opposed to the
// undefined you get from a hand-written object literal — lands the customer
// on the equator unless something rejects null by name.
//
// Every previous version of this assertion used a MISSING field. `Number(
// undefined)` is NaN, which is correctly rejected by a plain isFinite check,
// so the test passed against the broken code every time. A mutant caught it
// here; nothing else had, in six attempts.
const explicitNulls = addressFillForMatch(
  { address: null },
  { address: "789 Null Coord Way", latitude: null, longitude: null }
);
ok(
  "THE POINT: an explicitly null coordinate is null, not nought",
  explicitNulls.latitude === null && explicitNulls.longitude === null,
  JSON.stringify(explicitNulls)
);
ok(
  "...and an empty-string coordinate is too",
  addressFillForMatch({ address: null }, { address: "x", latitude: "", longitude: "" })
    .latitude === null
);

ok(
  "a zero coordinate is not mistaken for a missing one",
  addressFillForMatch({ address: null }, { address: "x", latitude: 0, longitude: 0 })
    .latitude === 0,
  "0,0 is a real place and null is not — Number(null) is 0, which is the bug this guards"
);
ok(
  "a non-numeric coordinate is dropped rather than written",
  addressFillForMatch({ address: null }, { address: "x", latitude: "north" })
    .latitude === null
);
ok(
  "the address is trimmed on the way in",
  addressFillForMatch({ address: null }, { address: "  12 Elm St  " }).address ===
    "12 Elm St"
);

console.log("-- the race guard --\n");

// Two bookings for the same customer landing together. The second must not
// write over what the first just filled in.
ok(
  "THE POINT: a null address is guarded with an is-null filter",
  blankAddressGuard({ address: null }).kind === "is-null"
);
ok(
  "...as is a customer row with no address key at all",
  blankAddressGuard({}).kind === "is-null" &&
    blankAddressGuard(undefined).kind === "is-null"
);
ok(
  "THE POINT: a whitespace address is guarded on its exact value",
  blankAddressGuard({ address: "   " }).kind === "equals" &&
    blankAddressGuard({ address: "   " }).value === "   ",
  "`is null` would not match it, so the write would be unguarded"
);
ok(
  "an empty string is guarded on its exact value too",
  blankAddressGuard({ address: "" }).kind === "equals" &&
    blankAddressGuard({ address: "" }).value === ""
);

console.log(`\n${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  FAIL  ${f}`);
process.exit(failures.length ? 1 : 0);
