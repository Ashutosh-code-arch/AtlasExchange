export interface ReadinessDependency {
  checkReadiness(): Promise<boolean>;
}

export class LifecycleState {
  readonly #dependency: ReadinessDependency;
  #startupComplete = false;
  #shutdownStarted = false;

  public constructor(dependency: ReadinessDependency) {
    this.#dependency = dependency;
  }

  public markStartupComplete(): void {
    this.#startupComplete = true;
  }

  public beginShutdown(): void {
    this.#shutdownStarted = true;
  }

  public async isReady(): Promise<boolean> {
    if (!this.#startupComplete || this.#shutdownStarted) {
      return false;
    }

    return this.#dependency.checkReadiness();
  }
}
