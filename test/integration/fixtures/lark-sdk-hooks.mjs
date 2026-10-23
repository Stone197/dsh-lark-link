// Node module customization hook: resolve @larksuiteoapi/node-sdk to the
// in-process fake so the "real apply()" harness never touches the network.
//
// Registered from test/integration/apply-harness.ts via module.register()
// BEFORE src/index.ts is dynamically imported (ESM imports are hoisted, so the
// harness must not statically import the plugin entry).

const FAKE_URL = new URL("./fake-lark-sdk.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@larksuiteoapi/node-sdk") {
    return { url: FAKE_URL, shortCircuit: true, format: "module" };
  }
  return nextResolve(specifier, context);
}
