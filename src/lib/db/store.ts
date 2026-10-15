import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildSeed } from "../seed";
import type { StoreData } from "../types";
import { loadSupabaseState, saveSupabaseState } from "./supabase-state";

const dataPath = () => path.join(process.cwd(), ".data", "acme-retail.json");

let chain: Promise<unknown> = Promise.resolve();
let memory: StoreData | null = null;

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task);
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function load(): Promise<StoreData> {
  if (process.env.ACME_DATA_PATH === "memory") {
    memory ??= buildSeed();
    return memory;
  }
  if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    const remote = await loadSupabaseState();
    if (remote) return remote;
  }
  const file = dataPath();
  try {
    const raw = await readFile(/*turbopackIgnore: true*/ file, "utf8");
    return JSON.parse(raw) as StoreData;
  } catch {
    const seed = buildSeed();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(seed), "utf8");
    return seed;
  }
}

async function persist(data: StoreData): Promise<void> {
  if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.ACME_DATA_PATH !== "memory") {
    await saveSupabaseState(data);
  }
  if (process.env.ACME_DATA_PATH === "memory") {
    memory = data;
    return;
  }
  const file = dataPath();
  try {
    await mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.tmp`;
    await writeFile(temp, JSON.stringify(data), "utf8");
    await writeFile(file, await readFile(temp));
  } catch (error) {
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) throw error;
  }
}

export async function readStore<T>(fn: (data: StoreData) => T): Promise<T> {
  return enqueue(async () => fn(structuredClone(await load())));
}

export async function updateStore<T>(fn: (data: StoreData) => T): Promise<T> {
  return enqueue(async () => {
    const data = await load();
    const result = fn(data);
    await persist(data);
    return result;
  });
}

export async function resetStore(): Promise<void> {
  await updateStore((data) => {
    const seed = buildSeed();
    Object.assign(data, seed);
    data.users = seed.users;
    data.orders = seed.orders;
  });
}
