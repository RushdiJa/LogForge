import amqp from "amqplib";
import { once } from "node:events";

const queueType = process.env.QUEUE_TYPE;
const messageCount = Number(process.env.MESSAGE_COUNT ?? 2_000);
const rabbitMqUrl = process.env.RABBITMQ_URL ?? "amqp://logforge:logforge@rabbitmq:5672";

if (!["classic", "quorum", "stream"].includes(queueType)) {
  throw new Error("QUEUE_TYPE must be classic, quorum, or stream");
}
if (!Number.isInteger(messageCount) || messageCount < 1 || messageCount > 100_000) {
  throw new Error("MESSAGE_COUNT must be an integer between 1 and 100000");
}

const logs = Array.from({ length: 500 }, (_, index) => ({
  timestamp: "2026-08-12T22:00:00.000Z",
  level: ["debug", "info", "warn", "error"][index % 4],
  service: `rabbit-bench-${index % 20}`,
  message: `benchmark log message ${index % 100}`,
  attributes: {
    region: `region-${index % 4}`,
    worker: index % 16,
    sampled: index % 2 === 0,
  },
}));
const payload = Buffer.from(JSON.stringify({ logs }));
const queue = `logforge.diag.${queueType}.${Date.now()}`;
const connection = await amqp.connect(rabbitMqUrl);
const publisher = await connection.createConfirmChannel();
const consumer = await connection.createChannel();

try {
  await publisher.assertQueue(queue, {
    durable: true,
    arguments: { "x-queue-type": queueType },
  });

  let returned = 0;
  publisher.on("return", () => {
    returned += 1;
  });
  const confirmations = [];
  const publishStarted = performance.now();
  for (let index = 0; index < messageCount; index += 1) {
    let writable = true;
    const confirmation = new Promise((resolve, reject) => {
      writable = publisher.sendToQueue(
        queue,
        payload,
        {
          persistent: true,
          mandatory: true,
          contentType: "application/json",
          messageId: `${queueType}-${index}`,
        },
        (error) => error === null ? resolve() : reject(error),
      );
    });
    confirmations.push(confirmation);
    if (!writable) {
      await Promise.race([once(publisher, "drain"), confirmation]);
    }
  }
  await Promise.all(confirmations);
  const publishMs = performance.now() - publishStarted;
  const queued = await publisher.checkQueue(queue);

  await consumer.prefetch(64);
  const consumeStarted = performance.now();
  let consumed = 0;
  let resolveConsumed;
  const allConsumed = new Promise((resolve) => {
    resolveConsumed = resolve;
  });
  const consumeResult = await consumer.consume(
    queue,
    (message) => {
      if (message === null) return;
      consumed += 1;
      consumer.ack(message);
      if (consumed === messageCount) resolveConsumed();
    },
    {
      noAck: false,
      arguments: queueType === "stream" ? { "x-stream-offset": "first" } : {},
    },
  );
  await allConsumed;
  const consumeMs = performance.now() - consumeStarted;
  await consumer.cancel(consumeResult.consumerTag);

  console.log(JSON.stringify({
    queueType,
    messageCount,
    logsPerMessage: logs.length,
    payloadBytes: payload.length,
    returned,
    readyAfterPublish: queued.messageCount,
    publishMs: Number(publishMs.toFixed(2)),
    publishMessagesPerSecond: Number((messageCount * 1_000 / publishMs).toFixed(2)),
    equivalentLogsPerSecond: Number(
      (messageCount * logs.length * 1_000 / publishMs).toFixed(2),
    ),
    publishMiBPerSecond: Number(
      (messageCount * payload.length * 1_000 / publishMs / 1_024 / 1_024).toFixed(2),
    ),
    consumeMs: Number(consumeMs.toFixed(2)),
    consumeMessagesPerSecond: Number((messageCount * 1_000 / consumeMs).toFixed(2)),
  }));
} finally {
  await publisher.deleteQueue(queue).catch(() => undefined);
  await Promise.allSettled([publisher.close(), consumer.close()]);
  await connection.close().catch(() => undefined);
}
