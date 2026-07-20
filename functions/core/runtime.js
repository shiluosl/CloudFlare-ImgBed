import { requireD1 } from '../repositories/d1.js';
import { StorageRepository } from '../repositories/storageRepository.js';
import { ZeroCostGuard } from './cost/zeroCostGuard.js';
import { JobService } from './jobs/jobService.js';
import { UploadService } from './upload/uploadService.js';
import { StorageOrchestrator } from './storage/orchestrator.js';

export function runtime(env) {
  const repository = new StorageRepository(requireD1(env)); const guard = new ZeroCostGuard(repository, env);
  const jobs = new JobService(repository, guard, env.STORAGE_QUEUE || null);
  return { repository, guard, jobs, upload: new UploadService(repository, guard, env, jobs), storage: new StorageOrchestrator(repository, env, jobs) };
}
