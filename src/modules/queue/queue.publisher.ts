import { once } from "node:events";
import type { Message } from "amqplib";

import type { QueuedBatchReference } from "./outbox.repository.js";
import type { QueueRepository } from "./queue.repository.js";
import type { QueueMetrics } from "./queue.metrics.js";
import { INGEST_EXCHANGE, INGEST_ROUTING_KEY } from "./queue.type.js";

export class QueuePublisher {
  constructor(
    private readonly repository: QueueRepository,
    private readonly metrics?: QueueMetrics,
  ) {}

  async publish(batches: QueuedBatchReference[]): Promise<void> {
    const channel = this.repository.getChannels().publisher;
    const confirmations: Promise<void>[] = [];
    const returnedBatchIds = new Set<string>();
    const onReturn = (message: Message): void => {
      if (typeof message.properties.messageId === "string") {
        returnedBatchIds.add(message.properties.messageId);
      }
    };
    channel.on("return", onReturn);

    try {
      for (const batch of batches) {
        const serializationStartedAt = this.metrics === undefined ? 0 : performance.now();
        const content = Buffer.from(JSON.stringify(batch));
        this.metrics?.recordPublishSerialization(performance.now() - serializationStartedAt);
        this.metrics?.recordPublishedPayload(content.length);
        const confirmationStartedAt = performance.now();
        this.metrics?.recordPublishStarted();
        let writable = true;

        const confirmation = new Promise<void>((resolve, reject) => {
          const finish = (error: Error | null): void => {
            setImmediate(() => {
              const failure = error ?? (returnedBatchIds.has(batch.batchId)
                ? new Error(`RabbitMQ returned unroutable batch ${batch.batchId}`)
                : null);
              this.metrics?.recordPublishConfirmation(
                performance.now() - confirmationStartedAt,
                failure === null,
              );
              if (failure === null) {
                this.metrics?.recordPublished(batch.acceptedCount);
                resolve();
              } else {
                reject(failure);
              }
            });
          };

          try {
            const publishStartedAt = performance.now();
            writable = channel.publish(
              INGEST_EXCHANGE,
              INGEST_ROUTING_KEY,
              content,
              {
                persistent: true,
                mandatory: true,
                contentType: "application/json",
                messageId: batch.batchId,
                timestamp: Math.floor(Date.now() / 1_000),
              },
              finish,
            );
            this.metrics?.recordPublishCall(performance.now() - publishStartedAt);
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
          const waitStartedAt = performance.now();
          await Promise.race([once(channel, "drain"), confirmation]);
          this.metrics?.recordPublisherBackpressureWait(performance.now() - waitStartedAt);
        }
      }

      await Promise.all(confirmations);
    } finally {
      channel.off("return", onReturn);
    }
  }
}
