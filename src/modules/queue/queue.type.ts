import type { Channel, ChannelModel, ConfirmChannel, ConsumeMessage } from "amqplib";
import type { AcceptedLog } from "../logs/logs.type.js";

export const INGEST_QUEUE = "logs.ingest";

export interface QueueChannels {
  connection: ChannelModel;
  publisher: ConfirmChannel;
  consumer: Channel;
}

export interface BufferedMessage {
  message: ConsumeMessage;
  logs: AcceptedLog[];
}
