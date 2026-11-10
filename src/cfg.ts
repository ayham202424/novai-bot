import { supabase } from './db';

export type Cfg = {
  roles: Record<string, string>;      // support, dev, customer, ui, builder, ...
  categories: Record<string, string>; // devfiles, deals, tickets, ...
  channels: Record<string, string>;   // dev-logs, task-ui, ...
  posted: Record<string, string>;     // message ids of the panels the bot keeps up to date
};

const empty = (): Cfg => ({ roles: {}, categories: {}, channels: {}, posted: {} });
let cache: Cfg | null = null;

export async function getCfg(fresh = false): Promise<Cfg> {
  if (cache && !fresh) return cache;
  const { data } = await supabase.from('bot_state').select('value').eq('key', 'cfg').maybeSingle();
  cache = { ...empty(), ...((data?.value as Partial<Cfg>) ?? {}) };
  return cache;
}

export async function saveCfg(cfg: Cfg) {
  cache = cfg;
  const { error } = await supabase.from('bot_state').upsert({ key: 'cfg', value: cfg });
  if (error) console.error('❌ saveCfg:', error.message);
}