export class RegistrationCapacityError extends Error {
  public constructor() {
    super("The beta has reached its account limit.");
    this.name = "RegistrationCapacityError";
  }
}
