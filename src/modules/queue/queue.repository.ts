import { connect, type ChannelModel } from "amqplib";

import { QueueConnectionError } from "./queue.error.js";
import {
  DEAD_LETTER_EXCHANGE,
  DEAD_LETTER_QUEUE,
  DEAD_LETTER_ROUTING_KEY,
  INGEST_EXCHANGE,
  INGEST_QUEUE,
  INGEST_ROUTING_KEY,
  type QueueChannels,
} from "./queue.type.js";

const INGEST_QUEUE_MAX_BYTES = 512 * 1_024 * 1_024;
const DEAD_LETTER_QUEUE_MAX_BYTES = 128 * 1_024 * 1_024;

export class QueueRepository {
  private connection: ChannelModel | undefined;
  private channels: QueueChannels | undefined;

  async connect(url: string, onDisconnect: () => void): Promise<QueueChannels> {
    await this.close();
    try {
      const connection = await connect(url, {
        clientProperties: { connection_name: "logforge" },
      });
      let disconnected = false;
      connection.on("close", () => {
        this.connection = undefined;
        this.channels = undefined;
        if (!disconnected) {
          disconnected = true;
          onDisconnect();
        }
      });
      connection.on("error", () => undefined);

      const [publisher, consumer] = await Promise.all([
        connection.createConfirmChannel(),
        connection.createChannel(),
      ]);
      await publisher.assertExchange(INGEST_EXCHANGE, "direct", { durable: true });
      await publisher.assertExchange(DEAD_LETTER_EXCHANGE, "direct", { durable: true });
      await publisher.assertQueue(DEAD_LETTER_QUEUE, {
        durable: true,
        arguments: {
          "x-queue-type": "quorum",
          "x-max-length-bytes": DEAD_LETTER_QUEUE_MAX_BYTES,
          "x-overflow": "reject-publish",
        },
      });
      await publisher.bindQueue(
        DEAD_LETTER_QUEUE,
        DEAD_LETTER_EXCHANGE,
        DEAD_LETTER_ROUTING_KEY,
      );
      await publisher.assertQueue(INGEST_QUEUE, {
        durable: true,
        arguments: {
          "x-queue-type": "quorum",
          "x-delivery-limit": 20,
          "x-max-length-bytes": INGEST_QUEUE_MAX_BYTES,
          "x-overflow": "reject-publish",
          "x-dead-letter-exchange": DEAD_LETTER_EXCHANGE,
          "x-dead-letter-routing-key": DEAD_LETTER_ROUTING_KEY,
        },
      });
      await publisher.bindQueue(INGEST_QUEUE, INGEST_EXCHANGE, INGEST_ROUTING_KEY);

      this.connection = connection;
      this.channels = { connection, publisher, consumer };
      return this.channels;
    } catch (error) {
      await this.close();
      throw new QueueConnectionError("Could not connect to RabbitMQ", { cause: error });
    }
  }

  getChannels(): QueueChannels {
    if (this.channels === undefined) {
      throw new QueueConnectionError("RabbitMQ is not connected");
    }
    return this.channels;
  }

  async getReadyMessageCount(): Promise<number> {
    if (this.channels === undefined) return 0;
    const queue = await this.channels.consumer.checkQueue(INGEST_QUEUE);
    return queue.messageCount;
  }

  async close(): Promise<void> {
    const channels = this.channels;
    const connection = this.connection;
    this.channels = undefined;
    this.connection = undefined;

    await Promise.allSettled([channels?.publisher.close(), channels?.consumer.close()]);
    if (connection !== undefined) {
      await connection.close().catch(() => undefined);
    }
  }
}
