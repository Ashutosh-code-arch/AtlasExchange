import { z } from "zod";

import type {
  AuthenticatedContext,
  IdentityAdministrationStore,
  IdentityAdministrationUser,
} from "../../identity/index.js";
import { requireAdministrationAuthorization } from "./administration-authorization.js";

export type GetAdministrationUserResult =
  | { readonly status: "found"; readonly user: IdentityAdministrationUser }
  | { readonly status: "not_found" };

export class GetAdministrationUser {
  public constructor(private readonly users: Pick<IdentityAdministrationStore, "findUser">) {}

  public async execute(input: {
    readonly context: AuthenticatedContext;
    readonly userId: string;
  }): Promise<GetAdministrationUserResult> {
    requireAdministrationAuthorization(input.context, "administration.users.read");
    const userId = z.uuid().parse(input.userId);
    const user = await this.users.findUser(userId);
    return user === undefined ? { status: "not_found" } : { status: "found", user };
  }
}
