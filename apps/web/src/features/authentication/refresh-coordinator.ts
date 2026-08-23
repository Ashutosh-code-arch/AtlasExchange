const refreshLockName = "atlas-auth-refresh";
const refreshChannelName = "atlas-auth-refresh";
const refreshCompletionType = "atlas-auth-refresh-completed";

interface RefreshCompletionMessage {
  readonly type: typeof refreshCompletionType;
  readonly successful: boolean;
}

export interface RefreshChannel {
  postMessage(message: RefreshCompletionMessage): void;
  addEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  close(): void;
}

export interface RefreshLockManager {
  request<Result>(
    name: string,
    options: { readonly mode: "exclusive" },
    callback: () => Promise<Result>,
  ): Promise<Result>;
}

export interface RefreshCoordinatorOptions {
  readonly performRefresh: () => Promise<boolean>;
  readonly onAuthenticationLost: () => void;
  readonly lockManager?: RefreshLockManager | null;
  readonly channel?: RefreshChannel | null;
}

function getBrowserLockManager(): RefreshLockManager | undefined {
  return (globalThis as unknown as { navigator?: { locks?: RefreshLockManager } }).navigator?.locks;
}

function createBrowserChannel(): RefreshChannel | undefined {
  const Channel = (globalThis as unknown as { BroadcastChannel?: typeof BroadcastChannel })
    .BroadcastChannel;
  return Channel === undefined ? undefined : new Channel(refreshChannelName);
}

function isRefreshCompletionMessage(value: unknown): value is RefreshCompletionMessage {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<RefreshCompletionMessage>;
  return candidate.type === refreshCompletionType && typeof candidate.successful === "boolean";
}

export class RefreshCoordinator {
  private readonly lockManager: RefreshLockManager | undefined;
  private readonly channel: RefreshChannel | undefined;
  private completionSequence = 0;
  private lastObservedResult: boolean | undefined;
  private inFlight: Promise<boolean> | undefined;

  private readonly handleMessage = (event: MessageEvent<unknown>): void => {
    if (!isRefreshCompletionMessage(event.data)) {
      return;
    }
    this.completionSequence += 1;
    this.lastObservedResult = event.data.successful;
    if (!event.data.successful) {
      this.options.onAuthenticationLost();
    }
  };

  public constructor(private readonly options: RefreshCoordinatorOptions) {
    this.lockManager =
      options.lockManager === undefined
        ? getBrowserLockManager()
        : (options.lockManager ?? undefined);
    this.channel =
      options.channel === undefined ? createBrowserChannel() : (options.channel ?? undefined);
    this.channel?.addEventListener("message", this.handleMessage);
  }

  public captureCompletionSequence(): number {
    return this.completionSequence;
  }

  public recover(sequenceBeforeRequest = this.completionSequence): Promise<boolean> {
    if (this.inFlight !== undefined) {
      return this.inFlight;
    }

    if (
      this.completionSequence !== sequenceBeforeRequest &&
      this.lastObservedResult !== undefined
    ) {
      return Promise.resolve(this.lastObservedResult);
    }

    const recovery = this.coordinateRefresh(sequenceBeforeRequest);
    this.inFlight = recovery;
    const clearInFlight = (): void => {
      if (this.inFlight === recovery) {
        this.inFlight = undefined;
      }
    };
    void recovery.then(clearInFlight, clearInFlight);
    return recovery;
  }

  public dispose(): void {
    this.channel?.removeEventListener("message", this.handleMessage);
    this.channel?.close();
  }

  private async coordinateRefresh(sequenceBeforeRequest: number): Promise<boolean> {
    if (this.lockManager === undefined) {
      return this.performAndPublish();
    }

    return this.lockManager.request(refreshLockName, { mode: "exclusive" }, async () => {
      if (
        this.completionSequence !== sequenceBeforeRequest &&
        this.lastObservedResult !== undefined
      ) {
        return this.lastObservedResult;
      }
      return this.performAndPublish();
    });
  }

  private async performAndPublish(): Promise<boolean> {
    const successful = await this.options.performRefresh();
    this.completionSequence += 1;
    this.lastObservedResult = successful;
    if (!successful) {
      this.options.onAuthenticationLost();
    }
    this.channel?.postMessage({ type: refreshCompletionType, successful });
    return successful;
  }
}
