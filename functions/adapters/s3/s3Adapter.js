import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { StorageAdapter, StorageError, STORAGE_ERROR_CODES } from '../../core/storage/adapter.js';
import { assertExternalEndpoint } from '../../core/security/endpointValidation.js';

export class S3Adapter extends StorageAdapter {
  constructor(channel, env, clientFactory = createS3Client) {
    super(channel, env);
    this.clientFactory = clientFactory;
    this.client = null;
  }

  provider() { return 's3'; }
  capabilities() { return { ...super.capabilities(), range: true, checksum: true, maxObjectSize: null }; }
  config() { return this.channel.config || {}; }

  clientForChannel() {
    if (!this.client) this.client = this.clientFactory(this.channel, this.env);
    return this.client;
  }

  async put(input) {
    const result = await this.send(new PutObjectCommand({
      Bucket: this.bucketName(),
      Key: input.objectKey,
      Body: input.body,
      ContentType: input.contentType || 'application/octet-stream',
    }), 'PUT');
    return {
      objectKey: input.objectKey,
      remoteId: null,
      etag: result.ETag || null,
      checksum: firstChecksum(result),
      size: input.size,
      safeMetadata: {},
    };
  }

  async get(input) {
    const result = await this.send(new GetObjectCommand({
      Bucket: this.bucketName(),
      Key: input.objectKey,
      Range: input.range || undefined,
    }), 'GET');
    return new Response(result.Body || null, {
      status: result.$metadata?.httpStatusCode || 200,
      headers: responseHeaders(result),
    });
  }

  async head(input) {
    const result = await this.send(new HeadObjectCommand({ Bucket: this.bucketName(), Key: input.objectKey }), 'HEAD');
    return { exists: true, size: result.ContentLength ?? null, etag: result.ETag || null, checksum: firstChecksum(result) };
  }

  async delete(input) {
    try {
      await this.send(new DeleteObjectCommand({ Bucket: this.bucketName(), Key: input.objectKey }), 'DELETE');
    } catch (error) {
      if (error.code !== STORAGE_ERROR_CODES.NOT_FOUND) throw error;
    }
    return { deleted: true };
  }

  async healthCheck() {
    const result = await this.send(new HeadBucketCommand({ Bucket: this.bucketName() }), 'healthCheck');
    return { healthy: true, status: result.$metadata?.httpStatusCode || 200 };
  }

  bucketName() {
    const bucketName = String(this.config().bucketName || '');
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/i.test(bucketName)) {
      throw configurationError(this.channel.id, 'S3 bucketName is required and must be a valid bucket name');
    }
    return bucketName;
  }

  async send(command, operation) {
    const controller = new AbortController();
    const timeoutMs = boundedTimeout(this.config().timeoutMs);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.clientForChannel().send(command, { abortSignal: controller.signal });
    } catch (error) {
      throw s3Error(this.channel.id, operation, error);
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createS3Client(channel, env = {}) {
  const config = channel.config || {};
  let endpoint;
  try {
    endpoint = assertExternalEndpoint(config.endpoint, { label: 'S3 endpoint' }).toString();
  } catch (error) {
    throw configurationError(channel.id, error.message);
  }
  const secretRefs = channel.secretRefs || channel.secret_refs || {};
  const accessKeyId = env[secretRefs.accessKeyIdRef];
  const secretAccessKey = env[secretRefs.secretAccessKeyRef];
  if (!accessKeyId || !secretAccessKey) {
    throw configurationError(channel.id, 'S3 access key and secret key references are required');
  }
  return new S3Client({
    endpoint,
    region: String(config.region || 'auto'),
    forcePathStyle: config.pathStyle === true,
    credentials: { accessKeyId, secretAccessKey },
    maxAttempts: 1,
  });
}

function responseHeaders(result) {
  const headers = new Headers();
  if (result.ContentType) headers.set('Content-Type', result.ContentType);
  if (result.ContentLength !== undefined) headers.set('Content-Length', String(result.ContentLength));
  if (result.ETag) headers.set('ETag', result.ETag);
  if (result.ContentRange) headers.set('Content-Range', result.ContentRange);
  return headers;
}

function firstChecksum(result) {
  return result.ChecksumSHA256 || result.ChecksumSHA1 || result.ChecksumCRC32C || result.ChecksumCRC32 || null;
}

function boundedTimeout(value) {
  const timeout = Number(value);
  return Number.isFinite(timeout) ? Math.min(Math.max(timeout, 1000), 30000) : 10000;
}

function configurationError(channelId, message) {
  return new StorageError({ provider: 's3', channelId, code: STORAGE_ERROR_CODES.INVALID_CONFIGURATION, message });
}

function s3Error(channelId, operation, error) {
  if (error instanceof StorageError) return error;
  const status = Number(error?.$metadata?.httpStatusCode) || null;
  const name = String(error?.name || error?.Code || error?.code || '');
  const retryAfterSeconds = Number(error?.$response?.headers?.['retry-after']) || null;
  if (error?.name === 'AbortError' || /timeout/i.test(name)) return new StorageError({ provider: 's3', channelId, code: STORAGE_ERROR_CODES.TIMEOUT, retryable: true, message: `S3 ${operation} timed out`, cause: error });
  if (['NoSuchKey', 'NotFound', 'NoSuchBucket'].includes(name) || status === 404) return new StorageError({ provider: 's3', channelId, code: STORAGE_ERROR_CODES.NOT_FOUND, retryable: false, status, message: `S3 ${operation} object not found`, cause: error });
  if (status === 401 || status === 403 || /invalidaccesskey|signaturedoesnotmatch|accessdenied/i.test(name)) return new StorageError({ provider: 's3', channelId, code: STORAGE_ERROR_CODES.AUTH_FAILED, retryable: false, status, message: `S3 ${operation} authorization failed`, cause: error });
  if (status === 429 || /slowdown|throttl|requestlimit/i.test(name)) return new StorageError({ provider: 's3', channelId, code: STORAGE_ERROR_CODES.RATE_LIMITED, retryable: true, status, retryAfterSeconds, message: `S3 ${operation} rate limited`, cause: error });
  if (status && status >= 500) return new StorageError({ provider: 's3', channelId, code: STORAGE_ERROR_CODES.NETWORK_ERROR, retryable: true, status, message: `S3 ${operation} remote failure`, cause: error });
  return new StorageError({ provider: 's3', channelId, code: STORAGE_ERROR_CODES.NETWORK_ERROR, retryable: true, status, message: `S3 ${operation} failed`, cause: error });
}
