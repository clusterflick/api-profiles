/** WebAssembly, which wrangler bundles precompiled. */
declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}

/** A font, which wrangler bundles as bytes (the `Data` rule). */
declare module "*.woff" {
  const data: ArrayBuffer;
  export default data;
}
