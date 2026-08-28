export interface FinancialNotificationInput {
  readonly ownerId: string;
  readonly sourceId: string;
  readonly assetCode: string;
  readonly amount: string;
  readonly occurredAt: string;
}

export interface FinancialNotificationPublisher {
  depositCredited(input: FinancialNotificationInput): Promise<void>;
  withdrawalCompleted(input: FinancialNotificationInput): Promise<void>;
}
