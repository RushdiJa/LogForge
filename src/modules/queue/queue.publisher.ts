import { once } from "node:events";

import type { AcceptedLog, QueuePublisher as QueuePublisherContract } from "../logs/logs.type.js";
import type { QueueRepository } from "./queue.repository.js";
import type { QueueMetrics } from "./queue.metrics.js";
import { INGEST_QUEUE } from "./queue.type.js";

const MAX_LOGS_PER_MESSAGE = 5_000;

export class QueuePublisher implements QueuePublisherContract {
  constructor(
    private readonly repository: QueueRepository,
    private readonly metrics?: QueueMetrics,
  ) {}

  async publish(logs: AcceptedLog[]): Promise<void> {
    const channel = this.repository.getChannels().publisher;
    const confirmations: Promise<void>[] = [];

    for (let offset = 0; offset < logs.length; offset += MAX_LOGS_PER_MESSAGE) {
      const batch = logs.slice(offset, offset + MAX_LOGS_PER_MESSAGE);
      const serializationStartedAt = this.metrics === undefined ? 0 : performance.now();
      const content = Buffer.from(JSON.stringify({ logs: batch }));
      if (this.metrics !== undefined) {
        this.metrics.recordPublishSerialization(performance.now() - serializationStartedAt);
      }
      let writable = true;
      const confirmationStartedAt = this.metrics === undefined ? 0 : performance.now();
      this.metrics?.recordPublishStarted();

      const confirmation = new Promise<void>((resolve, reject) => {
        try {
          writable = channel.sendToQueue(
            INGEST_QUEUE,
            content,
            {
              persistent: true,
              contentType: "application/json",
              timestamp: Math.floor(Date.now() / 1_000),
            },
            (error) => {
              const succeeded = error === null;
              this.metrics?.recordPublishConfirmation(
                performance.now() - confirmationStartedAt,
                succeeded,
              );
              if (succeeded) {
                this.metrics?.recordPublished(batch.length);
                resolve();
              } else {
                reject(error);
              }
            },
          );
        } catch (error) {
          this.metrics?.recordPublishConfirmation(
            performance.now() - confirmationStartedAt,
            false,
          );
          reject(error);
        }
      });
      confirmations.push(confirmation);

      if (!writable) {
        this.metrics?.recordPublisherBackpressure();
        await Promise.race([once(channel, "drain"), confirmation]);
      }
    }

    await Promise.all(confirmations);
  }
}
