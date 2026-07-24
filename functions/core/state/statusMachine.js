const FILE_TRANSITIONS = {
  receiving: ['replicating', 'available', 'degraded', 'failed', 'deleting'],
  replicating: ['available', 'degraded', 'failed', 'deleting'],
  available: ['degraded', 'deleting'],
  degraded: ['available', 'failed', 'deleting'],
  // A repaired replica can restore a previously failed logical file directly.
  failed: ['replicating', 'available', 'degraded', 'deleting'],
  deleting: ['delete_degraded', 'deleted'],
  delete_degraded: ['deleting', 'deleted'],
  deleted: [],
};

const REPLICA_TRANSITIONS = {
  planned: ['uploading', 'retry_wait', 'deleting', 'deleted'],
  uploading: ['healthy', 'corrupt', 'retry_wait', 'permanent_failure', 'deleting'],
  healthy: ['uploading', 'suspect', 'missing', 'corrupt', 'deleting'],
  suspect: ['healthy', 'missing', 'corrupt', 'retry_wait', 'deleting'],
  missing: ['uploading', 'healthy', 'retry_wait', 'deleting'],
  corrupt: ['uploading', 'healthy', 'retry_wait', 'deleting'],
  retry_wait: ['uploading', 'permanent_failure', 'deleting'],
  deleting: ['deleted', 'retry_wait', 'permanent_failure'],
  deleted: [],
  permanent_failure: ['uploading', 'deleting'],
};

const JOB_TRANSITIONS = {
  pending: ['queued', 'running', 'cancelled'],
  // A Queue delivery can exhaust its platform retries while the durable D1
  // job is still queued. Operators may safely put it back through the outbox.
  queued: ['pending', 'running', 'retry_wait', 'cancelled'],
  running: ['succeeded', 'retry_wait', 'dead', 'cancelled'],
  retry_wait: ['pending', 'queued', 'running', 'dead', 'cancelled'],
  succeeded: [],
  dead: ['pending', 'queued', 'cancelled'],
  cancelled: [],
};

function assertTransition(machine, entity, from, to) {
  if (from === to) return;
  if (!machine[from] || !machine[from].includes(to)) {
    const error = new Error(`Invalid ${entity} status transition: ${from} -> ${to}`);
    error.code = 'INVALID_STATUS_TRANSITION';
    throw error;
  }
}

export const assertFileTransition = (from, to) => assertTransition(FILE_TRANSITIONS, 'file', from, to);
export const assertReplicaTransition = (from, to) => assertTransition(REPLICA_TRANSITIONS, 'replica', from, to);
export const assertJobTransition = (from, to) => assertTransition(JOB_TRANSITIONS, 'job', from, to);

export const FILE_STATUSES = Object.freeze(Object.keys(FILE_TRANSITIONS));
export const REPLICA_STATUSES = Object.freeze(Object.keys(REPLICA_TRANSITIONS));
export const JOB_STATUSES = Object.freeze(Object.keys(JOB_TRANSITIONS));
