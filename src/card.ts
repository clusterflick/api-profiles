import encodeJpeg, { init as initJpeg } from "@jsquash/jpeg/encode.js";
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import satori, { init as initSatori } from "satori/standalone";

/**
 * The image a link to a profile previews with: the reader's favourite films'
 * posters and their handle, on the site's colours. Posters and handle only:
 * a display name is the reader's own words, drawn under our name, and could
 * need a font for any script, where a handle is `[a-z0-9_-]`.
 */
export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;

/** Up to four, as favourites are. */
export const CARD_MAX_POSTERS = 4;

export type CardInput = {
  handle: string;
  /** Each poster as a data URL, in the reader's order: 1 to 4 of them. */
  posters: string[];
};

/**
 * What rendering needs that isn't code: the three WebAssembly modules, which a
 * Worker can only import precompiled (it can't compile WebAssembly from bytes
 * at run time), and the font. Passed in, so Node can render the same card for
 * the bench.
 */
export type CardAssets = {
  /**
   * `satori/yoga.wasm`: Satori's layout engine. Satori is pinned at 0.32.0:
   * from 0.33.0 its standalone build compiles WebAssembly as it's imported,
   * which a Worker refuses ("Wasm code generation disallowed by embedder").
   * Check that before moving it on (`@cf-wasm/satori` pins 0.32.0 too).
   */
  layout: WebAssembly.Module | BufferSource;
  /** `@resvg/resvg-wasm/index_bg.wasm`: the rasteriser. */
  resvg: WebAssembly.Module | BufferSource;
  /**
   * `@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm`: the JPEG encoder, which
   * takes only a compiled module.
   */
  jpeg: WebAssembly.Module;
  /** Montserrat Bold, as the site's headings: WOFF, which Satori reads. */
  font: ArrayBuffer;
};

/** The brand guide's colours (clusterflick/branding). */
const NAVY = "#010013";
const PINK = "#f12869";
const BLUE = "#319edb";
const YELLOW = "#fade05";
const WHITE = "#ffffff";

/** The site's icon, public/images/icon.svg in clusterflick.com. */
const ICON_SVG = `<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg"><circle cx="100" cy="100" r="95" fill="${PINK}"/><circle cx="100" cy="100" r="84" fill="${NAVY}"/><circle cx="100" cy="100" r="72" fill="${BLUE}"/><circle cx="100" cy="100" r="60" fill="${NAVY}"/><g transform="translate(65 34) rotate(18) scale(0.66)"><path d="M 98.00 137.91 C95.53,137.43 90.53,135.57 86.91,133.77 L 80.31 130.50 L 74.91 133.22 C67.50,136.95 60.16,138.30 50.05,137.80 C38.68,137.24 30.03,133.23 21.49,124.58 C6.49,109.40 2.84,88.91 11.96,71.08 C14.97,65.19 23.37,56.95 29.25,54.11 C33.42,52.10 34.00,51.43 34.02,48.66 C34.17,30.36 51.02,10.46 70.11,6.06 C82.27,3.26 97.04,5.68 107.17,12.13 C119.22,19.81 128.00,35.01 128.00,48.19 C128.00,51.62 128.38,52.15 132.25,54.10 C142.56,59.29 149.57,67.63 153.02,78.81 C158.05,95.08 153.30,112.63 140.57,124.86 C128.69,136.27 113.53,140.91 98.00,137.91 ZM 116.13 115.47 C125.59,112.25 132.69,103.41 133.70,93.59 C134.19,88.91 133.86,87.23 131.54,82.49 C128.43,76.14 124.10,72.76 116.74,70.94 C113.63,70.17 111.11,68.73 109.49,66.80 C106.72,63.52 106.79,63.86 106.61,52.00 C106.45,42.08 104.38,37.11 98.28,32.07 C94.26,28.74 86.67,26.00 81.50,26.00 C76.09,26.00 68.57,28.82 64.35,32.43 C58.27,37.64 55.85,44.12 56.13,54.45 C56.46,66.16 54.91,68.31 44.19,71.02 C39.53,72.20 32.74,77.66 30.46,82.07 C26.32,90.08 28.23,100.72 35.10,107.87 C40.47,113.45 45.99,115.95 53.00,115.97 C60.70,116.00 65.06,114.56 71.16,109.97 C78.72,104.29 82.76,104.53 91.00,111.13 C98.02,116.75 107.54,118.40 116.13,115.47 Z" fill="${YELLOW}"/></g></svg>`;
const ICON_URL = `data:image/svg+xml;base64,${btoa(ICON_SVG)}`;

/** A poster's shape: TMDB's are 2:3. */
const POSTER_RATIO = 3 / 2;

type Style = Record<string, string | number>;
type Element = {
  type: string;
  props: { style?: Style; children?: unknown; [key: string]: unknown };
};

const h = (
  type: string,
  style: Style,
  children?: unknown,
  props: Record<string, unknown> = {},
): Element => ({ type, props: { style, children, ...props } });

const glow = (colour: string) => `0 0 24px ${colour}99`;

/**
 * The handle's size: as large as fits `width` on one line, down to `min`,
 * below which it wraps instead. Montserrat Bold averages about 0.56em a
 * character across `[a-z0-9_-]`, as measured from a rendered handle; an
 * estimate that's out only moves where it wraps. Shrinking the longest handle
 * (31 characters with its "@") onto one line took it to 24px, smaller than the
 * address under it and unreadable in a preview drawn at 40%.
 */
function handleSize(handle: string, width: number, max: number, min = 36) {
  const fits = Math.floor(width / ((handle.length + 1) * 0.56));
  return Math.max(min, Math.min(max, fits));
}

/**
 * The handle, ready to wrap: a zero-width space after each `-` and `_` lets a
 * long one break there, and `wordBreak: "break-word"` breaks one with
 * neither wherever it has to.
 */
const wrappable = (handle: string) => `@${handle.replace(/[-_]/g, "$&\u200b")}`;

function brand(size: number) {
  return h("div", { display: "flex", alignItems: "center", gap: size * 0.3 }, [
    h("img", {}, undefined, { src: ICON_URL, width: size, height: size }),
    h(
      "div",
      {
        fontSize: size * 0.7,
        color: PINK,
        textShadow: glow(PINK),
      },
      "Clusterflick",
    ),
  ]);
}

/**
 * A thin light edge rather than a drop shadow, which lifts a poster off the
 * navy as well: resvg's blur took 2.2s of a 2.4s render, the edge nothing.
 */
function poster(src: string, width: number, style: Style = {}) {
  return h(
    "img",
    {
      borderRadius: 12,
      border: "2px solid rgba(255, 255, 255, 0.18)",
      ...style,
    },
    undefined,
    { src, width, height: Math.round(width * POSTER_RATIO) },
  );
}

/** Tilts for 1 to 4 posters, outermost first, in degrees. */
const FAN_ANGLES = [[-3], [-6, 6], [-9, 0, 9], [-11, -4, 4, 11]];

/** The handle and "favourite films" on the left, the posters fanned right. */
function layout({ handle, posters }: CardInput): Element {
  const textWidth = 470;
  const area = { left: 590, width: 560 };
  const posterWidth = posters.length === 1 ? 290 : 250;
  const posterHeight = Math.round(posterWidth * POSTER_RATIO);
  const angles = FAN_ANGLES[posters.length - 1];
  const step =
    posters.length === 1
      ? 0
      : Math.min(190, (area.width - posterWidth) / (posters.length - 1));
  const spread = step * (posters.length - 1) + posterWidth;
  const first = area.left + (area.width - spread) / 2;
  return h(
    "div",
    {
      display: "flex",
      width: CARD_WIDTH,
      height: CARD_HEIGHT,
      position: "relative",
      backgroundColor: NAVY,
      backgroundImage: `radial-gradient(circle at 72% 50%, #1c1450 0%, ${NAVY} 65%)`,
      fontFamily: "Montserrat",
    },
    [
      h(
        "div",
        {
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          position: "absolute",
          left: 72,
          top: 0,
          width: textWidth,
          height: CARD_HEIGHT,
        },
        [
          brand(60),
          h(
            "div",
            {
              marginTop: 56,
              fontSize: handleSize(handle, textWidth, 64),
              lineHeight: 1.15,
              color: WHITE,
              wordBreak: "break-word",
            },
            wrappable(handle),
          ),
          h(
            "div",
            {
              marginTop: 8,
              fontSize: 52,
              color: YELLOW,
              textShadow: glow(YELLOW),
            },
            "Favourite films",
          ),
          h(
            "div",
            { marginTop: 48, fontSize: 28, color: BLUE },
            "clusterflick.com",
          ),
        ],
      ),
      ...posters.map((src, index) => {
        const angle = angles[index];
        return poster(src, posterWidth, {
          position: "absolute",
          left: Math.round(first + step * index),
          // The outer posters a little lower, as a fan held in a hand.
          top: Math.round(
            (CARD_HEIGHT - posterHeight) / 2 + Math.abs(angle) * 2.5,
          ),
          transform: `rotate(${angle}deg)`,
        });
      }),
    ],
  );
}

/** The card as SVG, ready for resvg to rasterise. */
export async function renderCardSvg(
  input: CardInput,
  font: ArrayBuffer,
): Promise<string> {
  if (input.posters.length < 1 || input.posters.length > CARD_MAX_POSTERS) {
    throw new Error(`A card needs 1 to ${CARD_MAX_POSTERS} posters`);
  }
  return satori(layout(input) as Parameters<typeof satori>[0], {
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
    fonts: [{ name: "Montserrat", data: font, weight: 700, style: "normal" }],
  });
}

/**
 * Set up on the first render, never at start-up: a Worker has a second to
 * start, and the isolate keeps them for every render after.
 */
let ready: Promise<void> | undefined;

/**
 * jSquash's own types leave out the module its `init` takes (its code reads
 * it), and want a DOM `ImageData`, which is only ever read for these three.
 */
const initMozjpeg = initJpeg as (module: WebAssembly.Module) => Promise<void>;
type Pixels = { data: Uint8ClampedArray; width: number; height: number };
const encode = encodeJpeg as unknown as (
  image: Pixels,
  options: Record<string, unknown>,
) => Promise<ArrayBuffer>;

/**
 * Baseline at quality 85, measured on cards drawn from real posters: about
 * 95KB for four posters, against 670KB as a PNG. At 75 the pink wordmark's
 * edges soften and its glow bands; progressive saves 5% for twice the
 * encoding time, and only helps someone watching it load, which a site
 * fetching a preview isn't.
 */
const JPEG_OPTIONS = { quality: 85, baseline: true, progressive: false };

function prepare(assets: CardAssets) {
  ready ??= Promise.all([
    initSatori(assets.layout),
    initWasm(assets.resvg),
    initMozjpeg(assets.jpeg),
  ])
    .then(() => undefined)
    .catch((e) => {
      ready = undefined;
      throw e;
    });
  return ready;
}

/**
 * The card as a JPEG: it's posters, which a JPEG holds in a seventh of the
 * bytes of a PNG. resvg draws the pixels and mozjpeg encodes them, so it's
 * never encoded as a PNG on the way.
 */
export async function renderCard(
  input: CardInput,
  assets: CardAssets,
): Promise<Uint8Array> {
  await prepare(assets);
  const svg = await renderCardSvg(input, assets.font);
  // Both hold WebAssembly memory that lives as long as the isolate unless freed.
  const resvg = new Resvg(svg, { fitTo: { mode: "original" } });
  let pixels: Pixels;
  try {
    const image = resvg.render();
    try {
      const { buffer, byteOffset, byteLength } = image.pixels;
      pixels = {
        data: new Uint8ClampedArray(buffer, byteOffset, byteLength),
        width: image.width,
        height: image.height,
      };
    } finally {
      image.free();
    }
  } finally {
    resvg.free();
  }
  return new Uint8Array(await encode(pixels, JPEG_OPTIONS));
}
