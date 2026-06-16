/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Optional tldraw commercial/trial license key. When set, the
   * "made with tldraw" watermark is removed from the canvas and exports.
   * Leave unset for the free, watermarked build.
   */
  readonly VITE_TLDRAW_LICENSE_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
