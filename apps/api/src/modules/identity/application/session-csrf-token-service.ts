export interface SessionCsrfTokenService {
  issue(sessionId: string): string;
  verify(sessionId: string, token: string): boolean;
}
