"use client";

import { useState } from "react";
import { Renderer, StateProvider, ActionProvider, VisibilityProvider } from "@json-render/react";
import type { Spec } from "@json-render/react";
import { registry } from "@/components/registry";
import dataControllerSpec from "../../../test-specs/data-controller-test.json";
import formControllerSpec from "../../../test-specs/form-controller-test.json";

const specs: Record<string, Spec> = {
  "data-controller": dataControllerSpec as unknown as Spec,
  "form-controller": formControllerSpec as unknown as Spec,
};

export default function TestSpecPage() {
  const [active, setActive] = useState<string>("data-controller");
  const spec = specs[active];

  return (
    <div className="mx-auto max-w-4xl p-8">
      <h1 className="mb-4 text-2xl font-bold text-gray-900 dark:text-gray-100">Spec Test Page</h1>
      <div className="mb-6 flex gap-3">
        {Object.keys(specs).map((key) => (
          <button
            key={key}
            onClick={() => setActive(key)}
            className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
              active === key
                ? "bg-indigo-600 text-white"
                : "bg-gray-200 text-gray-700 hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-300"
            }`}
          >
            {key}
          </button>
        ))}
      </div>
      <div className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-900">
        <StateProvider initialState={spec.state ?? {}}>
          <ActionProvider>
            <VisibilityProvider>
              <Renderer spec={spec} registry={registry} />
            </VisibilityProvider>
          </ActionProvider>
        </StateProvider>
      </div>
    </div>
  );
}
