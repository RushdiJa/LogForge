import type { Channel, ChannelModel, ConfirmChannel, ConsumeMessage } from "amqplib";
import type { QueuedBatchReference } from "./outbox.repository.js";

export const INGEST_EXCHANGE = "logs.ingest.exchange.v2";
export const INGEST_QUEUE = "logs.ingest.v2";
export const INGEST_ROUTING_KEY = "logs.ingest";
export const DEAD_LETTER_EXCHANGE = "logs.ingest.dlx.v2";
export const DEAD_LETTER_QUEUE = "logs.ingest.dead.v2";
export const DEAD_LETTER_ROUTING_KEY = "logs.ingest.dead";

export interface QueueChannels {
  connection: ChannelModel;
  publisher: ConfirmChannel;
  consumer: Channel;
}

export interface BufferedMessage {
  message: ConsumeMessage;
  reference: QueuedBatchReference;
  receivedAt: number;
}
