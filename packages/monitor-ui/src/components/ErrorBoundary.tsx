// Hermes Handoff Monitor — top-level error boundary (M11', §16).
//
// A render crash must never leave the operator staring at a blank screen
// with no idea what happened. This catches it and shows what broke + how
// to recover, in the same "untrusted" visual language as a degraded
// stream. Error boundaries must be class components.

import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Optional override for the reload action (tests). */
  onReload?: () => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    if (typeof console !== "undefined") {
      console.error("Hermes monitor crashed:", error, info.componentStack);
    }
  }

  private handleReload = (): void => {
    if (this.props.onReload) {
      this.props.onReload();
    } else if (typeof window !== "undefined") {
      window.location.reload();
    }
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="hm-board">
        <div className="hm-degraded-banner" role="alert">
          <span className="pill">CRASHED</span>
          <span className="reasons">
            The monitor hit an unexpected error: <code>{error.message || "unknown"}</code>. Live data is unaffected —
            reload to recover.
          </span>
          <span className="right">
            <button type="button" onClick={this.handleReload}>
              Reload
            </button>
          </span>
        </div>
      </div>
    );
  }
}
