import { connect, type ChannelModel } from "amqplib";

import { QueueConnectionError } from "./queue.error.js";
import { INGEST_QUEUE, type QueueChannels } from "./queue.type.js";

export class QueueRepository {
  private connection: ChannelModel | undefined;
  private channels: QueueChannels | undefined;

  async connect(url: string, onDisconnect: () => void): Promise<QueueChannels> {
    try {
      const connection = await connect(url, {
        clientProperties: { connection_name: "logforge" },
      });
      connection.on("close", onDisconnect);
      connection.on("error", () => undefined);

      const [publisher, consumer] = await Promise.all([
        connection.createConfirmChannel(),
        connection.createChannel(),
      ]);
      await Promise.all([
        publisher.assertQueue(INGEST_QUEUE, { durable: true }),
        consumer.assertQueue(INGEST_QUEUE, { durable: true }),
      ]);

      this.connection = connection;
      this.channels = { connection, publisher, consumer };
      return this.channels;
    } catch (error) {
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
    const queue = await this.getChannels().consumer.checkQueue(INGEST_QUEUE);
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
