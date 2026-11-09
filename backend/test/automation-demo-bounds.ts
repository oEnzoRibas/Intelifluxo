import amqp, { type Channel, type ChannelModel } from "amqplib";
import { randomUUID } from "node:crypto";
import { logBrokerError } from "../src/broker.js";

export const operationTimeout = 10000;
export const cleanupTimeout = 2000;

// Install before issuing any RPC, including for channels resolving after a timeout.
export async function watchedChannel<T extends Channel>(
  pending: Promise<T>,
): Promise<T> {
  return pending.then((channel) => {
    channel.on("error", (error) => logBrokerError("channel", error));
    return channel;
  });
}

export function queueDeclaration(name: string) {
  let attempted = false;
  return {
    declare: (channel: Channel, abort: () => void, ms = operationTimeout) =>
      deadline(
        "declare queue",
        () => {
          attempted = true;
          return channel.assertQueue(name, { durable: true });
        },
        ms,
        abort,
      ),
    cleanup: (connect?: () => Promise<ChannelModel>) =>
      attempted ? deleteAttemptedQueue(name, connect) : Promise.resolve(),
  };
}

export function isolatedQueue(): string {
  return `intelifluxo.automation.${randomUUID()}`;
}

export function assertIsolatedQueue(name: string): void {
  if (
    !/^intelifluxo\.automation\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      name,
    )
  )
    throw new Error("isolated automation queue required");
}

// amqplib exposes the underlying stream at runtime but not in its public types.
// Destroying it interrupts pending channel RPCs after a deadline.
export function destroyBroker(connection: ChannelModel | undefined): void {
  const internal = connection?.connection as unknown as
    { stream?: { destroy(): void } } | undefined;
  internal?.stream?.destroy();
}

export async function deadline<T>(
  label: string,
  work: () => Promise<T>,
  ms = operationTimeout,
  onTimeout?: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          try {
            onTimeout?.();
          } finally {
            reject(new Error(`${label} timed out after ${ms}ms`));
          }
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function connectDemoBroker(): Promise<ChannelModel> {
  let expired = false;
  const pending = amqp.connect(process.env.AMQP_URL!, {
    timeout: operationTimeout,
  });
  // If the overall deadline wins, discard a connection that opens afterwards.
  void pending.then(
    (connection) => {
      connection.on("error", (error) => logBrokerError("connection", error));
      if (expired) destroyBroker(connection);
    },
    () => {},
  );
  return deadline(
    "broker connect",
    () => pending,
    operationTimeout,
    () => {
      expired = true;
    },
  );
}

// Declaration can succeed on the server even when its response is lost. Use a
// fresh connection because the declaration timeout destroys the original one.
export async function deleteAttemptedQueue(
  name: string,
  connect: () => Promise<ChannelModel> = connectDemoBroker,
): Promise<void> {
  assertIsolatedQueue(name);
  let connection: ChannelModel | undefined;
  let expired = false;
  let closed = false;
  const pending = connect();
  void pending.then(
    (value) => {
      if (expired) destroyBroker(value);
    },
    () => {},
  );
  try {
    await deadline(
      "delete attempted queue",
      async () => {
        connection = await pending;
        if (expired) return;
        const channel = await watchedChannel(connection.createChannel());
        if (expired) return;
        try {
          await channel.deleteQueue(name);
        } catch (error) {
          // RabbitMQ may close the channel with NOT_FOUND if no queue exists.
          // amqplib 2.3.0 lib/channel.js copies ChannelClose fields onto the
          // RPC error; lib/defs.js identifies QueueDelete as class 50, method 40.
          const close = error as {
            code?: number;
            classId?: number;
            methodId?: number;
          };
          if (
            close.code !== 404 ||
            close.classId !== 50 ||
            close.methodId !== 40
          )
            throw error;
        }
      },
      cleanupTimeout,
      () => {
        expired = true;
        destroyBroker(connection);
      },
    );
    if (connection)
      await deadline(
        "close cleanup broker",
        () => connection!.close(),
        cleanupTimeout,
        () => destroyBroker(connection),
      );
    closed = true;
  } finally {
    expired = true;
    if (!closed) destroyBroker(connection);
  }
}

export function boundedSteps(
  steps: Array<[string, () => Promise<unknown>]>,
  onTimeout: () => void,
): Array<[string, () => Promise<unknown>]> {
  return steps.map(([name, step]) => [
    name,
    () => deadline(`cleanup ${name}`, step, cleanupTimeout, onTimeout),
  ]);
}

// The demo and its tests share this exact sequence; each step remains independent.
export function demoCleanupSteps(
  steps: Record<
    | "api"
    | "consumer"
    | "queue"
    | "confirm"
    | "broker"
    | "pool"
    | "schema"
    | "admin",
    () => Promise<unknown>
  >,
  onTimeout: () => void,
): Array<[string, () => Promise<unknown>]> {
  return boundedSteps(
    [
      ["API", steps.api],
      ["consumer", steps.consumer],
      ["queue", steps.queue],
      ["confirm channel", steps.confirm],
      ["broker", steps.broker],
      ["pool", steps.pool],
      ["schema", steps.schema],
      ["admin", steps.admin],
    ],
    onTimeout,
  );
}
