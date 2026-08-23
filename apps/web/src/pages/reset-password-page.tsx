import { PasswordReset } from "../features/authentication";

export interface ResetPasswordPageProps {
  readonly token: string | undefined;
}

export function ResetPasswordPage({ token }: ResetPasswordPageProps): React.JSX.Element {
  return (
    <main className="identity-route">
      <PasswordReset token={token} />
    </main>
  );
}
