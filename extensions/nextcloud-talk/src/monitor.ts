// Nextcloud Talk plugin module implements monitor behavior.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  WEBHOOK_RATE_LIMIT_DEFAULTS,
  createAuthRateLimiter,
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
  resolveRequestClientIp,
  requestBodyErrorToText,
} from "openclaw/plugin-sdk/webhook-ingress";
import {
  createWebhookInFlightLimiter,
  sendHttpRequestRejection,
} from "openclaw/plugin-sdk/webhook-request-guards";
import { extractNextcloudTalkHeaders, verifyNextcloudTalkSignature } from "./signature.js";
import type { NextcloudTalkWebhookHeaders, NextcloudTalkWebhookServerOptions } from "./types.js";
import { NextcloudTalkWebhookPayloadError } from "./webhook-spool-state.js";

const DEFAULT_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
const PREAUTH_WEBHOOK_MAX_BODY_BYTES = 64 * 1024;
const NEXTCLOUD_TALK_WEBHOOK_ACCEPTED_HEADER = "x-openclaw-delivery-accepted";
const NEXTCLOUD_TALK_WEBHOOK_ACCEPTED_VALUE = "durable";
const PREAUTH_WEBHOOK_BODY_TIMEOUT_MS = 5_000;
// One route, so a single fixed key: keying by client IP would hand a distributed caller a
// fresh budget per source. 64 mirrors the sms channel, which bounds an identical 64 KB/5 s
// pre-auth read; the shared default of 8 is sized for per-route keys, not one route-wide key.
const PREAUTH_WEBHOOK_MAX_IN_FLIGHT = 64;
const PREAUTH_WEBHOOK_IN_FLIGHT_KEY = "nextcloud-talk-webhook-preauth";
const HEALTH_PATH = "/healthz";
const WEBHOOK_AUTH_RATE_LIMIT_SCOPE = "nextcloud-talk-webhook-auth";
const WEBHOOK_ERRORS = {
  missingSignatureHeaders: "Missing signature headers",
  invalidBackend: "Invalid backend",
  invalidSignature: "Invalid signature",
  invalidPayloadFormat: "Invalid payload format",
  payloadTooLarge: "Payload too large",
  webhookCapacityExceeded: "Webhook capacity exceeded",
  internalServerError: "Internal server error",
} as const;

function writeJsonResponse(
  res: ServerResponse,
  status: number,
  body?: Record<string, unknown>,
): void {
  if (body) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
    return;
  }
  res.writeHead(status);
  res.end();
}

function writeWebhookError(res: ServerResponse, status: number, error: string): void {
  if (res.headersSent) {
    return;
  }
  writeJsonResponse(res, status, { error });
}

function validateWebhookHeaders(params: {
  req: IncomingMessage;
  res: ServerResponse;
  isBackendAllowed?: (backend: string) => boolean;
}): NextcloudTalkWebhookHeaders | null {
  const headers = extractNextcloudTalkHeaders(
    params.req.headers as Record<string, string | string[] | undefined>,
  );
  if (!headers) {
    writeWebhookError(params.res, 400, WEBHOOK_ERRORS.missingSignatureHeaders);
    return null;
  }
  if (params.isBackendAllowed && !params.isBackendAllowed(headers.backend)) {
    writeWebhookError(params.res, 401, WEBHOOK_ERRORS.invalidBackend);
    return null;
  }
  return headers;
}

function verifyWebhookSignature(params: {
  headers: NextcloudTalkWebhookHeaders;
  body: string;
  secret: string;
  res: ServerResponse;
  clientIp: string;
  authRateLimiter: ReturnType<typeof createAuthRateLimiter>;
}): boolean {
  const isValid = verifyNextcloudTalkSignature({
    signature: params.headers.signature,
    random: params.headers.random,
    body: params.body,
    secret: params.secret,
  });
  if (!isValid) {
    params.authRateLimiter.recordFailure(params.clientIp, WEBHOOK_AUTH_RATE_LIMIT_SCOPE);
    writeWebhookError(params.res, 401, WEBHOOK_ERRORS.invalidSignature);
    return false;
  }
  params.authRateLimiter.reset(params.clientIp, WEBHOOK_AUTH_RATE_LIMIT_SCOPE);
  return true;
}

function readNextcloudTalkWebhookBody(req: IncomingMessage, maxBodyBytes: number): Promise<string> {
  return readRequestBodyWithLimit(req, {
    // This read happens before signature verification, so keep the unauthenticated
    // body budget bounded even if the operator-configured post-parse limit is larger.
    maxBytes: Math.min(maxBodyBytes, PREAUTH_WEBHOOK_MAX_BODY_BYTES),
    timeoutMs: PREAUTH_WEBHOOK_BODY_TIMEOUT_MS,
    // Defer destruction so the rejections below reach the backend before the close.
    destroyOnLimit: false,
  });
}

async function rejectWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  error: string,
): Promise<void> {
  if (res.headersSent) {
    return;
  }
  await sendHttpRequestRejection(req, res, status, JSON.stringify({ error }), "application/json");
}

/** Read the pre-authentication body, answering the bounded read's own rejections in place. */
async function readPreAuthWebhookBodyOrReject(params: {
  req: IncomingMessage;
  res: ServerResponse;
  maxBodyBytes: number;
  readBody: (req: IncomingMessage, maxBodyBytes: number) => Promise<string>;
}): Promise<string | null> {
  try {
    return await params.readBody(params.req, params.maxBodyBytes);
  } catch (err) {
    // These rejections are answered here, inside the caller's slot-owning scope:
    // sendHttpRequestRejection keeps the socket in a close grace period, so releasing the
    // slot first would hand capacity back while the connection is still winding down.
    if (isRequestBodyLimitError(err, "PAYLOAD_TOO_LARGE")) {
      await rejectWebhookRequest(params.req, params.res, 413, WEBHOOK_ERRORS.payloadTooLarge);
      return null;
    }
    if (isRequestBodyLimitError(err, "REQUEST_BODY_TIMEOUT")) {
      await rejectWebhookRequest(
        params.req,
        params.res,
        408,
        requestBodyErrorToText("REQUEST_BODY_TIMEOUT"),
      );
      return null;
    }
    throw err;
  }
}

/**
 * Read and authenticate one webhook request while holding a pre-authentication slot.
 *
 * The auth rate limiter guarding this route is failure-driven: it only counts an attempt once
 * `recordFailure` runs, which happens after a body read has completed and the signature turned
 * out invalid. A caller that never finishes its body therefore never registers, so nothing
 * bounds how many unauthenticated reads run at once. Hold a slot across the read and the
 * signature check, and release it before durable admission so a slow spool cannot pin it.
 */
async function readAuthenticatedWebhookBody(params: {
  req: IncomingMessage;
  res: ServerResponse;
  headers: NextcloudTalkWebhookHeaders;
  maxBodyBytes: number;
  secret: string;
  clientIp: string;
  authRateLimiter: ReturnType<typeof createAuthRateLimiter>;
  inFlightLimiter: ReturnType<typeof createWebhookInFlightLimiter>;
  readBody: (req: IncomingMessage, maxBodyBytes: number) => Promise<string>;
}): Promise<string | null> {
  if (!params.inFlightLimiter.tryAcquire(PREAUTH_WEBHOOK_IN_FLIGHT_KEY)) {
    // 503, not 429: a delivery refused for capacity must stay retryable. Nextcloud retries only
    // a few times, and this route already answers retryable failures with 5xx, so a terminal
    // 4xx here would turn transient overload into silently dropped messages. Going through the
    // shared rejection helper also closes a connection that is still uploading.
    await rejectWebhookRequest(params.req, params.res, 503, WEBHOOK_ERRORS.webhookCapacityExceeded);
    return null;
  }
  try {
    const body = await readPreAuthWebhookBodyOrReject({
      req: params.req,
      res: params.res,
      maxBodyBytes: params.maxBodyBytes,
      readBody: params.readBody,
    });
    if (body === null) {
      return null;
    }
    const hasValidSignature = verifyWebhookSignature({
      headers: params.headers,
      body,
      secret: params.secret,
      res: params.res,
      clientIp: params.clientIp,
      authRateLimiter: params.authRateLimiter,
    });
    return hasValidSignature ? body : null;
  } finally {
    params.inFlightLimiter.release(PREAUTH_WEBHOOK_IN_FLIGHT_KEY);
  }
}

export function createNextcloudTalkWebhookServer(opts: NextcloudTalkWebhookServerOptions): {
  server: Server;
  start: () => Promise<void>;
  stop: () => Promise<void>;
} {
  const { port, host, path, secret, onWebhook, onError, abortSignal } = opts;
  const maxBodyBytes =
    typeof opts.maxBodyBytes === "number" &&
    Number.isFinite(opts.maxBodyBytes) &&
    opts.maxBodyBytes > 0
      ? Math.floor(opts.maxBodyBytes)
      : DEFAULT_WEBHOOK_MAX_BODY_BYTES;
  const readBody = opts.readBody ?? readNextcloudTalkWebhookBody;
  const isBackendAllowed = opts.isBackendAllowed;
  const authRateLimitMaxRequests =
    typeof opts.authRateLimit?.maxRequests === "number"
      ? opts.authRateLimit.maxRequests
      : WEBHOOK_RATE_LIMIT_DEFAULTS.maxRequests;
  const authRateLimitWindowMs =
    typeof opts.authRateLimit?.windowMs === "number"
      ? opts.authRateLimit.windowMs
      : WEBHOOK_RATE_LIMIT_DEFAULTS.windowMs;
  const webhookAuthRateLimiter = createAuthRateLimiter({
    maxAttempts: authRateLimitMaxRequests,
    windowMs: authRateLimitWindowMs,
    lockoutMs: authRateLimitWindowMs,
    exemptLoopback: false,
    pruneIntervalMs: authRateLimitWindowMs,
  });
  const preAuthInFlightLimiter = createWebhookInFlightLimiter({
    maxInFlightPerKey: PREAUTH_WEBHOOK_MAX_IN_FLIGHT,
    maxTrackedKeys: 1,
  });

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      if (req.url === HEALTH_PATH) {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ok");
        return;
      }

      if (req.url !== path || req.method !== "POST") {
        res.writeHead(404);
        res.end();
        return;
      }

      const clientIp =
        resolveRequestClientIp(req, opts.trustedProxies, opts.allowRealIpFallback) ??
        req.socket.remoteAddress ??
        "unknown";
      if (!webhookAuthRateLimiter.check(clientIp, WEBHOOK_AUTH_RATE_LIMIT_SCOPE).allowed) {
        res.writeHead(429);
        res.end("Too Many Requests");
        return;
      }

      try {
        const headers = validateWebhookHeaders({
          req,
          res,
          isBackendAllowed,
        });
        if (!headers) {
          return;
        }

        const body = await readAuthenticatedWebhookBody({
          req,
          res,
          headers,
          maxBodyBytes,
          secret,
          clientIp,
          authRateLimiter: webhookAuthRateLimiter,
          inFlightLimiter: preAuthInFlightLimiter,
          readBody,
        });
        if (body === null) {
          return;
        }

        // Nextcloud retries only a few times. Acknowledge only after the raw
        // envelope is durably admitted; append failure must remain retryable.
        const admission = await onWebhook(body);
        if (admission === "accepted") {
          // Ignored non-message events still receive 200 but must not claim
          // durable adoption.
          res.setHeader(
            NEXTCLOUD_TALK_WEBHOOK_ACCEPTED_HEADER,
            NEXTCLOUD_TALK_WEBHOOK_ACCEPTED_VALUE,
          );
        }
        writeJsonResponse(res, 200);
      } catch (err) {
        // Body-read limits are answered inside readAuthenticatedWebhookBody so the rejection
        // completes while its pre-authentication slot is still held.
        if (err instanceof NextcloudTalkWebhookPayloadError) {
          writeWebhookError(res, 400, WEBHOOK_ERRORS.invalidPayloadFormat);
          return;
        }
        const error = err instanceof Error ? err : new Error(formatErrorMessage(err));
        onError?.(error);
        writeWebhookError(res, 500, WEBHOOK_ERRORS.internalServerError);
      }
    })();
  });

  let stopRequested = false;
  let closePromise: Promise<void> | undefined;
  const closeIfListening = (): Promise<void> => {
    if (closePromise) {
      return closePromise;
    }
    if (!server.listening) {
      return Promise.resolve();
    }
    closePromise = new Promise<void>((resolve) => {
      server.close(() => resolve());
    }).finally(() => {
      closePromise = undefined;
    });
    return closePromise;
  };
  const stop = async () => {
    stopRequested = true;
    await closeIfListening();
    webhookAuthRateLimiter.dispose();
  };

  const start = (): Promise<void> => {
    if (stopRequested) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const onListenError = (error: Error) => reject(error);
      server.once("error", onListenError);
      server.listen(port, host, () => {
        server.off("error", onListenError);
        void (async () => {
          // Abort can land between listen() and its callback. Close after the
          // listener becomes visible so a stopped monitor never retains the port.
          if (stopRequested) {
            await closeIfListening();
          }
          resolve();
        })().catch(reject);
      });
    });
  };

  if (abortSignal) {
    if (abortSignal.aborted) {
      void stop();
    } else {
      abortSignal.addEventListener("abort", () => void stop(), { once: true });
    }
  }

  return { server, start, stop };
}
