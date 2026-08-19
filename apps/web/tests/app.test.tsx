import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { App } from "../src/app";

describe("Atlas overview", () => {
  it("shows the current delivery phase", async () => {
    render(
      <App
        apiBaseUrl="http://api.test"
        readinessClient={() => Promise.resolve({ status: "ready" })}
      />,
    );

    expect(screen.getByRole("heading", { name: /build trust/i })).toBeInTheDocument();
    expect(screen.getByText("Foundation")).toBeInTheDocument();
    expect(await screen.findByText("Operational")).toBeInTheDocument();
  });

  it("shows a safe offline state when readiness cannot be loaded", async () => {
    render(
      <App
        apiBaseUrl="http://api.test"
        readinessClient={() => Promise.reject(new Error("network failure"))}
      />,
    );

    expect(await screen.findByText("Offline")).toBeInTheDocument();
    expect(screen.getByText(/cannot be reached/i)).toBeInTheDocument();
  });

  it("allows the operator to refresh readiness", async () => {
    const readinessClient = vi
      .fn()
      .mockResolvedValueOnce({ status: "not_ready" as const })
      .mockResolvedValueOnce({ status: "ready" as const });
    const user = userEvent.setup();
    render(<App apiBaseUrl="http://api.test" readinessClient={readinessClient} />);

    expect(await screen.findByText("Starting")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /refresh status/i }));

    await waitFor(() => expect(readinessClient).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Operational")).toBeInTheDocument();
  });
});
