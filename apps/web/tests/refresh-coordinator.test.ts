import { describe, expect, it, vi } from "vitest";

import {
  RefreshCoordinator,
  type RefreshChannel,
  type RefreshLockManager,
} from "../src/features/authentication/refresh-coordinator";

type RefreshMessage = Parameters<RefreshChannel["postMessage"]>[0];
type RefreshListener = Parameters<RefreshChannel["addEventListener"]>[1];

class ChannelHub {
  private readonly channels = new Set<TestRefreshChannel>();

  public create(): TestRefreshChannel {
    const channel = new TestRefreshChannel(this);
    this.channels.add(channel);
    return channel;
  }

  public publish(sender: TestRefreshChannel, message: RefreshMessage): void {
    for (const channel of this.channels) {
      if (channel !== sender) {
        channel.receive(message);
      }
    }
  }

  public remove(channel: TestRefreshChannel): void {
    this.channels.delete(channel);
  }
}

class TestRefreshChannel implements RefreshChannel {
  private readonly listeners = new Set<RefreshListener>();

  public constructor(private readonly hub: ChannelHub) {}

  public postMessage(message: RefreshMessage): void {
    this.hub.publish(this, message);
  }

  public addEventListener(_type: "message", listener: RefreshListener): void {
    this.listeners.add(listener);
  }

  public removeEventListener(_type: "message", listener: RefreshListener): void {
    this.listeners.delete(listener);
  }

  public close(): void {
    this.hub.remove(this);
  }

  public receive(message: RefreshMessage): void {
    for (const listener of this.listeners) {
      listener(new MessageEvent("message", { data: message }));
    }
  }
}

class SerialRefreshLockManager implements RefreshLockManager {
  private tail: Promise<void> = Promise.resolve();

  public async request<Result>(
    _name: string,
    _options: { readonly mode: "exclusive" },
    callback: () => Promise<Result>,
  ): Promise<Result> {
    const previous = this.tail;
    let release = (): void => undefined;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await callback();
    } finally {
      release();
    }
  }
}

describe("RefreshCoordinator", () => {
  it("deduplicates concurrent refreshes within one tab", async () => {
    let resolveRefresh = (_successful: boolean): void => undefined;
    const refreshResult = new Promise<boolean>((resolve) => {
      resolveRefresh = resolve;
    });
    const performRefresh = vi.fn(() => refreshResult);
    const coordinator = new RefreshCoordinator({
      performRefresh,
      onAuthenticationLost: vi.fn(),
      lockManager: null,
      channel: null,
    });

    const first = coordinator.recover();
    const second = coordinator.recover();
    expect(performRefresh).toHaveBeenCalledOnce();
    resolveRefresh(true);

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(performRefresh).toHaveBeenCalledOnce();
  });

  it("uses one cross-tab refresh and shares its completion", async () => {
    const hub = new ChannelHub();
    const lockManager = new SerialRefreshLockManager();
    const firstRefresh = vi.fn().mockResolvedValue(true);
    const secondRefresh = vi.fn().mockResolvedValue(true);
    const first = new RefreshCoordinator({
      performRefresh: firstRefresh,
      onAuthenticationLost: vi.fn(),
      lockManager,
      channel: hub.create(),
    });
    const second = new RefreshCoordinator({
      performRefresh: secondRefresh,
      onAuthenticationLost: vi.fn(),
      lockManager,
      channel: hub.create(),
    });

    await expect(Promise.all([first.recover(), second.recover()])).resolves.toEqual([true, true]);
    expect(firstRefresh).toHaveBeenCalledOnce();
    expect(secondRefresh).not.toHaveBeenCalled();

    first.dispose();
    second.dispose();
  });

  it("reuses a completion observed while the original request was in flight", async () => {
    const hub = new ChannelHub();
    const first = new RefreshCoordinator({
      performRefresh: vi.fn().mockResolvedValue(true),
      onAuthenticationLost: vi.fn(),
      lockManager: null,
      channel: hub.create(),
    });
    const secondRefresh = vi.fn().mockResolvedValue(true);
    const second = new RefreshCoordinator({
      performRefresh: secondRefresh,
      onAuthenticationLost: vi.fn(),
      lockManager: null,
      channel: hub.create(),
    });
    const sequenceBeforeRequest = second.captureCompletionSequence();

    await expect(first.recover()).resolves.toBe(true);
    await expect(second.recover(sequenceBeforeRequest)).resolves.toBe(true);
    expect(secondRefresh).not.toHaveBeenCalled();

    first.dispose();
    second.dispose();
  });

  it("notifies every tab when refresh establishes terminal authentication loss", async () => {
    const hub = new ChannelHub();
    const lockManager = new SerialRefreshLockManager();
    const firstLost = vi.fn();
    const secondLost = vi.fn();
    const first = new RefreshCoordinator({
      performRefresh: vi.fn().mockResolvedValue(false),
      onAuthenticationLost: firstLost,
      lockManager,
      channel: hub.create(),
    });
    const second = new RefreshCoordinator({
      performRefresh: vi.fn().mockResolvedValue(false),
      onAuthenticationLost: secondLost,
      lockManager,
      channel: hub.create(),
    });

    await expect(Promise.all([first.recover(), second.recover()])).resolves.toEqual([false, false]);
    expect(firstLost).toHaveBeenCalledOnce();
    expect(secondLost).toHaveBeenCalledOnce();

    first.dispose();
    second.dispose();
  });

  it("notifies every tab when a session ends explicitly", () => {
    const hub = new ChannelHub();
    const firstLost = vi.fn();
    const secondLost = vi.fn();
    const first = new RefreshCoordinator({
      performRefresh: vi.fn(),
      onAuthenticationLost: firstLost,
      lockManager: null,
      channel: hub.create(),
    });
    const second = new RefreshCoordinator({
      performRefresh: vi.fn(),
      onAuthenticationLost: secondLost,
      lockManager: null,
      channel: hub.create(),
    });

    first.announceAuthenticationLost();

    expect(firstLost).toHaveBeenCalledOnce();
    expect(secondLost).toHaveBeenCalledOnce();

    first.dispose();
    second.dispose();
  });

  it("propagates transient refresh failures without declaring authentication loss", async () => {
    const onAuthenticationLost = vi.fn();
    const coordinator = new RefreshCoordinator({
      performRefresh: vi.fn().mockRejectedValue(new Error("network unavailable")),
      onAuthenticationLost,
      lockManager: null,
      channel: null,
    });

    await expect(coordinator.recover()).rejects.toThrow("network unavailable");
    expect(onAuthenticationLost).not.toHaveBeenCalled();
  });
});
