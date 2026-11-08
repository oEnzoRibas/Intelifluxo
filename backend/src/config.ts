export function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set explicitly`);
  return value;
}

export const queue = "intelifluxo.local.receipt.v1";
