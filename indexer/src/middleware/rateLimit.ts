import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import type { NextFunction, Request, Response } from 'express';

type RequestWithRateLimit = Request & {
  rateLimit?: {
    resetTime?: Date;
  };
};

export interface RateLimitOptions {
  /** Max requests per window for anonymous (unauthenticated) clients. */
  anonymousLimit: number;
  /** Max requests per window for API-key-authenticated clients. */
  apiKeyLimit: number;
  /** Sliding/fixed window size in milliseconds. */
  windowMs: number;
  /** Paths excluded from rate limiting (e.g. liveness probes). */
  skipPaths?: string[];
}

const DEFAULT_SKIP_PATHS = ['/health'];

function createLimitedHandler(windowMs: number) {
  return (req: RequestWithRateLimit, res: Response) => {
    const resetTimeMs = req.rateLimit?.resetTime?.getTime();
    const retryAfterSeconds =
      resetTimeMs === undefined
        ? Math.ceil(windowMs / 1000)
        : Math.max(1, Math.ceil((resetTimeMs - Date.now()) / 1000));

    res.setHeader('Retry-After', String(retryAfterSeconds));
    res.status(429).json({
      error: 'Too many requests, please try again later.',
    });
  };
}

/**
 * Dual-tier rate limiting:
 * - Anonymous traffic is capped at `anonymousLimit` per IP per window.
 * - API-key traffic is capped at a higher `apiKeyLimit` (keyed by API key).
 * Health checks are skipped so uptime monitors are not throttled.
 */
export function createRateLimitMiddleware(options: RateLimitOptions) {
  const {
    anonymousLimit,
    apiKeyLimit,
    windowMs,
    skipPaths = DEFAULT_SKIP_PATHS,
  } = options;

  const skipPathSet = new Set(skipPaths.map((p) => p.replace(/\/$/, '') || '/'));

  const shouldSkipPath = (req: Request) => {
    const rawPath = (req.path || req.url || '').split('?')[0] ?? '';
    const path = rawPath.replace(/\/$/, '') || '/';
    return skipPathSet.has(path);
  };

  const anonymousLimiter = rateLimit({
    windowMs,
    limit: anonymousLimit,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req, res) =>
      shouldSkipPath(req) || res.locals.apiKeyAuthenticated === true,
    handler: createLimitedHandler(windowMs),
  });

  const apiKeyLimiter = rateLimit({
    windowMs,
    limit: apiKeyLimit,
    standardHeaders: true,
    legacyHeaders: false,
    // Authenticated traffic is keyed by API key. The IP fallback uses the
    // library helper so IPv6 clients are not able to bypass via address variants.
    keyGenerator: (req) => {
      const apiKey = req.header('x-api-key')?.trim();
      if (apiKey) {
        return `apikey:${apiKey}`;
      }
      return ipKeyGenerator(req.ip ?? 'unknown');
    },
    skip: (req, res) =>
      shouldSkipPath(req) || res.locals.apiKeyAuthenticated !== true,
    handler: createLimitedHandler(windowMs),
  });

  return (req: Request, res: Response, next: NextFunction) => {
    if (res.locals.apiKeyAuthenticated === true) {
      apiKeyLimiter(req, res, next);
      return;
    }
    anonymousLimiter(req, res, next);
  };
}

/** @deprecated Prefer createRateLimitMiddleware with RateLimitOptions. */
export function createLegacyRateLimitMiddleware(limit: number, windowMs: number) {
  return createRateLimitMiddleware({
    anonymousLimit: limit,
    apiKeyLimit: limit,
    windowMs,
    skipPaths: [],
  });
}
