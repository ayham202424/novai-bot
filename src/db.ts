import { createClient } from '@supabase/supabase-js';

const TIMEOUT_MS = 8000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Every database call gets a time limit (so nothing can hang forever).
// Reads are retried once if the network hiccups. Writes are never retried
// (so an order can never be created twice).
const safeFetch: typeof fetch = async (input, init) => {
  const method = (init?.method ?? 'GET').toUpperCase();
  const attempts = method === 'GET' || method === 'HEAD' ? 2 : 1;
  for (let n = 1; ; n++) {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    try {
      return await fetch(input, { ...init, signal });
    } catch (err) {
      if (n >= attempts) throw err;
      await sleep(300);
    }
  }
};

export const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SECRET_KEY!,
  { auth: { persistSession: false }, global: { fetch: safeFetch } }
);