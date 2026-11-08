import amqp, { type ChannelModel, type ConfirmChannel } from "amqplib";
import { randomUUID } from "node:crypto";
import { required, queue } from "./config.js";

export async function connectBroker(): Promise<ChannelModel> {
  const connection = await amqp.connect(required("AMQP_URL"));
  connection.on("error", () => console.error("broker connection error"));
  return connection;
}

// One in-flight publication per channel: return and confirm are correlated without
// depending on caller-supplied IDs. A timeout makes an uncertain outcome a failure.
export async function publish(
  channel: ConfirmChannel,
  routingKey: string,
  body: Buffer,
  trace: string[] = [],
): Promise<boolean> {
  const messageId = randomUUID();
  let returned = false;
  const onReturn = (message: amqp.Message) => {
    if (message.properties.messageId === messageId) {
      returned = true;
      trace.push("return");
    }
  };
  channel.on("return", onReturn);
  try {
    return await new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("publisher confirm timeout")),
        10000,
      );
      try {
        channel.sendToQueue(
          routingKey,
          body,
          { mandatory: true, persistent: true, messageId },
          (error) => {
            clearTimeout(timer);
            trace.push("confirm");
            if (error) reject(error);
            else resolve(!returned);
          },
        );
      } catch (error) {
        clearTimeout(timer);
        reject(error);
      }
    });
  } finally {
    channel.off("return", onReturn);
  }
}

// Runtime gate exercises the exact adapter against the currently connected broker.
export async function conformanceGate(channel: ConfirmChannel): Promise<void> {
  const suffix = randomUUID();
  const testQueue = `intelifluxo.probe.${suffix}`;
  await channel.assertQueue(testQueue, { exclusive: true, autoDelete: true });
  try {
    const unrouted: string[] = [];
    const routed: string[] = [];
    const a = await publish(
      channel,
      `intelifluxo.absent.${suffix}`,
      Buffer.from("probe"),
      unrouted,
    );
    const b = await publish(channel, testQueue, Buffer.from("probe"), routed);
    if (
      a ||
      !b ||
      unrouted.join(",") !== "return,confirm" ||
      routed.join(",") !== "confirm"
    ) {
      throw new Error(
        "RabbitMQ mandatory return/confirm conformance gate failed",
      );
    }
  } finally {
    await channel.deleteQueue(testQueue);
  }
}

export async function prepareQueue(
  channel: ConfirmChannel,
  name = queue,
): Promise<void> {
  await channel.assertQueue(name, { durable: true });
}
