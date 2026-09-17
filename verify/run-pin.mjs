// Runs the real Pin component in jsdom against a fake maps library whose
// availability can be switched at will.
//
// That switch is the point. The bug only appears in the window where
// useMapsLibrary has not yet resolved, which on a real load is a frame or two
// and impossible to hit reliably by hand. Here it is a function call.
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const stub = {
  name: "stub",
  setup(b) {
    b.onResolve({ filter: /@vis\.gl\/react-google-maps/ }, (a) => ({
      path: a.path,
      namespace: "vis",
    }));
    b.onLoad({ filter: /.*/, namespace: "vis" }, () => ({
      contents: `
        // Imported, not injected: esbuild then resolves it to the SAME React
        // instance the component tree uses. A separate copy gives "Invalid
        // hook call", because the two disagree about whose dispatcher is live.
        import { useState, useEffect } from "react";

        // A minimal stand-in for google.maps.marker.AdvancedMarkerElement.
        // Only what Pin actually touches: map, position, content, title,
        // gmpClickable, zIndex, and addListener.
        class FakeMarker {
          constructor(opts) {
            this.map = opts.map;
            this.position = opts.position;
            this.content = opts.content;
            this.title = opts.title;
            this._listeners = {};
            state.markers.push(this);
          }
          addListener(event, fn) {
            (this._listeners[event] ||= []).push(fn);
            return { remove: () => {
              this._listeners[event] = (this._listeners[event] || [])
                .filter((f) => f !== fn);
            } };
          }
          fire(event) {
            for (const fn of this._listeners[event] || []) fn();
          }
        }

        const lib = { AdvancedMarkerElement: FakeMarker };
        const fakeMap = { __isMap: true, getDiv: () => document.body, getZoom: () => 14,
                          addListener: () => ({ remove() {} }) };

        const state = { markers: [], library: lib, subs: new Set() };

        export function useMap() { return fakeMap; }

        // Mirrors the real hook's contract: null until the library resolves,
        // then the namespace. Backed by a subscription so the test can flip it
        // mid-life and every mounted component re-renders, which is exactly
        // what happens for real.
        export function useMapsLibrary() {
          const [v, setV] = useState(state.library);
          useEffect(() => {
            const fn = () => setV(state.library);
            state.subs.add(fn);
            return () => state.subs.delete(fn);
          }, []);
          return v;
        }

        globalThis.__mapsFake = {
          lib,
          get markers() { return state.markers; },
          // StrictMode mounts, unmounts and remounts, so the FIRST marker a
          // component makes is a discarded one whose refs were nulled by the
          // cleanup. The live marker is always the most recent.
          live() { return state.markers[state.markers.length - 1]; },
          setLibrary(l) { state.library = l; for (const fn of state.subs) fn(); },
          reset() { state.markers.length = 0; },
        };
      `,
      loader: "js",
      resolveDir: process.cwd(),
    }));

    b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: "empty" }));
    b.onLoad({ filter: /.*/, namespace: "empty" }, () => ({ contents: "", loader: "js" }));
  },
};

await build({
  entryPoints: ["verify/pin.test.jsx"],
  bundle: true,
  outfile: "verify/.pin.mjs",
  platform: "node",
  format: "esm",
  jsx: "automatic",
  plugins: [stub],
  logLevel: "warning",
});

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://crm.example.com/",
});
global.window = dom.window;
global.document = dom.window.document;
Object.defineProperty(global, "navigator", { value: dom.window.navigator, configurable: true });
global.HTMLElement = dom.window.HTMLElement;
global.Element = dom.window.Element;
global.Node = dom.window.Node;
global.MouseEvent = dom.window.MouseEvent;
global.IS_REACT_ACT_ENVIRONMENT = true;

const realError = console.error;
console.error = (...a) => {
  if (typeof a[0] === "string" && a[0].includes("not wrapped in act")) return;
  realError(...a);
};

await import("./.pin.mjs");
