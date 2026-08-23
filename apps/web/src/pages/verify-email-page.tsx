import { EmailVerification } from "../features/authentication";

export interface VerifyEmailPageProps {
  readonly token: string | undefined;
}

export function VerifyEmailPage({ token }: VerifyEmailPageProps): React.JSX.Element {
  return (
    <main className="identity-route">
      <EmailVerification token={token} />
    </main>
  );
}
