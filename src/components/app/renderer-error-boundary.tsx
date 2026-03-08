"use client";

import { Component, type ReactNode, type ErrorInfo } from "react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class RendererErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Renderer error:", error, errorInfo);
  }

  reset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div
          className="border border-error-border bg-error-bg p-6"
          style={{ borderRadius: "var(--radius-card)" }}
        >
          <p className="font-medium text-error-text">Visualization render error</p>
          <p className="mt-1 text-sm text-error-text opacity-85">
            {this.state.error?.message ?? "An unexpected error occurred while rendering."}
          </p>
          <button
            onClick={this.reset}
            className="mt-3 text-sm font-medium text-error-text underline hover:no-underline"
          >
            Try again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
