import font from "@fontsource/montserrat/files/montserrat-latin-700-normal.woff";
import jpeg from "@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm";
import resvg from "@resvg/resvg-wasm/index_bg.wasm";
import layout from "satori/yoga.wasm";
import type { CardAssets } from "./card";

/**
 * The card's assets as the Worker bundles them: the WebAssembly precompiled
 * at deploy (`CompiledWasm`, wrangler's default for `.wasm`), and the font as
 * bytes (the `Data` rule in wrangler.jsonc). Apart from `card.ts` so that file
 * runs in Node too. Montserrat is under the SIL Open Font Licence, in
 * node_modules/@fontsource/montserrat/LICENSE.
 * mozjpeg, through jSquash, is under the Apache Licence 2.0 and its own
 * BSD-style licence.
 */
export const CARD_ASSETS: CardAssets = { layout, resvg, jpeg, font };
