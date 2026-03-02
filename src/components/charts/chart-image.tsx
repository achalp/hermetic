"use client";

interface ChartImageProps {
  src: string;
  alt: string;
  caption?: string | null;
  width?: number | null;
}

export function ChartImageComponent({ props }: { props: ChartImageProps }) {
  return (
    <figure className="w-full">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={props.src}
        alt={props.alt}
        className="rounded-lg border border-border-default"
        style={{ maxWidth: props.width ? `${props.width}px` : "100%" }}
      />
      {props.caption && (
        <figcaption className="mt-2 text-center text-sm text-t-secondary">
          {props.caption}
        </figcaption>
      )}
    </figure>
  );
}
