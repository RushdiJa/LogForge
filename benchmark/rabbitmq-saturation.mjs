import amqp from "amqplib";

const rabbitMqUrl = process.env.RABBITMQ_URL ?? "amqp://logforge:logforge@rabbitmq:5672";
const queue = `logforge.diag.saturation.${Date.now()}`;
const connection = await amqp.connect(rabbitMqUrl);
const publisher = await connection.createConfirmChannel();
const consumer = await connection.createChannel();

try {
  await publisher.assertQueue(queue, {
    durable: true,
    arguments: {
      "x-queue-type": "quorum",
      "x-max-length": 10,
      "x-overflow": "reject-publish",
    },
  });

  const publish = (messageId) => new Promise((resolve, reject) => {
    publisher.sendToQueue(
      queue,
      Buffer.from(JSON.stringify({ batchId: messageId, acceptedCount: 1 })),
      {
        persistent: true,
        mandatory: true,
        contentType: "application/json",
        messageId,
      },
      (error) => error === null ? resolve() : reject(error),
    );
  });

  let acceptedMessages = 0;
  let rejectedMessages = 0;
  for (let index = 1; index <= 100; index += 1) {
    const messageId = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    try {
      await publish(messageId);
      acceptedMessages += 1;
    } catch {
      rejectedMessages += 1;
    }
  }
  const state = await publisher.checkQueue(queue);
  if (rejectedMessages === 0 || state.messageCount >= 100) {
    throw new Error(
      `bounded queue did not report saturation: rejected=${rejectedMessages} ready=${state.messageCount}`,
    );
  }

  let resolveConsumed;
  const consumed = new Promise((resolve) => {
    resolveConsumed = resolve;
  });
  let consumedMessages = 0;
  const result = await consumer.consume(queue, (message) => {
    if (message === null) return;
    consumer.ack(message);
    consumedMessages += 1;
    if (consumedMessages === state.messageCount) resolveConsumed();
  });
  await consumed;
  await consumer.cancel(result.consumerTag);

  console.log(JSON.stringify({
    queueType: "quorum",
    configuredMaximumMessages: 10,
    attemptedMessages: 100,
    acceptedMessages,
    rejectedMessages,
    readyAfterPublish: state.messageCount,
    confirmReportedSaturation: rejectedMessages > 0,
    drained: true,
  }));
} finally {
  await publisher.deleteQueue(queue).catch(() => undefined);
  await Promise.allSettled([publisher.close(), consumer.close()]);
  await connection.close().catch(() => undefined);
}
