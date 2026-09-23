// The CRM's AddressPicker: how often does it actually call Google?
//
//   node verify/address-picker.mjs
//
// Renders the real component in jsdom with @vis.gl/react-google-maps and the
// stylesheet stubbed at bundle time, so nothing here touches the network.
//
// This tests a COST property, which is unusual and is the whole reason it
// exists. Calling Google on every keystroke breaks nothing — the suggestions
// are correct, the form works, the lead saves. The only symptom is the bill,
// and a bill is not something a test suite normally notices. So the thing
// being asserted is the number of requests, not the behaviour they produce.
//
// The assertions marked THE POINT are the ones that would have caught the
// original.

import { build } from "esbuild";
import { join } from "node:path";
import { JSDOM } from "jsdom";

// --- bundle the real component, stubbing what it imports --------------------

const stubs = {
  name: "stubs",
  setup(b) {
    // The maps wrapper: useMapsLibrary("places") hands back whatever the test
    // has put on globalThis.__places.
    b.onResolve({ filter: /^@vis\.gl\/react-google-maps$/ }, (a) => ({
      path: a.path,
      namespace: "vis",
    }));
    b.onLoad({ filter: /.*/, namespace: "vis" }, () => ({
      contents: "export function useMapsLibrary() { return globalThis.__places ?? null; }",
      loader: "js",
    }));

    b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: "css" }));
    b.onLoad({ filter: /.*/, namespace: "css" }, () => ({ contents: "", loader: "js" }));
  },
};

// Written inside verify/ rather than a temp directory: the bundle imports
// react, and Node resolves that from the nearest node_modules — which a
// /tmp path does not have. Same reason verify/sms-js.mjs keeps its bundle
// here. Dot-prefixed so it reads as build output.
const out = "verify/.address-picker-bundle.mjs";

await build({
  entryPoints: [join(process.cwd(), "src/components/AddressPicker.jsx")],
  bundle: true,
  format: "esm",
  platform: "node",
  jsx: "automatic",
  outfile: out,
  external: ["react", "react-dom", "react/jsx-runtime"],
  plugins: [stubs],
  logLevel: "warning",
});

// --- a DOM ------------------------------------------------------------------

const dom = new JSDOM("<!doctype html><div id='root'></div>", { pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Event = dom.window.Event;
// Node 22 defines globalThis.navigator as a getter-only property, so it
// cannot be assigned the way the others can. React only needs it to exist.
Object.defineProperty(globalThis, "navigator", {
  value: dom.window.navigator,
  configurable: true,
});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import("react")).default;
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const AddressPicker = (await import("./.address-picker-bundle.mjs")).default;

let bad = 0;
const chk = (what, pass, detail = "") => {
  if (pass) console.log(`ok    ${what}`);
  else {
    bad++;
    console.log(`FAIL  ${what}${detail ? `\n        ${detail}` : ""}`);
  }
};

const sleep = (ms) => new Promise((r) => dom.window.setTimeout(r, ms));

// --- the fake Places library ------------------------------------------------

function installPlaces({ delayFor = () => 0 } = {}) {
  const calls = [];
  let tokens = 0;

  globalThis.__places = {
    AutocompleteSessionToken: function () {
      this.id = ++tokens;
    },
    AutocompleteSuggestion: {
      async fetchAutocompleteSuggestions(req) {
        calls.push(req);
        const wait = delayFor(req.input);
        if (wait) await sleep(wait);
        // Three of them, so the keyboard has somewhere to go and wrapping
        // round the ends is observable.
        return {
          suggestions: ["Corvallis", "Albany", "Philomath"].map((town) => ({
            placePrediction: {
              text: { text: `${req.input} — ${town}, OR` },
              toPlace: () => ({
                formattedAddress: `${req.input}, ${town}, OR 97330`,
                location: { lat: () => 44.59, lng: () => -123.24 },
                async fetchFields() {},
              }),
            },
          })),
        };
      },
    },
  };
  return calls;
}

async function mount(extraProps = {}) {
  // A fresh container per mount. Reusing one and calling createRoot on it
  // again warns, and leaves the previous root attached to the same node.
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const state = { address: null, text: "" };
  const root = createRoot(host);
  await act(async () => {
    root.render(
      React.createElement(AddressPicker, {
        value: "",
        onChange: (v) => (state.address = v),
        onTextChange: (t) => (state.text = t),
        ...extraProps,
      })
    );
  });
  const input = host.querySelector("input");
  return { host, input, state, root };
}

// Types one character at a time, the way a person does.
//
// Continues from whatever is already in the field rather than starting from
// empty — the first version reset to "", so a second burst of typing
// produced " Diane" instead of "1014 NE Diane". Three assertions failed and
// all three were this one helper, which is the usual ratio.
async function typeInto(input, text, perKey = 30) {
  let soFar = input.value;
  for (const ch of text) {
    soFar += ch;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        dom.window.HTMLInputElement.prototype,
        "value"
      ).set;
      setter.call(input, soFar);
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await act(async () => {
      await sleep(perKey);
    });
  }
}

// ---------------------------------------------------------------------------
console.log("\n-- how many times Google gets asked --\n");

{
  const calls = installPlaces();
  const { input } = await mount();

  // 16 characters, typed at a realistic pace.
  await typeInto(input, "1014 NE Diane Pl");
  await act(async () => {
    await sleep(400);
  });

  chk("THE POINT: typing a whole address is one request, not one per key",
    calls.length === 1,
    `${calls.length} requests for 16 characters — the old version sent 16`);

  chk("and it asked for the finished text, not a prefix",
    calls[0]?.input === "1014 NE Diane Pl", calls[0]?.input);

  chk("the request is US-only and carries a session token",
    JSON.stringify(calls[0]?.includedRegionCodes) === '["us"]' &&
      Boolean(calls[0]?.sessionToken));
}

{
  const calls = installPlaces();
  const { input } = await mount();

  await typeInto(input, "10");
  await act(async () => {
    await sleep(400);
  });

  chk("THE POINT: two characters asks Google nothing",
    calls.length === 0,
    "one character matches most of the country and is never a useful search");
}

{
  const calls = installPlaces();
  const { input } = await mount();

  // Typed, paused long enough to search, then continued.
  await typeInto(input, "1014 NE");
  await act(async () => {
    await sleep(400);
  });
  await typeInto(input, " Diane");
  await act(async () => {
    await sleep(400);
  });

  chk("a real pause does produce a second search",
    calls.length === 2, `${calls.length}`);
  chk("...and the debounce is not just swallowing everything",
    calls[1]?.input === "1014 NE Diane", calls[1]?.input);
}

// ---------------------------------------------------------------------------
console.log("\n-- a slow reply arriving late --\n");

{
  // The first search is slow, the second is fast — so the answer to the
  // SHORTER query lands last. Without a guard it wins, and the customer sees
  // suggestions for what they typed two seconds ago.
  // 1200ms, not 300. The first attempt used a delay short enough that the
  // slow reply still landed BEFORE the second search was issued — so nothing
  // was ever out of order and the guard was never exercised. Mutation testing
  // caught that: removing the guard changed nothing. The delay has to outlast
  // the typing, the debounce AND the second round trip.
  const calls = installPlaces({
    delayFor: (input) => (input === "1014 NE" ? 1200 : 0),
  });
  const { host, input } = await mount();

  await typeInto(input, "1014 NE");
  await act(async () => {
    await sleep(300);
  });
  await typeInto(input, " Diane Pl");
  await act(async () => {
    await sleep(1400);
  });

  const shown = host.querySelector(".addresspicker__option")?.textContent ?? "";
  chk("THE POINT: the newest search wins, however the replies are ordered",
    shown.startsWith("1014 NE Diane Pl"),
    `showing "${shown}" — a stale reply overwrote the current one`);
  chk("both searches were genuinely made", calls.length === 2, `${calls.length}`);
}

// ---------------------------------------------------------------------------
console.log("\n-- the things that must not have changed --\n");

{
  const calls = installPlaces();
  const { host, input, state } = await mount();

  await typeInto(input, "1014 NE Diane Pl");
  await act(async () => {
    await sleep(400);
  });

  chk("the dropdown appears", host.querySelectorAll(".addresspicker__option").length === 3);
  chk("typing still reports the text to the form as it goes",
    state.text === "1014 NE Diane Pl", state.text);

  await act(async () => {
    host.querySelector(".addresspicker__option").dispatchEvent(
      new dom.window.Event("click", { bubbles: true })
    );
  });
  await act(async () => {
    await sleep(50);
  });

  chk("picking one hands back the address and its coordinates",
    state.address?.address?.includes("Corvallis") &&
      state.address?.latitude === 44.59 &&
      state.address?.longitude === -123.24,
    JSON.stringify(state.address));

  chk("the list closes afterwards",
    host.querySelectorAll(".addresspicker__option").length === 0);

  // Reusing a token across searches is what turns free typing into billed
  // typing — the same class of bug as the debounce, and already handled here.
  await typeInto(input, " 2");
  await act(async () => {
    await sleep(400);
  });
  chk("a search after a selection opens a new session token",
    calls.at(-1)?.sessionToken?.id !== calls[0]?.sessionToken?.id,
    `tokens: ${calls[0]?.sessionToken?.id} then ${calls.at(-1)?.sessionToken?.id}`);
}

{
  // Unmounting with a request pending must not fire it into a dead component.
  const calls = installPlaces();
  const { input, root } = await mount();
  await typeInto(input, "1014 NE Diane");
  await act(async () => {
    root.unmount();
  });
  await act(async () => {
    await sleep(400);
  });
  chk("a pending search is cancelled when the form closes", calls.length === 0);
}


// ---------------------------------------------------------------------------
console.log("\n-- the keyboard --\n");

async function press(input, key) {
  await act(async () => {
    input.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
    );
  });
}

{
  installPlaces();
  const { host, input } = await mount();
  await typeInto(input, "1014 NE");
  await act(async () => {
    await sleep(400);
  });

  chk("the input announces itself as a combobox",
    input.getAttribute("role") === "combobox" &&
      input.getAttribute("aria-expanded") === "true" &&
      host.querySelector(".addresspicker__menu")?.getAttribute("role") === "listbox");

  chk("nothing is highlighted before a key is pressed",
    input.getAttribute("aria-activedescendant") === null,
    "otherwise Enter would pick a row the person never chose");

  await press(input, "ArrowDown");
  const first = input.getAttribute("aria-activedescendant");
  chk("arrowing down highlights a row, and names it for a screen reader",
    Boolean(first) && Boolean(dom.window.document.getElementById(first)));
  chk("the highlighted row is marked as such",
    host.querySelector(".addresspicker__option--active")?.textContent.includes("Corvallis"));

  await press(input, "ArrowDown");
  chk("and again moves on",
    host.querySelector(".addresspicker__option--active")?.textContent.includes("Albany"));

  await press(input, "ArrowUp");
  chk("up goes back",
    host.querySelector(".addresspicker__option--active")?.textContent.includes("Corvallis"));

  await press(input, "ArrowUp");
  chk("and wraps round to the last one rather than sticking",
    host.querySelector(".addresspicker__option--active")?.textContent.includes("Philomath"));

  await press(input, "Escape");
  chk("Escape closes the list",
    host.querySelectorAll(".addresspicker__option").length === 0 &&
      input.getAttribute("aria-expanded") === "false");
}

{
  installPlaces();
  const { host, input, state } = await mount();
  await typeInto(input, "1014 NE");
  await act(async () => {
    await sleep(400);
  });

  await press(input, "ArrowDown");
  await press(input, "ArrowDown");
  await press(input, "Enter");
  await act(async () => {
    await sleep(50);
  });

  chk("THE POINT: Enter picks the highlighted row",
    state.address?.address?.includes("Albany"), JSON.stringify(state.address));
  chk("...with its coordinates, same as clicking",
    state.address?.latitude === 44.59 && state.address?.longitude === -123.24);
  chk("and the list closes",
    host.querySelectorAll(".addresspicker__option").length === 0);
}

{
  // The case that makes Enter tricky: a half-typed address with the list
  // open but nothing highlighted. Enter must reach the form, not be eaten.
  installPlaces();
  const { input } = await mount();
  await typeInto(input, "1014 NE");
  await act(async () => {
    await sleep(400);
  });

  let defaultPrevented = null;
  await act(async () => {
    const ev = new dom.window.KeyboardEvent("keydown", {
      key: "Enter", bubbles: true, cancelable: true,
    });
    input.dispatchEvent(ev);
    defaultPrevented = ev.defaultPrevented;
  });

  chk("THE POINT: Enter with nothing highlighted still submits the form",
    defaultPrevented === false,
    "swallowing it would make the form feel broken for anyone not using the list");
}

{
  // Highlight a row, then keep typing. The new suggestions are a different
  // list; carrying the old index over means the highlight points at an
  // address nobody chose — and if the new list is shorter, at nothing at
  // all, which Enter then tries to select.
  installPlaces();
  const { host, input } = await mount();
  await typeInto(input, "1014 NE");
  await act(async () => {
    await sleep(400);
  });

  await press(input, "ArrowDown");
  await press(input, "ArrowDown");
  chk("a row is highlighted to begin with",
    input.getAttribute("aria-activedescendant") !== null);

  await typeInto(input, " Diane");
  await act(async () => {
    await sleep(400);
  });

  chk("THE POINT: new suggestions clear the highlight",
    input.getAttribute("aria-activedescendant") === null &&
      host.querySelector(".addresspicker__option--active") === null,
    "a carried-over index highlights a row the person never looked at");
}

// ---------------------------------------------------------------------------
console.log("\n-- borrowed styling --\n");

{
  installPlaces();
  const { host } = await mount({ inputClassName: "detail__input" });
  chk("a host page can keep its own field styling",
    Boolean(host.querySelector("input.detail__input")),
    "LeadDetail and the map modal both need their own input class");
}

console.log(bad === 0 ? "\nall ok — AddressPicker holds\n" : `\n${bad} FAILED\n`);
process.exit(bad === 0 ? 0 : 1);
