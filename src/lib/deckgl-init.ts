/**
 * Force deck.gl v9 / luma.gl to use WebGL2 instead of WebGPU.
 * This module must be imported BEFORE any @deck.gl/* imports.
 */
import { luma } from "@luma.gl/core";
import { webgl2Adapter } from "@luma.gl/webgl";

luma.registerAdapters([webgl2Adapter]);
