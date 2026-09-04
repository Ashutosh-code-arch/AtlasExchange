import { useEffect, useRef, useState } from "react";

export type HumanVerificationAction = "register" | "resend_verification" | "forgot_password";

interface TurnstileApi {
  render(
    container: HTMLElement,
    options: Readonly<{
      sitekey: string;
      action: HumanVerificationAction;
      theme: "light";
      size: "flexible";
      callback: (token: string) => void;
      "expired-callback": () => void;
      "error-callback": () => void;
    }>,
  ): string;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let turnstileLoading: Promise<TurnstileApi> | undefined;

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile !== undefined) return Promise.resolve(window.turnstile);
  if (turnstileLoading !== undefined) return turnstileLoading;

  const loading = new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.defer = true;
    script.addEventListener("load", () => {
      if (window.turnstile === undefined) {
        reject(new Error("Turnstile did not initialize."));
        return;
      }
      resolve(window.turnstile);
    });
    script.addEventListener("error", () => reject(new Error("Turnstile could not load.")));
    document.head.append(script);
  });
  turnstileLoading = loading.catch((error: unknown) => {
    turnstileLoading = undefined;
    throw error;
  });
  return turnstileLoading;
}

export interface HumanVerificationWidgetProps {
  readonly action: HumanVerificationAction;
  readonly siteKey: string;
  readonly resetKey: number;
  readonly onTokenChange: (token: string | null) => void;
}

export function HumanVerificationWidget({
  action,
  siteKey,
  resetKey,
  onTokenChange,
}: HumanVerificationWidgetProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const [failedResetKey, setFailedResetKey] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    let widget: { api: TurnstileApi; id: string } | undefined;
    onTokenChange(null);
    void loadTurnstile()
      .then((api) => {
        if (!active || containerRef.current === null) return;
        const id = api.render(containerRef.current, {
          sitekey: siteKey,
          action,
          theme: "light",
          size: "flexible",
          callback: (token) => {
            if (active) onTokenChange(token);
          },
          "expired-callback": () => {
            if (active) onTokenChange(null);
          },
          "error-callback": () => {
            if (active) {
              onTokenChange(null);
              setFailedResetKey(resetKey);
            }
          },
        });
        widget = { api, id };
      })
      .catch(() => {
        if (active) setFailedResetKey(resetKey);
      });

    return () => {
      active = false;
      if (widget !== undefined) widget.api.remove(widget.id);
    };
  }, [action, onTokenChange, resetKey, siteKey]);

  return (
    <div className="human-verification" aria-label="Human verification">
      <div ref={containerRef} />
      {failedResetKey === resetKey ? (
        <p className="login-form__error" role="alert">
          Verification cannot load. Check your connection or content blocker, then try again.
        </p>
      ) : null}
    </div>
  );
}
