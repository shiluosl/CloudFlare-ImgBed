import { runtime } from '../core/runtime.js';
import { ChannelHealthService } from '../core/health/channelHealthService.js';

export async function runMaintenance(env) {
  const app = runtime(env);
  const dispatched = await app.jobs.redispatchDue(50);
  const status = await app.guard.status();
  if (status.level !== 'NORMAL') return { dispatched, checked: 0, protectionLevel: status.level };
  const channels = await app.repository.listChannels({ limit: 5 });
  const health = new ChannelHealthService(app.repository, env);
  let checked = 0;
  for (const channel of channels.filter(channel => channel.enabled)) {
    await health.check(channel.id);
    checked += 1;
  }
  return { dispatched, checked, protectionLevel: status.level };
}
