import { runtime } from '../core/runtime.js';
import { ChannelHealthService } from '../core/health/channelHealthService.js';

export async function runMaintenance(env) {
  const app = runtime(env);
  const redispatch = await app.jobs.redispatchDue(50);
  const status = await app.guard.status();
  if (status.level !== 'NORMAL') return { ...redispatch, checked: 0, protectionLevel: status.level };
  const channels = await selectRotatingHealthCheckChannels(app.repository);
  const health = new ChannelHealthService(app.repository, env);
  let checked = 0;
  for (const channel of channels.filter(channel => channel.enabled)) {
    await health.check(channel.id);
    checked += 1;
  }
  return { ...redispatch, checked, protectionLevel: status.level };
}

export async function selectRotatingHealthCheckChannels(repository, limit = 5) {
  const cursorName = 'channel_health_cursor';
  const cursor = await repository.getMaintenanceCursor(cursorName);
  let channels = await repository.listChannelsAfter(cursor, limit);
  if (!channels.length && cursor) channels = await repository.listChannelsAfter(0, limit);
  if (channels.length) await repository.setMaintenanceCursor(cursorName, channels.at(-1).cursor);
  return channels;
}
