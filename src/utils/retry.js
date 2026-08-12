const RETRYABLE_ERROR_CODES = new Set([
  'ABORT_ERR',
  'ECONNRESET',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'ETIMEDOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

const highPriorityQueue = [];
const normalPriorityQueue = [];
let queueRunning = false;
const DEFAULT_QUEUE_TIMEOUT_MS = 25_000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withOperationTimeout(operation, timeoutMs) {
  let timeoutId;
  let operationPromise;

  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const err = new Error(`Network operation timed out after ${timeoutMs}ms`);
      err.code = 'ETIMEDOUT';
      reject(err);
    }, timeoutMs);
  });

  operationPromise = Promise.resolve()
    .then(operation)
    .finally(() => clearTimeout(timeoutId));

  // If the operation eventually rejects after the queue has already timed out,
  // keep Node from treating it as an unhandled rejection.
  operationPromise.catch(() => {});

  return Promise.race([operationPromise, timeoutPromise]);
}

function isRetryableNetworkError(err) {
  if (!err) return false;

  const message = String(err.message || '');
  return (
    err.name === 'AbortError' ||
    RETRYABLE_ERROR_CODES.has(err.code) ||
    message.includes('This operation was aborted') ||
    message.includes('getaddrinfo ENOTFOUND') ||
    message.includes('other side closed') ||
    message.includes('fetch failed')
  );
}

function pumpNetworkQueue() {
  if (queueRunning) return;
  const task = highPriorityQueue.shift() || normalPriorityQueue.shift();
  if (!task) return;

  queueRunning = true;
  withOperationTimeout(task.operation, task.timeoutMs)
    .then(task.resolve, task.reject)
    .finally(() => {
      queueRunning = false;
      pumpNetworkQueue();
    });
}

async function enqueueNetworkOperation(operation, options = {}) {
  const queue = options.priority === 'high' ? highPriorityQueue : normalPriorityQueue;
  const timeoutMs = options.timeoutMs || DEFAULT_QUEUE_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    queue.push({ operation, resolve, reject, timeoutMs });
    pumpNetworkQueue();
  });
}

async function retryNetworkOperation(operation, options = {}) {
  const {
    attempts = 3,
    baseDelayMs = 1500,
    label = 'operation',
    onRetry,
  } = options;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation(attempt);
    } catch (err) {
      const canRetry = attempt < attempts && isRetryableNetworkError(err);
      if (!canRetry) throw err;

      const waitMs = baseDelayMs * Math.pow(2, attempt - 1);
      if (onRetry) {
        onRetry(err, attempt, attempts, waitMs, label);
      }
      await delay(waitMs);
    }
  }
}

module.exports = { delay, enqueueNetworkOperation, isRetryableNetworkError, retryNetworkOperation };
