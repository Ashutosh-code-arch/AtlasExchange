import { useEffect, useRef, useState } from "react";
import {
  operatorEmailTestAvailabilitySchema,
  operatorEmailTestResponseSchema,
} from "@atlas/contracts";

import { ApiHttpError } from "../../../shared/api/http-client";
import { useAuthenticationSession } from "../session/use-authentication-session";

export function OperatorEmailTest(): React.JSX.Element | null {
  const { request, state } = useAuthenticationSession();
  const userId = state.status === "authenticated" ? state.user.id : undefined;
  const [authorizedUserId, setAuthorizedUserId] = useState<string | undefined>();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const busy = useRef(false);
  const mounted = useRef(false);

  useEffect(() => {
    if (userId === undefined) return;
    mounted.current = true;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await request("/api/v1/auth/operator-email-test", {
          signal: controller.signal,
        });
        const result = operatorEmailTestAvailabilitySchema.parse(await response.json());
        if (!controller.signal.aborted)
          setAuthorizedUserId(result.data.enabled ? userId : undefined);
      } catch {
        if (!controller.signal.aborted) setAuthorizedUserId(undefined);
      }
    })();
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, [request, userId]);

  const send = async (): Promise<void> => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setMessage(null);
    try {
      const response = await request("/api/v1/auth/operator-email-test", {
        method: "POST",
        body: {},
        csrf: true,
        recoverAuthentication: false,
      });
      operatorEmailTestResponseSchema.parse(await response.json());
      if (mounted.current)
        setMessage(
          "SMTP accepted the test email. Check your inbox and spam folder to confirm delivery.",
        );
    } catch (error) {
      if (mounted.current) {
        setMessage(
          error instanceof ApiHttpError && error.status === 429
            ? "Test email limit reached. Wait 15 minutes before trying again."
            : "Email acceptance could not be confirmed. Check your inbox and Brevo logs before retrying; do not share credentials or provider error details.",
        );
      }
    } finally {
      busy.current = false;
      if (mounted.current) setPending(false);
    }
  };

  if (userId === undefined || authorizedUserId !== userId) return null;
  return (
    <section className="profile-session-security" aria-labelledby="operator-email-test-title">
      <h3 id="operator-email-test-title">Operator email test</h3>
      <p className="profile-session-security__description">
        Send a test only to your server-confirmed account email. This does not enable signup or
        change your account. Maximum three attempts per 15 minutes.
      </p>
      <button
        className="secondary-button"
        type="button"
        disabled={pending}
        onClick={() => void send()}
      >
        {pending ? "Sending test email…" : "Send test email"}
      </button>
      {message === null ? null : <p role="status">{message}</p>}
    </section>
  );
}
