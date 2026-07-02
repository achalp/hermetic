"use client";

interface DefinitionItem {
  term: string;
  definition: string;
}

interface DefinitionListProps {
  title?: string | null;
  items: DefinitionItem[];
}

/**
 * A clean key-value / definition block for a report's metadata header (Source,
 * Window, Scope) and its glossary (Term → meaning). Deliberately NOT a DataTable
 * — those carry search/sort/export/pagination chrome that looks amateurish on a
 * static 3-row header. Renders as a proper two-column definition layout: term in
 * the left column (semibold, muted), definition flowing on the right.
 */
export function DefinitionListComponent({ props }: { props: DefinitionListProps }) {
  const items = Array.isArray(props.items) ? props.items : [];
  return (
    <div className="w-full space-y-2">
      {props.title && (
        <h3
          className="text-t-secondary"
          style={{ fontSize: "var(--chart-title-size)", fontWeight: "var(--chart-title-weight)" }}
        >
          {props.title}
        </h3>
      )}
      <dl className="grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-6 gap-y-2 text-sm">
        {items.map((it, i) => (
          <div key={i} className="contents">
            <dt className="font-semibold text-t-primary">{it.term}</dt>
            <dd className="text-t-secondary">{it.definition}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
