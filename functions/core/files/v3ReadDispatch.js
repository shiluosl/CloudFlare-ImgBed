import { v3ReadEnabled } from '../config.js';

// Returns null only when the legacy route remains the authoritative compatibility path.
export async function tryReadV3File({ env, fileId, request }, dependencies) {
  const { createRuntime, createFileService } = dependencies;
  if (!v3ReadEnabled(env) || !(env.DB || env.img_d1) || fileId.includes('/')) return null;

  try {
    const app = createRuntime(env);
    const v3File = await app.repository.getFile(fileId);
    if (!v3File) return null;

    try {
      return (await createFileService(app).read(fileId, request)).response;
    } catch (error) {
      console.warn('V3 logical file read failed:', error.code || 'UNKNOWN');
      return new Response('File temporarily unavailable', { status: 503 });
    }
  } catch (error) {
    // An unmigrated or binding-free rollback deployment may still serve legacy files.
    if (isV3CompatibilityError(error)) return null;
    console.warn('V3 logical file lookup failed:', error.code || 'UNKNOWN');
    return new Response('File temporarily unavailable', { status: 503 });
  }
}

function isV3CompatibilityError(error) {
  return error?.code === 'D1_REQUIRED' || /no such table/i.test(String(error?.message || ''));
}
