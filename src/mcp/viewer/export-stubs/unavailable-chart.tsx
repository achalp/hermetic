/**
 * Stand-ins compiled into the STANDARD export bundle in place of the heavy
 * chart families (plotly gl3d/finance/polar, deck.gl/maplibre geo, globe) —
 * the assembler picks the FULL bundle whenever a spec actually uses one of
 * these types, so a recipient only ever sees this tile if a file was built
 * standard and later hand-edited to add a heavy chart.
 *
 * The export names mirror the real modules exactly (esbuild aliases whole
 * modules, so every export the registry binds must exist here).
 */
import React from "react";

function Unavailable({ family }: { family: string }) {
  return (
    <div
      className="flex min-h-[120px] items-center justify-center border border-border-default bg-surface-2 p-4 text-center text-xs text-t-tertiary"
      style={{ borderRadius: "var(--radius-card)" }}
    >
      This {family} chart isn&apos;t included in this export bundle — re-export from hermetic to
      embed it.
    </div>
  );
}

/* eslint-disable @typescript-eslint/no-unused-vars, @typescript-eslint/no-explicit-any */
function stub(family: string) {
  function UnavailableStub(_props: any) {
    return <Unavailable family={family} />;
  }
  UnavailableStub.displayName = `Unavailable(${family})`;
  return UnavailableStub;
}

// plotly-3d-wrapper
export const Plotly3DChart = stub("3D");
// plotly-finance-wrapper
export const PlotlyFinanceChart = stub("finance");
// plotly-polar-wrapper
export const PlotlyPolarChart = stub("polar");
// map-view
export const MapViewComponent = stub("map");
// map3d-view
export const Map3DComponent = stub("3D map");
// globe-view
export const Globe3DComponent = stub("globe");
